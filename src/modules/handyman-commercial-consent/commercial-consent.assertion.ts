import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { stableJson } from '../../shared/stable-json';
import { readHandoffIntegrationSecret } from '../handyman-handoff/handoff-runtime.config';
import { readTenantSlotSecret } from '../handyman-appointment-contract/handyman-tenant-slot-assertion';

/** Reuses the BM purpose-scoped HMAC/freshness convention, NOT its handoff or
 * scheduling authority. A separately enrolled customer-verification backend
 * must originate this assertion; Care must never possess this signing key. */
export const COMMERCIAL_CONSENT_PURPOSE = 'HANDYMAN_CUSTOMER_COMMERCIAL_DECISION_V1';
export const COMMERCIAL_CONSENT_METHOD = 'BM_VERIFIED_CUSTOMER_CHANNEL_V1';
export type CommercialConsentAssertion = {
  iss: string; aud: 'handyman-backend'; purpose: typeof COMMERCIAL_CONSENT_PURPOSE;
  method: typeof COMMERCIAL_CONSENT_METHOD; jti: string; iat: string; exp: string;
  careActorId: string; clientId: string; handymanRequestId: string;
  tenantCompanyId: string; tenantPicId: string | null; buildingId: string; spaceId: string | null;
  communicationId: string; customerReference: string; verificationReference: string;
  targetType: 'QUOTATION_VERSION' | 'BAST'; targetId: string; targetDigest: string;
  decision: 'ACCEPT' | 'REJECT'; rejectReason: string | null;
};
const FIELDS = ['iss', 'aud', 'purpose', 'method', 'jti', 'iat', 'exp', 'careActorId', 'clientId',
  'handymanRequestId', 'tenantCompanyId', 'tenantPicId', 'buildingId', 'spaceId', 'communicationId',
  'customerReference', 'verificationReference', 'targetType', 'targetId', 'targetDigest', 'decision', 'rejectReason'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bounded = (v: unknown, max: number) => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= max;
export function parseCommercialConsentAssertion(value: unknown): CommercialConsentAssertion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== FIELDS.length || Object.keys(v).some(k => !FIELDS.includes(k)) ||
      v.aud !== 'handyman-backend' || v.purpose !== COMMERCIAL_CONSENT_PURPOSE || v.method !== COMMERCIAL_CONSENT_METHOD ||
      !['QUOTATION_VERSION', 'BAST'].includes(String(v.targetType)) || !['ACCEPT', 'REJECT'].includes(String(v.decision))) return null;
  for (const key of ['careActorId', 'clientId', 'handymanRequestId', 'tenantCompanyId', 'buildingId', 'communicationId', 'targetId']) {
    if (typeof v[key] !== 'string' || !UUID.test(v[key] as string)) return null;
  }
  for (const key of ['tenantPicId', 'spaceId']) if (v[key] !== null && (typeof v[key] !== 'string' || !UUID.test(v[key] as string))) return null;
  if (!bounded(v.iss, 64) || !/^[A-Za-z0-9_-]+$/.test(v.iss as string) || !bounded(v.jti, 128) || (v.jti as string).length < 16 ||
      !bounded(v.customerReference, 200) || !bounded(v.verificationReference, 200) ||
      typeof v.targetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.targetDigest) ||
      (v.rejectReason !== null && !bounded(v.rejectReason, 2000)) || (v.decision === 'ACCEPT' && v.rejectReason !== null) ||
      (v.targetType === 'QUOTATION_VERSION' && v.rejectReason !== null)) return null;
  for (const key of ['iat', 'exp']) {
    if (typeof v[key] !== 'string' || !Number.isFinite(Date.parse(v[key] as string)) ||
        new Date(v[key] as string).toISOString() !== v[key]) return null;
  }
  return v as unknown as CommercialConsentAssertion;
}
export function commercialConsentSecretEnvName(code: string): string {
  return `HANDYMAN_COMMERCIAL_CONSENT_SECRET_${code.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}
export function readCommercialConsentSecret(code: string): string | null {
  const value = process.env[commercialConsentSecretEnvName(code)];
  // Domain separation must not be defeated by copying the existing Care/slot key.
  return value && value.length >= 32 && value !== readHandoffIntegrationSecret(code) && value !== readTenantSlotSecret(code) ? value : null;
}
export function signCommercialConsentAssertion(a: CommercialConsentAssertion, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(COMMERCIAL_CONSENT_PURPOSE + '\0' + stableJson(a)).digest('hex');
}
export function verifyCommercialConsentSignature(a: CommercialConsentAssertion, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(signCommercialConsentAssertion(a, secret)));
}
export function freshCommercialConsent(a: CommercialConsentAssertion, now: Date): boolean {
  const iat = Date.parse(a.iat), exp = Date.parse(a.exp);
  return iat <= now.getTime() && exp > now.getTime() && exp > iat && exp - iat <= 300_000;
}
export function commercialConsentHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}
