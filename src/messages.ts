import {
  bookingCancelledEvent,
  bookingCreatedEvent,
  bookingRescheduledEvent,
  callTurnCompletedEvent,
  consentGrantedEvent,
  consentWithdrawnEvent,
  conversationHandedBackEvent,
  conversationIdSchema,
  conversationTakenOverEvent,
  crmConnectedEvent,
  crmDisconnectedEvent,
  crmRunCompletedEvent,
  crmSyncRunIdSchema,
  dealOutcomeChangedEvent,
  exportJobIdSchema,
  exportPartFailedEvent,
  exportPartReadyEvent,
  exportRequestedEvent,
  membershipIdSchema,
  messageApprovedEvent,
  messageIdSchema,
  messageSentEvent,
  prospectCreatedEvent,
  prospectErasedEvent,
  prospectIdSchema,
  prospectImportIdSchema,
  prospectMergedEvent,
  prospectMergeUndoneEvent,
  prospectUpdatedEvent,
  replyClassifiedEvent,
  suppressionAddedEvent,
  suppressionImportIdSchema,
  suppressionRemovedEvent,
  userIdSchema,
} from 'tula-closeline-contract'
import {
  type AuditRecordedEnvelope,
  auditRecordedMessage,
  createMessageRegistry,
  defineMessage,
  type EnvelopeOf,
} from 'tula-closeline-kit'
import { z } from 'zod'

/**
 * `prospect.created` as a queue message. The payload is the `data` of the contract's event, so a
 * consumer that reads the contract's shape reads this one; the kit adds its own envelope around it.
 */
export const prospectCreated = defineMessage({
  type: 'prospect.created',
  version: 1,
  scope: 'organization',
  payload: prospectCreatedEvent.schema.shape.data,
})

/** `prospect.updated` as a queue message; the payload is the `data` of the contract's event. */
export const prospectUpdated = defineMessage({
  type: 'prospect.updated',
  version: 1,
  scope: 'organization',
  payload: prospectUpdatedEvent.schema.shape.data,
})

/** `prospect.erased` as a queue message; the payload is the `data` of the contract's event: the id alone, no personal data. */
export const prospectErased = defineMessage({
  type: 'prospect.erased',
  version: 1,
  scope: 'organization',
  payload: prospectErasedEvent.schema.shape.data,
})

/** `prospect.merged` as a queue message; the payload is the `data` of the contract's event: ids only. */
export const prospectMerged = defineMessage({
  type: 'prospect.merged',
  version: 1,
  scope: 'organization',
  payload: prospectMergedEvent.schema.shape.data,
})

/** `prospect.merge_undone` as a queue message; the payload is the `data` of the contract's event: ids only. */
export const prospectMergeUndone = defineMessage({
  type: 'prospect.merge_undone',
  version: 1,
  scope: 'organization',
  payload: prospectMergeUndoneEvent.schema.shape.data,
})

/** `suppression.added` as a queue message; the payload is the `data` of the contract's event. It never carries the address. */
export const suppressionAdded = defineMessage({
  type: 'suppression.added',
  version: 1,
  scope: 'organization',
  payload: suppressionAddedEvent.schema.shape.data,
})

/** `suppression.removed` as a queue message; the payload is the `data` of the contract's event. */
export const suppressionRemoved = defineMessage({
  type: 'suppression.removed',
  version: 1,
  scope: 'organization',
  payload: suppressionRemovedEvent.schema.shape.data,
})

/** `consent.granted` as a queue message; the payload is the `data` of the contract's event. */
export const consentGranted = defineMessage({
  type: 'consent.granted',
  version: 1,
  scope: 'organization',
  payload: consentGrantedEvent.schema.shape.data,
})

/** `consent.withdrawn` as a queue message; the payload is the `data` of the contract's event. */
export const consentWithdrawn = defineMessage({
  type: 'consent.withdrawn',
  version: 1,
  scope: 'organization',
  payload: consentWithdrawnEvent.schema.shape.data,
})

/** `crm.connected` as a queue message; the payload is the `data` of the contract's event. It never carries a token. */
export const crmConnected = defineMessage({
  type: 'crm.connected',
  version: 1,
  scope: 'organization',
  payload: crmConnectedEvent.schema.shape.data,
})

