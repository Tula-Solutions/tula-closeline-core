import { expect, test } from 'bun:test'
import {
  createUnconfiguredInvitationMailer,
  InvitationMailerNotConfigured,
} from './invitation-mailer'

test('delivery fails until a provider is configured, and the error says nothing of the message', async () => {
  const mailer = createUnconfiguredInvitationMailer()
  const token = 'T'.repeat(43)

  const failure = await mailer
    .deliver(
      {
        email: 'a@example.com',
        role: 'rep',
        organizationName: 'Acme',
        token,
        link: `https://app.test/sign-up#invitation=${token}`,
        expiresAt: new Date(),
      },
      new AbortController().signal
    )
    .then(
      () => undefined,
      (error: unknown) => error
    )

  expect(failure).toBeInstanceOf(InvitationMailerNotConfigured)
  expect(String((failure as Error).message)).not.toContain(token)
})
