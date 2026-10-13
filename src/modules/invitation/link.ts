/** The portal page that takes an invitation, relative to the portal's base URL. */
export const SIGN_UP_PATH = '/sign-up'

/** The fragment key that carries the raw token. */
export const TOKEN_FRAGMENT_KEY = 'invitation'

/**
 * The link an invitee follows: `<portal base URL>/sign-up#invitation=<raw token>`. The token is in
 * the fragment, which a browser never sends to a server, so it reaches no access log; it is never
 * in the path or the query. The link is as secret as the token. `base` is `PORTAL_BASE_URL`, which
 * the environment guarantees has no query or fragment; a trailing slash is ignored.
 */
export function invitationLink(base: string, token: string): string {
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${SIGN_UP_PATH}`
  url.search = ''
  url.hash = `${TOKEN_FRAGMENT_KEY}=${encodeURIComponent(token)}`
  return url.toString()
}
