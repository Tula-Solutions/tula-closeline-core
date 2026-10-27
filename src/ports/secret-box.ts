import type { OrganizationId } from 'tula-closeline-contract'

/** The longest sealed token the database accepts, in bytes. */
export const MAX_CRM_SEALED_TOKEN_BYTES = 16384

/** The longest key id the database accepts, in characters. */
export const MAX_SECRET_KEY_ID_LENGTH = 128

/**
 * What a sealed value is bound to. It is authenticated with the ciphertext but never stored with
 * it, so a sealed token copied to another connection, Organization or purpose does not open.
 */
export type SecretContext = {
  organizationId: OrganizationId
  /** The id the value belongs to: a CRM or calendar connection, or the Rep a calendar state names. */
  connectionId: string
  purpose: 'access_token' | 'refresh_token' | 'calendar_credential' | 'calendar_state'
}

/** A value after sealing: which key sealed it, and the opaque bytes to store. */
export type SealedSecret = {
  keyId: string
  ciphertext: Uint8Array
}

/**
 * Seals and opens secrets (CRM tokens) so the database never holds one in the clear. The production
 * adapter is the AWS KMS one (`src/adapters/kms`); the memory adapter is for local and tests only.
 */
export interface SecretBox {
  /** False when no key service is configured, so a caller can refuse before it spends a single-use code. */
  readonly configured: boolean
  /** Seals `plaintext`, bound to `context`. */
  seal(plaintext: string, context: SecretContext): Promise<SealedSecret>
  /** Opens a sealed value; rejects when the bytes, the key id or `context` do not match what sealed it. */
  open(sealed: SealedSecret, context: SecretContext): Promise<string>
}
