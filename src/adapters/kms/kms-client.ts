import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from '@aws-sdk/client-kms'

/** A fresh AES-256 data key: the plaintext to use once and discard, and KMS's wrapped copy to store. */
export type KmsDataKey = { plaintext: Uint8Array; wrapped: Uint8Array }

/**
 * The two KMS calls the secret box makes, and no others (the IAM grant allows Encrypt, Decrypt and
 * GenerateDataKey). Every call carries an abort signal so the caller can bound it.
 */
export interface KmsClient {
  /** Asks KMS for an AES-256 data key under `keyId`, bound to `context`. */
  generateDataKey(
    input: { keyId: string; context: Record<string, string> },
    signal: AbortSignal
  ): Promise<KmsDataKey>
  /** Unwraps a data key; KMS refuses unless `context` and `keyId` match the ones that wrapped it. */
  decrypt(
    input: { keyId: string; wrapped: Uint8Array; context: Record<string, string> },
    signal: AbortSignal
  ): Promise<Uint8Array>
}

/** The part of the SDK's `KMSClient` this adapter uses; `send` takes the SDK's command objects. */
export type KmsSdkClient = {
  send(
    command: GenerateDataKeyCommand,
    options?: { abortSignal?: AbortSignal }
  ): Promise<GenerateDataKeyCommandOutput>
  send(
    command: DecryptCommand,
    options?: { abortSignal?: AbortSignal }
  ): Promise<DecryptCommandOutput>
}

/** Adapts the AWS SDK's client to {@link KmsClient}. The SDK's own retries are off; the box retries. */
export function createSdkKmsClient(sdk: KmsSdkClient): KmsClient {
  return {
    async generateDataKey({ keyId, context }, signal) {
      const out = await sdk.send(
        new GenerateDataKeyCommand({
          KeyId: keyId,
          KeySpec: 'AES_256',
          EncryptionContext: context,
        }),
        { abortSignal: signal }
      )
      if (!out.Plaintext || !out.CiphertextBlob) {
        throw new Error('KMS returned no data key')
      }
      return { plaintext: out.Plaintext, wrapped: out.CiphertextBlob }
    },
    async decrypt({ keyId, wrapped, context }, signal) {
      const out = await sdk.send(
        new DecryptCommand({ KeyId: keyId, CiphertextBlob: wrapped, EncryptionContext: context }),
        { abortSignal: signal }
      )
      if (!out.Plaintext) {
        throw new Error('KMS returned no plaintext')
      }
      return out.Plaintext
    },
  }
}
