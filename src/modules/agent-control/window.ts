import { type AgentSendWindow, WEEKDAYS } from 'tula-closeline-contract'

/** True when the zone is one the runtime's time zone database knows. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/** The weekday and `HH:MM` the instant `at` has in `timeZone`. */
function localTimeIn(timeZone: string, at: Date): { day: (typeof WEEKDAYS)[number]; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  const day = get('weekday').slice(0, 3).toLowerCase()
  const known = WEEKDAYS.find((d) => d === day)
  return { day: known ?? 'mon', time: `${get('hour').padStart(2, '0')}:${get('minute')}` }
}

/**
 * True when `at` falls inside one of the window's working windows in the window's own time zone.
 * A window opens at its start and closes at its end; a day that is absent has no window.
 */
export function isInsideSendWindow(window: AgentSendWindow, at: Date): boolean {
  const { day, time } = localTimeIn(window.timeZone, at)
  const today = window.days.find((d) => d.day === day)
  return today?.windows.some((w) => w.start <= time && time < w.end) ?? false
}
