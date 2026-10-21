import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadSpec } from './helpers/openapi-census';
import { parseDefectTransitionBody } from '../src/modules/handyman-evidence-qc-api/handyman-evidence-qc-api.validation';

const spec = loadSpec() as any;

test('defect discovery documents composite field authority, not a Care-only permission', () => {
  for (const path of ['/handyman/execution-scopes/{executionScopeId}/defects', '/handyman/defects/{defectId}']) {
    const op = spec.paths[path].get;
    assert.equal(op['x-required-permission'], undefined);
    assert.match(op.description, /PIC/);
    assert.match(op.description, /Supervisor/);
    assert.match(op.description, /[Bb]uilding/);
    assert.deepEqual(op.security, [{ bearerAuth: [] }]);
  }
  assert.match(spec.paths['/handyman/execution-scopes/{executionScopeId}/defects'].get.description,
    /PIC does NOT require tenant_company.read/);
});

test('reinspection contract requires the same reason/version/key as the runtime parser', () => {
  const path = '/handyman/defects/{defectId}/request-reinspection';
  assert.equal(spec.paths[path].post.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/HandymanDefectRequestReinspectionRequest');
  assert.deepEqual(spec.components.schemas.HandymanDefectRequestReinspectionRequest.allOf[1].required, ['reason']);
  assert.throws(() => parseDefectTransitionBody({ expectedVersion: 1, idempotencyKey: 'repair' }, 'REQUEST_REINSPECTION'));
  assert.deepEqual(parseDefectTransitionBody({ expectedVersion: 1, idempotencyKey: 'repair', reason: 'Seal still leaks' }, 'REQUEST_REINSPECTION'),
    { expectedVersion: 1, idempotencyKey: 'repair', reason: 'Seal still leaks' });
});

test('staff Care origin and optional PIC User binding remain in the published contract', () => {
  const source = readFileSync('src/modules/handyman-care-standalone-discovery/handyman-care-tenant-request-gateway.service.ts', 'utf8');
  assert.match(source, /originChannel: 'CUSTOMER_CARE_BACKEND'/);
  const op = spec.paths['/handyman/care/buildings/{buildingId}/requests'].post;
  assert.equal(op.operationId, 'createBuildingCareRequest');
  assert.match(op.description, /originChannel=CUSTOMER_CARE_BACKEND/);
  assert.deepEqual(spec.components.schemas.CreateTenantPicRequest.required, ['picName']);
  assert.ok(spec.components.schemas.CreateTenantPicRequest.properties.userId);
});
