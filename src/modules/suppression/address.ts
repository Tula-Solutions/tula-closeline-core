import { createHmac } from 'node:crypto'
import type { OrganizationId } from 'tula-closeline-contract'
import { MAX_MASKED_ADDRESS_LENGTH } from 'tula-closeline-db/schema'
import { toAsciiDomain } from '~/modules/invitation/email'
import { normaliseLinkedin, normalisePhone } from '~/modules/prospect/normalise'

/** The kinds of address the Suppression list keeps (ADR 0021). */
export type AddressKind = 'email' | 'phone' | 'linkedin'

/** One address as a request names it, before normalising. */
export type RawAddress = { kind: AddressKind; value: string }

/**
 * Normalises an address the way Prospect identities are stored (ADR 0011), so the same person
 * hashes to the same bytes however the address was typed: an email is trimmed, lower-cased and
 * its domain converted to ASCII; a phone is E.164; a LinkedIn address is `linkedin.com/...`.
 * `undefined` when the value is not a valid address of that kind.
 */
export function normaliseAddress(kind: AddressKind, raw: string): string | undefined {
  switch (kind) {
    case 'email': {
      const email = toAsciiDomain(raw.trim()).toLowerCase()
      return /^[!-~]+$/.test(email) && email.split('@').length === 2 && email.length >= 3
        ? email
        : undefined
    }
    case 'phone':
      return normalisePhone(raw)
    case 'linkedin':
      return normaliseLinkedin(raw)
  }
}

/**
 * The salted hash of a normalised address: HMAC-SHA-256 under a key derived from the secret and
 * the Organization (so the same address hashes differently in another Organization), over the
 * kind and the address. The hash is what the list stores; the address is not kept (ADR 0021).
 */
export function hashAddress(
  secret: string,
  organizationId: OrganizationId,
  kind: AddressKind,
  normalised: string
): Uint8Array {
  const organizationKey = createHmac('sha256', secret).update(`organization:${organizationId}`)
  const key = organizationKey.digest()
  return new Uint8Array(createHmac('sha256', key).update(`${kind}:${normalised}`).digest())
}

/**
 * A display form of a normalised address that does not reveal it: `a***@example.com`,
 * `+*******4567`, `linkedin.com/in/j***`. At most the database's 100 characters.
 */
export function maskAddress(kind: AddressKind, normalised: string): string {
  let masked: string
  switch (kind) {
    case 'email': {
      const at = normalised.lastIndexOf('@')
      masked = `${normalised.slice(0, 1)}***${normalised.slice(at)}`
      break
    }
    case 'phone':
      masked = `+${'*'.repeat(Math.max(normalised.length - 5, 3))}${normalised.slice(-4)}`
      break
    case 'linkedin': {
      const slash = normalised.lastIndexOf('/')
      masked = `${normalised.slice(0, slash + 1)}${normalised.slice(slash + 1, slash + 2)}***`
      break
    }
  }
  return masked.slice(0, MAX_MASKED_ADDRESS_LENGTH)
}
