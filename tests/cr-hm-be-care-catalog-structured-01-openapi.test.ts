import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const openapi = parse(readFileSync('docs/api/openapi.yaml', 'utf8')) as any;

/**
 * CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — focused OpenAPI/runtime contract
 * consistency checks. No database required.
 */
describe('CR-HM-BE-CARE-CATALOG-STRUCTURED-01 OpenAPI contract', () => {
  it('documents exclusive legacy-versus-structured Care create and exact item fields', () => {
    const operation =
      openapi.paths['/handyman/care/buildings/{buildingId}/requests'].post;
    assert.equal(operation.operationId, 'createBuildingCareRequest');
    assert.equal(operation['x-required-permission'], 'handyman.care.building');
    assert.ok(
      operation.parameters.some(
        (parameter: any) =>
          parameter.$ref ===
          '#/components/parameters/RequestIdempotencyKeyHeader',
      ),
    );
    assert.ok(
      operation['x-error-codes'].includes(
        'HANDYMAN_SERVICE_REQUEST_ITEM_INVALID',
      ),
    );

    const createBody =
      openapi.components.schemas.HandymanCareRequestCreateBody;
    assert.equal(createBody.additionalProperties, false);
    assert.deepEqual(createBody.required, ['tenantCompanyId']);
    assert.equal(createBody.oneOf.length, 2);
    assert.deepEqual(createBody.oneOf[0].required, ['serviceCatalogId']);
    assert.deepEqual(createBody.oneOf[0].not.required, ['items']);
    assert.deepEqual(createBody.oneOf[1].required, ['items']);
    assert.deepEqual(createBody.oneOf[1].not.anyOf.map((x: any) => x.required), [
      ['serviceCatalogId'],
      ['serviceVariantId'],
    ]);

    const item =
      openapi.components.schemas.HandymanCareStructuredRequestItem;
    assert.equal(item.additionalProperties, false);
    assert.deepEqual(item.required, ['serviceCatalogId', 'quantity']);
    for (const field of [
      'serviceCatalogId',
      'serviceVariantId',
      'quantity',
      'uomId',
      'attributeValues',
      'itemDescription',
      'accessCondition',
    ]) {
      assert.ok(item.properties[field], `missing items[].${field}`);
    }
    assert.equal(item.properties.quantity.exclusiveMinimum, 0);
    assert.equal(item.properties.quantity.multipleOf, 0.0001);
    assert.equal(item.properties.uomId.format, 'uuid');
    assert.equal(item.properties.itemDescription.maxLength, 1000);
    assert.equal(item.properties.attributeValues.maxProperties, 20);
  });

  it('documents persisted structured readback and the extended reusable item schema', () => {
    const detailOperation =
      openapi.paths[
        '/handyman/care/buildings/{buildingId}/requests/{requestId}'
      ].get;
    assert.equal(detailOperation.operationId, 'getStandaloneCareRequestDetail');
    const detailSchema =
      openapi.components.schemas.HandymanCareStandaloneRequestDetail;
    assert.deepEqual(detailSchema.required, ['request', 'items', 'progress']);
    assert.equal(
      detailSchema.properties.items.items.$ref,
      '#/components/schemas/HandymanCareStructuredRequestItemRead',
    );
    const readItem =
      openapi.components.schemas.HandymanCareStructuredRequestItemRead;
    for (const field of [
      'quantity',
      'uomId',
      'itemDescription',
      'attributeValues',
      'inheritedAttributeValues',
      'accessCondition',
    ]) {
      assert.ok(readItem.properties[field], `missing readback ${field}`);
    }

    const reusableItem =
      openapi.components.schemas.HandymanServiceRequestItem;
    assert.ok(reusableItem.properties.uomId);
    assert.ok(reusableItem.properties.itemDescription);
    assert.ok(reusableItem.properties.inheritedAttributeValues);
  });
});
