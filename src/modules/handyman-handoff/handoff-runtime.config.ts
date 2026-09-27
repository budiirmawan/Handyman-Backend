/**
 * CR-HM-01 PART 03 — handoff runtime configuration (secret boundary).
 *
 * Per frozen D1, credential/key material is scoped per BM integration and
 * must never be stored or logged in plaintext. Following the existing
 * whatsapp-callback secret-boundary convention, secret material lives ONLY
 * in environment configuration, looked up per integration code:
 *
 *   HANDYMAN_HANDOFF_SECRET_<NORMALIZED_INTEGRATION_CODE>
 *
 * (upper-cased, non-alphanumerics folded to '_'). The secret value is used
 * exclusively as an HMAC key inside this module; error messages and logs
 * may name the integration code but never the secret.
 */

export const HANDYMAN_HANDOFF_ASSERTION_CLOCK_SKEW_SECONDS = 60;
export const HANDYMAN_HANDOFF_ASSERTION_DEFAULT_MAX_AGE_SECONDS = 300;
export const HANDYMAN_HANDOFF_EXCHANGE_DEFAULT_TTL_SECONDS = 120;

export function handoffIntegrationSecretEnvName(
  integrationCode: string,
): string {
  const normalized = integrationCode.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `HANDYMAN_HANDOFF_SECRET_${normalized}`;
}

export type HandoffRuntimeConfig = {
  assertionMaxAgeSeconds: number;
  clockSkewSeconds: number;
  exchangeTtlSeconds: number;
};

function readPositiveInt(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function readHandoffRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): HandoffRuntimeConfig {
  return {
    assertionMaxAgeSeconds: readPositiveInt(
      env.HANDYMAN_HANDOFF_ASSERTION_MAX_AGE_SECONDS,
      HANDYMAN_HANDOFF_ASSERTION_DEFAULT_MAX_AGE_SECONDS,
    ),
    clockSkewSeconds: HANDYMAN_HANDOFF_ASSERTION_CLOCK_SKEW_SECONDS,
    exchangeTtlSeconds: readPositiveInt(
      env.HANDYMAN_HANDOFF_EXCHANGE_TTL_SECONDS,
      HANDYMAN_HANDOFF_EXCHANGE_DEFAULT_TTL_SECONDS,
    ),
  };
}

/** Returns the scoped HMAC secret for an integration, or null when unset. */
export function readHandoffIntegrationSecret(
  integrationCode: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env[handoffIntegrationSecretEnvName(integrationCode)];
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}
