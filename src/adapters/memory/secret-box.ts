import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { SealedSecret, SecretBox, SecretContext } from '~/ports/secret-box'

const IV_BYTES = 12
const TAG_BYTES = 16

/** The id of the key a memory box seals under, so a test can show which key opened a value. */
export const MEMORY_SECRET_KEY_ID = 'memory-1'

/** Thrown when a sealed value does not open: wrong key, wrong context or altered bytes. */
export class SecretBoxOpenError extends Error {
  constructor() {
    super('the sealed value could not be opened')
    this.name = 'SecretBoxOpenError'
  }
}

/** What the box binds a value to, as bytes, in a fixed order. */
const contextBytes = (context: SecretContext): Buffer =>
  Buffer.from(
    JSON.stringify([context.organizationId, context.connectionId, context.purpose]),
    'utf8'
  )

/**
 * A secret box for local and tests only: AES-256-GCM under a key that exists only in this process,
 * with the context as additional authenticated data. It stands in for the AWS KMS adapter infra owes;
 * a value sealed by one box opens in no other.
 */
export function createMemorySecretBox(key: Uint8Array = randomBytes(32)): SecretBox {
  if (key.byteLength !== 32) {
    throw new Error('the memory secret box needs a 32-byte key')
  }
  return {
    async seal(plaintext, context): Promise<SealedSecret> {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(contextBytes(context))
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const ciphertext = new Uint8Array(Buffer.concat([iv, body, cipher.getAuthTag()]))
      return { keyId: MEMORY_SECRET_KEY_ID, ciphertext }
    },

    async open(sealed, context): Promise<string> {
      if (
        sealed.keyId !== MEMORY_SECRET_KEY_ID ||
        sealed.ciphertext.byteLength < IV_BYTES + TAG_BYTES
      ) {
        throw new SecretBoxOpenError()
      }
      const bytes = Buffer.from(sealed.ciphertext)
      const iv = bytes.subarray(0, IV_BYTES)
      const tag = bytes.subarray(bytes.length - TAG_BYTES)
      const body = bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAAD(contextBytes(context))
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
      } catch {
        throw new SecretBoxOpenError()
      }
    },
  }
}
