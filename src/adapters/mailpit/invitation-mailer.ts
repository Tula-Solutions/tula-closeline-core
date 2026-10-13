import { lookup as resolve } from 'node:dns'
import { request } from 'node:http'
import { isIPv4, type LookupFunction } from 'node:net'
import type { Logger } from 'tula-closeline-kit'
import type { InvitationMailer, InvitationMessage } from '~/ports/invitation-mailer'
import { renderInvitationEmail } from './invitation-email'

/** The most one attempt to hand a message to the local mailbox may take. */
export const MAIL_ATTEMPT_TIMEOUT_MS = 2_000

/** How many times a message is handed over at most: the first try and two retries. */
export const MAIL_MAX_ATTEMPTS = 3

/** The longest pause before a retry, in ms; the pause is 50 ms plus up to this less 50. */
export const MAIL_RETRY_DELAY_MAX_MS = 150

/** The sender address of a local deployment: under the reserved `.test` domain (RFC 6761). */
export const DEFAULT_LOCAL_MAIL_FROM = 'no-reply@closeline.test'

/** The pause before a retry: 50 to 150 ms, so instances do not retry in step. */
function defaultRetryDelayMs(): number {
  return 50 + Math.random() * (MAIL_RETRY_DELAY_MAX_MS - 50)
}

/**
 * The bound of one attempt that lets every attempt and pause fit inside `totalMs`, the caller's
 * whole delivery time (`INVITATION_DELIVERY_TIMEOUT_MS`): the total less the longest pauses, shared
 * between the attempts, never above {@link MAIL_ATTEMPT_TIMEOUT_MS} and at least 1 ms. So the
 * attempts times this bound plus the pauses is at most `totalMs` (for any `totalMs` of 303 ms or
 * more), and the caller's own abort covers what is left.
 */
export function attemptTimeoutFor(totalMs: number): number {
  const share = Math.floor(
    (totalMs - (MAIL_MAX_ATTEMPTS - 1) * MAIL_RETRY_DELAY_MAX_MS) / MAIL_MAX_ATTEMPTS
  )
  return Math.max(1, Math.min(MAIL_ATTEMPT_TIMEOUT_MS, share))
}

/**
 * Thrown when the local mailbox did not take a message. The text holds only an HTTP status or a
 * kind of failure and the attempt count, never an address, a subject, a link, a token or a body.
 */
export class MailDeliveryFailed extends Error {
  constructor(reason: string, attempts: number) {
    super(`local mail delivery failed (${reason}, ${attempts} attempt${attempts === 1 ? '' : 's'})`)
    this.name = 'MailDeliveryFailed'
  }
}

/** Options for {@link createMailpitInvitationMailer}. */
export type MailpitInvitationMailerOptions = {
  /** The mailbox's origin, such as `http://127.0.0.1:8025`. */
  baseUrl: string
  /** The `From` address of every message. */
  from: string
  /** Where a retry is noted. It receives a status or a failure kind and an attempt number only. */
  logger?: Pick<Logger, 'warn'>
  /**
   * Resolves the mailbox's host name; defaults to the system resolver. Every address it returns
   * must be loopback or the send fails. Injected for tests.
   */
  lookup?: LookupFunction
  /** One attempt's bound; defaults to {@link MAIL_ATTEMPT_TIMEOUT_MS}. See {@link attemptTimeoutFor}. */
  timeoutMs?: number
  /** How long to pause before a retry; defaults to a jittered 50 to 150 ms. */
  retryDelayMs?: () => number
}

/** Whether `address` is in `127.0.0.0/8` or is `::1`. */
function isLoopback(address: string): boolean {
  return (isIPv4(address) && address.startsWith('127.')) || address === '::1'
}

/**
 * Wraps a resolver so that any answer outside loopback is refused: a hosts-file or resolver answer
 * for `localhost` that points elsewhere must not receive the message. `refused` is called when
 * that happens, so the attempt can tell it from a network error and not retry it.
 */
function loopbackOnly(inner: LookupFunction, refused: () => void): LookupFunction {
  return (hostname, options, callback) => {
    inner(hostname, options, (error, address, family) => {
      if (error) {
        callback(error, address, family)
        return
      }
      const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address]
      if (addresses.length === 0 || !addresses.every(isLoopback)) {
        refused()
        // Fixed text: the address that came back is not repeated.
        callback(new Error('the host name did not resolve to a loopback address'), '', 4)
        return
      }
      callback(null, address, family)
    })
  }
}

