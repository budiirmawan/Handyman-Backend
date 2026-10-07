import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { FOUNDATION_PERMISSIONS } from '../src/database/seeds/foundation-access.seed';
import { api } from './helpers/http';

/**
 * CR-BE-MOB-03 PART 02 — Housekeeping supervisor supporting contract.
 *
 * Documentation-only checks (no database):
 *  - the 28 existing BE-11J / BE-16J / BE-11L / BE-11M supervisor-supporting
 *    operations are published under the Housekeeping tag with their exact
 *    operationIds, methods, permissions and Building-scope annotations;
 *  - the published surface is ⊆ the routes actually registered in the four
 *    housekeeping-support modules (no invented endpoint);
 *  - every published operation carries x-required-permission (a REAL seeded
 *    code) and x-building-scoped: true;
 *  - no /mobile/housekeeping facade and no duplicate operationId exists;
 *  - unauthenticated calls are rejected by auth middleware (401, never 404).
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

/** PART 02 published surface: key `${METHOD} ${path}` → { operationId, permission }. */
const PUBLISHED: Record<string, { operationId: string; permission: string }> = {
  // BE-11J consumable readiness
  'GET /housekeeping/consumable-requirements': { operationId: 'listConsumableRequirements', permission: 'consumable_readiness.read' },
  'POST /housekeeping/consumable-requirements': { operationId: 'createConsumableRequirement', permission: 'consumable_readiness.manage' },
  'GET /housekeeping/consumable-requirements/{id}': { operationId: 'getConsumableRequirement', permission: 'consumable_readiness.read' },
  'PATCH /housekeeping/consumable-requirements/{id}': { operationId: 'updateConsumableRequirement', permission: 'consumable_readiness.manage' },
  'POST /housekeeping/consumable-requirements/{id}/readiness': { operationId: 'recordConsumableReadiness', permission: 'consumable_readiness.manage' },
  'GET /housekeeping/consumable-readiness': { operationId: 'listConsumableReadiness', permission: 'consumable_readiness.read' },
  // BE-16J consumable bindings
  'GET /housekeeping/consumable-requirements/{requirementId}/bindings': { operationId: 'listConsumableRequirementBindings', permission: 'consumable_readiness.read' },
  'POST /housekeeping/consumable-requirements/{requirementId}/bindings': { operationId: 'createConsumableRequirementBinding', permission: 'consumable_readiness.manage' },
  'GET /housekeeping/consumable-bindings': { operationId: 'listHousekeepingConsumableBindings', permission: 'consumable_readiness.read' },
  'GET /housekeeping/consumable-bindings/{id}': { operationId: 'getHousekeepingConsumableBinding', permission: 'consumable_readiness.read' },
  'PATCH /housekeeping/consumable-bindings/{id}': { operationId: 'updateHousekeepingConsumableBinding', permission: 'consumable_readiness.manage' },
  'GET /buildings/{buildingId}/housekeeping-consumable-bindings': { operationId: 'listBuildingHousekeepingConsumableBindings', permission: 'consumable_readiness.read' },
  'GET /cleaning-areas/{cleaningAreaId}/housekeeping-consumable-bindings': { operationId: 'listCleaningAreaHousekeepingConsumableBindings', permission: 'consumable_readiness.read' },
  'GET /clients/{clientId}/housekeeping-consumable-bindings': { operationId: 'listClientHousekeepingConsumableBindings', permission: 'consumable_readiness.read' },
  'GET /warehouses/{warehouseId}/housekeeping-consumable-bindings': { operationId: 'listWarehouseHousekeepingConsumableBindings', permission: 'consumable_readiness.read' },
  'GET /inventory-items/{itemId}/housekeeping-consumable-bindings': { operationId: 'listItemHousekeepingConsumableBindings', permission: 'consumable_readiness.read' },
  // BE-11L complaint bindings
  'GET /housekeeping/complaint-bindings': { operationId: 'listHousekeepingComplaintBindings', permission: 'housekeeping_complaint.read' },
  'POST /housekeeping/complaint-bindings': { operationId: 'createHousekeepingComplaintBinding', permission: 'housekeeping_complaint.manage' },
  'GET /housekeeping/complaint-bindings/{id}': { operationId: 'getHousekeepingComplaintBinding', permission: 'housekeeping_complaint.read' },
  'PATCH /housekeeping/complaint-bindings/{id}': { operationId: 'updateHousekeepingComplaintBinding', permission: 'housekeeping_complaint.manage' },
  // BE-11M report datasets
  'GET /housekeeping/reports/summary': { operationId: 'getHousekeepingReportSummary', permission: 'housekeeping_report.read' },
  'GET /housekeeping/reports/cleaning': { operationId: 'getHousekeepingReportCleaning', permission: 'housekeeping_report.read' },
  'GET /housekeeping/reports/inspections': { operationId: 'getHousekeepingReportInspections', permission: 'housekeeping_report.read' },
  'GET /housekeeping/reports/supervisor-inspections': { operationId: 'getHousekeepingReportSupervisorInspections', permission: 'housekeeping_report.read' },
  'GET /housekeeping/reports/findings': { operationId: 'getHousekeepingReportFindings', permission: 'housekeeping_report.read' },
  'GET /housekeeping/reports/consumables': { operationId: 'getHousekeepingReportConsumables', permission: 'housekeeping_report.read' },
  'GET /housekeeping/reports/quality-audits': { operationId: 'getHousekeepingReportQualityAudits', permission: 'housekeeping_report.read' },
  'GET /housekeeping/reports/complaints': { operationId: 'getHousekeepingReportComplaints', permission: 'housekeeping_report.read' },
};

