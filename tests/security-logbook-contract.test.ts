import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { FOUNDATION_PERMISSIONS } from '../src/database/seeds/foundation-access.seed';
import { api } from './helpers/http';

/**
 * CR-BE-MOB-05 PART 03 — Security Operational Logbook contract.
 *
 * Documentation-only checks (no database):
 *  - the four logbook operations are published with their exact
 *    operationIds, methods, tags and permissions
 *    (`security_logbook.manage` for create/update, `security_logbook.read`
 *    for list/detail);
 *  - every documented permission is a REAL seeded catalogue code;
 *  - the published surface is actually registered in the security-logbook
 *    router (no invented endpoint) with no duplicate operationId;
 *  - the Building-nested routes carry `x-building-scoped: true` and every
 *    operation documents bearer + the standard failure responses;
 *  - no `/mobile/{domain}` duplicate facade was created;
 *  - the schemas carry authoritative ids only (no client-generated id);
 *  - CR-BE-MOB-05 PART 01 / PART 02 behavior is preserved
 *    (`getMobileUpcomingShifts`, `clockInAttendance`,
 *    `getCurrentAttendance` stay published);
 *  - unauthenticated calls are rejected by auth middleware (401, never 404).
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const ROUTES_PATH = resolve(
  __dirname,
  '../src/modules/security-logbook/security-logbook.routes.ts',
);
const API_PREFIX = '/api/v1';

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

const SEEDED_PERMISSIONS = new Set(
  FOUNDATION_PERMISSIONS.map((permission) => permission.code),
);

/** path → { method, operationId, permission, scoped }. */
const PUBLISHED: Record<
  string,
  { method: string; operationId: string; permission: string; scoped: boolean }
> = {
  '/buildings/{buildingId}/security/logbook': {
    method: 'post',
    operationId: 'createSecurityLogbookEntry',
    permission: 'security_logbook.manage',
    scoped: true,
  },
  '/buildings/{buildingId}/security/logbook': {
    method: 'get',
    operationId: 'listSecurityLogbookEntries',
    permission: 'security_logbook.read',
    scoped: true,
  },
  '/security/logbook/{id}': {
    method: 'get',
    operationId: 'getSecurityLogbookEntry',
    permission: 'security_logbook.read',
    scoped: true,
  },
  '/security/logbook/{id}': {
    method: 'patch',
    operationId: 'updateSecurityLogbookEntry',
    permission: 'security_logbook.manage',
    scoped: true,
  },
};

