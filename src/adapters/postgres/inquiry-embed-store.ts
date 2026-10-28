import { eq } from 'drizzle-orm'
import { consentWordingIdSchema, type OrganizationId } from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { inquiryEmbeds } from 'tula-closeline-db/schema'
import type { InquiryEmbedScope } from '~/ports/inquiry-embed-store'

/** Builds the Inquiry embed methods of one transaction's scope, under row-level security. */
export function createInquiryEmbedStore(
  tx: Transaction,
  organizationId: OrganizationId
): InquiryEmbedScope {
  const mine = eq(inquiryEmbeds.organizationId, organizationId)
  return {
    getInquiryEmbed: async () => {
      const [row] = await tx.select().from(inquiryEmbeds).where(mine).limit(1)
      return row
        ? {
            publishableKey: row.publishableKey,
            allowedOrigins: row.allowedOrigins,
            consentWordingId:
              row.consentWordingId === null
                ? null
                : consentWordingIdSchema.parse(row.consentWordingId),
            consentWordingVersion: row.consentWordingVersion,
            consentWordingText: row.consentWordingText,
            updatedAt: row.updatedAt,
          }
        : null
    },
    insertInquiryEmbed: async ({ publishableKey, keyHash, now }) => {
      await tx.insert(inquiryEmbeds).values({
        organizationId,
        publishableKey,
        publishableKeyHash: keyHash,
        allowedOrigins: [],
        createdAt: now,
        updatedAt: now,
      })
    },
    updateInquiryEmbed: async ({ allowedOrigins, wording, now }) => {
      await tx
        .update(inquiryEmbeds)
        .set({
          allowedOrigins,
          consentWordingId: wording.id,
          consentWordingVersion: wording.version,
          consentWordingText: wording.text,
          updatedAt: now,
        })
        .where(mine)
    },
    rotateInquiryEmbedKey: async ({ publishableKey, keyHash, now }) => {
      await tx
        .update(inquiryEmbeds)
        .set({ publishableKey, publishableKeyHash: keyHash, updatedAt: now })
        .where(mine)
    },
  }
}
