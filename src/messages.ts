import {
  bookingCreatedEvent,
  consentGrantedEvent,
  consentWithdrawnEvent,
  crmConnectedEvent,
  crmDisconnectedEvent,
  dealOutcomeChangedEvent,
  exportJobIdSchema,
  exportPartFailedEvent,
  exportPartReadyEvent,
  exportRequestedEvent,
  membershipIdSchema,
  messageSentEvent,
  prospectCreatedEvent,
  prospectErasedEvent,
  prospectIdSchema,
  prospectImportIdSchema,
  prospectUpdatedEvent,
  replyClassifiedEvent,
  suppressionAddedEvent,
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

/** `export.requested` as a queue message; every service that has a slice of an export writes it on this. */
export const exportRequested = defineMessage({
  type: 'export.requested',
  version: 1,
  scope: 'organization',
  payload: exportRequestedEvent.schema.shape.data,
})

/** Every message type core's queue carries. */
export type CoreDefinition =
  | typeof exportRequested
  | typeof prospectCreated
  | typeof prospectUpdated
  | typeof prospectErased
  | typeof suppressionAdded
  | typeof suppressionRemoved
  | typeof consentGranted
  | typeof consentWithdrawn
  | typeof crmConnected
  | typeof crmDisconnected

/** An envelope of any type core's queue carries. */
export type CoreEnvelope = EnvelopeOf<CoreDefinition>

/** Validates and builds the envelopes of {@link CoreDefinition}; shared by the queue and publishers. */
export const registry = createMessageRegistry([
  exportRequested,
  prospectCreated,
  prospectUpdated,
  prospectErased,
  suppressionAdded,
  suppressionRemoved,
  consentGranted,
  consentWithdrawn,
  crmConnected,
  crmDisconnected,
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

/** `reply.classified` as it reaches core's jobs queue; the payload is the contract event's `data`. */
export const replyClassified = defineMessage({
  type: 'reply.classified',
  version: 1,
  scope: 'organization',
  payload: replyClassifiedEvent.schema.shape.data,
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

/** The most days one reconcile job recounts: a little over two months, so the job stays small. */
export const MAX_RECONCILE_DAYS = 62

/** Asks core to recount the last `days` UTC days of an Organization's rollups from the event ledger (the nightly reconcile). */
export const analyticsReconcile = defineMessage({
  type: 'analytics.reconcile',
  version: 1,
  scope: 'organization',
  payload: z.strictObject({ days: z.number().int().min(1).max(MAX_RECONCILE_DAYS) }),
})

/** Every message type core's jobs queue carries. */
export type JobDefinition =
  | typeof exportBuildCorePart
  | typeof exportPartReady
  | typeof exportPartFailed
  | typeof prospectAssignChunk
  | typeof prospectImportProcess
  | typeof prospectErase
  | typeof messageSent
  | typeof replyClassified
  | typeof bookingCreated
  | typeof dealOutcomeChanged
  | typeof analyticsReconcile

/** An envelope of any type core's jobs queue carries. */
export type JobEnvelope = EnvelopeOf<JobDefinition>

/** Validates and builds the envelopes of {@link JobDefinition}. */
export const jobRegistry = createMessageRegistry([
  exportBuildCorePart,
  exportPartReady,
  exportPartFailed,
  prospectAssignChunk,
  prospectImportProcess,
  prospectErase,
  messageSent,
  replyClassified,
  bookingCreated,
  dealOutcomeChanged,
  analyticsReconcile,
])

/** The one message type the audit queue carries. */
export type AuditDefinition = typeof auditRecordedMessage

/** An envelope of the audit queue: `audit.recorded`, as the kit's audit recorder publishes it. */
export type AuditEnvelope = AuditRecordedEnvelope

/** Validates the envelopes of the audit queue, which other services publish to and core consumes. */
export const auditRegistry = createMessageRegistry([auditRecordedMessage])
