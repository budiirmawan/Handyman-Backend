import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * CR-BE-INTEG-01 PART 04 — outbound webhook HMAC signature (governance §5).
 *
 * Symmetric HMAC-SHA256 over the canonical, byte-exact signing input
 * (`node:crypto` — the whatsapp-callback precedent; no new scheme, no PKI):
 *
 *   signed_payload = "<timestamp_unix_seconds>" + "." + "<delivery_id>"
 *                    + "." + <raw_request_body_bytes>
 *   signature      = hex( HMAC_SHA256( endpoint.signing_secret, signed_payload ) )
 *
 * The body bytes are the outbox `payload` TEXT VERBATIM (serialized once at
 * enqueue — §2.1), so they are identical across attempts and endpoints; only
 * the timestamp varies per attempt, which is what makes receiver-side replay
 * detection possible. The scheme is versioned Stripe-style: the header value
 * is `v1=<hex digest>`.
 */

export const INTEGRATION_WEBHOOK_SIGNATURE_VERSION = 'v1';
export const INTEGRATION_WEBHOOK_USER_AGENT = 'Asentra-Webhook/1';

/** Outbound header names (governance §5). */
export const INTEGRATION_WEBHOOK_HEADERS = {
  SIGNATURE: 'X-Asentra-Signature',
  TIMESTAMP: 'X-Asentra-Timestamp',
  DELIVERY_ID: 'X-Asentra-Delivery-Id',
  EVENT_ID: 'X-Asentra-Event-Id',
  EVENT_TYPE: 'X-Asentra-Event-Type',
} as const;

/** Receiver-side timestamp tolerance documented for replay protection. */
export const INTEGRATION_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export type IntegrationWebhookSignatureInput = {
  /** The endpoint's signing secret (used as HMAC key only — never logged). */
  secret: string;
  /** Unix seconds at send time. */
  timestamp: number;
  /** Delivery id — the receiver-facing idempotency key. */
  deliveryId: string;
  /** The EXACT request body bytes (the stored outbox payload TEXT verbatim). */
  payload: string;
};

/** The canonical `.`-joined signing input string. */
export function buildIntegrationWebhookSignedPayload(
  input: Pick<IntegrationWebhookSignatureInput, 'timestamp' | 'deliveryId' | 'payload'>,
): string {
  return `${input.timestamp}.${input.deliveryId}.${input.payload}`;
}

/** Hex HMAC-SHA256 digest of the canonical signing input. */
export function computeIntegrationWebhookSignature(
  input: IntegrationWebhookSignatureInput,
): string {
  return createHmac('sha256', input.secret)
    .update(buildIntegrationWebhookSignedPayload(input))
    .digest('hex');
}

/** The versioned `X-Asentra-Signature` header value. */
export function buildIntegrationWebhookSignatureHeader(
  input: IntegrationWebhookSignatureInput,
): string {
  return `${INTEGRATION_WEBHOOK_SIGNATURE_VERSION}=${computeIntegrationWebhookSignature(input)}`;
}

/**
 * Constant-time verification of a received `v1=<hex>` header (the documented
 * receiver recipe; also keeps our own tests honest).
 */
export function verifyIntegrationWebhookSignature(
  input: IntegrationWebhookSignatureInput,
  signatureHeader: string | undefined,
): boolean {
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
    return false;
  }
  const expected = Buffer.from(buildIntegrationWebhookSignatureHeader(input));
  const received = Buffer.from(signatureHeader);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export type IntegrationWebhookHeaderInput = {
  timestamp: number;
  deliveryId: string;
  /** The authoritative operational event id (also the payload `id`). */
  eventId: string;
  eventType: string;
  /** The precomputed `v1=<hex>` signature header value. */
  signatureHeader: string;
};

/**
 * The full outbound header set (governance §5). Never contains
 * `Authorization` values, secrets, or internal hostnames.
 */
export function buildIntegrationWebhookRequestHeaders(
  input: IntegrationWebhookHeaderInput,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'User-Agent': INTEGRATION_WEBHOOK_USER_AGENT,
    [INTEGRATION_WEBHOOK_HEADERS.TIMESTAMP]: String(input.timestamp),
    [INTEGRATION_WEBHOOK_HEADERS.DELIVERY_ID]: input.deliveryId,
    [INTEGRATION_WEBHOOK_HEADERS.EVENT_ID]: input.eventId,
    [INTEGRATION_WEBHOOK_HEADERS.EVENT_TYPE]: input.eventType,
    [INTEGRATION_WEBHOOK_HEADERS.SIGNATURE]: input.signatureHeader,
  };
}