/** `crm.disconnected` as a queue message; the payload is the `data` of the contract's event. */
export const crmDisconnected = defineMessage({
  type: 'crm.disconnected',
  version: 1,
  scope: 'organization',
  payload: crmDisconnectedEvent.schema.shape.data,
})

/** `crm.run_completed` as a queue message; the payload is the `data` of the contract's event. */
export const crmRunCompleted = defineMessage({
  type: 'crm.run_completed',
  version: 1,
  scope: 'organization',
  payload: crmRunCompletedEvent.schema.shape.data,
})

/**
 * The job that pulls one CRM sync run's Deals into the Playbook, a page at a time. It carries only
 * the run id; the cursor and counts live on the run row, so a redelivery resumes where it stopped.
 */
export const crmSyncRun = defineMessage({
  type: 'crm.sync_run',
  version: 1,
  scope: 'organization',
  payload: z.strictObject({ runId: crmSyncRunIdSchema }),
})

/** `export.requested` as a queue message; every service that has a slice of an export writes it on this. */
export const exportRequested = defineMessage({
  type: 'export.requested',
  version: 1,
  scope: 'organization',
  payload: exportRequestedEvent.schema.shape.data,
})

/** `reply.classified` as a queue message; the payload is the `data` of the contract's event. It never carries the reply text. */
export const replyClassified = defineMessage({
  type: 'reply.classified',
  version: 1,
  scope: 'organization',
  payload: replyClassifiedEvent.schema.shape.data,
})

/** `message.approved` as a queue message; the payload is the `data` of the contract's event. It never carries the text. */
export const messageApproved = defineMessage({
  type: 'message.approved',
  version: 1,
  scope: 'organization',
  payload: messageApprovedEvent.schema.shape.data,
})

/** `conversation.taken_over` as a queue message; ids and a count only, never a Message body. */
export const conversationTakenOver = defineMessage({
  type: 'conversation.taken_over',
  version: 1,
  scope: 'organization',
  payload: conversationTakenOverEvent.schema.shape.data,
})

/** `conversation.handed_back` as a queue message; ids only, never a Message body. */
export const conversationHandedBack = defineMessage({
  type: 'conversation.handed_back',
  version: 1,
  scope: 'organization',
  payload: conversationHandedBackEvent.schema.shape.data,
})

/** `booking.cancelled`: a Booking was cancelled; published by core's Booking service. */
export const bookingCancelled = defineMessage({
  type: 'booking.cancelled',
  version: 1,
  scope: 'organization',
  payload: bookingCancelledEvent.schema.shape.data,
})

/** `booking.rescheduled`: a Booking moved to another start time; published by core's Booking service. */
export const bookingRescheduled = defineMessage({
  type: 'booking.rescheduled',
  version: 1,
  scope: 'organization',
  payload: bookingRescheduledEvent.schema.shape.data,
})

/** Every message type core's queue carries. */
export type CoreDefinition =
  | typeof replyClassified
  | typeof messageApproved
  | typeof conversationTakenOver
  | typeof conversationHandedBack
  | typeof exportRequested
  | typeof prospectCreated
  | typeof prospectUpdated
  | typeof prospectErased
  | typeof prospectMerged
  | typeof prospectMergeUndone
  | typeof suppressionAdded
  | typeof suppressionRemoved
  | typeof consentGranted
  | typeof consentWithdrawn
  | typeof crmConnected
  | typeof crmDisconnected
  | typeof crmRunCompleted
  | typeof bookingCancelled
  | typeof bookingRescheduled

/** An envelope of any type core's queue carries. */
export type CoreEnvelope = EnvelopeOf<CoreDefinition>

/** Validates and builds the envelopes of {@link CoreDefinition}; shared by the queue and publishers. */
export const registry = createMessageRegistry([
  replyClassified,
  messageApproved,
  conversationTakenOver,
  conversationHandedBack,
  exportRequested,
  prospectCreated,
  prospectUpdated,
  prospectErased,
  prospectMerged,
  prospectMergeUndone,
  suppressionAdded,
  suppressionRemoved,
  consentGranted,
  consentWithdrawn,
  crmConnected,
  crmDisconnected,
  crmRunCompleted,
  bookingCancelled,
  bookingRescheduled,
])

/** The most Prospects one `prospect.assign_chunk` job carries. */
export const ASSIGN_CHUNK_SIZE = 100

