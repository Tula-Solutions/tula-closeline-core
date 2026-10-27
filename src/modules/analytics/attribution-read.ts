import {
  ATTRIBUTION_LOOKBACK_DAYS,
  type CitationRef,
  citationRefSchema,
  type DealAttribution,
  type DealRecordId,
  decodeCursor,
  ERRORS,
  encodeCursor,
  type getDealAttributionQuerySchema,
  type ListSourcePerformanceQuery,
  type listSourcePerformanceResponseSchema,
  touchIdSchema,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { openOrganization } from '~/modules/organization/access'
import {
  type AttributedTouchRecord,
  citationOfMomentRef,
  type SourcePerformanceRecord,
  sourceWinRate,
} from '~/ports/attribution-store'
import { sourceCursorSchema, touchCursorSchema } from './schema'

type GetDealAttributionQuery = z.infer<typeof getDealAttributionQuerySchema>
type ListSourcePerformanceResponse = z.infer<typeof listSourcePerformanceResponseSchema>

/** What the Attribution reads need from the container. */
export type AttributionReadDeps = Pick<Container, 'store'>

/** Reads a cursor, or refuses it as a bad request. */
function decodeOrRefuse<S extends z.ZodType>(cursor: string | undefined, schema: S) {
  if (cursor === undefined) {
    return undefined
  }
  const decoded: z.infer<S> | undefined = decodeCursor(cursor, schema)
  if (decoded === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return decoded
}

const touchOf = (t: AttributedTouchRecord): DealAttribution['touches']['items'][number] => ({
  kind: 'message',
  id: t.id,
  messageId: t.messageId,
  prospectId: t.prospectId,
  occurredAt: t.occurredAt.toISOString(),
  credit: { firstTouch: t.firstTouch, lastTouch: t.lastTouch },
  sources: t.citedSources,
})

/**
 * The Attribution of one won or lost Deal: its touches oldest first, one cursor page, with the
 * first-touch and last-touch ids. Owner and Admin only. An open, unknown or other-Organization
 * Deal is `request.not_found`. Ids and times only, never Message text.
 */
export async function dealAttribution(
  deps: AttributionReadDeps,
  caller: Caller,
  dealRecordId: DealRecordId,
  query: GetDealAttributionQuery
): Promise<DealAttribution> {
  const after = decodeOrRefuse(query.cursor, touchCursorSchema)
  const parsedId = after === undefined ? undefined : touchIdSchema.safeParse(after.id)
  if (parsedId && !parsedId.success) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'analytics.attribution')
    const outcome = await scope.dealOutcome(dealRecordId)
    if (outcome === null) {
      throw domainError(ERRORS['request.not_found'])
    }
    const ends = await scope.dealCreditEnds(dealRecordId)
    const rows = await scope.listDealTouches(
      dealRecordId,
      query.limit + 1,
      after && parsedId?.success ? { occurredAt: new Date(after.at), id: parsedId.data } : undefined
    )
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      dealRecordId,
      outcome,
      lookbackDays: ATTRIBUTION_LOOKBACK_DAYS,
      ...ends,
      touches: {
        items: page.map(touchOf),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ at: last.occurredAt.toISOString(), id: last.id })
            : null,
      },
    }
  })
}

/** The Citation a stored source key stands for, or `null` for a key the contract does not accept. */
function citationOfKey(row: SourcePerformanceRecord): CitationRef | null {
  if (row.kind === 'moment') {
    return citationOfMomentRef(row.key)
  }
  const [documentId, page, ...rest] = row.key.split(':')
  const parsed = citationRefSchema.safeParse({
    kind: 'document',
    documentId,
    ...(page === undefined || page === 'all' ? {} : { page: Number(page) }),
  })
  return rest.length === 0 && parsed.success ? parsed.data : null
}

/**
 * The Playbook sources the Agents cited with their win rates, most touched first, one cursor
 * page; `flag` keeps only those flagged. Owner and Admin only, for the caller's Organization.
 */
export async function sourcePerformance(
  deps: AttributionReadDeps,
  caller: Caller,
  query: ListSourcePerformanceQuery
): Promise<ListSourcePerformanceResponse> {
  const after = decodeOrRefuse(query.cursor, sourceCursorSchema)
  const rows = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'analytics.attribution')
    return scope.listSourcePerformance({
      limit: query.limit + 1,
      ...(query.flag === undefined ? {} : { flag: query.flag }),
      ...(after === undefined
        ? {}
        : { after: { dealsTouched: after.touched, kind: after.kind, key: after.key } }),
    })
  })
  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  return {
    items: page.flatMap((row) => {
      const source = citationOfKey(row)
      return source === null
        ? []
        : [
            {
              source,
              dealsTouched: row.dealsTouched,
              dealsWon: row.dealsWon,
              recordCount: row.dealsTouched,
              winRate: sourceWinRate(row.dealsTouched, row.dealsWon),
              flag: row.flag,
            },
          ]
    }),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ touched: last.dealsTouched, kind: last.kind, key: last.key })
        : null,
  }
}
