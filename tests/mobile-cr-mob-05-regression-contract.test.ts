import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { FOUNDATION_PERMISSIONS } from '../src/database/seeds/foundation-access.seed';
import { api } from './helpers/http';

/**
 * CR-BE-MOB-05 PART 04 — Cross-contract regression (validation only).
 *
 * One DB-free suite that freezes the complete CR-BE-MOB-05 backend surface
 * (PART 01 Mobile Upcoming Shifts, PART 02 Workforce Attendance, PART 03
 * Security Operational Logbook) and re-validates the cross-contract
 * boundaries:
 *
 *   OpenAPI/runtime parity   — every documented CR-BE-MOB-05 operation is
 *                              registered in the router, unique operationIds,
 *                              all $refs resolve;
 *   RBAC + scope metadata    — permissions are REAL seeded codes and the
 *                              Building-scope annotations match what the
 *                              runtime enforces (auth-only self-service for
 *                              upcoming-shifts + attendance; x-building-scoped
 *                              for the Building-nested logbook surface);
 *   Authoritative identity   — no caller-supplied identity field exists in
 *                              any CR-BE-MOB-05 request schema (identity is
 *                              always session-derived) and no client-generated
 *                              id field exists in any response schema;
 *   Cross-contract boundaries— no /mobile/{domain} duplicate facade, no
 *                              Management Read Model substitution (the
 *                              surface lives on the domain routes, not
 *                              /management/*), no invented ids;
 *   Regression               — PART 01/02/03 operations stay published and
 *                              the pre-existing BE-25M self-service contract
 *                              (getMobileCurrentShift / getMobileMyTeam)
 *                              is untouched.
 *
 * Deliberately DB-free: lifecycle/timestamp/isolation runtime behavior is
 * covered by the DB-backed suites (attendance.test.ts, upcoming-shifts,
 * security-logbook.test.ts) — see the handoff document.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const MODULES_DIR = resolve(__dirname, '../src/modules');
const ROUTES_DIR = resolve(__dirname, '../src/routes');

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

const SEEDED_PERMISSIONS = new Set(
  FOUNDATION_PERMISSIONS.map((permission) => permission.code),
);

/**
 * The frozen CR-BE-MOB-05 published surface. `permission: null` means
 * authentication-only self-service (same posture as getMobileCurrentShift).
 * `scoped: 'self'` means the operation deliberately does NOT claim
 * x-building-scoped (caller-scoped, not Building-nested).
 */
const CR_MOB_05_SURFACE: Array<{
  path: string;
  method: string;
  operationId: string;
  permission: string | null;
  scoped: boolean | 'self';
}> = [
  // PART 01 — Mobile Upcoming Shifts
  {
    path: '/mobile/upcoming-shifts',
    method: 'get',
    operationId: 'getMobileUpcomingShifts',
    permission: null,
    scoped: 'self',
  },
  // PART 02 — Workforce Attendance
  {
    path: '/attendance/clock-in',
    method: 'post',
    operationId: 'clockInAttendance',
    permission: 'attendance.manage',
    scoped: 'self',
  },
  {
    path: '/attendance/clock-out',
    method: 'post',
    operationId: 'clockOutAttendance',
    permission: 'attendance.manage',
    scoped: 'self',
  },
  {
    path: '/attendance/current',
    method: 'get',
    operationId: 'getCurrentAttendance',
    permission: 'attendance.read',
    scoped: 'self',
  },
  // PART 03 — Security Operational Logbook
  {
    path: '/buildings/{buildingId}/security/logbook',
    method: 'post',
    operationId: 'createSecurityLogbookEntry',
    permission: 'security_logbook.manage',
    scoped: true,
  },
  {
    path: '/buildings/{buildingId}/security/logbook',
    method: 'get',
    operationId: 'listSecurityLogbookEntries',
    permission: 'security_logbook.read',
    scoped: true,
  },
  {
    path: '/security/logbook/{id}',
    method: 'get',
    operationId: 'getSecurityLogbookEntry',
    permission: 'security_logbook.read',
    scoped: true,
  },
  {
    path: '/security/logbook/{id}',
    method: 'patch',
    operationId: 'updateSecurityLogbookEntry',
    permission: 'security_logbook.manage',
    scoped: true,
  },
];

/** The CR-BE-MOB-05 request schemas must never accept identity from the client. */
const CR_MOB_05_REQUEST_SCHEMAS = [
  'ClockInRequest',
  'CreateSecurityLogbookEntryRequest',
  'UpdateSecurityLogbookEntryRequest',
];

