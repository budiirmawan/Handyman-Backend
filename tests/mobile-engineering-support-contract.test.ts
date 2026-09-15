import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { FOUNDATION_PERMISSIONS } from '../src/database/seeds/foundation-access.seed';
import { api } from './helpers/http';

/**
 * CR-BE-MOB-03 PART 03 — Engineering & corrective-action verification
 * contract.
 *
 * Documentation-only checks (no database):
 *  - the 8 existing BE-10I engineering report datasets are published under
 *    the Engineering tag with their exact operationIds, `engineering_report.read`
 *    permission and `x-building-scoped: true`;
 *  - the 6 existing BE-21J corrective-action verification operations are
 *    published under the new `Corrective Action Verification` tag with their
 *    exact operationIds and read/manage permission split;
 *  - the published surface is ⊆ the routes actually registered in the two
 *    modules (no invented endpoint);
 *  - every documented permission is a REAL seeded code;
 *  - no /mobile/engineering facade and no duplicate operationId exists;
 *  - /mobile/verification is NOT extended (still only
 *    CHECKLIST_EXECUTION / FORM_INSTANCE / FINDING);
 *  - unauthenticated calls are rejected by auth middleware (401, never 404).
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

/** PART 03 published surface: key `${METHOD} ${path}` → { operationId, permission, tag }. */
const PUBLISHED: Record<string, { operationId: string; permission: string; tag: string }> = {
  // BE-10I engineering report datasets
  'GET /engineering/reports/technical-summary': { operationId: 'getEngineeringReportTechnicalSummary', permission: 'engineering_report.read', tag: 'Engineering' },
  'GET /engineering/reports/inspections': { operationId: 'getEngineeringReportInspections', permission: 'engineering_report.read', tag: 'Engineering' },
  'GET /engineering/reports/meter-readings': { operationId: 'getEngineeringReportMeterReadings', permission: 'engineering_report.read', tag: 'Engineering' },
  'GET /engineering/reports/equipment-logs': { operationId: 'getEngineeringReportEquipmentLogs', permission: 'engineering_report.read', tag: 'Engineering' },
  'GET /engineering/reports/checklists': { operationId: 'getEngineeringReportChecklists', permission: 'engineering_report.read', tag: 'Engineering' },
  'GET /engineering/reports/breakdowns': { operationId: 'getEngineeringReportBreakdowns', permission: 'engineering_report.read', tag: 'Engineering' },
  'GET /engineering/reports/maintenance': { operationId: 'getEngineeringReportMaintenance', permission: 'engineering_report.read', tag: 'Engineering' },
  'GET /engineering/reports/findings': { operationId: 'getEngineeringReportFindings', permission: 'engineering_report.read', tag: 'Engineering' },
  // BE-21J corrective-action verification
  'GET /corrective-action-verifications': { operationId: 'listCorrectiveActionVerifications', permission: 'corrective_action_verification.read', tag: 'Corrective Action Verification' },
  'GET /corrective-actions/{id}/verification': { operationId: 'getCorrectiveActionVerificationContext', permission: 'corrective_action_verification.read', tag: 'Corrective Action Verification' },
  'POST /corrective-actions/{id}/verification': { operationId: 'openCorrectiveActionVerification', permission: 'corrective_action_verification.manage', tag: 'Corrective Action Verification' },
  'POST /corrective-actions/{id}/verification/decision': { operationId: 'submitCorrectiveActionVerification', permission: 'corrective_action_verification.manage', tag: 'Corrective Action Verification' },
  'GET /corrective-actions/{id}/verification/latest': { operationId: 'getLatestCorrectiveActionVerification', permission: 'corrective_action_verification.read', tag: 'Corrective Action Verification' },
  'GET /corrective-actions/{id}/verification/history': { operationId: 'listCorrectiveActionVerificationHistory', permission: 'corrective_action_verification.read', tag: 'Corrective Action Verification' },
};

