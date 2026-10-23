import {
  membershipIdSchema,
  prospectCreatedEvent,
  prospectIdSchema,
  prospectUpdatedEvent,
  suppressionAddedEvent,
  suppressionRemovedEvent,
  userIdSchema,
} from 'tula-closeline-contract'
import { createMessageRegistry, defineMessage, type EnvelopeOf } from 'tula-closeline-kit'
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

/** Every message type core's queue carries. */
export type CoreDefinition =
  | typeof prospectCreated
  | typeof prospectUpdated
  | typeof suppressionAdded
  | typeof suppressionRemoved

/** An envelope of any type core's queue carries. */
export type CoreEnvelope = EnvelopeOf<CoreDefinition>

/** Validates and builds the envelopes of {@link CoreDefinition}; shared by the queue and publishers. */
export const registry = createMessageRegistry([
  prospectCreated,
  prospectUpdated,
  suppressionAdded,
  suppressionRemoved,
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

/** Every message type core's jobs queue carries. */
export type JobDefinition = typeof prospectAssignChunk

/** An envelope of any type core's jobs queue carries. */
export type JobEnvelope = EnvelopeOf<JobDefinition>

/** Validates and builds the envelopes of {@link JobDefinition}. */
export const jobRegistry = createMessageRegistry([prospectAssignChunk])
