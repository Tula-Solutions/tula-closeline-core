import type { OrganizationId } from 'tula-closeline-contract'
import {
  type MomentSearch,
  momentPassage,
  momentSourceRef,
  type PlaybookMoment,
} from '~/ports/moment-search'

/** The in-memory Playbook search: per-Organization moments a test plants, for local runs and tests. */
export type MemoryMomentSearch = MomentSearch & {
  /** Plants the moments an Organization's Playbook holds. */
  seed(organizationId: OrganizationId, moments: PlaybookMoment[]): void
}

/** Searches only the moments planted for the asking Organization, in the order planted. */
export function createMemoryMomentSearch(): MemoryMomentSearch {
  const held = new Map<OrganizationId, PlaybookMoment[]>()
  return {
    seed: (organizationId, moments) => {
      held.set(organizationId, [...(held.get(organizationId) ?? []), ...moments])
    },
    searchWonMoments: async ({ organizationId, limit }) => {
      const all = held.get(organizationId) ?? []
      return {
        moments: all.slice(0, limit),
        evidence: { moments: all.length, deals: new Set(all.map((m) => m.dealRecordId)).size },
      }
    },
    passagesFor: async ({ organizationId, refs }) => {
      const wanted = new Set(refs)
      const found = new Map<string, string>()
      for (const moment of held.get(organizationId) ?? []) {
        const ref = momentSourceRef(moment)
        if (ref !== null && wanted.has(ref)) {
          found.set(ref, momentPassage(moment))
        }
      }
      return found
    },
  }
}