/** Modules touched by PART 02. */
const HK_SUPPORT_MODULES = [
  'consumable-readiness',
  'inventory-housekeeping-consumable-bindings',
  'housekeeping-complaints',
  'housekeeping-reports',
];

function toExpress(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

/** Collapses param names so `:id` and `{id}` compare equal. */
function canonical(route: string): string {
  return route.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p');
}

function registeredRoutes(moduleDir: string): Set<string> {
  const dir = resolve(__dirname, '../src/modules', moduleDir);
  const routes = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.routes.ts')) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    const pattern = /router\.(get|post|patch|put|delete)\(\s*'([^']+)'/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      routes.add(`${match[1]} ${match[2]}`);
    }
  }
  return routes;
}

const registered = new Set<string>();
for (const module of HK_SUPPORT_MODULES) {
  for (const route of registeredRoutes(module)) {
    registered.add(canonical(route));
  }
}

describe('CR-BE-MOB-03 PART 02 — Housekeeping supervisor supporting contract', () => {
  it('publishes the 28 existing operations with correct ids, tags and permissions', () => {
    const seen: string[] = [];
    for (const [key, expected] of Object.entries(PUBLISHED)) {
      const [method, path] = key.split(' ');
      const op = spec.paths?.[path]?.[method.toLowerCase()];
      assert.ok(op, `${key} must exist in OpenAPI`);
      assert.equal(op.operationId, expected.operationId);
      assert.ok((op.tags ?? []).includes('Housekeeping'), `${expected.operationId} must be tagged Housekeeping`);
      assert.equal(op['x-required-permission'], expected.permission, `${expected.operationId} must require ${expected.permission}`);
      assert.equal(op['x-building-scoped'], true, `${expected.operationId} must be building-scoped`);
      assert.ok(
        (op.security ?? []).some((s: Record<string, unknown>) => 'bearerAuth' in s),
        `${expected.operationId} must require bearer auth`,
      );
      seen.push(key);
    }
    assert.equal(seen.length, 28, 'PART 02 publishes exactly 28 operations');
  });

  it('documents only operations the routers actually register', () => {
    const phantom: string[] = [];
    for (const [key, expected] of Object.entries(PUBLISHED)) {
      const [method, path] = key.split(' ');
      const expressPath = canonical(toExpress(path));
      if (!registered.has(`${method.toLowerCase()} ${expressPath}`)) {
        phantom.push(key);
      }
    }
    assert.deepEqual(phantom, [], 'no invented endpoint may be published');
  });

  it('preserves RBAC with REAL seeded permission codes', () => {
    const seeded = new Set(FOUNDATION_PERMISSIONS.map((p) => p.code));
    const unknown: string[] = [];
    for (const [key, expected] of Object.entries(PUBLISHED)) {
      const [method, path] = key.split(' ');
      const op = spec.paths[path][method.toLowerCase()];
      const code = op['x-required-permission'];
      if (!seeded.has(code)) unknown.push(`${expected.operationId} -> ${code}`);
    }
    assert.deepEqual(unknown, [], 'a documented permission must exist in the seeded permission catalogue');
    assert.ok(seeded.has('consumable_readiness.read'));
    assert.ok(seeded.has('consumable_readiness.manage'));
    assert.ok(seeded.has('housekeeping_complaint.read'));
    assert.ok(seeded.has('housekeeping_complaint.manage'));
    assert.ok(seeded.has('housekeeping_report.read'));
  });

  it('documents the standard failure responses', () => {
    const bad: string[] = [];
    for (const [key, expected] of Object.entries(PUBLISHED)) {
      const [method, path] = key.split(' ');
      const op = spec.paths[path][method.toLowerCase()];
      if (!op.responses?.['401'] || !op.responses?.['403']) {
        bad.push(key);
      }
    }
    assert.deepEqual(bad, []);
  });

  it('creates no /mobile/housekeeping facade and no duplicate operationId', () => {
    const mobile: string[] = [];
    const allOpIds = new Set<string>();
    const duplicates: string[] = [];
    for (const [p, methods] of Object.entries<any>(spec.paths ?? {})) {
      if (p.startsWith('/mobile/housekeeping')) mobile.push(p);
      for (const [m, op] of Object.entries<any>(methods)) {
        if (!op?.operationId) continue;
        if (allOpIds.has(op.operationId)) duplicates.push(op.operationId);
        allOpIds.add(op.operationId);
      }
    }
    assert.deepEqual(mobile, [], 'no /mobile/housekeeping facade may exist');
    assert.deepEqual(duplicates, [], 'no duplicate operationId may exist');
  });

  it('rejects unauthenticated requests with 401, never 404', async () => {
    const request = api();
    const samples: Array<{ method: 'get' | 'post' | 'patch'; path: string }> = [
      { method: 'get', path: '/housekeeping/consumable-requirements' },
      { method: 'post', path: '/housekeeping/consumable-requirements' },
      { method: 'get', path: '/housekeeping/consumable-requirements/00000000-0000-4000-8000-000000000001' },
      { method: 'patch', path: '/housekeeping/consumable-requirements/00000000-0000-4000-8000-000000000001' },
      { method: 'post', path: '/housekeeping/consumable-requirements/00000000-0000-4000-8000-000000000001/readiness' },
      { method: 'get', path: '/housekeeping/consumable-readiness' },
      { method: 'get', path: '/housekeeping/consumable-bindings' },
      { method: 'get', path: '/housekeeping/consumable-bindings/00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/buildings/00000000-0000-4000-8000-000000000001/housekeeping-consumable-bindings' },
      { method: 'get', path: '/cleaning-areas/00000000-0000-4000-8000-000000000001/housekeeping-consumable-bindings' },
      { method: 'get', path: '/clients/00000000-0000-4000-8000-000000000001/housekeeping-consumable-bindings' },
      { method: 'get', path: '/warehouses/00000000-0000-4000-8000-000000000001/housekeeping-consumable-bindings' },
      { method: 'get', path: '/inventory-items/00000000-0000-4000-8000-000000000001/housekeeping-consumable-bindings' },
      { method: 'get', path: '/housekeeping/complaint-bindings' },
      { method: 'post', path: '/housekeeping/complaint-bindings' },
      { method: 'get', path: '/housekeeping/complaint-bindings/00000000-0000-4000-8000-000000000001' },
      { method: 'patch', path: '/housekeeping/complaint-bindings/00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/housekeeping/reports/summary?buildingId=00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/housekeeping/reports/cleaning?buildingId=00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/housekeeping/reports/inspections?buildingId=00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/housekeeping/reports/supervisor-inspections?buildingId=00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/housekeeping/reports/findings?buildingId=00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/housekeeping/reports/consumables?buildingId=00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/housekeeping/reports/quality-audits?buildingId=00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/housekeeping/reports/complaints?buildingId=00000000-0000-4000-8000-000000000001' },
    ];
    for (const { method, path } of samples) {
      const response =
        method === 'get'
          ? await request.get(`${API_PREFIX}${path}`)
          : method === 'post'
            ? await request.post(`${API_PREFIX}${path}`).send({})
            : await request.patch(`${API_PREFIX}${path}`).send({});
      assert.notEqual(
        response.status,
        404,
        `${method.toUpperCase()} ${path} is documented but not registered (got 404)`,
      );
      assert.equal(response.status, 401, `${path} must require authentication`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });
});
