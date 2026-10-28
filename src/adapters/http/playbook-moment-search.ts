import { searchMomentsResponseSchema } from 'tula-closeline-contract'
import type { MomentSearch } from '~/ports/moment-search'

/** How the Playbook is reached and retried; tests shorten the numbers. */
export type PlaybookMomentSearchOptions = {
  /** The Playbook's internal base URL. */
  baseUrl: string
  /** The shared secret (ADR 0013) the Playbook expects as a bearer token. Never logged. */
  token: string
  /** One attempt's limit in ms; default 3 000. */
  timeoutMs?: number
}

const MAX_BODY_CHARS = 1_000_000

/**
 * A {@link MomentSearch} over the Playbook's internal Moment search route. One attempt with a timeout,
 * never retried here: the Draft writer's `withRetry` owns the bounded, jittered retry, so retrying
 * in both places would multiply the attempts. Any failure (503, 401, 400, a malformed answer, a
 * refused connection) throws. Moment text is never logged and no error carries the token or
 * the body. The Playbook has no internal route that resolves Source references yet, so
 * `passagesFor` refuses.
 */
export function createPlaybookMomentSearch(options: PlaybookMomentSearchOptions): MomentSearch {
  const timeoutMs = options.timeoutMs ?? 3_000
  const url = `${options.baseUrl.replace(/\/+$/, '')}/internal/v1/playbook/search/moments`

  return {
    searchWonMoments: async (input, signal) => {
      const body = JSON.stringify({
        turns: [{ role: 'prospect', text: input.query }],
        limit: input.limit,
      })
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            'x-organization-id': input.organizationId,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body,
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          throw new Error(`the Playbook answered ${response.status}`)
        }
        const text = await response.text()
        if (text.length > MAX_BODY_CHARS) {
          throw new Error('the Playbook answered with too large a body')
        }
        const parsed = searchMomentsResponseSchema.safeParse(JSON.parse(text))
        if (!parsed.success) {
          throw new Error('the Playbook answered with a body of the wrong shape')
        }
        return {
          moments: parsed.data.items.map((item) => ({
            callId: item.callId,
            dealRecordId: item.dealRecordId,
            momentIndex: item.momentIndex ?? null,
            prospect: item.prospect,
            repNext: item.repNext,
          })),
          evidence: parsed.data.evidence,
        }
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
        throw new Error(
          timedOut ? 'the Playbook did not answer in time' : 'the Playbook search failed'
        )
      }
    },
    passagesFor: async () => {
      throw new Error('The Playbook has no internal route for Source passages')
    },
  }
}
