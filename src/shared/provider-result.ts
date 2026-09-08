/**
 * CR-BE-NOTIFY-PROV-01 PART 01 — Provider result taxonomy.
 *
 * The shared classification of outbound provider send results, defined by the
 * START GOVERNANCE §3.3. Channel adapters (`EmailAdapter`, `WhatsAppAdapter`)
 * keep their existing `SENT | FAILED` result shape — extended additively with
 * a `retryable` hint — and this taxonomy normalizes any adapter result into
 * one of four outcomes that the future delivery lifecycle (PART 02+) reasons
 * about:
 *
 *   ACCEPTED             — the provider accepted the message (→ ledger SENT),
 *   REJECTED_RETRYABLE   — transient failure; a later attempt may succeed,
 *   REJECTED_PERMANENT   — validation/policy failure; retrying cannot help,
 *   ERROR_UNKNOWN        — the adapter threw or returned an unclassifiable
 *                          result; treated as retryable until attempts are
 *                          exhausted (assigned by the orchestration layer,
 *                          never produced by `classifyProviderResult`).
 *
 * Pure foundation: no persistence, no provider contact, no credentials.
 */

export const DELIVERY_PROVIDER_OUTCOMES = [
  'ACCEPTED',
  'REJECTED_RETRYABLE',
  'REJECTED_PERMANENT',
  'ERROR_UNKNOWN',
] as const;

export type DeliveryProviderOutcome = (typeof DELIVERY_PROVIDER_OUTCOMES)[number];

export function isDeliveryProviderOutcome(value: unknown): value is DeliveryProviderOutcome {
  return (
    typeof value === 'string' &&
    (DELIVERY_PROVIDER_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * The minimal shared shape of the channel adapter results this taxonomy
 * classifies (a structural subset of `EmailSendResult` / `WhatsAppSendResult`).
 */
export type ClassifiableProviderResult = {
  status: 'SENT' | 'FAILED';
  /** Adapter's classification hint for a FAILED outcome (conservative: absent = not retryable). */
  retryable?: boolean;
};

/**
 * Normalizes an adapter send result into a provider outcome.
 *
 * `SENT` → `ACCEPTED`. A `FAILED` result is `REJECTED_RETRYABLE` only when
 * the adapter explicitly says so (`retryable: true`); every other failure —
 * including the conservative default — is `REJECTED_PERMANENT`.
 * `ERROR_UNKNOWN` is never returned here: it is the orchestration layer's
 * classification for adapter throws / unclassifiable results.
 */
export function classifyProviderResult(
  result: ClassifiableProviderResult,
): DeliveryProviderOutcome {
  if (result.status === 'SENT') {
    return 'ACCEPTED';
  }
  return result.retryable === true ? 'REJECTED_RETRYABLE' : 'REJECTED_PERMANENT';
}

/**
 * Whether a provider outcome permits another delivery attempt. `ERROR_UNKNOWN`
 * is retryable by governance decision (§3.3) until attempts are exhausted.
 */
export function isRetryableProviderOutcome(outcome: DeliveryProviderOutcome): boolean {
  return outcome === 'REJECTED_RETRYABLE' || outcome === 'ERROR_UNKNOWN';
}
