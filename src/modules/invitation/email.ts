import { domainToASCII } from 'node:url'
import { emailSchema } from 'tula-closeline-contract'
import { z } from 'zod'

/** The most characters an address may have before its domain is converted (a Unicode domain can be longer than its A-label form). */
const MAX_RAW_EMAIL_LENGTH = 1000

function isPrintableAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x21 || code > 0x7e) {
      return false
    }
  }
  return true
}

/**
 * Converts the domain of an address with an internationalised domain to its ASCII (A-label,
 * `xn--`) form, which is how the database stores it. An address whose domain is already ASCII is
 * returned untouched, and so is one that cannot be converted, so the contract's schema refuses it.
 * The local part is never changed: a non-ASCII local part stays and is refused.
 */
export function toAsciiDomain(address: string): string {
  const at = address.lastIndexOf('@')
  if (at < 1) {
    return address
  }
  const domain = address.slice(at + 1)
  if (isPrintableAscii(domain)) {
    return address
  }
  const ascii = domainToASCII(domain)
  return ascii === '' ? address : `${address.slice(0, at)}@${ascii}`
}

/**
 * An email address as a request carries it: the domain is converted to ASCII, then the contract's
 * `emailSchema` folds and validates the result. Its output type is the contract's.
 */
export const requestEmailSchema = z
  .string()
  .max(MAX_RAW_EMAIL_LENGTH)
  .transform(toAsciiDomain)
  .pipe(emailSchema)
