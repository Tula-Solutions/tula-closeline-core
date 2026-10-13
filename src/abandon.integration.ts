import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  createdAt,
  directoryRows,
  harness,
  holdOrganizationLock,
  organizationCount,
  owner,
  statusOf,
  store,
  untilSomeoneWaits,
} from '~/integration-harness'
import { newUserId, publicCaller, seedOrganization } from '~/testing'

describe('abandoning an Organization, over Postgres', () => {
  test('deletes the Organization, frees the user id at once, and a repeat is a success', async () => {
    const h = await harness()
    const { userId, organizationId } = await h.signUp()
    expect(await directoryRows(userId)).toBe(1)

    const first = await h.abandon(organizationId, userId)
    const again = await h.abandon(organizationId, userId)
    const stranger = await h.abandon(organizationId, newUserId())

    for (const answer of [first, again, stranger]) {
      expect(answer.status).toBe(200)
      expect(answer.body).toEqual({ organizationId, status: 'deleted' })
    }
    expect(await statusOf(organizationId)).toBe('deleted')
    expect(await directoryRows(userId)).toBe(0)
    expect(await store.organizationOfUser(userId)).toBeNull()
    const second = await h.post('/internal/organizations', {
      userId,
      organizationName: 'Second try',
      email: `${userId}@example.test`,
    })
    expect(second.status).toBe(200)
    expect(second.body.organizationId).not.toBe(organizationId)
  })

  test('an Organization id nobody created is a success and creates nothing', async () => {
    const h = await harness()
    const before = await organizationCount()

    const answer = await h.abandon(`org_${'0'.repeat(31)}1`, newUserId())

    expect(answer.status).toBe(200)
    expect(await organizationCount()).toBe(before)
  })

  test('refuses two members, and a different sole member, and leaves them be', async () => {
    const h = await harness()
    const two = await seedOrganization(store, ['rep'])
    const solo = await h.signUp()

    const crowded = await h.abandon(two.organizationId, two.owner.userId)
    const wrong = await h.abandon(solo.organizationId, newUserId())

    expect(crowded.status).toBe(409)
    expect(crowded.body.error?.code).toBe('organization.not_abandonable')
    expect(wrong.status).toBe(409)
    expect(await statusOf(two.organizationId)).toBe('active')
    expect(await statusOf(solo.organizationId)).toBe('active')
    expect(await directoryRows(solo.userId)).toBe(1)
  })

  test('judges age by the database clock, whatever the process clock says', async () => {
    const h = await harness({ clockStart: '2001-01-01T00:00:00Z' })
    const justUnder = await h.signUp()
    const justOver = await h.signUp()
    // The process clock of this app reads 2001. The database clock decides.
    await createdAt(justUnder.organizationId, '-24 hours + 5 seconds')
    await createdAt(justOver.organizationId, '-24 hours - 5 seconds')

    const under = await h.abandon(justUnder.organizationId, justUnder.userId)
    const over = await h.abandon(justOver.organizationId, justOver.userId)

    expect(under.status).toBe(200)
    expect(await statusOf(justUnder.organizationId)).toBe('deleted')
    expect(over.status).toBe(409)
    expect(over.body.error?.code).toBe('organization.not_abandonable')
    expect(await statusOf(justOver.organizationId)).toBe('active')
  })

  test('a pending Invitation of an abandoned Organization cannot be accepted', async () => {
    const h = await harness()
    const { userId, organizationId } = await h.signUp()
    await publicCaller(h)({ userId, role: 'owner' }, organizationId, 'POST', '/invitations', {
      email: 'late@example.test',
      role: 'rep',
    })
    const token = h.deps.mail.last().token
    await h.abandon(organizationId, userId)

    const accepted = await h.post('/internal/invitations/accept', {
      userId: newUserId(),
      email: 'late@example.test',
      invitationToken: token,
    })

    expect(accepted.status).toBe(422)
    expect(accepted.body.error?.code).toBe('invitation.invalid')
  })

  test('removes a Team place of the member and leaves the Team for the deletion job', async () => {
    const h = await harness()
    const { userId, organizationId } = await h.signUp()
    const api = publicCaller(h)
    const owner_ = { userId, role: 'owner' as const }
    const team = await api(owner_, organizationId, 'POST', '/teams', { name: 'Sales' })
    expect(team.status).toBe(201)
    const [member] = await h.members(organizationId, { userId })
    const placed = await api(owner_, organizationId, 'POST', `/teams/${team.body.id}/members`, {
      membershipId: member?.id,
    })
    expect(placed.status).toBeLessThan(300)

    expect((await h.abandon(organizationId, userId)).status).toBe(200)

    const { rows } = await owner.db.execute<{ teams: number; places: number }>(sql`
      select
        (select count(*)::int from core.teams where organization_id = ${organizationId}) as teams,
        (select count(*)::int from core.team_members where organization_id = ${organizationId}) as places
    `)
    expect(rows[0]).toEqual({ teams: 1, places: 0 })
  })

  test('waits for the Organization lock, a bounded time, then answers 503 and changes nothing', async () => {
    const h = await harness({ impatient: true })
    const { userId, organizationId } = await h.signUp()
    const holder = holdOrganizationLock(organizationId)
    await holder.hasLock

    const blocked = await h.abandon(organizationId, userId)
    holder.release()
    await holder.done

    expect(blocked.status).toBe(503)
    expect(blocked.body.error?.code).toBe('server.unavailable')
    expect(blocked.retryAfter).toBe('1')
    expect(await statusOf(organizationId)).toBe('active')
    expect((await h.abandon(organizationId, userId)).status).toBe(200)
  })

  test('an accept queued behind the same lock lands before or after an abandon, never between', async () => {
    for (let round = 0; round < 5; round += 1) {
      const h = await harness()
      const { userId, organizationId } = await h.signUp()
      await publicCaller(h)({ userId, role: 'owner' }, organizationId, 'POST', '/invitations', {
        email: `race${round}@example.test`,
        role: 'rep',
      })
      const token = h.deps.mail.last().token
      const joiner = newUserId()
      const holder = holdOrganizationLock(organizationId)
      await holder.hasLock

      const accepted = h.post('/internal/invitations/accept', {
        userId: joiner,
        email: `race${round}@example.test`,
        invitationToken: token,
      })
      const abandoned = h.abandon(organizationId, userId)
      await untilSomeoneWaits()
      holder.release()
      await holder.done
      const [acceptAnswer, abandonAnswer] = await Promise.all([accepted, abandoned])

      const status = await statusOf(organizationId)
      if (acceptAnswer.status === 200) {
        expect(abandonAnswer.status).toBe(409)
        expect(status).toBe('active')
        expect(await directoryRows(joiner)).toBe(1)
        expect(await directoryRows(userId)).toBe(1)
      } else {
        expect(acceptAnswer.status).toBe(422)
        expect(abandonAnswer.status).toBe(200)
        expect(status).toBe('deleted')
        expect(await directoryRows(joiner)).toBe(0)
        expect(await directoryRows(userId)).toBe(0)
      }
    }
  })

  test('many abandons at once all succeed and leave one deleted Organization', async () => {
    const h = await harness()
    const { userId, organizationId } = await h.signUp()

    const answers = await Promise.all(
      Array.from({ length: 8 }, () => h.abandon(organizationId, userId))
    )

    expect(answers.map((a) => a.status)).toEqual(Array(8).fill(200))
    expect(await statusOf(organizationId)).toBe('deleted')
  })
})
