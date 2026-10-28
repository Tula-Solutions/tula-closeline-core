import type { OrganizationId } from 'tula-closeline-contract'
import type { InquiryEmbedRecord, InquiryEmbedScope } from '~/ports/inquiry-embed-store'

/** What the in-memory store keeps for Inquiry embeds, one per Organization. */
export type InquiryEmbedState = {
  /** The map is replaced, never changed in place, once a transaction has taken its copy. */
  inquiryEmbeds: Map<OrganizationId, InquiryEmbedRecord & { keyHash: string }>
}

/** An empty {@link InquiryEmbedState}. */
export function emptyInquiryEmbedState(): InquiryEmbedState {
  return { inquiryEmbeds: new Map() }
}

/** A copy of the shell of the map, for a transaction's first write. */
export function copyInquiryEmbedState(state: InquiryEmbedState): InquiryEmbedState {
  return { inquiryEmbeds: new Map(state.inquiryEmbeds) }
}

/** Builds the Inquiry embed methods of one transaction's scope, with the database's own rules. */
export function createInquiryEmbedScope(env: {
  organizationId: OrganizationId
  read: () => InquiryEmbedState
  write: () => InquiryEmbedState
  requireLock: () => void
}): InquiryEmbedScope {
  const { organizationId, read, write, requireLock } = env
  return {
    getInquiryEmbed: async () => {
      const found = read().inquiryEmbeds.get(organizationId)
      if (!found) {
        return null
      }
      const { keyHash: _hash, ...record } = found
      return { ...record, allowedOrigins: [...record.allowedOrigins] }
    },
    insertInquiryEmbed: async ({ publishableKey, keyHash, now }) => {
      requireLock()
      const state = write()
      if (state.inquiryEmbeds.has(organizationId)) {
        throw new Error('duplicate inquiry embed')
      }
      state.inquiryEmbeds.set(organizationId, {
        publishableKey,
        keyHash,
        allowedOrigins: [],
        consentWordingId: null,
        consentWordingVersion: null,
        consentWordingText: null,
        updatedAt: now,
      })
    },
    updateInquiryEmbed: async ({ allowedOrigins, wording, now }) => {
      requireLock()
      const state = write()
      const found = state.inquiryEmbeds.get(organizationId)
      if (found) {
        state.inquiryEmbeds.set(organizationId, {
          ...found,
          allowedOrigins: [...allowedOrigins],
          consentWordingId: wording.id,
          consentWordingVersion: wording.version,
          consentWordingText: wording.text,
          updatedAt: now,
        })
      }
    },
    rotateInquiryEmbedKey: async ({ publishableKey, keyHash, now }) => {
      requireLock()
      const state = write()
      const found = state.inquiryEmbeds.get(organizationId)
      if (found) {
        state.inquiryEmbeds.set(organizationId, {
          ...found,
          publishableKey,
          keyHash,
          updatedAt: now,
        })
      }
    },
  }
}
