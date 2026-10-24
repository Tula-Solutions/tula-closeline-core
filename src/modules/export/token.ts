import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  type ExportJobId,
  exportJobIdSchema,
  type OrganizationId,
  organizationIdSchema,
} from 'tula-closeline-contract'

/** Separates the signed fields; no id or number contains it. */
const SEPARATOR = '|'

/** The format and purpose of the signature, so a MAC made for another use never verifies here. */
const CONTEXT = 'closeline-export-download-v1'

/** The length of an HMAC-SHA256 tag, in bytes. */
const MAC_BYTES = 32

/** What a download link says: whose export, until when. It names no file and holds no secret. */
export type ExportDownloadClaims = {
  organizationId: OrganizationId
  exportId: ExportJobId
  expiresAt: Date
}

function sign(key: string, payload: Buffer): Buffer {
  return createHmac('sha256', key).update(CONTEXT).update('\0').update(payload).digest()
}

/**
 * Makes the token of an export download link: the Organization, the export and the expiry (whole
 * seconds), signed with HMAC-SHA256 under `key`, as one base64url string. The token is the link's
 * only credential, so it is never logged and never stored.
 */
export function mintExportDownloadToken(key: string, claims: ExportDownloadClaims): string {
  const payload = Buffer.from(
    [
      claims.organizationId,
      claims.exportId,
      String(Math.floor(claims.expiresAt.getTime() / 1000)),
    ].join(SEPARATOR),
    'utf8'
  )
  return Buffer.concat([payload, sign(key, payload)]).toString('base64url')
}

/**
 * The claims of a token if its signature holds, else `undefined`. The signature is compared in
 * constant time and checked before the payload is read. Expiry is not judged here.
 */
export function readExportDownloadToken(
  key: string,
  token: string
): ExportDownloadClaims | undefined {
  const raw = Buffer.from(token, 'base64url')
  if (raw.length <= MAC_BYTES) {
    return undefined
  }
  const payload = raw.subarray(0, raw.length - MAC_BYTES)
  const presented = raw.subarray(raw.length - MAC_BYTES)
  if (!timingSafeEqual(presented, sign(key, payload))) {
    return undefined
  }
  const [organizationId, exportId, expires, ...rest] = payload.toString('utf8').split(SEPARATOR)
  const org = organizationIdSchema.safeParse(organizationId)
  const job = exportJobIdSchema.safeParse(exportId)
  const seconds = Number(expires)
  if (rest.length > 0 || !org.success || !job.success || !Number.isSafeInteger(seconds)) {
    return undefined
  }
  return { organizationId: org.data, exportId: job.data, expiresAt: new Date(seconds * 1000) }
}
