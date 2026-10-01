import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

/**
 * CR-HM-01 AMENDMENT 01 PART 11 — focused OpenAPI contract check for the
 * Customer Care handoff (governance amendment §3.1/§3.4/§3.5/§3.7/§6).
 *
 * Pure document assertions (no database, no HTTP server): the spec must
 * document the optional signed actor block, the closed CUSTOMER_CARE
 * vocabulary, the preserved one-time exchange semantics, and the
 * server-derived actor provenance — without inventing endpoints, without
 * giving `careActorId` any client authority, and without changing the legacy
 * request/response contract.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const spec = parseYaml(
  readFileSync(new URL('../docs/api/openapi.yaml', import.meta.url), 'utf8'),
) as Json;

const schemas = spec.components.schemas;
const accept = spec.paths['/handoff/assertions'].post;
const bind = spec.paths['/handoff/channel-attributions'].post;

function descriptionOf(node: Json): string {
  return typeof node?.description === 'string' ? node.description : '';
}

describe('CR-HM-01 A01 PART 11 — Customer Care handoff OpenAPI contract', () => {
  it('documents the optional signed actor block with a closed vocabulary', () => {
    const claim = schemas.HandoffCareActorClaim;
    assert.ok(claim, 'HandoffCareActorClaim schema exists');
    assert.deepEqual(claim.required, ['type', 'actorReference']);
    assert.equal(claim.additionalProperties, false);
    assert.deepEqual(claim.properties.type.enum, ['CUSTOMER_CARE']);
    assert.equal(claim.properties.actorReference.minLength, 1);
    assert.equal(claim.properties.actorReference.maxLength, 128);

    // The actor block is optional on the assertion (legacy requests stay valid).
    const actor = schemas.HandoffAssertion.properties.actor;
    assert.ok(actor, 'HandoffAssertion.actor documented');
    assert.deepEqual(actor.allOf[0].$ref, '#/components/schemas/HandoffCareActorClaim');
    assert.ok(
      !schemas.HandoffAssertion.required.includes('actor'),
      'actor must remain optional for legacy assertions',
    );
  });

  it('states that the actor block is signature-covered and attested', () => {
    const claimText = descriptionOf(schemas.HandoffCareActorClaim);
    assert.match(claimText, /signature/i);
    assert.match(claimText, /CUSTOMER_CARE/);
    assert.match(claimText, /distinct from the represented/i);
    assert.match(
      descriptionOf(schemas.HandoffCareActorClaim.properties.actorReference),
      /never client-authoritative/i,
    );

    const pathText = descriptionOf(accept);
    assert.match(pathText, /x-hub-signature-256/);
    assert.match(pathText, /CUSTOMER_CARE/);
  });

  it('preserves the legacy assertion and binding request contracts', () => {
    assert.deepEqual(schemas.HandoffAssertion.required, [
      'integrationCode',
      'assertionId',
      'issuedAt',
      'expiresAt',
      'tenantCompanyId',
      'buildingId',
    ]);
    // Binding still accepts nothing but the exchange token: no actor
    // identity can ever be supplied by a caller.
    assert.deepEqual(schemas.HandoffBindingRequest.required, ['exchangeToken']);
    assert.deepEqual(
      Object.keys(schemas.HandoffBindingRequest.properties),
      ['exchangeToken'],
    );
  });

  it('documents server-derived actor provenance on the response surfaces only', () => {
    const snapshot = schemas.HandoffContextSnapshot;
    for (const field of ['actorType', 'careActorId', 'actorReference']) {
      assert.ok(
        snapshot.required.includes(field),
        `HandoffContextSnapshot.${field} documented as always present`,
      );
      assert.equal(snapshot.properties[field].nullable, true);
    }
    assert.deepEqual(snapshot.properties.actorType.enum, ['CUSTOMER_CARE']);

    const attribution = schemas.HandymanChannelAttribution;
    for (const field of ['actorType', 'careActorId', 'actorReference']) {
      assert.ok(
        attribution.required.includes(field),
        `HandymanChannelAttribution.${field} documented`,
      );
      assert.equal(attribution.properties[field].nullable, true);
    }
    assert.deepEqual(attribution.properties.actorType.enum, ['CUSTOMER_CARE']);

    // Represented-context columns are unchanged.
    assert.deepEqual(attribution.properties.originChannel.enum, ['BM_SUPER_APP']);
    assert.deepEqual(
      attribution.required.filter((name: string) =>
        ['clientId', 'tenantCompanyId', 'tenantPicId', 'buildingId', 'spaceId'].includes(name),
      ),
      ['clientId', 'tenantCompanyId', 'tenantPicId', 'buildingId', 'spaceId'],
    );
  });

  it('gives careActorId no client authority and no writable surface', () => {
    for (const node of [
      schemas.HandoffContextSnapshot,
      schemas.HandymanChannelAttribution,
    ]) {
      const text = descriptionOf(node.properties.careActorId);
      assert.match(text, /never client authority/i);
      assert.match(text, /never accepted as an input|never accepted as input/i);
    }
    // No request schema (path request bodies) exposes actor identity.
    assert.equal(
      schemas.HandoffBindingRequest.properties.careActorId,
      undefined,
    );
    assert.equal(schemas.HandoffBindingRequest.properties.actorType, undefined);
    assert.equal(
      schemas.HandoffBindingRequest.properties.actorReference,
      undefined,
    );
  });

  it('keeps the one-time exchange contract and legacy compatibility documented', () => {
    // Response codes unchanged for both endpoints.
    assert.deepEqual(Object.keys(accept.responses).sort(), ['201', '400', '401', '409']);
    assert.deepEqual(Object.keys(bind.responses).sort(), ['201', '400', '401', '409']);

    // Same single credential model: no Bearer substitute on the assertion
    // endpoint, and the exchange token stays the only binding input.
    assert.deepEqual(accept.security, [{ handoffAssertionSignature: [] }]);
    assert.equal(bind.security, undefined);
    assert.equal(
      spec.components.securitySchemes.handoffAssertionSignature.name,
      'x-hub-signature-256',
    );

    // One-time / hash-only semantics remain stated, and no downgrade exists.
    const exchangeText = descriptionOf(schemas.HandoffExchangeAccepted.properties.exchangeToken);
    assert.match(exchangeText, /exactly once/i);
    assert.match(exchangeText, /hash/i);
    assert.match(descriptionOf(accept), /never\s+silently downgraded|never\s+downgraded/i);
  });

  it('invents no endpoint and no /webhooks handoff surface', () => {
    const handoffPaths = Object.keys(spec.paths).filter((path) =>
      path.includes('handoff'),
    );
    assert.deepEqual(handoffPaths.sort(), [
      '/handoff/assertions',
      '/handoff/channel-attributions',
    ]);
    for (const path of Object.keys(spec.paths)) {
      assert.ok(
        !path.startsWith('/webhooks/') || !path.toLowerCase().includes('handoff'),
        `handoff leaked into webhook path ${path}`,
      );
    }
    assert.equal(accept.operationId, 'acceptHandoffAssertion');
    assert.equal(bind.operationId, 'bindHandoffExchangeToChannelAttribution');
  });
});
