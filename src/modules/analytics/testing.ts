import {
  type DealRecordId,
  formatId,
  type MessageId,
  type OrganizationId,
} from 'tula-closeline-contract'
import { jobRegistry } from '~/messages'
import type { AnalyticsEnvelope } from './consumer'

const id = (prefix: Parameters<typeof formatId>[0]) =>
  formatId(prefix, crypto.randomUUID().replaceAll('-', ''))

/** A `message.sent` envelope for tests, sent at `sentAt`. */
export function sentEnvelope(
  organizationId: OrganizationId,
  sentAt: string,
  over: { messageId?: MessageId; channel?: 'email' | 'linkedin' | 'chat' } = {}
): AnalyticsEnvelope {
  return jobRegistry.create({
    type: 'message.sent',
    organizationId,
    traceId: 'trace-analytics',
    payload: {
      draftId: id('drf'),
      conversationId: id('cnv'),
      messageId: over.messageId ?? id('msg'),
      prospectId: id('prs'),
      channel: over.channel ?? 'email',
      sentAt,
    },
  }) as AnalyticsEnvelope
}

/** A `reply.classified` envelope for tests. */
export function repliedEnvelope(
  organizationId: OrganizationId,
  classifiedAt: string,
  over: { messageId?: MessageId; label?: 'positive' | 'negative'; channel?: 'email' | 'chat' } = {}
): AnalyticsEnvelope {
  return jobRegistry.create({
    type: 'reply.classified',
    organizationId,
    traceId: 'trace-analytics',
    payload: {
      conversationId: id('cnv'),
      messageId: over.messageId ?? id('msg'),
      prospectId: id('prs'),
      channel: over.channel ?? 'email',
      label: over.label ?? 'positive',
      confidence: 0.9,
      classifiedAt,
    },
  }) as AnalyticsEnvelope
}

/** A `deal.outcome_changed` envelope for tests. */
export function outcomeEnvelope(
  organizationId: OrganizationId,
  changedAt: string,
  outcome: 'won' | 'lost' | 'open',
  dealRecordId: DealRecordId = id('deal') as DealRecordId
): AnalyticsEnvelope {
  return jobRegistry.create({
    type: 'deal.outcome_changed',
    organizationId,
    traceId: 'trace-analytics',
    payload: {
      dealRecordId,
      prospectId: null,
      previousOutcome: outcome === 'open' ? 'won' : 'open',
      outcome,
      changedAt,
    },
  }) as AnalyticsEnvelope
}