/** The CR-BE-MOB-05 response schemas must carry authoritative ids only. */
const CR_MOB_05_RESPONSE_SCHEMAS = [
  'MobileUpcomingShift',
  'MobileUpcomingShiftsContext',
  'AttendanceRecord',
  'SecurityLogbookEntry',
];

function operations(): Array<{ path: string; method: string; op: any }> {
  const out: Array<{ path: string; method: string; op: any }> = [];
  for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      out.push({ path, method, op });
    }
  }
  return out;
}

function normalize(path: string): string {
  return path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p').replace(/\{[^}]+\}/g, ':p');
}

function registeredRoutes(): Set<string> {
  const set = new Set<string>();
  const pattern = /\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.routes.ts')) continue;
      const source = readFileSync(full, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        set.add(`${match[1].toUpperCase()} ${normalize(match[2])}`);
      }
    }
  }
  walk(MODULES_DIR);
  walk(ROUTES_DIR);
  return set;
}

const byOperationId = new Map(
  operations().map(({ path, method, op }) => [op.operationId, { path, method, op }]),
);

describe('CR-BE-MOB-05 PART 04 — cross-contract regression', () => {
  it('publishes the complete CR-BE-MOB-05 surface (8 operations) with exact ids', () => {
    for (const entry of CR_MOB_05_SURFACE) {
      const op = spec.paths?.[entry.path]?.[entry.method];
      assert.ok(
        op,
        `${entry.method.toUpperCase()} ${entry.path} must exist in OpenAPI`,
      );
      assert.equal(op.operationId, entry.operationId);
    }
    assert.equal(CR_MOB_05_SURFACE.length, 8);
  });

  it('OpenAPI/runtime parity — every documented operation is registered', () => {
    const registered = registeredRoutes();
    const phantom: string[] = [];
    for (const { path, method, op } of operations()) {
      const key = `${method.toUpperCase()} ${normalize(path)}`;
      if (!registered.has(key)) phantom.push(`${op.operationId} (${key})`);
    }
    assert.deepEqual(phantom, [], 'no documented operation may be unregistered');
  });

  it('unique operationIds and resolvable $refs across the whole spec', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const { op } of operations()) {
      if (!op.operationId) continue;
      if (seen.has(op.operationId)) duplicates.push(op.operationId);
      seen.add(op.operationId);
    }
    assert.deepEqual(duplicates, []);
    const known = new Set([
      ...Object.keys(spec.components.schemas ?? {}),
      ...Object.keys(spec.components.responses ?? {}),
      ...Object.keys(spec.components.parameters ?? {}),
    ]);
    const unresolved: string[] = [];
    (function walk(node: unknown): void {
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref') {
            const target = String(value).split('/').pop()!;
            if (!known.has(target)) unresolved.push(String(value));
          } else {
            walk(value);
          }
        }
      }
    })(spec);
    assert.deepEqual(unresolved, []);
  });

  it('RBAC + scope metadata — exact permissions and honest scope claims', () => {
    const unknownPermission: string[] = [];
    const wrongPermission: string[] = [];
    const wrongScope: string[] = [];
    for (const entry of CR_MOB_05_SURFACE) {
      const op = spec.paths[entry.path][entry.method];
      const code = op['x-required-permission'];
      if (entry.permission === null) {
        if (code !== undefined) {
          wrongPermission.push(`${entry.operationId} must be auth-only`);
        }
      } else {
        if (code !== entry.permission) {
          wrongPermission.push(`${entry.operationId} must require ${entry.permission}`);
        }
        if (!SEEDED_PERMISSIONS.has(code)) {
          unknownPermission.push(`${entry.operationId} -> ${code}`);
        }
      }
      const claimed = op['x-building-scoped'] === true;
      if (entry.scoped === true && !claimed) {
        wrongScope.push(`${entry.operationId} must be x-building-scoped: true`);
      }
      if (entry.scoped === 'self' && claimed) {
        wrongScope.push(`${entry.operationId} must not claim x-building-scoped`);
      }
    }
    assert.deepEqual(unknownPermission, []);
    assert.deepEqual(wrongPermission, []);
    assert.deepEqual(wrongScope, []);
    assert.ok(SEEDED_PERMISSIONS.has('attendance.read'));
    assert.ok(SEEDED_PERMISSIONS.has('attendance.manage'));
    assert.ok(SEEDED_PERMISSIONS.has('security_logbook.read'));
    assert.ok(SEEDED_PERMISSIONS.has('security_logbook.manage'));
  });

  it('authoritative identity — no caller-supplied identity in any request schema', () => {
    const bannedIdentity = /^(workforceProfileId|userId|employeeCode)$/;
    const offenders: string[] = [];
    for (const name of CR_MOB_05_REQUEST_SCHEMAS) {
      const schema = spec.components.schemas[name];
      assert.ok(schema, `${name} must exist`);
      for (const property of Object.keys(schema.properties ?? {})) {
        if (bannedIdentity.test(property)) offenders.push(`${name}.${property}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'identity must come from the authenticated session, never the client',
    );
  });

  it('stable authoritative IDs — no client-generated id in any response schema', () => {
    const banned = /^(localId|tempId|clientId_local|clientGeneratedId|offlineId|fakeId|mockId)$/;
    const offenders: string[] = [];
    for (const name of CR_MOB_05_RESPONSE_SCHEMAS) {
      const schema = spec.components.schemas[name];
      assert.ok(schema, `${name} must exist`);
      const walk = (node: unknown, path: string): void => {
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
          if (banned.test(key)) offenders.push(`${name}.${path}${key}`);
          walk(value, `${path}${key}.`);
        }
      };
      walk(schema.properties ?? {}, '');
    }
    assert.deepEqual(offenders, [], 'no client-generated id field may exist');
  });

  it('no mobile-domain duplicate backend and no Management Read Model substitution', () => {
    const facades = Object.keys(spec.paths).filter((p: string) =>
      /\/mobile\/(housekeeping|security|engineering|material|inventory|work-order|patrol|incident|push-send|attendance|logbook)/.test(
        p,
      ),
    );
    assert.deepEqual(facades, [], 'no mobile-specific domain API may exist');

    // The CR-BE-MOB-05 surface lives on the domain routes, never under
    // /management/* (no Management Read Model substitution for the mobile
    // workforce/supervisor surface).
    for (const entry of CR_MOB_05_SURFACE) {
      assert.ok(
        !entry.path.startsWith('/management/'),
        `${entry.path} must not be a Management Read Model route`,
      );
    }
    // The only legitimate /mobile/* self-service reads remain BE-25M/N.
    assert.ok(spec.paths['/mobile/current-shift'], 'current-shift stays');
    assert.ok(spec.paths['/mobile/my-team'], 'my-team stays');
    assert.ok(spec.paths['/mobile/upcoming-shifts'], 'upcoming-shifts is BE-25M-family self-service, not a facade');
  });

  it('no invented shift/handover IDs — bindings reference authoritative rows', () => {
    // Upcoming shifts reuse the MobileCurrentShift roster-row shape.
    assert.equal(
      spec.components.schemas.MobileUpcomingShift.allOf?.[0]?.$ref,
      '#/components/schemas/MobileCurrentShift',
    );
    // Attendance and logbook bindings are nullable references to the
    // authoritative rows, never invented codes/ids.
    for (const [schemaName, field] of [
      ['AttendanceRecord', 'workforceShiftAssignmentId'],
      ['AttendanceRecord', 'shiftId'],
      ['SecurityLogbookEntry', 'shiftHandoverId'],
    ] as const) {
      const fieldSchema = spec.components.schemas[schemaName].properties[field];
      assert.equal(fieldSchema.format, 'uuid', `${schemaName}.${field} must be a UUID`);
      assert.equal(fieldSchema.nullable, true, `${schemaName}.${field} must be nullable`);
    }
    // No outgoing/incoming shift id field is invented on the logbook entry.
    const logbookProps = Object.keys(
      spec.components.schemas.SecurityLogbookEntry.properties,
    );
    assert.ok(
      !logbookProps.some((p) => /outgoingShift|incomingShift/.test(p)),
      'logbook must not invent outgoing/incoming shift ids',
    );
  });

  it('keeps the pre-existing BE-25M self-service contract published (regression)', () => {
    for (const [path, operationId] of [
      ['/mobile/current-shift', 'getMobileCurrentShift'],
      ['/mobile/my-team', 'getMobileMyTeam'],
    ] as const) {
      const op = spec.paths?.[path]?.get;
      assert.ok(op, `${operationId} must stay published`);
      assert.equal(op.operationId, operationId);
      assert.equal(op['x-required-permission'], undefined, 'auth-only self-service');
    }
  });

  it('rejects unauthenticated requests with 401, never 404, before RBAC/validation', async () => {
    const request = api();
    const API_PREFIX = '/api/v1';
    const samples = [
      { method: 'get', path: '/mobile/upcoming-shifts' },
      { method: 'post', path: '/attendance/clock-in' },
      { method: 'post', path: '/attendance/clock-out' },
      { method: 'get', path: '/attendance/current' },
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
      assert.notEqual(response.status, 404, `${method.toUpperCase()} ${path} must be registered`);
      assert.equal(response.status, 401, `${method.toUpperCase()} ${path} must require authentication`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });
});
