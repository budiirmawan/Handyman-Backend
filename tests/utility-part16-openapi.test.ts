import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { api } from './helpers/http';
const spec = parse(readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8')) as any;
describe('CR-BE-UTL-01 PART 16 OpenAPI', () => {
  it('publishes the registered read-only Building summary endpoint', async () => {
    const path = '/buildings/{buildingId}/utility-summary';
    const operation = spec.paths[path]?.get;
    assert.ok(operation);
    assert.equal(operation['x-required-permission'], 'management_read_model.read');
    assert.equal(operation['x-building-scoped'], true);
    for (const method of ['post', 'put', 'patch', 'delete']) assert.equal(spec.paths[path]?.[method], undefined);
    const response = await api().get(`/api/v1${path}`);
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
  it('documents reconciliation, Meter/Due, exception and billing-readiness shapes', () => {
    const schema = spec.components.schemas.BuildingUtilityOperationalSummary;
    for (const field of ['clientId', 'buildingId', 'reportingPeriod', 'reconciliations',
      'meters', 'exceptions', 'billingReadiness', 'asOf']) assert.ok(schema.properties[field]);
    const reconciliation = spec.components.schemas.BuildingUtilityReconciliationSummary;
    for (const field of ['sourceConsumption', 'tenantConsumption', 'commonAreaConsumption',
      'unallocatedConsumption', 'reconciliationPercentage', 'performanceMetric',
      'performanceValue', 'applicableAreaSqm', 'consumptionUomId', 'performanceUom']) {
      assert.ok(reconciliation.properties[field]);
    }
    assert.deepEqual(schema.properties.exceptions.properties.byStatus.required,
      ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CANCELLED']);
  });
  it('parses with unique operation IDs', () => {
    const ids: string[] = [];
    for (const item of Object.values(spec.paths) as any[]) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) if (item[method]) ids.push(item[method].operationId);
    }
    assert.equal(new Set(ids).size, ids.length);
  });
});
