import type { Role } from 'tula-closeline-contract'
import { seedTeam } from '~/modules/routing/fixtures'
import type { CoreStore } from '~/ports/core-store'
import { publicCaller, type SeededMember, seedOrganization, type TestApp } from '~/testing'

/** Seeds one Organization with a routed Team, connected Reps and an active Booking Type link, for tests. */
export async function bookingWorld(memory: CoreStore, harness: TestApp) {
  const seeded = await seedOrganization(memory, ['admin', 'manager', 'rep', 'rep'])
  const org = seeded.organizationId
  const pick = (role: Role) => seeded.members.filter((m) => m.role === role) as SeededMember[]
  const admin = pick('admin')[0] as SeededMember
  const manager = pick('manager')[0] as SeededMember
  const reps = pick('rep')
  const api = publicCaller(harness)
  const call = (m: SeededMember, method: string, path: string, body?: unknown) =>
    api(m, org, method, path, body)
  const teamId = await seedTeam(memory, org, [manager.id, ...reps.map((r) => r.id)], {})
  for (const rep of reps) {
    const code = `code-${rep.id}`
    harness.deps.memoryCalendar.allowGrant(code)
    const started = await call(rep, 'POST', '/calendar-connection/start', { provider: 'google' })
    await call(rep, 'POST', '/calendar-connection/complete', {
      state: (started.body as { state: string }).state,
      code,
    })
  }
  await call(admin, 'POST', '/routing-rules', {
    name: 'Default',
    target: { kind: 'team', teamId },
    conditions: {},
    isDefault: true,
  })
  const type = (
    await call(admin, 'POST', '/booking-types', {
      name: 'Intro',
      lengthMinutes: 30,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 5,
      minimumNoticeMinutes: 60,
      mode: 'phone',
    })
  ).body as { id: string; publicToken: string }
  return { org, admin, reps, call, type, token: type.publicToken }
}
