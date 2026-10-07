import { randomBytes } from 'node:crypto';

/**
 * CR-BE-INTEG-01 PART 02 — signing secret generation.
 *
 * Secrets are SERVER-GENERATED ONLY (never client-supplied): 32 random bytes,
 * base64url-encoded, `whsec_`-prefixed (governance §3.2). The raw value is
 * returned exactly once — on the create response and on the rotate response —
 * and is otherwise only ever used as an HMAC key by the PART 04 signer. One-way
 * hashing is not applicable (HMAC needs the raw key), so the read boundary is
 * the projection discipline in the repository instead.
 */
export const INTEGRATION_WEBHOOK_SECRET_PREFIX = 'whsec_';

export function generateIntegrationWebhookSigningSecret(): string {
  return `${INTEGRATION_WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}
