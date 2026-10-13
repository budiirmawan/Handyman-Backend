import { createHmac, timingSafeEqual } from 'node:crypto';
import { stableJson } from '../../shared/stable-json';

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D-2 — BM-signed tenant slot-choice assertion.
 *
 * Pure, dependency-free contract helpers (no DB, no clock side effects beyond
 * the explicit `nowMs` argument). The BM Backend signs an assertion that its
 * own authenticated tenant session selected an exact slot for an exact visit
 * version. Handyman verifies it here before any state change.
 *
 * Trust model (mirrors frozen D1 for handoff, with a SEPARATE purpose):
 * - issuer `iss` = the BM integration code; the HMAC secret is scoped to that
 *   integration AND to this purpose (`HANDYMAN_VISIT_SLOT_SECRET_<CODE>`), so a
 *   handoff-scoped secret can never validate a slot-choice assertion;
 * - audience `aud` = `handyman-backend`; purpose `purpose` = TENANT_SLOT_CHOICE;
 * - HMAC-SHA256 over `stableJson(assertion)` with constant-time comparison;
 * - freshness: exp > now, exp > iat, exp - iat <= 300s, iat <= now + 60s.
 *
 * What this does NOT prove: that a human tenant clicked. That fact is BM's
 * authority. Handyman records BM's evidence id as provenance and never invents
 * one. `tenantUserReference` is opaque provenance and grants no authority.
 */

export const TENANT_SLOT_AUDIENCE = 'handyman-backend';
export const TENANT_SLOT_PURPOSE = 'TENANT_SLOT_CHOICE';
export const TENANT_SLOT_METHOD = 'BM_AUTHENTICATED_TENANT_SELECTION';
export const TENANT_SLOT_MAX_AGE_SECONDS = 300;
export const TENANT_SLOT_CLOCK_SKEW_SECONDS = 60;
export const TENANT_SLOT_SIGNATURE_HEADER = 'x-handyman-tenant-slot-signature';

export type TenantSlotChoiceAssertion = {
  iss: string;
  aud: typeof TENANT_SLOT_AUDIENCE;
  purpose: typeof TENANT_SLOT_PURPOSE;
  jti: string;
  iat: string;
  exp: string;
  handymanRequestId: string;
  appointmentId: string;
  appointmentVersion: number;
  kind: 'INSPECTION' | 'EXECUTION';
  tenantCompanyId: string;
  buildingId: string;
  tenantPicId: string;
  tenantUserReference: string;
  selectedStartAt: string;
  selectedEndAt: string;
  bmConsentEvidenceId: string;
  method: typeof TENANT_SLOT_METHOD;
};

const FIELDS: readonly string[] = [
  'iss', 'aud', 'purpose', 'jti', 'iat', 'exp', 'handymanRequestId', 'appointmentId',
  'appointmentVersion', 'kind', 'tenantCompanyId', 'buildingId', 'tenantPicId',
  'tenantUserReference', 'selectedStartAt', 'selectedEndAt', 'bmConsentEvidenceId', 'method',
];
// Lowercase canonical UUIDs only: the signature covers the exact wire form, so no normalisation.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OFFSET_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/;

function bounded(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}

function instant(value: unknown): number | null {
  if (typeof value !== 'string' || !OFFSET_TIME.test(value)) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : null;
}

/**
 * Strict, closed-set structural parse of untrusted input. Unknown members,
 * wrong types, non-offset timestamps or malformed identifiers return null.
 * Callers collapse null into one non-enumerating 401.
 */
export function parseTenantSlotChoiceAssertion(value: unknown): TenantSlotChoiceAssertion | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !FIELDS.includes(key))) return null;
  if (FIELDS.some(key => !(key in record))) return null;
  if (record.aud !== TENANT_SLOT_AUDIENCE || record.purpose !== TENANT_SLOT_PURPOSE ||
      record.method !== TENANT_SLOT_METHOD) return null;
  if (record.kind !== 'INSPECTION' && record.kind !== 'EXECUTION') return null;
  if (!Number.isSafeInteger(record.appointmentVersion) || (record.appointmentVersion as number) < 1) return null;
  for (const key of ['handymanRequestId', 'appointmentId', 'tenantCompanyId', 'buildingId', 'tenantPicId']) {
    if (typeof record[key] !== 'string' || !UUID.test(record[key] as string)) return null;
  }
  if (!bounded(record.iss, 1, 64) || !bounded(record.jti, 16, 128) ||
      !bounded(record.tenantUserReference, 1, 128) || !bounded(record.bmConsentEvidenceId, 1, 128)) return null;
  if (instant(record.iat) === null || instant(record.exp) === null ||
      instant(record.selectedStartAt) === null || instant(record.selectedEndAt) === null) return null;
  if ((instant(record.selectedEndAt) as number) <= (instant(record.selectedStartAt) as number)) return null;
  return record as unknown as TenantSlotChoiceAssertion;
}

/** Scoped secret name: one secret per BM integration AND per purpose. */
export function tenantSlotSecretEnvName(integrationCode: string): string {
  return `HANDYMAN_VISIT_SLOT_SECRET_${integrationCode.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export function readTenantSlotSecret(
  integrationCode: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env[tenantSlotSecretEnvName(integrationCode)];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 'sha256=<hmac-hex>' over the canonical assertion (BM side / tests). */
export function signTenantSlotChoiceAssertion(
  assertion: TenantSlotChoiceAssertion,
  secret: string,
): string {
  return 'sha256=' + createHmac('sha256', secret).update(stableJson(assertion)).digest('hex');
}

/** Constant-time signature check; any malformed header is simply false. */
export function verifyTenantSlotChoiceSignature(
  assertion: TenantSlotChoiceAssertion,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) return false;
  const expected = Buffer.from(signTenantSlotChoiceAssertion(assertion, secret));
  const received = Buffer.from(signatureHeader);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Freshness window. A stale, future-dated or over-long assertion is refused. */
export function isTenantSlotAssertionFresh(
  assertion: TenantSlotChoiceAssertion,
  nowMs: number = Date.now(),
): boolean {
  const issued = instant(assertion.iat);
  const expires = instant(assertion.exp);
  if (issued === null || expires === null) return false;
  return expires > nowMs &&
    expires > issued &&
    expires - issued <= TENANT_SLOT_MAX_AGE_SECONDS * 1000 &&
    issued - nowMs <= TENANT_SLOT_CLOCK_SKEW_SECONDS * 1000;
}

/** Exact instant comparison; timezone spelling in the wire format is irrelevant. */
export function sameInstant(left: string, right: Date | string): boolean {
  const a = instant(left);
  const b = right instanceof Date ? right.getTime() : instant(right);
  return a !== null && b !== null && a === b;
}
