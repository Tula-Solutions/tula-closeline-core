import type { CrmDeal, CrmGrant, CrmStage } from '~/ports/crm-provider'

/** One scripted answer: served instead of the normal one, in order, for the next calls to any path. */
export type FakeAnswer =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  | 'hang'

/** A request the fake saw, with the secrets cut out. */
export type FakeRequest = { method: string; path: string; form: Record<string, string> }

/** A raw deal record as HubSpot's search returns it; a test may plant a malformed one. */
export type FakeDealRecord = { id?: unknown; properties?: unknown }

/** The raw record HubSpot would serve for `deal`. */
export function hubspotDeal(deal: CrmDeal): FakeDealRecord {
  return {
    id: deal.id,
    properties: {
      dealname: deal.name,
      dealstage: deal.stageId,
      amount: deal.amount === null ? null : String(deal.amount),
      deal_currency_code: deal.currency,
      closedate: deal.closedAt === null ? null : `${deal.closedAt}T00:00:00.000Z`,
      hs_lastmodifieddate: deal.version,
    },
  }
}

/**
 * A scripted HubSpot over real HTTP on a loopback port, for the adapter's tests and local runs: it
 * knows the codes and refresh tokens it was given and serves queued failures first. No real
 * HubSpot account is involved.
 */
export function startFakeHubspot() {
  const codes = new Map<string, CrmGrant>()
  const refreshTokens = new Set<string>()
  const accounts = new Map<string, CrmGrant>()
  const script: FakeAnswer[] = []
  const requests: FakeRequest[] = []
  let stages: CrmStage[] = []
  let deals: FakeDealRecord[] = []
  let issued = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === 'POST' ? await request.text() : ''
      const isJson = request.headers.get('content-type')?.includes('json') === true
      const form = isJson ? {} : Object.fromEntries(new URLSearchParams(text))
      const json: unknown = isJson ? JSON.parse(text) : null
      requests.push({ method: request.method, path: url.pathname, form })
      const next = script.shift()
      if (next === 'hang') {
        return new Promise<Response>(() => undefined)
      }
      if (next) {
        return Response.json(next.body ?? {}, { status: next.status, headers: next.headers ?? {} })
      }
      if (url.pathname === '/oauth/v1/token') {
        if (form.grant_type === 'authorization_code') {
          const grant = form.code ? codes.get(form.code) : undefined
          if (!grant || !form.code) {
            return Response.json({ status: 'BAD_AUTH_CODE' }, { status: 400 })
          }
          codes.delete(form.code)
          const accessToken = grant.accessToken
          accounts.set(accessToken, grant)
          return Response.json({
            access_token: accessToken,
            refresh_token: grant.refreshToken,
            expires_in: 3600,
          })
        }
        if (!form.refresh_token || !refreshTokens.has(form.refresh_token)) {
          return Response.json({ status: 'BAD_REFRESH_TOKEN' }, { status: 400 })
        }
        issued += 1
        return Response.json({
          access_token: `refreshed-${issued}`,
          refresh_token: form.refresh_token,
          expires_in: 1800,
        })
      }
      if (url.pathname === '/crm/v3/pipelines/deals') {
        const pipelines = new Map<string, { id: string; label: string | null; stages: unknown[] }>()
        for (const stage of stages) {
          const id = stage.pipelineId ?? 'default'
          const pipeline = pipelines.get(id) ?? { id, label: stage.pipelineLabel, stages: [] }
          pipeline.stages.push({ id: stage.stageId, label: stage.label })
          pipelines.set(id, pipeline)
        }
        return Response.json({ results: [...pipelines.values()] })
      }
      if (url.pathname === '/crm/v3/objects/deals/search') {
        const body = json as {
          filterGroups: { filters: { value: string }[] }[]
          limit: number
        }
        const from = Number(body.filterGroups[0]?.filters[0]?.value ?? 0)
        const modified = (record: FakeDealRecord): number =>
          Date.parse(
            String(
              (record.properties as { hs_lastmodifieddate?: unknown } | undefined)
                ?.hs_lastmodifieddate
            )
          )
        const matching = deals
          .filter((record) => modified(record) >= from)
          .sort((a, b) => modified(a) - modified(b))
        return Response.json({ total: matching.length, results: matching.slice(0, body.limit) })
      }
      const info = url.pathname.match(/^\/oauth\/v1\/access-tokens\/(.+)$/)
      const account = info?.[1] ? accounts.get(decodeURIComponent(info[1])) : undefined
      if (!account) {
        return Response.json({ status: 'BAD_ACCESS_TOKEN' }, { status: 404 })
      }
      return Response.json({
        hub_id: Number(account.externalAccountId),
        hub_domain: account.accountLabel,
        scopes:
          account.scopeLevel === 'read_write'
            ? ['oauth', 'crm.objects.deals.read', 'crm.objects.deals.write']
            : ['oauth', 'crm.objects.deals.read'],
      })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    acceptCode(code: string, grant: CrmGrant) {
      codes.set(code, grant)
      if (grant.refreshToken !== null) {
        refreshTokens.add(grant.refreshToken)
      }
    },
    /** Replaces the deal stages the fake serves. */
    plantStages(next: CrmStage[]) {
      stages = next
    },
    /** Replaces the deal records the fake serves (raw, so a test may plant a malformed one). */
    plantDeals(next: FakeDealRecord[]) {
      deals = next
    },
    /** Queues answers served, in order, before the normal behaviour resumes. */
    queue(...answers: FakeAnswer[]) {
      script.push(...answers)
    },
    stop: () => server.stop(true),
  }
}