/**
 * One POST to a loopback origin, answered with the status line alone. It deliberately does not use
 * `fetch`: Bun's `fetch` sends a request to `HTTP_PROXY` (and its relatives) unless `NO_PROXY`
 * names the host, which would hand the Invitation link and the address to the proxy. `node:http`
 * connects to the host and port it is given. A redirect is never followed, and the body of the
 * answer is never read (it can echo the message): the connection is destroyed instead, which also
 * bounds it. `signal` covers connecting, sending and waiting for the answer. `lookup` pins the
 * connection to a loopback address (a literal address is never looked up).
 */
function post(
  target: { host: string; port: number; path: string },
  body: string,
  signal: AbortSignal,
  lookup: LookupFunction
): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: target.host,
        port: target.port,
        path: target.path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        agent: false,
        lookup,
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0
        response.destroy()
        resolve(status)
      }
    )
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}

/** Waits `ms`, or less when `signal` aborts first; resolves either way. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}

/** How one attempt ended, and whether another attempt could help. */
type Outcome = { ok: true } | { ok: false; reason: string; retryable: boolean }

/**
 * An Invitation mailer for local development: renders the Invitation email and hands it to a
 * Mailpit mailbox over its HTTP send API (`POST /api/v1/send`, a JSON body of `From`, `To`,
 * `Subject`, `Text` and `HTML`). The mailbox catches mail and never delivers it, so nothing leaves
 * the machine.
 *
 * Each attempt has a timeout. A network error, a timeout or a 5xx is retried up to
 * {@link MAIL_MAX_ATTEMPTS} attempts in all, after a jittered pause; a 4xx or a redirect is not
 * (the mailbox refused the message, so asking again cannot help). The caller's `signal` (the
 * route's `INVITATION_DELIVERY_TIMEOUT_MS`) also ends an attempt and a pause, and nothing is tried
 * after it aborts, so a send never outlives the time the route gave it. A failure rejects with
 * {@link MailDeliveryFailed}. No log line or error made here contains the message or any part of
 * it, nor the mailbox's answer.
 */
export function createMailpitInvitationMailer(
  options: MailpitInvitationMailerOptions
): InvitationMailer {
  const origin = new URL(options.baseUrl)
  const target = {
    // A URL keeps the brackets of an IPv6 host; a socket address does not.
    host: origin.hostname.replace(/^\[|\]$/g, ''),
    port: origin.port === '' ? 80 : Number(origin.port),
    path: '/api/v1/send',
  }
  const resolver = options.lookup ?? resolve
  const timeoutMs = options.timeoutMs ?? MAIL_ATTEMPT_TIMEOUT_MS
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs

  /** One try at handing the message over, bounded by its own timeout and by the caller's signal. */
  const attempt = async (body: string, caller: AbortSignal): Promise<Outcome> => {
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), caller])
    let outsideLoopback = false
    try {
      const status = await post(
        target,
        body,
        signal,
        loopbackOnly(resolver, () => {
          outsideLoopback = true
        })
      )
      if (status >= 200 && status < 300) {
        return { ok: true }
      }
      return { ok: false, reason: `HTTP ${status}`, retryable: status >= 500 }
    } catch (error) {
      // Final: asking again would get the same answer from the same resolver.
      if (outsideLoopback) {
        return { ok: false, reason: 'host name not on loopback', retryable: false }
      }
      // Final: the caller's time is spent, so there is no time for another try.
      if (caller.aborted) {
        return { ok: false, reason: 'deadline', retryable: false }
      }
      if (signal.aborted) {
        return { ok: false, reason: 'timeout', retryable: true }
      }
      // The name only: a network error's message can quote what it tried to reach.
      return {
        ok: false,
        reason: `network error ${error instanceof Error ? error.name : 'unknown'}`,
        retryable: true,
      }
    }
  }

  return {
    async deliver(message: InvitationMessage, signal: AbortSignal): Promise<void> {
      const email = renderInvitationEmail(message)
      const body = JSON.stringify({
        From: { Email: options.from },
        To: [{ Email: message.email }],
        Subject: email.subject,
        Text: email.text,
        HTML: email.html,
      })
      for (let tries = 1; ; tries += 1) {
        const outcome = await attempt(body, signal)
        if (outcome.ok) {
          return
        }
        if (!outcome.retryable || tries >= MAIL_MAX_ATTEMPTS) {
          throw new MailDeliveryFailed(outcome.reason, tries)
        }
        options.logger?.warn('local mail delivery failed, retrying', {
          reason: outcome.reason,
          attempt: tries,
        })
        await pause(retryDelayMs(), signal)
        if (signal.aborted) {
          throw new MailDeliveryFailed('deadline', tries)
        }
      }
    },
  }
}
