import {
  emailSchema,
  isBlankCsvRecord,
  PROSPECT_IMPORT_COLUMNS,
  type ProspectImportRowReason,
  prospectCompanyDomainSchema,
  prospectCompanyNameSchema,
  prospectJobTitleSchema,
  prospectNamePartSchema,
  prospectTagsSchema,
} from 'tula-closeline-contract'
import { normaliseLinkedin, normalisePhone } from '~/modules/prospect/normalise'

/** A column of the import template. */
export type ImportColumn = (typeof PROSPECT_IMPORT_COLUMNS)[number]

/** The separator inside the `tags` cell. */
const TAG_SEPARATOR = ';'

/** The columns that identify a person; a file needs at least one of them. */
const IDENTITY_COLUMNS: readonly ImportColumn[] = ['email', 'phone', 'linkedin_url']

/** A row of the file once its cells are trimmed and normalised; an empty cell is left out. */
export type ParsedRow = {
  firstName?: string
  lastName?: string
  jobTitle?: string
  email?: string
  phone?: string
  linkedinUrl?: string
  companyName?: string
  companyDomain?: string
  ownerEmail?: string
  tags: string[]
}

/** What the file's header gave: the columns in file order, or a refusal (never a cell). */
export type HeaderRead = { ok: true; columns: ImportColumn[] } | { ok: false }

/** What judging one row gave: its normalised values, or the one reason it is rejected. */
export type RowEvaluation =
  | { ok: true; row: ParsedRow }
  | { ok: false; reason: Extract<ProspectImportRowReason, string> }

/**
 * Judges the header record: every name (trimmed, case-folded) must be a column of the template,
 * none may repeat, and at least one must identify a person (email, phone or LinkedIn address).
 */
export function readHeader(record: readonly string[]): HeaderRead {
  const known: ReadonlySet<string> = new Set(PROSPECT_IMPORT_COLUMNS)
  const columns: ImportColumn[] = []
  for (const cell of record) {
    const name = cell.trim().toLowerCase()
    if (!known.has(name) || columns.includes(name as ImportColumn)) {
      return { ok: false }
    }
    columns.push(name as ImportColumn)
  }
  return columns.some((column) => IDENTITY_COLUMNS.includes(column))
    ? { ok: true, columns }
    : { ok: false }
}

/** The identities a row holds, as `kind:value` keys of its normalised values. */
export function identityKeys(row: ParsedRow): string[] {
  return [
    ...(row.email === undefined ? [] : [`email:${row.email}`]),
    ...(row.phone === undefined ? [] : [`phone:${row.phone}`]),
    ...(row.linkedinUrl === undefined ? [] : [`linkedin:${row.linkedinUrl}`]),
  ]
}

type Reason = Extract<ProspectImportRowReason, string>

/** Judges the cells of one record against the template; the duplicate check is not part of it. */
function checkRow(columns: readonly ImportColumn[], record: readonly string[]): RowEvaluation {
  if (isBlankCsvRecord(record)) {
    return { ok: false, reason: 'blank_row' }
  }
  if (record.length !== columns.length) {
    return { ok: false, reason: 'wrong_column_count' }
  }
  const cells = new Map<ImportColumn, string>()
  columns.forEach((column, index) => {
    const cell = (record[index] ?? '').trim()
    if (cell !== '') {
      cells.set(column, cell)
    }
  })
  const row: ParsedRow = { tags: [] }
  const refuse = (reason: Reason): RowEvaluation => ({ ok: false, reason })

  for (const [column, key, reason] of [
    ['first_name', 'firstName', 'invalid_name'],
    ['last_name', 'lastName', 'invalid_name'],
  ] as const) {
    const cell = cells.get(column)
    if (cell !== undefined) {
      const parsed = prospectNamePartSchema.safeParse(cell)
      if (!parsed.success) {
        return refuse(reason)
      }
      row[key] = parsed.data
    }
  }
  const title = cells.get('job_title')
  if (title !== undefined) {
    const parsed = prospectJobTitleSchema.safeParse(title)
    if (!parsed.success) {
      return refuse('invalid_job_title')
    }
    row.jobTitle = parsed.data
  }
  const companyName = cells.get('company_name')
  if (companyName !== undefined) {
    const parsed = prospectCompanyNameSchema.safeParse(companyName)
    if (!parsed.success) {
      return refuse('invalid_company')
    }
    row.companyName = parsed.data
  }
  const companyDomain = cells.get('company_domain')
  if (companyDomain !== undefined) {
    const parsed = prospectCompanyDomainSchema.safeParse(companyDomain)
    if (!parsed.success) {
      return refuse('invalid_company')
    }
    row.companyDomain = parsed.data
  }
  const tags = cells.get('tags')
  if (tags !== undefined) {
    const parsed = prospectTagsSchema.safeParse(
      tags
        .split(TAG_SEPARATOR)
        .map((tag) => tag.trim())
        .filter((tag) => tag !== '')
    )
    if (!parsed.success) {
      return refuse('invalid_tags')
    }
    row.tags = parsed.data
  }
  const email = cells.get('email')
  if (email !== undefined) {
    const parsed = emailSchema.safeParse(email)
    if (!parsed.success) {
      return refuse('invalid_email')
    }
    row.email = parsed.data
  }
  const phone = cells.get('phone')
  if (phone !== undefined) {
    const normalised = normalisePhone(phone)
    if (normalised === undefined) {
      return refuse('invalid_phone')
    }
    row.phone = normalised
  }
  const linkedin = cells.get('linkedin_url')
  if (linkedin !== undefined) {
    const normalised = normaliseLinkedin(linkedin)
    if (normalised === undefined) {
      return refuse('invalid_linkedin_url')
    }
    row.linkedinUrl = normalised
  }
  const owner = cells.get('owner_email')
  if (owner !== undefined) {
    const parsed = emailSchema.safeParse(owner)
    if (!parsed.success) {
      return refuse('invalid_email')
    }
    row.ownerEmail = parsed.data
  }
  if (identityKeys(row).length === 0) {
    return refuse('missing_identity')
  }
  return { ok: true, row }
}

/**
 * Judges every data record in file order. A row is rejected as `duplicate_in_file` when a
 * normalised email, phone or LinkedIn address of it was already held by an earlier row that passed
 * the checks above; a rejected row, a duplicate included, holds nothing for the rows after it.
 * Pure: the same records always give the same answer, so a resumed job rebuilds it exactly.
 */
export function evaluateRows(
  columns: readonly ImportColumn[],
  records: readonly (readonly string[])[]
): RowEvaluation[] {
  const held = new Set<string>()
  return records.map((record) => {
    const checked = checkRow(columns, record)
    if (!checked.ok) {
      return checked
    }
    const keys = identityKeys(checked.row)
    if (keys.some((key) => held.has(key))) {
      return { ok: false, reason: 'duplicate_in_file' }
    }
    for (const key of keys) {
      held.add(key)
    }
    return checked
  })
}
