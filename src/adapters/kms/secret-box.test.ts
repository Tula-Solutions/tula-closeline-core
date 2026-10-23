import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import type { SecretContext } from '~/ports/secret-box'
import { describeSecretBox } from '~/ports/secret-box.behaviour'
import { FakeKms, FakeKmsError } from './fake-kms-client'
import { createKmsSecretBox, SecretBoxOpenError, SecretBoxUnavailable } from './secret-box'

const KEY_ARN = 'arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab'

const make = (kms = new FakeKms(), extra: Partial<Parameters<typeof createKmsSecretBox>[0]> = {}) =>
  createKmsSecretBox({
    client: kms,
    keyArn: KEY_ARN,
    sleep: async () => {},
    random: () => 0.5,
    ...extra,
  })

const where = (): SecretContext => ({
  organizationId: formatId('org', crypto.randomUUID()),
  connectionId: formatId('crn', crypto.randomUUID()),
  purpose: 'access_token',
})

describeSecretBox('kms', () => make())

describe('KMS secret box', () => {
  test('every KMS call carries closeline:service=core, the Organization and the purpose', async () => {
    const kms = new FakeKms()
    const box = make(kms)
    const ctx = where()
    const sealed = await box.seal('tok', ctx)
    await box.open(sealed, ctx)
    expect(kms.calls.map((c) => c.action)).toEqual(['generateDataKey', 'decrypt'])
    for (const call of kms.calls) {
      expect(call.keyId).toBe(KEY_ARN)
      expect(call.context).toEqual({
        'closeline:service': 'core',
        organizationId: ctx.organizationId,
        purpose: 'access_token',
      })
    }
  })

  test('the key id is the key ARN and the sealed bytes start with the format version', async () => {
    const sealed = await make().seal('tok', where())
    expect(sealed.keyId).toBe(KEY_ARN)
    expect(sealed.ciphertext[0]).toBe(1)
  })

  test('another Organization cannot open a token, and KMS itself refuses it', async () => {
    const kms = new FakeKms()
    const box = make(kms)
    const ctx = where()
    const sealed = await box.seal('tok', ctx)
    const other = { ...ctx, organizationId: formatId('org', crypto.randomUUID()) }
    await expect(box.open(sealed, other)).rejects.toBeInstanceOf(SecretBoxOpenError)
    expect(kms.calls.at(-1)?.context.organizationId).toBe(other.organizationId)
  })

  test('a token sealed under another key id does not open', async () => {
    const box = make()
    const ctx = where()
    const sealed = await box.seal('tok', ctx)
    await expect(box.open({ ...sealed, keyId: `${KEY_ARN}x` }, ctx)).rejects.toBeInstanceOf(
      SecretBoxOpenError
    )
  })

  test('tampering with the version, wrapped key, IV, body or tag fails to open', async () => {
    const box = make()
    const ctx = where()
    const sealed = await box.seal('a-token-of-some-length', ctx)
    const len = sealed.ciphertext.length
    // layout: version(1) wrappedLen(2) wrapped(48) iv(12) body tag(16)
    for (const index of [0, 1, 2, 3 + 10, 3 + 48 + 5, 3 + 48 + 12 + 1, len - 1]) {
      const altered = new Uint8Array(sealed.ciphertext)
      altered[index] = (altered[index] ?? 0) ^ 1
      await expect(box.open({ ...sealed, ciphertext: altered }, ctx)).rejects.toBeInstanceOf(
        SecretBoxOpenError
      )
    }
    for (const cut of [0, 1, 2, 10, len - 1]) {
      await expect(
        box.open({ ...sealed, ciphertext: sealed.ciphertext.slice(0, cut) }, ctx)
      ).rejects.toBeInstanceOf(SecretBoxOpenError)
    }
  })

  test('an unknown format version is refused without calling KMS', async () => {
    const kms = new FakeKms()
    const box = make(kms)
    const ctx = where()
    const sealed = await box.seal('tok', ctx)
    const altered = new Uint8Array(sealed.ciphertext)
    altered[0] = 2
    kms.calls.length = 0
    await expect(box.open({ ...sealed, ciphertext: altered }, ctx)).rejects.toBeInstanceOf(
      SecretBoxOpenError
    )
    expect(kms.calls).toHaveLength(0)
  })

  test('seal and open fit the database limit for a long token', async () => {
    const sealed = await make().seal('x'.repeat(8000), where())
    expect(sealed.ciphertext.byteLength).toBeLessThan(16384)
  })

  test('a transient KMS failure is retried and then succeeds', async () => {
    const kms = new FakeKms()
    kms.failures.push(new FakeKmsError('ThrottlingException', 400), new FakeKmsError('X', 503))
    const sleeps: number[] = []
    const box = make(kms, { sleep: async (ms) => void sleeps.push(ms) })
    const ctx = where()
    const sealed = await box.seal('tok', ctx)
    expect(await box.open(sealed, ctx)).toBe('tok')
    expect(kms.calls.filter((c) => c.action === 'generateDataKey')).toHaveLength(3)
    expect(sleeps).toHaveLength(2)
    expect(sleeps.every((ms) => ms > 0 && ms <= 1000)).toBe(true)
  })

  test('retries are bounded: three attempts, then SecretBoxUnavailable', async () => {
    const kms = new FakeKms()
    for (let i = 0; i < 10; i++) {
      kms.failures.push(new FakeKmsError('KMSInternalException', 500))
    }
    await expect(make(kms).seal('tok', where())).rejects.toBeInstanceOf(SecretBoxUnavailable)
    expect(kms.calls).toHaveLength(3)
  })

  test('the retry delay is jittered', async () => {
    const delays = async (random: number) => {
      const kms = new FakeKms()
      kms.failures.push(new FakeKmsError('ThrottlingException', 400))
      const sleeps: number[] = []
      await make(kms, { random: () => random, sleep: async (ms) => void sleeps.push(ms) }).seal(
        'tok',
        where()
      )
      return sleeps[0] ?? 0
    }
    expect(await delays(0.01)).toBeLessThan(await delays(0.99))
  })

  test.each(['AccessDeniedException', 'DisabledException', 'KMSInvalidStateException'])(
    'a %s is not retried',
    async (name) => {
      const kms = new FakeKms()
      kms.failures.push(new FakeKmsError(name, 400))
      await expect(make(kms).seal('tok', where())).rejects.toBeInstanceOf(SecretBoxUnavailable)
      expect(kms.calls).toHaveLength(1)
    }
  )

  test('a call that hangs is cut off by the timeout and retried', async () => {
    const kms = new FakeKms()
    kms.failures.push('hang', 'hang', 'hang')
    const started = Date.now()
    await expect(make(kms, { timeoutMs: 20 }).seal('tok', where())).rejects.toBeInstanceOf(
      SecretBoxUnavailable
    )
    expect(kms.calls).toHaveLength(3)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('a hung first call that is retried can still succeed', async () => {
    const kms = new FakeKms()
    kms.failures.push('hang')
    const sealed = await make(kms, { timeoutMs: 20 }).seal('tok', where())
    expect(sealed.keyId).toBe(KEY_ARN)
  })

  test('errors never carry the plaintext, key or ciphertext', async () => {
    const kms = new FakeKms()
    kms.failures.push(new FakeKmsError('AccessDeniedException', 400))
    const error = await make(kms)
      .seal('super-secret-plaintext', where())
      .catch((e: unknown) => e)
    expect(String(error)).not.toContain('super-secret-plaintext')
    expect((error as Error).message).not.toContain('super-secret-plaintext')
  })
})