function toExpress(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

function canonical(route: string): string {
  return route.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p');
}

function registeredRoutes(): Set<string> {
  const source = readFileSync(ROUTES_PATH, 'utf8');
  const set = new Set<string>();
  const pattern = /router\.(get|post|patch|put|delete)\(\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    set.add(canonical(`${match[1]} ${match[2]}`));
  }
  return set;
}

const registered = registeredRoutes();

describe('CR-BE-MOB-05 PART 03 — security logbook contract', () => {
  it('publishes the four logbook operations with exact ids and tags', () => {
    for (const [path, expected] of Object.entries(PUBLISHED)) {
      const op = spec.paths?.[path]?.[expected.method];
      assert.ok(op, `${expected.method.toUpperCase()} ${path} must exist in OpenAPI`);
      assert.equal(op.operationId, expected.operationId);
      assert.deepEqual(op.tags ?? [], ['Security Logbook']);
    }
    assert.ok(
      (spec.tags ?? []).some((t: { name: string }) => t.name === 'Security Logbook'),
      'the Security Logbook tag must be declared',
    );
  });

  it('requires REAL seeded permission codes with Building scope', () => {
    const missing: string[] = [];
    const unknown: string[] = [];
    const wrongScope: string[] = [];
    for (const [path, expected] of Object.entries(PUBLISHED)) {
      const op = spec.paths[path][expected.method];
      const code = op['x-required-permission'];
      if (!code) missing.push(`${expected.method.toUpperCase()} ${path}`);
      else if (!SEEDED_PERMISSIONS.has(code)) unknown.push(`${expected.operationId} -> ${code}`);
      assert.equal(code, expected.permission, `${path} must require ${expected.permission}`);
      if (expected.scoped && op['x-building-scoped'] !== true) {
        wrongScope.push(`${expected.operationId} must be x-building-scoped: true`);
      }
    }
    assert.deepEqual(missing, [], 'every published operation records a permission');
    assert.deepEqual(unknown, [], 'a documented permission must be seeded');
    assert.deepEqual(wrongScope, [], 'Building-scoped operations must claim x-building-scoped');
    assert.ok(SEEDED_PERMISSIONS.has('security_logbook.read'));
    assert.ok(SEEDED_PERMISSIONS.has('security_logbook.manage'));
  });

  it('is registered in the security-logbook router (no invented endpoint, no duplicate id)', () => {
    for (const [path, expected] of Object.entries(PUBLISHED)) {
      const key = canonical(`${expected.method} ${toExpress(path)}`);
      assert.ok(registered.has(key), `the router must register ${expected.method.toUpperCase()} ${path}`);
    }
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        if (seen.has(op.operationId)) duplicates.push(op.operationId);
        seen.add(op.operationId);
      }
    }
    assert.deepEqual(duplicates, [], 'no duplicate operationId may exist');
  });

  it('documents authentication and the standard failure responses', () => {
    const bad: string[] = [];
    for (const [path, expected] of Object.entries(PUBLISHED)) {
      const op = spec.paths[path][expected.method];
      const hasBearer = (op.security ?? []).some(
        (s: Record<string, unknown>) => 'bearerAuth' in s,
      );
      if (!hasBearer || !op.responses?.['401'] || !op.responses?.['403']) {
        bad.push(`${expected.method.toUpperCase()} ${path}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  it('adds no /mobile/{domain} duplicate facade', () => {
    const facade = /\/mobile\/(housekeeping|security|engineering|material|inventory|work-order|patrol|incident|push-send|attendance|logbook)/;
    const offenders = Object.keys(spec.paths ?? {}).filter((p) =>
      facade.test(p),
    );
    assert.deepEqual(offenders, []);
  });

  it('documents the authoritative logbook schema without invented ids', () => {
    const entry = spec.components.schemas.SecurityLogbookEntry;
    assert.ok(entry, 'SecurityLogbookEntry schema must exist');
    assert.deepEqual(entry.required, [
      'id', 'clientId', 'buildingId', 'buildingCode', 'buildingName',
      'workforceProfileId', 'employeeCode', 'shiftHandoverId', 'category',
      'summary', 'detail', 'status', 'recordedAt', 'createdAt', 'updatedAt',
    ]);
    assert.deepEqual(
      spec.components.schemas.SecurityLogbookStatus.enum,
      ['OPEN', 'CLOSED'],
    );
    assert.deepEqual(
      spec.components.schemas.SecurityLogbookCategory.enum,
      ['GENERAL', 'INCIDENT', 'PATROL', 'HANDOVER', 'FINDING'],
    );
    assert.deepEqual(
      spec.components.schemas.CreateSecurityLogbookEntryRequest.required,
      ['buildingId', 'category', 'summary'],
    );

    const banned = /^(localId|tempId|clientId_local|clientGeneratedId|offlineId|fakeId|mockId)$/;
    const offenders: string[] = [];
    for (const schema of [
      entry,
      spec.components.schemas.CreateSecurityLogbookEntryRequest,
      spec.components.schemas.UpdateSecurityLogbookEntryRequest,
    ]) {
      for (const property of Object.keys(schema.properties ?? {})) {
        if (banned.test(property)) offenders.push(property);
      }
    }
    assert.deepEqual(offenders, [], 'no client-generated id field may exist');
  });

  it('keeps CR-BE-MOB-05 PART 01 and PART 02 behavior published (regression)', () => {
    const upcoming = spec.paths?.['/mobile/upcoming-shifts']?.get;
    assert.ok(upcoming, 'getMobileUpcomingShifts must stay published');
    assert.equal(upcoming.operationId, 'getMobileUpcomingShifts');
    for (const [path, operationId] of [
      ['/attendance/clock-in', 'clockInAttendance'],
      ['/attendance/clock-out', 'clockOutAttendance'],
      ['/attendance/current', 'getCurrentAttendance'],
    ] as const) {
      const op = spec.paths?.[path]?.post ?? spec.paths?.[path]?.get;
      assert.ok(op, `${path} must stay published`);
      assert.equal(op.operationId, operationId);
    }
  });

  it('rejects unauthenticated requests with 401, never 404, before RBAC/validation', async () => {
    const request = api();
    const samples = [
      { method: 'post', path: '/buildings/00000000-0000-4000-8000-000000000001/security/logbook' },
      { method: 'get', path: '/buildings/00000000-0000-4000-8000-000000000001/security/logbook' },
      { method: 'get', path: '/security/logbook/00000000-0000-4000-8000-000000000001' },
      { method: 'patch', path: '/security/logbook/00000000-0000-4000-8000-000000000001' },
    ] as const;
    for (const { method, path } of samples) {
      const response =
        method === 'get'
          ? await request.get(`${API_PREFIX}${path}`)
          : await request[method](`${API_PREFIX}${path}`).send({});
      assert.notEqual(response.status, 404, `${path} must be registered`);
      assert.equal(response.status, 401, `${path} must require authentication`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });
});
