import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * CR-BE-NOTIFY-PROV-01 PART 07 — Meta webhook verification.
 *
 * Two mechanisms, both credential-checked with constant-time comparison:
 *   1. GET subscription handshake — `hub.mode=subscribe` and a matching
 *      `hub.verify_token` echo `hub.challenge`,
 *   2. POST payload signature — HMAC-SHA256 of the RAW request body with
 *      the Meta app secret, compared against `X-Hub-Signature-256`.
 */

/**
 * Verifies the `X-Hub-Signature-256` header against the raw body.
 * The raw body (exact bytes received) MUST be used — re-serializing parsed
 * JSON changes key order/whitespace and breaks the digest.
 */
export function verifyMetaWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
    return false;
  }
  const expected =
    'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signatureHeader);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

/** Verifies Meta's GET subscription handshake query. */
export function verifyMetaWebhookHandshake(
  query: Record<string, unknown>,
  verifyToken: string,
): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode !== 'subscribe') {
    return null;
  }
  if (typeof token !== 'string' || token.length !== verifyToken.length) {
    return null;
  }
  if (!timingSafeEqual(Buffer.from(token), Buffer.from(verifyToken))) {
    return null;
  }
  if (typeof challenge !== 'string' || challenge.length === 0) {
    return null;
  }
  return challenge;
}
