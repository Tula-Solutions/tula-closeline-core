import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { SealedSecret, SecretBox, SecretContext } from '~/ports/secret-box'
import type { KmsClient } from './kms-client'

/** The first byte of every sealed value; bump it when the layout changes. */
export const KMS_SEALED_VERSION = 1

/** The service name every KMS call is tagged with; the IAM grant denies calls without it. */
export const KMS_SERVICE_CONTEXT = { 'closeline:service': 'core' } as const

const IV_BYTES = 12
const TAG_BYTES = 16
const DATA_KEY_BYTES = 32
const HEADER_BYTES = 3

/** How many calls one operation makes in all: the first try and two retries. */
export const KMS_MAX_ATTEMPTS = 3

/** How long one KMS call may take before it is cut off, in milliseconds. */
export const KMS_DEFAULT_TIMEOUT_MS = 3_000

const BASE_DELAY_MS = 100
const MAX_DELAY_MS = 1_000

/** Thrown when a sealed value does not open: altered bytes, another key, Organization or purpose. */
export class SecretBoxOpenError extends Error {
  constructor() {
    super('the sealed value could not be opened')
    this.name = 'SecretBoxOpenError'
  }
}

/** Thrown when KMS cannot be reached or refuses the call; the message never carries a secret. */
export class SecretBoxUnavailable extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`the key service failed: ${reason}`, options)
    this.name = 'SecretBoxUnavailable'
  }
}

const RETRYABLE_NAMES = new Set([
  'ThrottlingException',
  'KMSInternalException',
  'DependencyTimeoutException',
  'RequestTimeout',
  'RequestTimeoutException',
  'ServiceUnavailableException',
  'TimeoutError',
  'AbortError',
  'TypeError',
])
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'])
const NOT_OPENABLE_NAMES = new Set(['InvalidCiphertextException', 'IncorrectKeyException'])

const nameOf = (error: unknown): string => (error instanceof Error ? error.name : 'Error')

function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const { $metadata, code } = error as { $metadata?: { httpStatusCode?: number }; code?: unknown }
  const status = $metadata?.httpStatusCode
  return (
    RETRYABLE_NAMES.has(error.name) ||
    (status !== undefined && status >= 500) ||
    (typeof code === 'string' && NETWORK_CODES.has(code))
  )
}

/** Options for {@link createKmsSecretBox}. */
export type KmsSecretBoxOptions = {
  client: KmsClient
  /** The full ARN of the KMS key; it is also the key id stored beside each sealed value. */
  keyArn: string
  /** The longest one KMS call may take. */
  timeoutMs?: number
  /** Waits between retries; injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>
  /** A number in [0, 1) for the retry jitter; injectable for tests. */
  random?: () => number
}

/** The KMS encryption context of a value: the service tag plus its Organization and purpose. */
const kmsContext = (context: SecretContext): Record<string, string> => ({
  ...KMS_SERVICE_CONTEXT,
  organizationId: context.organizationId,
  purpose: context.purpose,
})

/** What AES-GCM authenticates: the version and the full context, connection included. */
const aad = (context: SecretContext): Buffer =>
  Buffer.from(
    JSON.stringify([
      KMS_SEALED_VERSION,
      context.organizationId,
      context.connectionId,
      context.purpose,
    ]),
    'utf8'
  )

/**
 * The production secret box: envelope encryption under one AWS KMS key. `seal` asks KMS for a data
 * key (GenerateDataKey), encrypts locally with AES-256-GCM and a random 96-bit IV, and stores the
 * wrapped key with the ciphertext; `open` has KMS unwrap the key (Decrypt) and decrypts locally.
 * Layout: version (1 byte), wrapped-key length (2 bytes, big endian), wrapped key, IV, ciphertext,
 * tag. Every KMS call carries the encryption context (service, Organization, purpose), has a
 * timeout and a bounded, jittered retry. Plaintext, data keys and ciphertext are never logged.
 */
export function createKmsSecretBox(options: KmsSecretBoxOptions): SecretBox {
  const { client, keyArn } = options
  const timeoutMs = options.timeoutMs ?? KMS_DEFAULT_TIMEOUT_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random

  async function attempt<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
      timeoutMs
    )
    try {
      return await Promise.race([
        call(controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true,
          })
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async function withRetry<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (let n = 1; ; n++) {
      try {
        return await attempt(call)
      } catch (error) {
        if (NOT_OPENABLE_NAMES.has(nameOf(error))) {
          throw new SecretBoxOpenError()
        }
        if (n >= KMS_MAX_ATTEMPTS || !isRetryable(error)) {
          throw new SecretBoxUnavailable(nameOf(error), { cause: error })
        }
        const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (n - 1))
        await sleep(Math.max(1, Math.floor(random() * ceiling)))
      }
    }
  }

  return {
    async seal(plaintext, context): Promise<SealedSecret> {
      const dataKey = await withRetry((signal) =>
        client.generateDataKey({ keyId: keyArn, context: kmsContext(context) }, signal)
      )
      try {
        if (dataKey.plaintext.byteLength !== DATA_KEY_BYTES) {
          throw new SecretBoxUnavailable('unexpected data key')
        }
        const iv = randomBytes(IV_BYTES)
        const cipher = createCipheriv('aes-256-gcm', dataKey.plaintext, iv)
        cipher.setAAD(aad(context))
        const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
        const header = Buffer.alloc(HEADER_BYTES)
        header[0] = KMS_SEALED_VERSION
        header.writeUInt16BE(dataKey.wrapped.byteLength, 1)
        const ciphertext = new Uint8Array(
          Buffer.concat([header, dataKey.wrapped, iv, body, cipher.getAuthTag()])
        )
        return { keyId: keyArn, ciphertext }
      } finally {
        dataKey.plaintext.fill(0)
      }
    },

    async open(sealed, context): Promise<string> {
      const bytes = Buffer.from(sealed.ciphertext)
      if (
        sealed.keyId !== keyArn ||
        bytes.length < HEADER_BYTES ||
        bytes[0] !== KMS_SEALED_VERSION
      ) {
        throw new SecretBoxOpenError()
      }
      const wrappedLength = bytes.readUInt16BE(1)
      const ivStart = HEADER_BYTES + wrappedLength
      if (wrappedLength === 0 || bytes.length < ivStart + IV_BYTES + TAG_BYTES) {
        throw new SecretBoxOpenError()
      }
      const wrapped = new Uint8Array(bytes.subarray(HEADER_BYTES, ivStart))
      const iv = bytes.subarray(ivStart, ivStart + IV_BYTES)
      const body = bytes.subarray(ivStart + IV_BYTES, bytes.length - TAG_BYTES)
      const tag = bytes.subarray(bytes.length - TAG_BYTES)
      const key = await withRetry((signal) =>
        client.decrypt({ keyId: keyArn, wrapped, context: kmsContext(context) }, signal)
      )
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAAD(aad(context))
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
      } catch {
        throw new SecretBoxOpenError()
      } finally {
        key.fill(0)
      }
    },
  }
}
