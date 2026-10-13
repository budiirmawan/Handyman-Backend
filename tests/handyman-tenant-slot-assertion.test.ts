import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  isTenantSlotAssertionFresh,
  parseTenantSlotChoiceAssertion,
  readTenantSlotSecret,
  sameInstant,
  signTenantSlotChoiceAssertion,
  tenantSlotSecretEnvName,
  verifyTenantSlotChoiceSignature,
  type TenantSlotChoiceAssertion,
} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-assertion';
import {tenantSlotConsentAuthorityConfigured} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-authority';

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D-2 — pure tenant slot-choice assertion contract.
 * No database. Proves the closed-set parse, HMAC scope, freshness window and
 * fail-closed authority gate that the consent ingest depends on.
 */
const SECRET = 'bm-slot-secret-0123456789abcdef';
const NOW = Date.parse('2031-11-01T10:00:00.000Z');
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;

function assertion(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    iss: 'BM_TENANT', aud: 'handyman-backend', purpose: 'TENANT_SLOT_CHOICE',
    jti: 'slot-jti-0000000000000001',
    iat: new Date(NOW).toISOString(), exp: new Date(NOW + 120_000).toISOString(),
    handymanRequestId: uuid(1),
    kind: 'INSPECTION', tenantCompanyId: uuid(3), buildingId: uuid(4), tenantPicId: uuid(5),
    tenantUserReference: 'bm-user-ref-1',
    selectedStartAt: '2031-11-13T03:00:00.000Z', selectedEndAt: '2031-11-13T04:00:00.000Z',
    bmConsentEvidenceId: 'bm-evidence-0000000001', method: 'BM_AUTHENTICATED_TENANT_SELECTION',
    ...overrides,
  };
}
const valid = (overrides: Partial<Record<string, unknown>> = {}) =>
  parseTenantSlotChoiceAssertion(assertion(overrides)) as TenantSlotChoiceAssertion;

test('parses a canonical assertion and rejects every closed-set violation', () => {
  assert.ok(valid(), 'canonical assertion must parse');
  assert.equal(parseTenantSlotChoiceAssertion({...assertion(), extra: 'x'}), null, 'unknown member');
  const missing = assertion(); delete missing.bmConsentEvidenceId;
  assert.equal(parseTenantSlotChoiceAssertion(missing), null, 'missing member');
  assert.equal(parseTenantSlotChoiceAssertion(assertion({aud: 'other'})), null, 'wrong audience');
  assert.equal(parseTenantSlotChoiceAssertion(assertion({purpose: 'HANDOFF'})), null, 'wrong purpose');
  assert.equal(parseTenantSlotChoiceAssertion(assertion({method: 'OPERATOR'})), null, 'wrong method');
  assert.equal(parseTenantSlotChoiceAssertion(assertion({kind: 'CANCELLED'})), null, 'wrong kind');
  assert.equal(parseTenantSlotChoiceAssertion({...assertion(), appointmentId: uuid(2)}), null,
    'the tenant originates the slot; an assertion names no appointment');
  assert.equal(parseTenantSlotChoiceAssertion({...assertion(), appointmentVersion: 1}), null,
    'no appointment version either');
  assert.equal(parseTenantSlotChoiceAssertion(assertion({jti: 'short'})), null, 'short jti');
  assert.equal(parseTenantSlotChoiceAssertion(assertion({handymanRequestId: 'not-a-uuid'})), null, 'bad uuid');
  assert.equal(parseTenantSlotChoiceAssertion(assertion({tenantPicId: 'ABCDEF01-1111-4111-8111-111111111111'})), null,
    'uppercase UUID is not the canonical wire form');
  assert.equal(parseTenantSlotChoiceAssertion(assertion({selectedStartAt: '2031-11-13T03:00:00'})), null,
    'timestamp without offset');
  assert.equal(parseTenantSlotChoiceAssertion(assertion({selectedEndAt: '2031-11-13T03:00:00.000Z'})), null,
    'empty selected window');
  assert.equal(parseTenantSlotChoiceAssertion([]), null, 'array');
  assert.equal(parseTenantSlotChoiceAssertion(null), null, 'null');
});

test('signature is HMAC-SHA256 over the canonical assertion and fails closed on any drift', () => {
  const value = valid();
  const header = signTenantSlotChoiceAssertion(value, SECRET);
  assert.match(header, /^sha256=[0-9a-f]{64}$/);
  assert.equal(verifyTenantSlotChoiceSignature(value, header, SECRET), true);
  assert.equal(verifyTenantSlotChoiceSignature(value, header, 'other-secret-0123456789abcdef'), false, 'wrong secret');
  assert.equal(verifyTenantSlotChoiceSignature(valid({selectedStartAt: '2031-11-13T05:00:00.000Z'}), header, SECRET), false,
    'tampered slot');
  assert.equal(verifyTenantSlotChoiceSignature(value, undefined, SECRET), false, 'missing header');
  assert.equal(verifyTenantSlotChoiceSignature(value, 'sha256=zz', SECRET), false, 'malformed header');
});

test('secret is scoped per integration and per purpose, never the handoff secret', () => {
  assert.equal(tenantSlotSecretEnvName('bm-tenant'), 'HANDYMAN_VISIT_SLOT_SECRET_BM_TENANT');
  const env = {HANDYMAN_VISIT_SLOT_SECRET_BM_TENANT: SECRET, HANDYMAN_HANDOFF_SECRET_BM_TENANT: 'handoff'} as NodeJS.ProcessEnv;
  assert.equal(readTenantSlotSecret('bm-tenant', env), SECRET);
  assert.equal(readTenantSlotSecret('other-integration', env), null, 'no cross-integration reuse');
  assert.equal(readTenantSlotSecret('bm-tenant', {} as NodeJS.ProcessEnv), null, 'unset is closed');
});

test('freshness: exp window, clock skew and max age are enforced', () => {
  assert.equal(isTenantSlotAssertionFresh(valid(), NOW), true);
  assert.equal(isTenantSlotAssertionFresh(valid(), NOW + 120_000), false, 'expired at exp');
  assert.equal(isTenantSlotAssertionFresh(valid({iat: new Date(NOW + 61_000).toISOString(),
    exp: new Date(NOW + 180_000).toISOString()}), NOW), false, 'iat too far in the future');
  assert.equal(isTenantSlotAssertionFresh(valid({exp: new Date(NOW + 301_000).toISOString()}), NOW), false,
    'lifetime above 300s');
});

test('sameInstant compares exact instants regardless of offset spelling', () => {
  assert.equal(sameInstant('2031-11-13T10:00:00+07:00', new Date('2031-11-13T03:00:00Z')), true);
  assert.equal(sameInstant('2031-11-13T03:00:00.001Z', new Date('2031-11-13T03:00:00Z')), false);
});

test('authority is fail-closed: needs ACTIVE, the scope grant and the deployed secret', async () => {
  const row = (integrationCode: string) => ({rows: [{integrationCode}]});
  const executorWith = (result: unknown) => ({query: async () => result}) as never;
  assert.equal(await tenantSlotConsentAuthorityConfigured(executorWith({rows: []}), {}), false, 'no grant');
  assert.equal(await tenantSlotConsentAuthorityConfigured(executorWith(row('bm-tenant')), {}), false,
    'granted but no secret deployed');
  assert.equal(await tenantSlotConsentAuthorityConfigured(executorWith(row('bm-tenant')),
    {HANDYMAN_VISIT_SLOT_SECRET_BM_TENANT: SECRET} as NodeJS.ProcessEnv), true, 'granted and deployed');
});
