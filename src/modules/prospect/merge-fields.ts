import type { ProspectId } from 'tula-closeline-contract'
import type { FieldHistoryRow } from '~/ports/prospect-merge-store'

/** The most entries one field's history may hold, as the database's trigger enforces. */
const FIELD_HISTORY_LIMIT = 50

/** The input of {@link mergeHistories}: every record's field history and the fields chosen by hand. */
export type MergeHistoriesInput = {
  survivorId: ProspectId
  /** The survivor and every merged Prospect, each with its whole field history. */
  histories: ReadonlyMap<ProspectId, readonly FieldHistoryRow[]>
  /** Per field name, the Prospect whose current value is kept. */
  choices: Readonly<Partial<Record<string, ProspectId>>>
}

/** The survivor's field history after the merge, or `ok: false` when a choice cannot be honoured. */
export type MergeHistoriesResult = { ok: true; rows: FieldHistoryRow[] } | { ok: false }

type Owned = { owner: ProspectId; row: FieldHistoryRow }

/** Whether `a` should be kept as current over `b` by ADR 0020: manual first, then newer, then earlier in the list. */
const beats = (a: Owned, b: Owned): boolean => {
  const manualA = a.row.source === 'manual'
  const manualB = b.row.source === 'manual'
  if (manualA !== manualB) {
    return manualA
  }
  return a.row.setAt.getTime() > b.row.setAt.getTime()
}

/**
 * Merges the field histories of several Prospects into one (ADR 0020). Per field, the current value
 * is the one of the chosen Prospect, else the manual one, else the newer one, else the survivor's;
 * every other current value, and every older or suggested value of every record, stays as history
 * with its own Source, reference, time and author. A field keeps its newest 50 entries and its
 * current value. A choice that names a Prospect outside the merge, or one with no current value
 * for that field, is not honoured (`ok: false`). Pure: O(entries log entries).
 */
export function mergeHistories(input: MergeHistoriesInput): MergeHistoriesResult {
  const { survivorId, histories, choices } = input
  for (const chosen of Object.values(choices)) {
    if (chosen !== undefined && !histories.has(chosen)) {
      return { ok: false }
    }
  }
  for (const [field, chosen] of Object.entries(choices)) {
    const has =
      chosen !== undefined &&
      (histories.get(chosen) ?? []).some((row) => row.field === field && row.state === 'current')
    if (chosen !== undefined && !has) {
      return { ok: false }
    }
  }
  const owners = [survivorId, ...[...histories.keys()].filter((id) => id !== survivorId)]
  const byField = new Map<string, Owned[]>()
  for (const owner of owners) {
    for (const row of histories.get(owner) ?? []) {
      byField.set(row.field, [...(byField.get(row.field) ?? []), { owner, row }])
    }
  }
  const rows: FieldHistoryRow[] = []
  for (const [field, entries] of byField) {
    const currents = entries.filter((entry) => entry.row.state === 'current')
    const chosen = choices[field]
    let winner: Owned | undefined
    if (chosen !== undefined) {
      winner = currents.find((entry) => entry.owner === chosen)
      if (!winner) {
        return { ok: false }
      }
    } else {
      winner = currents.reduce<Owned | undefined>(
        (best, entry) => (best && !beats(entry, best) ? best : entry),
        undefined
      )
    }
    const kept = entries
      .map((entry) => ({
        ...entry.row,
        state:
          entry.row.state === 'current' && entry !== winner
            ? ('superseded' as const)
            : entry.row.state,
      }))
      .sort((a, b) => a.setAt.getTime() - b.setAt.getTime())
    const surplus = kept.length - FIELD_HISTORY_LIMIT
    let dropped = 0
    for (const row of kept) {
      if (dropped < surplus && row.state !== 'current') {
        dropped += 1
        continue
      }
      rows.push(row)
    }
  }
  return { ok: true, rows }
}
