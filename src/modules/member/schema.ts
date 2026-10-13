import { type Member, memberSchema, membershipIdSchema } from 'tula-closeline-contract'
import { z } from 'zod'
import type { MembershipRecord } from '~/ports/core-store'

/** What a members cursor carries: the id the next page starts after, and nothing else. */
export const memberCursorSchema = z.object({ after: membershipIdSchema })

/** The API shape of a member: the contract's schema applied to the record, never the row. */
export function toMemberResponse(record: MembershipRecord): Member {
  return memberSchema.parse({
    id: record.id,
    userId: record.userId,
    role: record.role,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  })
}
