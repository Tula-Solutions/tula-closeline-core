import type { FieldRecord } from '~/ports/core-store'

/** A value offered for one field, with the Source it comes from (ADR 0020). `value: null` clears the field. */
export type FieldWrite = {
  field: string
  value: string | null
  source: string
  sourceRef: string | null
  /** When the Source says the value is from; an automatic write older than the held value is only history. */
  at?: Date
}

/** What the precedence rules decide for one write against the field's current value. */
export type FieldDecision =
  | { kind: 'unchanged' }
  | { kind: 'set' }
  | { kind: 'clear' }
  | { kind: 'record'; state: 'superseded' | 'suggested' }

/** The kind part of a Source: `crm:hubspot` is `crm`, `enrichment:apollo` is `enrichment`. */
const kindOf = (source: string): string => source.split(':')[0] ?? source

/**
 * Decides what a write does to a field, by the Source precedence of ADR 0020:
 *
 * - A manual edit always wins, and clearing is a manual act only.
 * - A later automatic write never overrides a manual value. An enrichment is kept as a
 *   `suggested` value; any other Source is kept as `superseded` history.
 * - An enrichment never overrides an import, a CRM or a form value either (it is `suggested`);
 *   it fills a field that is empty and replaces an older enrichment.
 * - Otherwise the newer write wins, so a newer `import` replaces an older `import`; a write that
 *   says (`at`) it is older than the held value is kept as `superseded` history, so a late or
 *   retried old import cannot overwrite a newer one.
 * - The same value again changes nothing, except that a manual write over the same value from
 *   another Source takes the value over, so it is protected from later automatic writes.
 */
export function decideFieldWrite(
  current: FieldRecord | undefined,
  write: FieldWrite
): FieldDecision {
  const writer = kindOf(write.source)
  if (write.value === null) {
    return writer === 'manual' && current ? { kind: 'clear' } : { kind: 'unchanged' }
  }
  if (!current) {
    return { kind: 'set' }
  }
  const holder = kindOf(current.source)
  const same = current.value === write.value
  if (writer === 'manual') {
    return same && holder === 'manual' ? { kind: 'unchanged' } : { kind: 'set' }
  }
  if (same) {
    return { kind: 'unchanged' }
  }
  if (holder === 'manual') {
    return { kind: 'record', state: writer === 'enrichment' ? 'suggested' : 'superseded' }
  }
  if (writer === 'enrichment' && holder !== 'enrichment') {
    return { kind: 'record', state: 'suggested' }
  }
  if (write.at && write.at < current.setAt) {
    return { kind: 'record', state: 'superseded' }
  }
  return { kind: 'set' }
}
