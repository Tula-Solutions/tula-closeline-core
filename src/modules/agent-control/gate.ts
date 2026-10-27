import type { InboxChannel } from 'tula-closeline-contract'
import type { OrganizationScope } from '~/ports/core-store'
import { isInsideSendWindow } from './window'

/** Why an Agent's Draft may not go out right now, or `open` when it may. */
export type ReleaseGate = 'open' | 'paused' | 'outside_window'

/** True when the Organization's Agents are paused. One primary-key read. */
export async function isPaused(
  scope: Pick<OrganizationScope, 'getAgentsPaused'>
): Promise<boolean> {
  return (await scope.getAgentsPaused())?.paused === true
}

/**
 * Whether the Inbound Agent may release a reply on an inbox channel at `now`: not while the
 * Organization is paused, and only inside the send window of the channel (its own row, else the
 * kind's default; with neither, always). Two or three primary-key reads, whatever the Organization's size.
 */
export async function releaseGate(
  scope: Pick<OrganizationScope, 'getAgentsPaused' | 'getAgentSetting'>,
  channel: InboxChannel,
  now: Date
): Promise<ReleaseGate> {
  if (await isPaused(scope)) {
    return 'paused'
  }
  const own = channel === 'chat' ? null : await scope.getAgentSetting('inbound', channel)
  const setting = own ?? (await scope.getAgentSetting('inbound', 'default'))
  if (setting && !isInsideSendWindow(setting.sendWindow, now)) {
    return 'outside_window'
  }
  return 'open'
}
