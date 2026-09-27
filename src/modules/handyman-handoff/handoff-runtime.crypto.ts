import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { stableJson } from '../../shared/stable-json';
import type { HandoffAssertion } from './handoff-runtime.types';

/**
 * CR-HM-01 PART 03 — handoff runtime crypto helpers.
 *
 * Conventions reused (no new crypto invented):
 * - HMAC-SHA256 signature with `sha256=<hex>` framing and constant-time
 *   comparison (whatsapp-callback.verify convention);
 * - canonical stable-JSON fingerprinting (CR-BE-IDEMPOTENCY-CORE-01);
 * - opaque high-entropy tokens, returned once, stored only as SHA-256 hash
 *   (BE-01C session / BE-01G invitation / BE-26J secure-link convention).
 */

export const HANDOFF_EXCHANGE_TOKEN_BYTES = 32;

/** Canonical signature payload for an assertion. */
export function canonicalHandoffAssertion(assertion: HandoffAssertion): string {
  return stableJson(assertion);
}

/** 'sha256=<hmac-hex>' over the canonical assertion (BM-side / tests). */
export function signHandoffAssertion(
  assertion: HandoffAssertion,
  integrationSecret: string,
): string {
  return (
    'sha256=' +
    createHmac('sha256', integrationSecret)
      .update(canonicalHandoffAssertion(assertion))
      .digest('hex')
  );
}

/** Constant-time signature verification against the scoped secret. */
export function verifyHandoffAssertionSignature(
  assertion: HandoffAssertion,
  signatureHeader: string | undefined,
  integrationSecret: string,
): boolean {
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
    return false;
  }
  const expected = signHandoffAssertion(assertion, integrationSecret);
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signatureHeader);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

/** SHA-256 fingerprint of the canonical assertion (replay record). */
export function hashHandoffAssertion(assertion: HandoffAssertion): string {
  return createHash('sha256')
    .update(canonicalHandoffAssertion(assertion), 'utf8')
    .digest('hex');
}

export function generateHandoffExchangeToken(
  bytes: number = HANDOFF_EXCHANGE_TOKEN_BYTES,
): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashHandoffExchangeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
