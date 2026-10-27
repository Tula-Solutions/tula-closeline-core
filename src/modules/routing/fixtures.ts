import {
  formatId,
  type MembershipId,
  type OrganizationId,
  type TeamId,
} from 'tula-closeline-contract'
import type { CoreStore } from '~/ports/core-store'

/** Makes a Team of the given members and, for each Rep in it, round-the-clock UTC hours and a healthy calendar. */
export async function seedTeam(
  store: CoreStore,
  organizationId: OrganizationId,
  members: readonly MembershipId[],
  options: { dailyCap?: number | null } = {}
): Promise<TeamId> {
  const now = new Date('2026-01-01T00:00:00Z')
  const teamId = formatId('team', crypto.randomUUID())
  await store.withOrganization(organizationId, async (scope) => {
    await scope.lockOrganization()
    await scope.insertTeam({ id: teamId, name: `Team ${teamId}`, now })
    for (const membershipId of members) {
      await scope.addTeamMember(teamId, membershipId, now)
      await scope.putWorkingHours(
        {
          membershipId,
          timeZone: 'UTC',
          windows: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 1440 })),
          dailyCap: options.dailyCap ?? null,
          awayUntil: null,
        },
        now
      )
      await scope.upsertCalendarConnection({
        id: formatId('cal', crypto.randomUUID()),
        membershipId,
        provider: 'google',
        credentialSealed: new Uint8Array([1, 2, 3, 4]),
        now,
      })
    }
  })
  return teamId
}