/**
 * A job: give these Prospects (at most {@link ASSIGN_CHUNK_SIZE}) to one owner, for a bulk
 * assignment too large to apply while the request waits. The worker re-checks the actor and the
 * owner on current data before it writes, so the message grants nothing by itself.
 */
export const prospectAssignChunk = defineMessage({
  type: 'prospect.assign_chunk',
  version: 1,
  scope: 'organization',
  payload: z.object({
    actorUserId: userIdSchema,
    ownerMembershipId: membershipIdSchema,
    prospectIds: z.array(prospectIdSchema).min(1).max(ASSIGN_CHUNK_SIZE),
  }),
})

/**
 * A job: read the uploaded CSV of this import and apply its rows. The file is in the object store,
 * so the message carries only the import id and who uploaded it; the worker re-checks that user's
 * role on current data before it writes, so the message grants nothing by itself.
 */
export const prospectImportProcess = defineMessage({
  type: 'prospect.import_process',
  version: 1,
  scope: 'organization',
  payload: z.object({
    importId: prospectImportIdSchema,
    actorUserId: userIdSchema,
  }),
})

/**
 * A job: read the uploaded CSV of this bulk Suppression import and add its addresses. The message
 * carries only the import id and who uploaded it; the file is in the object store.
 */
export const suppressionImportProcess = defineMessage({
  type: 'suppression.import_process',
  version: 1,
  scope: 'organization',
  payload: z.object({
    importId: suppressionImportIdSchema,
    actorUserId: userIdSchema,
  }),
})

/**
 * The job that erases one Prospect: its fields, history, identities and the row, then a
 * suppression entry for each address it held. Carries ids only, never a value; a redelivery that
 * finds the Prospect gone does nothing.
 */
export const prospectErase = defineMessage({
  type: 'prospect.erase',
  version: 1,
  scope: 'organization',
  payload: z.object({
    prospectId: prospectIdSchema,
    actorUserId: userIdSchema,
  }),
})

/**
 * One step of core's own slice of an export: it writes up to a bounded number of chunks of one
 * dataset from `cursor` and either publishes the next step or finishes the part. Carries a position
 * and counters only, never a row. The object keys are fixed by the position, so a redelivered step
 * rewrites the same objects.
 */
export const exportBuildCorePart = defineMessage({
  type: 'export.build_core_part',
  version: 1,
  scope: 'organization',
  payload: z.object({
    exportId: exportJobIdSchema,
    dataset: z.string().min(1).max(40),
    cursor: z.string().max(400).nullable(),
    chunk: z.number().int().min(0),
    files: z.number().int().min(0),
    bytes: z.number().int().min(0),
  }),
})

/** `export.part_ready` as it reaches core's jobs queue from another service; the payload is the contract event's `data`. */
export const exportPartReady = defineMessage({
  type: 'export.part_ready',
  version: 1,
  scope: 'organization',
  payload: exportPartReadyEvent.schema.shape.data,
})

/** `export.part_failed` as it reaches core's jobs queue from another service; the payload is the contract event's `data`. */
export const exportPartFailed = defineMessage({
  type: 'export.part_failed',
  version: 1,
  scope: 'organization',
  payload: exportPartFailedEvent.schema.shape.data,
})

/** `message.sent` as it reaches core's jobs queue from the outbound service; the payload is the contract event's `data`. */
export const messageSent = defineMessage({
  type: 'message.sent',
  version: 1,
  scope: 'organization',
  payload: messageSentEvent.schema.shape.data,
})

/** `booking.created` as it reaches core's jobs queue; the payload is the contract event's `data`. */
export const bookingCreated = defineMessage({
  type: 'booking.created',
  version: 1,
  scope: 'organization',
  payload: bookingCreatedEvent.schema.shape.data,
})

/** `deal.outcome_changed` as it reaches core's jobs queue; the payload is the contract event's `data`. */
export const dealOutcomeChanged = defineMessage({
  type: 'deal.outcome_changed',
  version: 1,
  scope: 'organization',
  payload: dealOutcomeChangedEvent.schema.shape.data,
})

/** `call.turn_completed` as it reaches core's jobs queue from voice; the payload is the contract event's `data`. */
export const callTurnCompleted = defineMessage({
  type: 'call.turn_completed',
  version: 1,
  scope: 'organization',
  payload: callTurnCompletedEvent.schema.shape.data,
})

/** The most days one reconcile job recounts: a little over two months, so the job stays small. */
export const MAX_RECONCILE_DAYS = 62

