import {
  type Team,
  type TeamMember,
  teamIdSchema,
  teamMemberSchema,
  teamSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { TeamMemberRecord, TeamRecord } from '~/ports/core-store'

/** What a Teams cursor carries: the id the next page starts after, and nothing else. */
export const teamCursorSchema = z.object({ after: teamIdSchema })

/** The API shape of a Team: the contract's schema applied to the record, never the row. */
export function toTeamResponse(record: TeamRecord): Team {
  return teamSchema.parse({
    id: record.id,
    name: record.name,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  })
}

/** The API shape of a member's place in a Team. */
export function toTeamMemberResponse(record: TeamMemberRecord): TeamMember {
  return teamMemberSchema.parse({
    teamId: record.teamId,
    membershipId: record.membershipId,
    createdAt: record.createdAt.toISOString(),
  })
}
