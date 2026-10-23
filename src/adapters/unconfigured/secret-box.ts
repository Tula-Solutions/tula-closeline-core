import type { SecretBox } from '~/ports/secret-box'

/** Thrown by the secret box of a deployment with no key service configured. */
export class SecretBoxNotConfigured extends Error {
  constructor() {
    super('no key service is configured')
    this.name = 'SecretBoxNotConfigured'
  }
}

/**
 * A secret box that refuses to seal or open; the runtime default outside local until the AWS KMS
 * adapter (owed by infra) is wired in. Disconnecting still works, since it only deletes.
 */
export function createUnconfiguredSecretBox(): SecretBox {
  return {
    async seal() {
      throw new SecretBoxNotConfigured()
    },
    async open() {
      throw new SecretBoxNotConfigured()
    },
  }
}
