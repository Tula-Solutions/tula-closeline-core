import { ERRORS, type MessageId, type OrganizationId } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { jobRegistry } from '~/messages'

/** Queues the job that labels a Message (`classify`) or answers it (`draft`); a queue that refuses it is `server.unavailable`. */
export async function publishInboxJob(
  deps: Pick<Container, 'jobs'>,
  type: 'inbox.classify_message' | 'inbox.draft_reply',
  organizationId: OrganizationId,
  messageId: MessageId,
  traceId: string
): Promise<void> {
  const job = jobRegistry.create({ type, payload: { messageId }, organizationId, traceId })
  let refused = false
  try {
    refused = (await deps.jobs.publishBatch([job])).failed.length > 0
  } catch {
    refused = true
  }
  if (refused) {
    throw domainError(ERRORS['server.unavailable'])
  }
}

/** The labels a Draft answers: an objection or a question. */
export const DRAFTED_LABELS: readonly string[] = ['objection', 'question']