/** Modules touched by PART 03. */
const PART03_MODULES = [
  'engineering-reports',
  'corrective-action-verifications',
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
for (const module of PART03_MODULES) {
  for (const route of registeredRoutes(module)) {
    registered.add(canonical(route));
  }
}

describe('CR-BE-MOB-03 PART 03 — Engineering & corrective-action verification contract', () => {
  it('publishes the 14 existing operations with correct ids, tags, permissions and scope', () => {
    const seen: string[] = [];
    for (const [key, expected] of Object.entries(PUBLISHED)) {
      const [method, path] = key.split(' ');
      const op = spec.paths?.[path]?.[method.toLowerCase()];
      assert.ok(op, `${key} must exist in OpenAPI`);
      assert.equal(op.operationId, expected.operationId);
      assert.ok((op.tags ?? []).includes(expected.tag), `${expected.operationId} must be tagged ${expected.tag}`);
      assert.equal(op['x-required-permission'], expected.permission, `${expected.operationId} must require ${expected.permission}`);
      assert.equal(op['x-building-scoped'], true, `${expected.operationId} must be building-scoped`);
      assert.ok(
        (op.security ?? []).some((s: Record<string, unknown>) => 'bearerAuth' in s),
        `${expected.operationId} must require bearer auth`,
      );
      seen.push(key);
    }
    assert.equal(seen.length, 14, 'PART 03 publishes exactly 14 operations');
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
    assert.ok(seeded.has('engineering_report.read'));
    assert.ok(seeded.has('corrective_action_verification.read'));
    assert.ok(seeded.has('corrective_action_verification.manage'));
  });

  it('documents exactly the implemented /mobile/verification target types', () => {
    const op = spec.paths?.['/mobile/verification/{targetType}/{targetId}']?.get;
    assert.ok(op, 'mobile verification must still be published');
    const ref = op.parameters?.find(
      (p: { $ref?: string }) => p?.$ref === '#/components/parameters/VerificationTargetTypeParam',
    );
    const param = ref
      ? spec.components.parameters.VerificationTargetTypeParam
      : op.parameters?.find((p: { name?: string }) => p?.name === 'targetType');
    const schema = param?.schema ?? {};
    const enums = schema.enum ?? [];
    assert.deepEqual(
      [...enums].sort(),
      ['CHECKLIST_EXECUTION', 'FINDING', 'FORM_INSTANCE', 'WORK_ORDER'].sort(),
      '/mobile/verification target types must equal the implemented set (WORK_ORDER added by CR-BE-MOB-03 PART 05; no CORRECTIVE_ACTION)',
    );
  });

  it('creates no /mobile/engineering facade and no duplicate operationId', () => {
    const mobile: string[] = [];
    const allOpIds = new Set<string>();
    const duplicates: string[] = [];
    for (const [p, methods] of Object.entries<any>(spec.paths ?? {})) {
      if (p.startsWith('/mobile/engineering')) mobile.push(p);
      for (const [m, op] of Object.entries<any>(methods)) {
        if (!op?.operationId) continue;
        if (allOpIds.has(op.operationId)) duplicates.push(op.operationId);
        allOpIds.add(op.operationId);
      }
    }
    assert.deepEqual(mobile, [], 'no /mobile/engineering facade may exist');
    assert.deepEqual(duplicates, [], 'no duplicate operationId may exist');
  });

  it('rejects unauthenticated requests with 401, never 404', async () => {
    const request = api();
    const samples: Array<{ method: 'get' | 'post'; path: string }> = [
      { method: 'get', path: '/engineering/reports/technical-summary?buildingId=00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/engineering/reports/inspections?buildingId=00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/engineering/reports/meter-readings?buildingId=00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/engineering/reports/equipment-logs?buildingId=00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/engineering/reports/checklists?buildingId=00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/engineering/reports/breakdowns?buildingId=00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/engineering/reports/maintenance?buildingId=00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/engineering/reports/findings?buildingId=00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/corrective-action-verifications' },
      { method: 'get', path: '/corrective-actions/00000000-0000-4000-8000-000000000001/verification' },
      { method: 'post', path: '/corrective-actions/00000000-0000-4000-8000-000000000001/verification' },
      { method: 'post', path: '/corrective-actions/00000000-0000-4000-8000-000000000001/verification/decision' },
      { method: 'get', path: '/corrective-actions/00000000-0000-4000-8000-000000000001/verification/latest' },
      { method: 'get', path: '/corrective-actions/00000000-0000-4000-8000-000000000001/verification/history' },
    ];
    for (const { method, path } of samples) {
      const response =
        method === 'get'
          ? await request.get(`${API_PREFIX}${path}`)
          : await request.post(`${API_PREFIX}${path}`).send({});
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