/** Asks core to recount the last `days` UTC days of an Organization's rollups from the event ledger (the nightly reconcile). */
export const analyticsReconcile = defineMessage({
  type: 'analytics.reconcile',
  version: 1,
  scope: 'organization',
  payload: z.strictObject({ days: z.number().int().min(1).max(MAX_RECONCILE_DAYS) }),
})

/**
 * The job that labels one inbound Message. Carries the id alone, never the text; the worker reads
 * the Message under the Organization's own scope, so the job grants nothing by itself.
 */
export const inboxClassifyMessage = defineMessage({
  type: 'inbox.classify_message',
  version: 1,
  scope: 'organization',
  payload: z.object({ messageId: messageIdSchema }),
})

/**
 * Asks core to write a grounded Draft in reply to one inbound Message labelled `objection` or
 * `question`. The payload names the Message only; the job reads it under the Organization's own
 * scope, so it grants nothing by itself.
 */
export const inboxDraftReply = defineMessage({
  type: 'inbox.draft_reply',
  version: 1,
  scope: 'organization',
  payload: z.object({ messageId: messageIdSchema }),
})

/**
 * Asks core to summarize one closed or quiet Conversation and label its Outcome. The payload names
 * the Conversation only; the job reads it under the Organization's own scope, so it grants nothing
 * by itself.
 */
export const inboxSummarizeConversation = defineMessage({
  type: 'inbox.summarize_conversation',
  version: 1,
  scope: 'organization',
  payload: z.strictObject({ conversationId: conversationIdSchema }),
})

/**
 * Asks core to queue a summary job for each closed or quiet Conversation of an Organization that
 * lacks a current one, one bounded page after `after`, then to queue the sweep for the next page.
 * Published from outside (like `analytics.reconcile`); core has no scheduler.
 */
export const inboxSummarizeSweep = defineMessage({
  type: 'inbox.summarize_sweep',
  version: 1,
  scope: 'organization',
  payload: z.strictObject({ after: conversationIdSchema.optional() }),
})

/**
 * Asks core to reload one Rep's busy times from their calendar for the next 14 days. Queued when
 * the Rep connects; later runs are published from outside (core has no scheduler). The payload
 * names the Rep only: the job reads the connection under the Organization's own scope.
 */
export const calendarRefreshBusy = defineMessage({
  type: 'calendar.refresh_busy',
  version: 1,
  scope: 'organization',
  payload: z.strictObject({ membershipId: membershipIdSchema }),
})

/** Every message type core's jobs queue carries. */
export type JobDefinition =
  | typeof inboxClassifyMessage
  | typeof inboxDraftReply
  | typeof inboxSummarizeConversation
  | typeof inboxSummarizeSweep
  | typeof calendarRefreshBusy
  | typeof exportBuildCorePart
  | typeof exportPartReady
  | typeof exportPartFailed
  | typeof prospectAssignChunk
  | typeof prospectImportProcess
  | typeof suppressionImportProcess
  | typeof crmSyncRun
  | typeof prospectErase
  | typeof messageSent
  | typeof replyClassified
  | typeof bookingCreated
  | typeof dealOutcomeChanged
  | typeof callTurnCompleted
  | typeof analyticsReconcile

/** An envelope of any type core's jobs queue carries. */
export type JobEnvelope = EnvelopeOf<JobDefinition>

/** Validates and builds the envelopes of {@link JobDefinition}. */
export const jobRegistry = createMessageRegistry([
  inboxClassifyMessage,
  inboxDraftReply,
  inboxSummarizeConversation,
  inboxSummarizeSweep,
  calendarRefreshBusy,
  exportBuildCorePart,
  exportPartReady,
  exportPartFailed,
  prospectAssignChunk,
  prospectImportProcess,
  suppressionImportProcess,
  crmSyncRun,
  prospectErase,
  messageSent,
  replyClassified,
  bookingCreated,
  dealOutcomeChanged,
  callTurnCompleted,
  analyticsReconcile,
])

/** The one message type the audit queue carries. */
export type AuditDefinition = typeof auditRecordedMessage

/** An envelope of the audit queue: `audit.recorded`, as the kit's audit recorder publishes it. */
export type AuditEnvelope = AuditRecordedEnvelope

/** Validates the envelopes of the audit queue, which other services publish to and core consumes. */
export const auditRegistry = createMessageRegistry([auditRecordedMessage])
