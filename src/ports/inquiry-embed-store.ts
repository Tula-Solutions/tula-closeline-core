import type { ConsentWordingId, OrganizationId } from 'tula-closeline-contract'

/** An Organization's embed settings as the store keeps them. The wording is a snapshot. */
export type InquiryEmbedRecord = {
  publishableKey: string
  allowedOrigins: string[]
  consentWordingId: ConsentWordingId | null
  consentWordingVersion: number | null
  consentWordingText: string | null
  updatedAt: Date
}

/** The consent wording an embed displays, as snapshotted when it was set. */
export type InquiryEmbedWording = { id: ConsentWordingId; version: number; text: string }

/** What a publishable key resolves to before any Organization is open. */
export type InquiryKeyResolution = {
  organizationId: OrganizationId
  allowedOrigins: string[]
  consentWording: { version: number; text: string }
}

/** The Inquiry embed methods of an Organization scope. */
export interface InquiryEmbedScope {
  /** The Organization's embed row, or `null` before the first read creates it. */
  getInquiryEmbed(): Promise<InquiryEmbedRecord | null>
  /** Creates the row with a new key, no origin and no wording. Call after `lockOrganization`. */
  insertInquiryEmbed(key: { publishableKey: string; keyHash: string; now: Date }): Promise<void>
  /** Replaces the origins and the wording snapshot. Call after `lockOrganization`. */
  updateInquiryEmbed(change: {
    allowedOrigins: string[]
    wording: InquiryEmbedWording
    now: Date
  }): Promise<void>
  /** Replaces the key and its hash at once, so the old key stops resolving. */
  rotateInquiryEmbedKey(key: { publishableKey: string; keyHash: string; now: Date }): Promise<void>
}
