import { randomBytes } from 'node:crypto'
import type { KmsClient, KmsDataKey } from './kms-client'

/** One call a {@link FakeKms} saw, with the encryption context it carried. */
export type FakeKmsCall = {
  action: 'generateDataKey' | 'decrypt'
  keyId: string
  context: Record<string, string>
}

/** An error shaped like the SDK's: a `name`, and optionally an HTTP status. */
export class FakeKmsError extends Error {
  readonly $metadata?: { httpStatusCode: number }
  constructor(name: string, httpStatusCode?: number) {
    super(name)
    this.name = name
    if (httpStatusCode !== undefined) {
      this.$metadata = { httpStatusCode }
    }
  }
}

/**
 * A KMS stand-in for tests: it wraps data keys by id, and, like the real service, refuses to
 * decrypt a blob under a different encryption context or key. No network.
 */
export class FakeKms implements KmsClient {
  readonly calls: FakeKmsCall[] = []
  /** Errors to throw on the next calls, one per call, oldest first; `undefined` lets a call run. */
  readonly failures: Array<Error | 'hang' | undefined> = []
  private readonly wrapped = new Map<string, { key: Uint8Array; context: string; keyId: string }>()

  private async maybeFail(signal: AbortSignal): Promise<void> {
    const next = this.failures.shift()
    if (next === 'hang') {
      await new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    if (next instanceof Error) {
      throw next
    }
  }

  async generateDataKey(
    input: { keyId: string; context: Record<string, string> },
    signal: AbortSignal
  ): Promise<KmsDataKey> {
    this.calls.push({ action: 'generateDataKey', keyId: input.keyId, context: input.context })
    await this.maybeFail(signal)
    const key = randomBytes(32)
    const blob = randomBytes(48)
    this.wrapped.set(Buffer.from(blob).toString('hex'), {
      key: new Uint8Array(key),
      context: JSON.stringify(Object.entries(input.context).sort()),
      keyId: input.keyId,
    })
    return { plaintext: new Uint8Array(key), wrapped: new Uint8Array(blob) }
  }

  async decrypt(
    input: { keyId: string; wrapped: Uint8Array; context: Record<string, string> },
    signal: AbortSignal
  ): Promise<Uint8Array> {
    this.calls.push({ action: 'decrypt', keyId: input.keyId, context: input.context })
    await this.maybeFail(signal)
    const entry = this.wrapped.get(Buffer.from(input.wrapped).toString('hex'))
    if (
      entry === undefined ||
      entry.keyId !== input.keyId ||
      entry.context !== JSON.stringify(Object.entries(input.context).sort())
    ) {
      throw new FakeKmsError('InvalidCiphertextException', 400)
    }
    return new Uint8Array(entry.key)
  }
}
