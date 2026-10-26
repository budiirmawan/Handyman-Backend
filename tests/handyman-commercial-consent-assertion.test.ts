import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  COMMERCIAL_CONSENT_METHOD, COMMERCIAL_CONSENT_PURPOSE, commercialConsentHash,
  freshCommercialConsent, parseCommercialConsentAssertion, signCommercialConsentAssertion,
  verifyCommercialConsentSignature, type CommercialConsentAssertion,
} from '../src/modules/handyman-commercial-consent/commercial-consent.assertion';

const now = new Date('2026-10-25T00:00:00.000Z');
function assertion(): CommercialConsentAssertion {
  return { iss: 'BM_TEST', aud: 'handyman-backend', purpose: COMMERCIAL_CONSENT_PURPOSE,
    method: COMMERCIAL_CONSENT_METHOD, jti: randomUUID(), iat: new Date(now.getTime() - 1000).toISOString(),
    exp: new Date(now.getTime() + 240000).toISOString(), careActorId: randomUUID(), clientId: randomUUID(),
    handymanRequestId: randomUUID(), tenantCompanyId: randomUUID(), tenantPicId: null,
    buildingId: randomUUID(), spaceId: null, communicationId: randomUUID(), customerReference: 'verified-person-123',
    verificationReference: 'bm-proof-123', targetType: 'QUOTATION_VERSION', targetId: randomUUID(),
    targetDigest: 'a'.repeat(64), decision: 'ACCEPT', rejectReason: null };
}
describe('commercial consent purpose-bound crypto contract (no customer account)', () => {
  it('strictly parses nullable PIC and space; stable HMAC/hash ignores object key order', () => {
    const a = assertion(), secret = 'only-the-independent-customer-verifier-holds-this';
    assert.deepEqual(parseCommercialConsentAssertion(a), a);
    const reversed = Object.fromEntries(Object.entries(a).reverse()) as CommercialConsentAssertion;
    assert.equal(signCommercialConsentAssertion(a, secret), signCommercialConsentAssertion(reversed, secret));
    assert.equal(commercialConsentHash(a), commercialConsentHash(reversed));
    assert.equal(verifyCommercialConsentSignature(a, signCommercialConsentAssertion(a, secret), secret), true);
    assert.equal(verifyCommercialConsentSignature(a, undefined, secret), false);
    assert.equal(verifyCommercialConsentSignature(a, signCommercialConsentAssertion(a, 'handoff-key'), secret), false);
    assert.equal(verifyCommercialConsentSignature({ ...a, decision: 'REJECT' }, signCommercialConsentAssertion(a, secret), secret), false);
  });
  it('refuses Care flags, attachments, unknown methods/fields, slot/handoff purpose and malformed context', () => {
    const a = assertion();
    for (const change of [ { verified: true }, { purpose: 'TENANT_SLOT_CHOICE' }, { method: 'CARE_CONFIRMED' },
      { customerReference: '' }, { verificationReference: '' }, { tenantPicId: 'not-a-pic' },
      { buildingId: randomUUID().toUpperCase() }, { targetDigest: 'free-standing-digest' },
      { rejectReason: 'not legal on accept' }, { iat: '2026-10-25' } ]) {
      assert.equal(parseCommercialConsentAssertion({ ...a, ...change }), null);
    }
    assert.equal(parseCommercialConsentAssertion({ verified: true, evidenceIds: [randomUUID()] }), null);
  });
  it('freshness is bounded, expiry/future/overlong fail closed at database clock', () => {
    const a = assertion();
    assert.equal(freshCommercialConsent(a, now), true);
    for (const change of [{ iat: new Date(now.getTime() + 1).toISOString() }, { exp: now.toISOString() },
      { iat: new Date(now.getTime() - 301000).toISOString() }]) {
      assert.equal(freshCommercialConsent({ ...a, ...change }, now), false);
    }
  });
});

it('OpenAPI documents only the new workspace receiver with a separate consent signature and nullable real recorders', () => {
  const spec = parseYaml(readFileSync('docs/api/openapi.yaml', 'utf8'));
  const root = '/handyman/care/requests/{requestId}';
  for (const kind of ['quotation-versions', 'bast']) {
    const operation = spec.paths[`${root}/${kind}/{targetId}/decision`].post;
    assert.deepEqual(operation.security, [{ careWorkspaceSession: [], commercialConsentSignature: [] }]);
    assert.ok(operation.responses['503']);
    assert.match(operation.description, /BLOCKED/);
  }
  assert.ok(spec.paths[`${root}/communications`].post);
  assert.ok(spec.paths[`${root}/commercial-targets/{targetType}/{targetId}`].get);
  assert.equal(spec.components.securitySchemes.commercialConsentSignature.name, 'x-handyman-commercial-consent-signature');
  assert.equal(spec.components.schemas.HandymanCommercialConsentAssertion.additionalProperties, false);
  assert.equal(spec.components.schemas.HandymanQuotationDecisionRecord.properties.decidedByUserId.nullable, true);
  assert.equal(spec.components.schemas.HandymanExecutionScopeRecord.properties.createdByUserId.nullable, true);
  assert.equal(spec.components.schemas.HandymanBastEvent.properties.actorUserId.nullable, true);
});
