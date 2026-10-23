import { prospectCreatedEvent, prospectUpdatedEvent } from 'tula-closeline-contract'
import { createMessageRegistry, defineMessage, type EnvelopeOf } from 'tula-closeline-kit'

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

/** Every message type core's queue carries. */
export type CoreDefinition = typeof prospectCreated | typeof prospectUpdated

/** An envelope of any type core's queue carries. */
export type CoreEnvelope = EnvelopeOf<CoreDefinition>

/** Validates and builds the envelopes of {@link CoreDefinition}; shared by the queue and publishers. */
export const registry = createMessageRegistry([prospectCreated, prospectUpdated])
