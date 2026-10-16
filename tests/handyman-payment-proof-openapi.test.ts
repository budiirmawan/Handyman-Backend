import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

/**
 * CR-HM-FIN-DOCUMENTS-01 — focused OpenAPI contract check (pure document
 * assertions, no database, no HTTP server) for the Finance payment-proof
 * retrieval contract and the Finance detail-read door consumed by
 * Handyman-Operations Draft PR #15.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const spec = parseYaml(
  readFileSync(new URL('../docs/api/openapi.yaml', import.meta.url), 'utf8'),
) as Json;
const schemas = spec.components.schemas;

describe('CR-HM-FIN-DOCUMENTS-01 — payment-proof OpenAPI contract', () => {
  it('documents both payment-proof retrieval doors behind handyman.finance.read', () => {
    const meta = spec.paths['/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/payment-proof'];
    const content = spec.paths['/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/payment-proof/content'];
    assert.ok(meta?.get, 'payment-proof metadata GET documented');
    assert.ok(content?.get, 'payment-proof content GET documented');

    for (const op of [meta.get, content.get]) {
      assert.equal(op['x-required-permission'], 'handyman.finance.read');
      assert.equal(op['x-building-scoped'], true);
      assert.deepEqual(op.security, [{ bearerAuth: [] }]);
    }

    // Params are the frozen CR-HM-13 payment family ids only.
    const names = meta.get.parameters.map((p: Json) => p.name ?? p.$ref?.split('/').pop());
    assert.ok(names.includes('ExecutionScopeIdPath'));
    assert.ok(names.includes('CustomerPaymentIdPath'));

    // Metadata envelope exposes paymentProof only.
    const dataSchema =
      meta.get.responses['200'].content['application/json'].schema.allOf[1]
        .properties.data;
    assert.deepEqual(dataSchema.required, ['paymentProof']);
    assert.equal(
      dataSchema.properties.paymentProof.$ref,
      '#/components/schemas/HandymanCustomerPaymentProofMetadata',
    );

    // Content delivery is binary through the authenticated route; 404 is an
    // explicit unavailable state and 409 is the corrupt-bytes conflict.
    assert.ok(content.get.responses['200'].content['application/octet-stream']);
    assert.ok(content.get.responses['404']);
    assert.ok(content.get.responses['409']);
  });

  it('keeps the metadata schema minimal: identity + integrity, never storage or URLs', () => {
    const schema = schemas.HandymanCustomerPaymentProofMetadata;
    assert.ok(schema, 'HandymanCustomerPaymentProofMetadata schema exists');
    assert.equal(schema.additionalProperties, false);
    for (const field of [
      'paymentId',
      'evidenceId',
      'executionType',
      'executionId',
      'clientId',
      'evidenceType',
      'originalFileName',
      'mimeType',
      'fileSize',
      'contentSha256',
      'hashAlgorithm',
      'status',
      'retentionState',
      'createdAt',
    ]) {
      assert.ok(schema.required.includes(field), `${field} required`);
    }
    assert.deepEqual(schema.properties.executionType.enum, [
      'HANDYMAN_CUSTOMER_PAYMENT',
    ]);
    assert.deepEqual(schema.properties.evidenceType.enum, ['PHOTO', 'DOCUMENT']);
    assert.deepEqual(schema.properties.status.enum, ['ACTIVE']);
    for (const forbidden of [
      'fileReference',
      'storageKey',
      'storageUrl',
      'url',
      'token',
      'sessionToken',
    ]) {
      assert.equal(
        schema.properties[forbidden],
        undefined,
        `${forbidden} must never be disclosed`,
      );
    }
  });

  it('documents the Finance detail-read door without widening the tenant ledger gates', () => {
    const financeDoor =
      spec.paths['/handyman/execution-scopes/{executionScopeId}/financial-ledger'];
    assert.ok(financeDoor?.get, 'financial-ledger GET documented');
    assert.equal(financeDoor.get['x-required-permission'], 'handyman.finance.read');
    assert.equal(financeDoor.get['x-building-scoped'], true);
    assert.equal(
      financeDoor.get.responses['200'].content['application/json'].schema.allOf[1]
        .properties.data.$ref,
      '#/components/schemas/HandymanCustomerLedgerTransactionRead',
    );

    // Existing tenant doors keep their published `tenant_company.read` gate.
    const customerLedger =
      spec.paths['/handyman/execution-scopes/{executionScopeId}/customer-ledger'];
    const clientLedger = spec.paths['/handyman/customer-ledger'];
    assert.match(String(customerLedger.get.description), /tenant_company\.read/);
    assert.match(String(clientLedger.get.description), /tenant_company\.read/);
  });
});
