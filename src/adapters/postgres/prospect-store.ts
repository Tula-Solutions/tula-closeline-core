import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm'
import {
  type MembershipId,
  membershipIdSchema,
  type OrganizationId,
  type ProspectCompanyId,
  type ProspectId,
  prospectCompanyIdSchema,
  prospectIdSchema,
  prospectStatusSchema,
  userIdSchema,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import {
  memberships,
  prospectCompanies,
  prospectCompanyFields,
  prospectFields,
  prospectIdentities,
  prospects,
} from 'tula-closeline-db/schema'
import {
  CompanyDomainTakenError,
  type FieldChange,
  type FieldOwnerKind,
  type FieldRecord,
  MissingReferenceError,
  type OrganizationScope,
  type ProspectCompanyPageRequest,
  type ProspectCompanyRecord,
  type ProspectIdentityKind,
  ProspectIdentityTakenError,
  type ProspectPageRequest,
  type ProspectRecord,
  type ProspectVisibility,
  REASSIGN_MAX_IDS,
} from '~/ports/core-store'

/** The unique index that holds "one Prospect Company per domain per Organization". */
export const COMPANY_DOMAIN_KEY = 'prospect_companies_domain_key'

/** The most entries one field's history holds, which a trigger enforces. */
const FIELD_HISTORY_LIMIT = 50

/** The Prospect field names of the port, and the snake_case the columns use. */
const FIELD_COLUMN: Readonly<Record<string, string>> = {
  firstName: 'first_name',
  lastName: 'last_name',
  jobTitle: 'job_title',
  email: 'email',
  phone: 'phone',
  linkedinUrl: 'linkedin_url',
  name: 'name',
  domain: 'domain',
  industry: 'industry',
  region: 'region',
  employeeCount: 'employee_count',
  technologies: 'technologies',
}

const columnOf = (field: string): string => FIELD_COLUMN[field] ?? field

/** The most rows one address read takes: far above the 50 entries per field a history keeps. */
const ADDRESS_ROWS_MAX = 1000

/** The identity kind a field-history column holds an address of. */
const ADDRESS_KIND_OF_COLUMN: Readonly<Record<string, ProspectIdentityKind | undefined>> = {
  email: 'email',
  phone: 'phone',
  linkedin_url: 'linkedin',
}
const fieldOf = (column: string): string =>
  Object.entries(FIELD_COLUMN).find(([, snake]) => snake === column)?.[0] ?? column

type ProspectRow = typeof prospects.$inferSelect
type CompanyRow = typeof prospectCompanies.$inferSelect

function toProspect(row: ProspectRow): ProspectRecord {
  return {
    id: prospectIdSchema.parse(row.id),
    companyId: row.companyId === null ? null : prospectCompanyIdSchema.parse(row.companyId),
    ownerMembershipId:
      row.ownerMembershipId === null ? null : membershipIdSchema.parse(row.ownerMembershipId),
    status: prospectStatusSchema.parse(row.status),
    source: row.source,
    tags: [...row.tags],
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function toCompany(row: CompanyRow): ProspectCompanyRecord {
  return {
    id: prospectCompanyIdSchema.parse(row.id),
    name: row.name,
    domain: row.domain,
    industry: row.industry,
    region: row.region,
    employeeCount: row.employeeCount,
    technologies: row.technologies === null ? null : [...row.technologies],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** The condition that limits a Prospect list or read to what the visibility allows. */
function visibilityCondition(
  organizationId: OrganizationId,
  visibility: ProspectVisibility
): SQL | undefined {
  switch (visibility.kind) {
    case 'all':
      return undefined
    case 'owner':
      return eq(prospects.ownerMembershipId, visibility.membershipId)
    case 'team':
      return sql`(${prospects.ownerMembershipId} = ${visibility.managerMembershipId}
        or ${prospects.ownerMembershipId} in (
          select tm.membership_id
          from core.team_members tm
          join core.memberships m
            on m.organization_id = tm.organization_id and m.id = tm.membership_id
          where tm.organization_id = ${organizationId}
            and m.role = 'rep'
            and tm.team_id in (
              select mine.team_id from core.team_members mine
              where mine.organization_id = ${organizationId}
                and mine.membership_id = ${visibility.managerMembershipId})))`
  }
}

/**
 * The statement behind `listProspects`: one page, `created_at` then `id` both descending (written
 * `nulls last` to match the indexes, whose columns are never null), so the
 * `prospects_*_list_idx` family serves it backwards with no sort. The owner, status, company and
 * Source filters each have such an index; the visibility of a Manager adds a membership
 * condition. With `ids`, the page is instead the Prospects among those ids (a window of the
 * database's search function), in id order: see `searchProspectPage`. Exported so the integration
 * suite can ask the database for its plan.
 */
export function prospectPageQuery(
  tx: Transaction,
  organizationId: OrganizationId,
  request: ProspectPageRequest,
  ids?: readonly string[]
) {
  const filters = and(
    eq(prospects.organizationId, organizationId),
    visibilityCondition(organizationId, request.visibility),
    request.ownerMembershipId === undefined
      ? undefined
      : eq(prospects.ownerMembershipId, request.ownerMembershipId),
    request.source === undefined ? undefined : eq(prospects.source, request.source),
    request.companyId === undefined ? undefined : eq(prospects.companyId, request.companyId),
    request.status === undefined ? undefined : eq(prospects.status, request.status)
  )
  if (ids !== undefined) {
    return tx
      .select()
      .from(prospects)
      .where(and(filters, inArray(prospects.id, [...ids])))
      .orderBy(prospects.id)
      .limit(request.limit)
  }
  return tx
    .select()
    .from(prospects)
    .where(
      and(
        filters,
        request.after === undefined
          ? undefined
          : sql`(${prospects.createdAt}, ${prospects.id}) < (${request.after.createdAt.toISOString()}::timestamptz, ${request.after.id})`
      )
    )
    .orderBy(sql`${prospects.createdAt} desc nulls last`, sql`${prospects.id} desc nulls last`)
    .limit(request.limit)
}

/** The most ids the search functions return in one call (they clamp to it). */
const SEARCH_WINDOW = 101

/** The most search windows one page reads, so a rare filter cannot make a request unbounded. */
const SEARCH_WINDOWS = 5

/** The ids of one window of the search function `fn`, after `after`, in id order. */
async function searchWindow(
  tx: Transaction,
  fn: 'search_prospect_ids' | 'search_prospect_company_ids',
  q: string,
  after: string,
  rows: number
): Promise<string[]> {
  const result = await tx.execute<{ id: string }>(
    sql`select id from core.${sql.raw(fn)}(${q}, ${after}, ${rows})`
  )
  return result.rows.map((row: { id: string }) => row.id)
}

/**
 * A `q` page of Prospects. The search runs in a definer function (so the trigram indexes serve it
 * under row-level security) that reads the Organization from the transaction and returns ids in id
 * order, at most 101 a call. A page is therefore in id order, keyed by the id of the cursor, and a
 * filter (owner, visibility, status) is applied to each window: windows are read until the page is
 * full, the matches run out, or `SEARCH_WINDOWS` windows have been read.
 */
async function searchProspectPage(
  tx: Transaction,
  organizationId: OrganizationId,
  request: ProspectPageRequest & { q: string }
) {
  const found: (typeof prospects.$inferSelect)[] = []
  let cursor = request.after?.id ?? ''
  for (let window = 0; window < SEARCH_WINDOWS && found.length < request.limit; window++) {
    const ids = await searchWindow(tx, 'search_prospect_ids', request.q, cursor, SEARCH_WINDOW)
    if (ids.length === 0) {
      break
    }
    const rows = await prospectPageQuery(
      tx,
      organizationId,
      { ...request, limit: request.limit - found.length },
      ids
    )
    found.push(...rows)
    const lastId = ids.at(-1)
    if (ids.length < SEARCH_WINDOW || lastId === undefined) {
      break
    }
    // A full page ends the loop; otherwise the next window starts after this one's last id.
    cursor = lastId
  }
  return found
}

/**
 * The statement behind `listProspectCompanies`, on `prospect_companies_list_idx`. With `ids`, the
 * Companies among those ids (the search function's answer) in id order. Exported for plan tests.
 */
export function prospectCompanyPageQuery(
  tx: Transaction,
  organizationId: OrganizationId,
  request: ProspectCompanyPageRequest,
  ids?: readonly string[]
) {
  if (ids !== undefined) {
    return tx
      .select()
      .from(prospectCompanies)
      .where(
        and(
          eq(prospectCompanies.organizationId, organizationId),
          inArray(prospectCompanies.id, [...ids])
        )
      )
      .orderBy(prospectCompanies.id)
      .limit(request.limit)
  }
  return tx
    .select()
    .from(prospectCompanies)
    .where(
      and(
        eq(prospectCompanies.organizationId, organizationId),
        request.after === undefined
          ? undefined
          : sql`(${prospectCompanies.createdAt}, ${prospectCompanies.id}) < (${request.after.createdAt.toISOString()}::timestamptz, ${request.after.id})`
      )
    )
    .orderBy(
      sql`${prospectCompanies.createdAt} desc nulls last`,
      sql`${prospectCompanies.id} desc nulls last`
    )
    .limit(request.limit)
}

/** The statement behind `findProspectByIdentity`: one read of the primary key. Exported for plan tests. */
export function identityLookupQuery(
  tx: Transaction,
  organizationId: OrganizationId,
  kind: ProspectIdentityKind,
  value: string
) {
  return tx
    .select({ prospectId: prospectIdentities.prospectId })
    .from(prospectIdentities)
    .where(
      and(
        eq(prospectIdentities.organizationId, organizationId),
        eq(prospectIdentities.kind, kind),
        eq(prospectIdentities.value, value)
      )
    )
    .limit(1)
}

/** The Prospect and Prospect Company methods of a scope over one transaction. */
export type ProspectStoreMethods = Pick<
  OrganizationScope,
  | 'insertProspect'
  | 'getProspect'
  | 'lockProspect'
  | 'updateProspect'
  | 'reassignProspects'
  | 'listProspects'
  | 'getProspectCompany'
  | 'lockProspectCompany'
  | 'insertProspectCompany'
  | 'updateProspectCompany'
  | 'listProspectCompanies'
  | 'getProspectCompanies'
  | 'listCurrentFields'
  | 'applyFieldChanges'
  | 'findProspectByIdentity'
  | 'getProspectIdentity'
  | 'listProspectAddresses'
  | 'eraseProspectFields'
  | 'eraseProspectRow'
  | 'setProspectIdentity'
>

/** Builds the Prospect and Prospect Company methods over one transaction of `organizationId`. */
export function createProspectStore(
  tx: Transaction,
  organizationId: OrganizationId
): ProspectStoreMethods {
  const prospectIn = (id: string): SQL | undefined =>
    and(eq(prospects.organizationId, organizationId), eq(prospects.id, id))
  const companyIn = (id: string): SQL | undefined =>
    and(eq(prospectCompanies.organizationId, organizationId), eq(prospectCompanies.id, id))

  const requireCompany = async (id: ProspectCompanyId | null | undefined): Promise<void> => {
    if (!id) {
      return
    }
    const rows = await tx
      .select({ id: prospectCompanies.id })
      .from(prospectCompanies)
      .where(companyIn(id))
    if (rows.length === 0) {
      throw new MissingReferenceError('The Prospect Company')
    }
  }
  const requireMembership = async (id: MembershipId | null | undefined): Promise<void> => {
    if (!id) {
      return
    }
    const rows = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.id, id)))
    if (rows.length === 0) {
      throw new MissingReferenceError('The owner')
    }
  }

  const readProspect = async (id: ProspectId, visibility: ProspectVisibility, lock: boolean) => {
    const condition = and(prospectIn(id), visibilityCondition(organizationId, visibility))
    const query = tx.select().from(prospects).where(condition)
    const rows = await (lock ? query.for('update') : query)
    const row = rows[0]
    return row ? toProspect(row) : null
  }

  const readCompany = async (id: ProspectCompanyId, lock: boolean) => {
    const query = tx.select().from(prospectCompanies).where(companyIn(id))
    const rows = await (lock ? query.for('update') : query)
    const row = rows[0]
    return row ? toCompany(row) : null
  }

  /** Makes room for one more entry of a field: drops the oldest entries that are not current. */
  const trimHistory = async (
    table: 'prospect_fields' | 'prospect_company_fields',
    owner: 'prospect_id' | 'company_id',
    ownerId: string,
    column: string
  ): Promise<void> => {
    const t = sql.raw(`core.${table}`)
    const o = sql.raw(owner)
    await tx.execute(sql`
      delete from ${t} where (organization_id, seq) in (
        select organization_id, seq from ${t}
        where organization_id = ${organizationId} and ${o} = ${ownerId} and field_name = ${column}
          and state <> 'current'
        order by set_at desc, seq desc
        offset greatest(0, ${FIELD_HISTORY_LIMIT - 1} - (
          select count(*) from ${t}
          where organization_id = ${organizationId} and ${o} = ${ownerId}
            and field_name = ${column} and state = 'current')::int))`)
  }

  const supersede = async (kind: FieldOwnerKind, ownerId: string, column: string) => {
    if (kind === 'prospect') {
      await tx
        .update(prospectFields)
        .set({ state: 'superseded' })
        .where(
          and(
            eq(prospectFields.organizationId, organizationId),
            eq(prospectFields.prospectId, ownerId),
            eq(prospectFields.fieldName, column),
            eq(prospectFields.state, 'current')
          )
        )
    } else {
      await tx
        .update(prospectCompanyFields)
        .set({ state: 'superseded' })
        .where(
          and(
            eq(prospectCompanyFields.organizationId, organizationId),
            eq(prospectCompanyFields.companyId, ownerId),
            eq(prospectCompanyFields.fieldName, column),
            eq(prospectCompanyFields.state, 'current')
          )
        )
    }
  }

  return {
    insertProspect: async (input) => {
      await requireCompany(input.companyId)
      await requireMembership(input.ownerMembershipId)
      const rows = await tx
        .insert(prospects)
        .values({
          id: input.id,
          organizationId,
          companyId: input.companyId,
          ownerMembershipId: input.ownerMembershipId,
          status: 'active',
          source: input.source,
          tags: input.tags,
          notes: input.notes,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning()
      const row = rows[0]
      if (!row) {
        throw new Error('The Prospect insert returned no row')
      }
      return toProspect(row)
    },

    getProspect: (id, visibility) => readProspect(id, visibility, false),

    lockProspect: (id, visibility) => readProspect(id, visibility, true),

    updateProspect: async (id, patch, now) => {
      if (patch.companyId !== undefined) {
        await requireCompany(patch.companyId)
      }
      if (patch.ownerMembershipId !== undefined) {
        await requireMembership(patch.ownerMembershipId)
      }
      const rows = await tx
        .update(prospects)
        .set({
          ...(patch.companyId === undefined ? {} : { companyId: patch.companyId }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.tags === undefined ? {} : { tags: patch.tags }),
          ...(patch.notes === undefined ? {} : { notes: patch.notes }),
          ...(patch.ownerMembershipId === undefined
            ? {}
            : { ownerMembershipId: patch.ownerMembershipId }),
          updatedAt: now,
        })
        .where(prospectIn(id))
        .returning()
      const row = rows[0]
      return row ? toProspect(row) : null
    },

    reassignProspects: async (ids, owner, now) => {
      if (ids.length > REASSIGN_MAX_IDS) {
        throw new RangeError('Too many Prospects to reassign in one call')
      }
      await requireMembership(owner)
      if (ids.length === 0) {
        return { found: 0, changed: [] }
      }
      const inOrganization = and(
        eq(prospects.organizationId, organizationId),
        inArray(prospects.id, [...ids])
      )
      const existing = await tx
        .select({ id: prospects.id })
        .from(prospects)
        .where(inOrganization)
        .orderBy(prospects.id)
        .for('update')
      const changed = await tx
        .update(prospects)
        .set({ ownerMembershipId: owner, updatedAt: now })
        .where(and(inOrganization, sql`${prospects.ownerMembershipId} is distinct from ${owner}`))
        .returning({ id: prospects.id })
      return { found: existing.length, changed: changed.map((row) => row.id as ProspectId) }
    },

    listProspects: async (request) =>
      (request.q === undefined
        ? await prospectPageQuery(tx, organizationId, request)
        : await searchProspectPage(tx, organizationId, { ...request, q: request.q })
      ).map(toProspect),

    getProspectCompany: (id) => readCompany(id, false),

    lockProspectCompany: (id) => readCompany(id, true),

    insertProspectCompany: async (input) => {
      const rows = await tx
        .insert(prospectCompanies)
        .values({
          id: input.id,
          organizationId,
          name: input.name,
          domain: input.domain,
          industry: input.industry ?? null,
          region: input.region ?? null,
          employeeCount: input.employeeCount ?? null,
          technologies: input.technologies ?? null,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning()
      const row = rows[0]
      if (!row) {
        throw new Error('The Prospect Company insert returned no row')
      }
      return toCompany(row)
    },

    updateProspectCompany: async (id, patch, now) => {
      const rows = await tx
        .update(prospectCompanies)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.domain === undefined ? {} : { domain: patch.domain }),
          ...(patch.industry === undefined ? {} : { industry: patch.industry }),
          ...(patch.region === undefined ? {} : { region: patch.region }),
          ...(patch.employeeCount === undefined ? {} : { employeeCount: patch.employeeCount }),
          ...(patch.technologies === undefined ? {} : { technologies: patch.technologies }),
          updatedAt: now,
        })
        .where(companyIn(id))
        .returning()
      const row = rows[0]
      return row ? toCompany(row) : null
    },

    listProspectCompanies: async (request) => {
      if (request.q === undefined) {
        return (await prospectCompanyPageQuery(tx, organizationId, request)).map(toCompany)
      }
      // One window is the whole page: a Company search has no other filter to thin it.
      const ids = await searchWindow(
        tx,
        'search_prospect_company_ids',
        request.q,
        request.after?.id ?? '',
        Math.min(request.limit, SEARCH_WINDOW)
      )
      if (ids.length === 0) {
        return []
      }
      return (await prospectCompanyPageQuery(tx, organizationId, request, ids)).map(toCompany)
    },

    getProspectCompanies: async (ids) => {
      if (ids.length === 0) {
        return []
      }
      const rows = await tx
        .select()
        .from(prospectCompanies)
        .where(
          and(
            eq(prospectCompanies.organizationId, organizationId),
            inArray(prospectCompanies.id, ids)
          )
        )
      return rows.map(toCompany)
    },

    listCurrentFields: async (kind, ids) => {
      const found = new Map<string, FieldRecord[]>()
      if (ids.length === 0) {
        return found
      }
      const rows =
        kind === 'prospect'
          ? (
              await tx
                .select()
                .from(prospectFields)
                .where(
                  and(
                    eq(prospectFields.organizationId, organizationId),
                    inArray(prospectFields.prospectId, ids),
                    eq(prospectFields.state, 'current')
                  )
                )
            ).map((row) => ({ ownerId: row.prospectId, row }))
          : (
              await tx
                .select()
                .from(prospectCompanyFields)
                .where(
                  and(
                    eq(prospectCompanyFields.organizationId, organizationId),
                    inArray(prospectCompanyFields.companyId, ids),
                    eq(prospectCompanyFields.state, 'current')
                  )
                )
            ).map((row) => ({ ownerId: row.companyId, row }))
      for (const { ownerId, row } of rows) {
        const list = found.get(ownerId) ?? []
        list.push({
          field: fieldOf(row.fieldName),
          value: row.value,
          source: row.source,
          sourceRef: row.sourceRef,
          setAt: row.setAt,
          setByUserId: row.setByUserId === null ? null : userIdSchema.parse(row.setByUserId),
        })
        found.set(ownerId, list)
      }
      return found
    },

    applyFieldChanges: async (kind, ownerId, changes: FieldChange[]) => {
      const ordered = [...changes].sort((a, b) =>
        columnOf(a.field) < columnOf(b.field) ? -1 : columnOf(a.field) > columnOf(b.field) ? 1 : 0
      )
      const table = kind === 'prospect' ? 'prospect_fields' : 'prospect_company_fields'
      const owner = kind === 'prospect' ? 'prospect_id' : 'company_id'
      for (const change of ordered) {
        const column = columnOf(change.field)
        if (change.action !== 'record') {
          await supersede(kind, ownerId, column)
        }
        if (change.action === 'clear') {
          continue
        }
        await trimHistory(table, owner, ownerId, column)
        const state = change.action === 'set' ? 'current' : change.state
        const stamp = {
          organizationId,
          fieldName: column,
          state,
          value: change.value,
          source: change.source,
          sourceRef: change.sourceRef,
          setAt: change.at,
          setByUserId: change.setByUserId,
        } as const
        if (kind === 'prospect') {
          await tx.insert(prospectFields).values({ ...stamp, prospectId: ownerId })
        } else {
          await tx.insert(prospectCompanyFields).values({ ...stamp, companyId: ownerId })
        }
      }
    },

    findProspectByIdentity: async (kind, value) => {
      const row = (await identityLookupQuery(tx, organizationId, kind, value))[0]
      return row ? prospectIdSchema.parse(row.prospectId) : null
    },

    getProspectIdentity: async (prospectId, kind) => {
      const rows = await tx
        .select({ value: prospectIdentities.value })
        .from(prospectIdentities)
        .where(
          and(
            eq(prospectIdentities.organizationId, organizationId),
            eq(prospectIdentities.prospectId, prospectId),
            eq(prospectIdentities.kind, kind)
          )
        )
        .orderBy(desc(prospectIdentities.isPrimary), prospectIdentities.value)
        .limit(1)
      return rows[0]?.value ?? null
    },

    listProspectAddresses: async (prospectId) => {
      const found = new Map<string, { kind: ProspectIdentityKind; value: string }>()
      const identities = await tx
        .select({ kind: prospectIdentities.kind, value: prospectIdentities.value })
        .from(prospectIdentities)
        .where(
          and(
            eq(prospectIdentities.organizationId, organizationId),
            eq(prospectIdentities.prospectId, prospectId)
          )
        )
        .limit(ADDRESS_ROWS_MAX)
      for (const row of identities) {
        found.set(`${row.kind}\u0000${row.value}`, { kind: row.kind, value: row.value })
      }
      const history = await tx
        .select({ fieldName: prospectFields.fieldName, value: prospectFields.value })
        .from(prospectFields)
        .where(
          and(
            eq(prospectFields.organizationId, organizationId),
            eq(prospectFields.prospectId, prospectId),
            inArray(prospectFields.fieldName, ['email', 'phone', 'linkedin_url'])
          )
        )
        .limit(ADDRESS_ROWS_MAX)
      for (const row of history) {
        const kind = ADDRESS_KIND_OF_COLUMN[row.fieldName]
        if (kind) {
          found.set(`${kind}\u0000${row.value}`, { kind, value: row.value })
        }
      }
      return [...found.values()]
    },

    eraseProspectFields: async (prospectId, limit) => {
      const result = await tx.execute(sql`
        delete from core.prospect_fields where (organization_id, seq) in (
          select organization_id, seq from core.prospect_fields
          where organization_id = ${organizationId} and prospect_id = ${prospectId}
          order by seq limit ${limit})
        returning seq`)
      return result.rows.length
    },

    eraseProspectRow: async (prospectId) => {
      const rows = await tx
        .delete(prospects)
        .where(prospectIn(prospectId))
        .returning({ id: prospects.id })
      return rows.length > 0
    },

    setProspectIdentity: async (prospectId, kind, value, now) => {
      await tx
        .delete(prospectIdentities)
        .where(
          and(
            eq(prospectIdentities.organizationId, organizationId),
            eq(prospectIdentities.prospectId, prospectId),
            eq(prospectIdentities.kind, kind)
          )
        )
      if (value === null) {
        return
      }
      const holder = (await identityLookupQuery(tx, organizationId, kind, value))[0]
      if (holder && holder.prospectId !== prospectId) {
        throw new ProspectIdentityTakenError(kind, prospectIdSchema.parse(holder.prospectId))
      }
      await tx.insert(prospectIdentities).values({
        organizationId,
        kind,
        value,
        prospectId,
        isPrimary: true,
        createdAt: now,
      })
    },
  }
}

/**
 * Turns a unique violation on a Prospect Company domain into the port's error, or returns
 * `undefined`. Identity clashes are caught by the pre-check: every write holds the Organization lock first,
 * so no second writer can slip between the check and the insert.
 */
export function translateProspectError(info: { code?: string; constraint?: string }): unknown {
  if (info.code === '23505' && info.constraint === COMPANY_DOMAIN_KEY) {
    return new CompanyDomainTakenError()
  }
  return undefined
}
