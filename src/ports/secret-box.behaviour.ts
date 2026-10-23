import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { MAX_SECRET_KEY_ID_LENGTH, type SecretBox, type SecretContext } from './secret-box'

const context = (purpose: SecretContext['purpose'] = 'access_token'): SecretContext => ({
  organizationId: formatId('org', crypto.randomUUID()),
  connectionId: formatId('crn', crypto.randomUUID()),
  purpose,
})

/** The behaviour every {@link SecretBox} adapter must show. */
export function describeSecretBox(label: string, make: () => SecretBox): void {
  describe(`SecretBox: ${label}`, () => {
    test('opens what it sealed', async () => {
      const box = make()
      const where = context()
      const sealed = await box.seal('pat-na1-secret-token', where)
      expect(await box.open(sealed, where)).toBe('pat-na1-secret-token')
    })

    test('the stored bytes do not contain the plaintext', async () => {
      const box = make()
      const sealed = await box.seal('pat-na1-secret-token', context())
      expect(Buffer.from(sealed.ciphertext).includes('pat-na1-secret-token')).toBe(false)
      expect(sealed.keyId.length).toBeGreaterThan(0)
      expect(sealed.keyId.length).toBeLessThanOrEqual(MAX_SECRET_KEY_ID_LENGTH)
    })

    test('sealing twice gives different bytes', async () => {
      const box = make()
      const where = context()
      const one = await box.seal('same', where)
      const two = await box.seal('same', where)
      expect(Buffer.from(one.ciphertext).equals(Buffer.from(two.ciphertext))).toBe(false)
    })

    test('does not open under another connection, Organization or purpose', async () => {
      const box = make()
      const where = context()
      const sealed = await box.seal('token', where)
      await expect(box.open(sealed, { ...where, purpose: 'refresh_token' })).rejects.toThrow()
      await expect(
        box.open(sealed, { ...where, connectionId: formatId('crn', crypto.randomUUID()) })
      ).rejects.toThrow()
      await expect(
        box.open(sealed, { ...where, organizationId: formatId('org', crypto.randomUUID()) })
      ).rejects.toThrow()
    })

    test('does not open altered bytes', async () => {
      const box = make()
      const where = context()
      const sealed = await box.seal('token', where)
      const altered = new Uint8Array(sealed.ciphertext)
      altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 1
      await expect(box.open({ ...sealed, ciphertext: altered }, where)).rejects.toThrow()
    })
  })
}
