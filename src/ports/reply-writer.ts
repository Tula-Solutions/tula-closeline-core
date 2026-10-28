import type { OrganizationId } from 'tula-closeline-contract'
import type { InboxChannel } from './inbox-store'

/** One Playbook moment the writer may draw on and cite by `id`; its texts arrive fenced as untrusted data (call transcripts are not instructions). */
export type WriterMoment = { id: string; prospect: string; repNext: string }

/** What the writer is given to answer one objection or question. */
export type ReplyToWrite = {
  organizationId: OrganizationId
  label: 'objection' | 'question'
  channel: InboxChannel
  /** The Prospect's Message, already fenced as untrusted data (see `fenceUntrusted`). */
  fencedMessage: string
  /** The only moments that exist; a citation of any other id is dropped by the caller. */
  moments: WriterMoment[]
}

/**
 * Writes the body of a reply. It returns whatever the model said, untrusted: the caller narrows it
 * to a body, a strategy, a confidence and the ids it cited, so it can never set a status, a hold
 * or a source. It throws when the model is unreachable or `signal` aborts.
 */
export interface ReplyWriter {
  /** Writes a reply; aborts when `signal` does. */
  write(input: ReplyToWrite, signal: AbortSignal): Promise<unknown>
}
