import type { OrganizationId } from 'tula-closeline-contract'
import type { Container } from '~/container'
import type { JobEnvelope } from '~/messages'
import { type AssessOptions, assessDraft } from '~/modules/inbox/assess'
import { resolveRetry, withRetry } from '~/modules/inbox/retry'

/** What assessing a turn needs from the container. */
export type TurnDeps = Pick<Container, 'store' | 'clock' | 'judge' | 'turnReader' | 'logger'>

/** The job that asks for the Assessment of one finished Agent turn. */
export type TurnEnvelope = Extract<JobEnvelope, { type: 'call.turn_completed' }>

/** How the turn is read and judged; tests shorten the retries. */
export type TurnOptions = AssessOptions & {
  /** How long one read of the turn's text may take, in ms. */
  readTimeoutMs?: number
}

/**
 * What the check came to: `assessed` (one Assessment was stored), `duplicate` (the turn already
 * had one), `unassessed` (the Transcript or the judge could not give a usable answer, so nothing
 * is stored) or `skipped` (the Organization is gone).
 */
export type TurnOutcome = 'assessed' | 'duplicate' | 'unassessed' | 'skipped'

const READ_TIMEOUT_MS = 8_000

/**
 * Assesses one finished Agent turn, once per turn however often the event arrives. It reads the
 * turn's text, asks the judge (bounded timeout, bounded jittered retries) and stores the verdict
 * and findings. A Transcript or judge outage, a timeout or an unusable answer stores nothing and
 * returns `unassessed`: it never throws for them and never touches the Call. Only a database
 * failure throws, so the queue hands the job out again.
 */
export async function assessTurn(
  deps: TurnDeps,
  organizationId: OrganizationId,
  event: TurnEnvelope['payload'],
  options: TurnOptions = {}
): Promise<TurnOutcome> {
  const known = await deps.store.withOrganization(organizationId, async (scope) => {
    const organization = await scope.getOrganization()
    if (!organization || organization.status === 'deleted') {
      return 'skipped' as const
    }
    return (await scope.hasTurnAssessment(event.callId, event.turnIndex))
      ? ('duplicate' as const)
      : ('new' as const)
  })
  if (known !== 'new') {
    return known
  }

  const unassessed = (reason: string): TurnOutcome => {
    deps.logger.warn('a Call turn was left unassessed', {
      organizationId,
      callId: event.callId,
      turnIndex: event.turnIndex,
      reason,
    })
    return 'unassessed'
  }

  let text: Awaited<ReturnType<Container['turnReader']['read']>>
  try {
    text = await withRetry(
      (signal) =>
        deps.turnReader.read(
          {
            organizationId,
            callId: event.callId,
            turnIndex: event.turnIndex,
            citedSources: event.citedSources,
          },
          signal
        ),
      options.readTimeoutMs ?? READ_TIMEOUT_MS,
      resolveRetry(options)
    )
  } catch {
    return unassessed('transcript_unavailable')
  }
  if (text === null) {
    return unassessed('no_text')
  }

  const judged = await assessDraft(
    deps,
    {
      channel: 'phone',
      inboundBody: text.prospectText,
      draftBody: text.agentText,
      sources: text.sources,
    },
    options
  )
  if (judged.status !== 'judged') {
    return unassessed(`judge_${judged.status}`)
  }

  return deps.store.withOrganization(organizationId, async (scope) => {
    const organization = await scope.lockOrganization()
    if (!organization || organization.status === 'deleted') {
      return 'skipped'
    }
    const prospect = event.prospectId
      ? await scope.getProspect(event.prospectId, { kind: 'all' })
      : null
    const { created } = await scope.saveTurnAssessment({
      callId: event.callId,
      turnIndex: event.turnIndex,
      prospectId: prospect?.id ?? null,
      agentKind: event.agentKind,
      instructionVersion: event.instructionVersion,
      verdict: judged.verdict,
      findings: judged.findings,
      now: deps.clock.now(),
    })
    return created ? 'assessed' : 'duplicate'
  })
}
