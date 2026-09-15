import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { api } from './helpers/http';

const spec = parse(readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8')) as any;
const handoff = readFileSync(resolve(__dirname, '../docs/api/CR_BE_UTL_01_UTILITY_HANDOFF.md'), 'utf8');
const operations = [
  'GET /buildings/{buildingId}/utility-meters',
  'POST /buildings/{buildingId}/utility-meters',
  'GET /utility/meters/{id}',
  'PATCH /utility/meters/{id}',
  'GET /utility/meters/{id}/sub-meters',
  'POST /utility/meters/{id}/sub-meters',
  'GET /utility/meters/{id}/readings',
  'POST /utility/meters/{id}/readings',
  'GET /utility/meter-readings/{id}',
  'GET /utility/meter-readings/{id}/evidence',
  'POST /utility/meter-readings/{id}/evidence',
  'GET /utility/meter-readings/{id}/evidence-validation',
  'GET /utility/meters/{id}/consumptions',
  'POST /utility/meters/{id}/consumptions',
  'GET /utility/meter-consumptions/{id}',
  'GET /buildings/{buildingId}/utility-tariffs',
  'POST /buildings/{buildingId}/utility-tariffs',
  'GET /utility/consumptions/{id}/calculations',
  'POST /utility/consumptions/{id}/calculations',
  'GET /utility/calculations/{id}',
  'POST /utility/calculations/{id}/finalize',
  'GET /tenant-approvals/pending',
  'POST /tenant-approvals',
  'GET /tenant-approvals/{id}',
  'GET /tenant-approvals/{id}/available-actions',
  'POST /tenant-approvals/{id}/approve',
  'POST /tenant-approvals/{id}/reject',
  'GET /utility/calculations/{id}/tenant-approvals',
  'POST /tenant-companies/{tenantCompanyId}/utility-bills',
  'GET /utility-bills',
  'GET /utility-bills/{id}',
  'PATCH /utility-bills/{id}',
  'GET /utility-bills/{id}/invoice-ready',
  'GET /buildings/{buildingId}/utility-reconciliations',
  'POST /buildings/{buildingId}/utility-reconciliations',
  'GET /utility/reconciliations/{id}',
] as const;

describe('CR-BE-UTL-01 PART 13 Utility OpenAPI contract', () => {
  it('publishes the pinned Utility lineage and analytics operations', () => {
    for (const entry of operations) {
      const [method, path] = entry.split(' ');
      const operation = spec.paths?.[path]?.[method.toLowerCase()];
      assert.ok(operation, `${entry} must be published`);
      assert.equal(operation.security?.[0]?.bearerAuth?.length, 0, `${entry} bearer security`);
      assert.ok(operation['x-required-permission'], `${entry} permission extension`);
      assert.equal(operation['x-building-scoped'], true, `${entry} Building scope`);
    }
  });

  it('documents exact lifecycle, purpose, lineage and analytical schemas', () => {
    const schemas = spec.components.schemas;
    assert.deepEqual(schemas.UtilityMeterPurpose.enum, ['TENANT', 'BUILDING', 'COMMON_AREA', 'ENERGY_SOURCE']);
    assert.deepEqual(schemas.UtilityCalculationStatus.enum, ['DRAFT', 'FINALIZED', 'SUPERSEDED']);
    assert.deepEqual(schemas.TenantApprovalStatus.enum, ['PENDING', 'APPROVED', 'REJECTED']);
    assert.deepEqual(schemas.UtilityBillStatus.enum, ['DRAFT', 'ISSUED', 'CANCELLED']);
    for (const field of ['meterReadingBindingId', 'formInstanceId']) assert.ok(schemas.UtilityMeterReading.properties[field]);
    for (const field of ['previousReadingId', 'currentReadingId']) assert.ok(schemas.UtilityConsumption.properties[field]);
    for (const field of ['consumptionId', 'tariffId', 'tenantCompanyId']) assert.ok(schemas.UtilityCalculation.properties[field]);
    for (const field of ['utilityCalculationId', 'utilityMeterId', 'utilitySpaceId']) assert.ok(schemas.TenantUtilityApproval.properties[field]);
    for (const field of ['calculationId', 'approvalId', 'consumptionId']) assert.ok(schemas.UtilityBill.properties[field]);
    for (const field of ['utilityBillId', 'sourceCalculationId']) assert.ok(schemas.UtilityInvoiceReady.properties[field]);
    for (const field of ['sourceConsumption', 'tenantConsumption', 'commonAreaConsumption',
      'unallocatedConsumption', 'reconciliationPercentage', 'applicableAreaSqm',
      'performanceMetric', 'performanceValue', 'performanceUom', 'calculatedAt']) {
      assert.ok(schemas.UtilityReconciliation.properties[field], `reconciliation.${field}`);
    }
  });

  it('publishes stable Utility errors and honest OCR/Reading Due boundaries', () => {
    const errors = new Set(spec.components.schemas.UtilityErrorCode.enum);
    for (const code of ['UTILITY_METER_NOT_FOUND', 'UTILITY_METER_CONSUMPTION_READING_INVALID',
      'UTILITY_TARIFF_NOT_FOUND', 'TENANT_APPROVAL_CONTEXT_MISMATCH',
      'UTILITY_BILL_ALREADY_EXISTS', 'BUILDING_UTILITY_RECONCILIATION_NO_SOURCE']) {
      assert.ok(errors.has(code), code);
    }
    assert.ok(spec.paths['/utility/reading-dues/{id}']);
    assert.ok(spec.paths['/utility/ocr-candidates/{id}']);
    assert.match(handoff, /schedule_definitions.*now admits/i);
    assert.match(handoff, /OCR output is a candidate/i);
    assert.match(handoff, /Tenant PIC boundary/i);
  });

  it('resolves every PART 13 schema/response reference', () => {
    const root = spec;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === '$ref' && typeof child === 'string' && child.startsWith('#/')) {
          const target = child.slice(2).split('/').reduce((node: any, segment) => node?.[segment], root);
          assert.ok(target, `unresolved $ref ${child}`);
        } else visit(child);
      }
    };
    for (const entry of operations) {
      const [method, path] = entry.split(' ');
      visit(spec.paths[path][method.toLowerCase()]);
    }
  });

  it('does not publish invented endpoints: every pinned route is registered', async () => {
    const request = api();
    for (const entry of operations) {
      const [method, path] = entry.split(' ');
      const url = `/api/v1${path}`;
      const response = method === 'GET' ? await request.get(url)
        : method === 'POST' ? await request.post(url).send({})
          : await request.patch(url).send({});
      assert.equal(response.status, 401, `${entry} must resolve to protected runtime route`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });
});
