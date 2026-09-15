import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { FOUNDATION_PERMISSIONS } from '../src/database/seeds/foundation-access.seed';
import { api } from './helpers/http';

/**
 * CR-BE-MOB-05 PART 02 — Workforce Attendance contract.
 *
 * Documentation-only checks (no database):
 *  - the three attendance operations are published with their exact
 *    operationIds, methods, tags and permissions (`attendance.manage` for
 *    clock-in/out, `attendance.read` for current);
 *  - every documented permission is a REAL seeded catalogue code;
 *  - the published surface is actually registered in the attendance router
 *    (no invented endpoint) with no duplicate operationId;
 *  - no `/mobile/{domain}` duplicate facade was created;
 *  - the schemas carry authoritative ids only (no client-generated id);
 *  - CR-BE-MOB-05 PART 01 behavior is preserved (`getMobileUpcomingShifts`
 *    and `getMobileCurrentShift` stay published);
 *  - unauthenticated calls are rejected by auth middleware (401, never 404)
 *    and authentication runs before RBAC/validation.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const ROUTES_PATH = resolve(
  __dirname,
  '../src/modules/attendance/attendance.routes.ts',
);
const API_PREFIX = '/api/v1';

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

const SEEDED_PERMISSIONS = new Set(
  FOUNDATION_PERMISSIONS.map((permission) => permission.code),
);

/** path → { method, operationId, permission }. */
const PUBLISHED: Record<
  string,
  { method: string; operationId: string; permission: string }
> = {
  '/attendance/clock-in': {
    method: 'post',
    operationId: 'clockInAttendance',
    permission: 'attendance.manage',
  },
  '/attendance/clock-out': {
    method: 'post',
    operationId: 'clockOutAttendance',
    permission: 'attendance.manage',
  },
  '/attendance/current': {
    method: 'get',
    operationId: 'getCurrentAttendance',
    permission: 'attendance.read',
  },
};

function allOperations(): Array<{ path: string; method: string; op: any }> {
  const out: Array<{ path: string; method: string; op: any }> = [];
  for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      out.push({ path, method, op });
    }
  }
  return out;
}

describe('CR-BE-MOB-05 PART 02 — workforce attendance contract', () => {
  it('publishes the three attendance operations with exact ids and tags', () => {
    for (const [path, expected] of Object.entries(PUBLISHED)) {
      const op = spec.paths?.[path]?.[expected.method];
      assert.ok(op, `${expected.method.toUpperCase()} ${path} must exist in OpenAPI`);
      assert.equal(op.operationId, expected.operationId);
      assert.deepEqual(op.tags ?? [], ['Attendance']);
    }
    assert.ok(
      (spec.tags ?? []).some((t: { name: string }) => t.name === 'Attendance'),
      'the Attendance tag must be declared',
    );
  });

  it('requires REAL seeded permission codes', () => {
    const missing: string[] = [];
    const unknown: string[] = [];
    for (const [path, expected] of Object.entries(PUBLISHED)) {
      const op = spec.paths[path][expected.method];
      const code = op['x-required-permission'];
      if (!code) missing.push(`${expected.method.toUpperCase()} ${path}`);
      else if (!SEEDED_PERMISSIONS.has(code)) unknown.push(`${expected.operationId} -> ${code}`);
      assert.equal(code, expected.permission, `${path} must require ${expected.permission}`);
    }
    assert.deepEqual(missing, [], 'every published operation records a permission');
    assert.deepEqual(unknown, [], 'a documented permission must be seeded');
    assert.ok(SEEDED_PERMISSIONS.has('attendance.read'));
    assert.ok(SEEDED_PERMISSIONS.has('attendance.manage'));
  });

  it('is registered in the attendance router (no invented endpoint, no duplicate id)', () => {
    const source = readFileSync(ROUTES_PATH, 'utf8');
    for (const [path, expected] of Object.entries(PUBLISHED)) {
      assert.match(
        source,
        new RegExp(`\\.${expected.method}\\(\\s*'${path}'`),
        `the router must register ${expected.method.toUpperCase()} ${path}`,
      );
    }
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const { op } of allOperations()) {
      if (seen.has(op.operationId)) duplicates.push(op.operationId);
      seen.add(op.operationId);
    }
    assert.deepEqual(duplicates, [], 'no duplicate operationId may exist');
  });

  it('adds no /mobile/{domain} duplicate facade', () => {
    const facade = /\/mobile\/(housekeeping|security|engineering|material|inventory|work-order|patrol|incident|push-send|attendance)/;
    const offenders = Object.keys(spec.paths ?? {}).filter((p) =>
      facade.test(p),
    );
    assert.deepEqual(offenders, []);
  });

  it('documents the authoritative attendance schema without invented ids', () => {
    const record = spec.components.schemas.AttendanceRecord;
    assert.ok(record, 'AttendanceRecord schema must exist');
    assert.deepEqual(
      record.required,
      [
        'id', 'clientId', 'buildingId', 'buildingCode', 'buildingName',
        'workforceProfileId', 'employeeCode', 'workforceShiftAssignmentId',
        'shiftId', 'shiftCode', 'shiftName', 'clockInAt', 'clockOutAt',
        'status', 'createdAt', 'updatedAt',
      ],
    );
    assert.equal(
      record.properties.status.$ref,
      '#/components/schemas/AttendanceStatus',
    );
    assert.deepEqual(
      spec.components.schemas.AttendanceStatus.enum,
      ['CLOCKED_IN', 'CLOCKED_OUT'],
    );
    assert.deepEqual(
      spec.components.schemas.ClockInRequest.required,
      ['buildingId'],
    );

    const banned = /^(localId|tempId|clientId_local|clientGeneratedId|offlineId|fakeId|mockId)$/;
    const offenders: string[] = [];
    for (const schema of [record, spec.components.schemas.ClockInRequest]) {
      for (const property of Object.keys(schema.properties ?? {})) {
        if (banned.test(property)) offenders.push(property);
      }
    }
    assert.deepEqual(offenders, [], 'no client-generated id field may exist');
  });

  it('keeps CR-BE-MOB-05 PART 01 behavior published (regression)', () => {
    const upcoming = spec.paths?.['/mobile/upcoming-shifts']?.get;
    assert.ok(upcoming, 'getMobileUpcomingShifts must stay published');
    assert.equal(upcoming.operationId, 'getMobileUpcomingShifts');
    const current = spec.paths?.['/mobile/current-shift']?.get;
    assert.ok(current, 'getMobileCurrentShift must stay published');
    assert.equal(current.operationId, 'getMobileCurrentShift');
  });

  it('rejects unauthenticated requests with 401, never 404, before RBAC/validation', async () => {
    const request = api();
    const samples = [
      { method: 'post', path: '/attendance/clock-in' },
      { method: 'post', path: '/attendance/clock-out' },
      { method: 'get', path: '/attendance/current' },
    ] as const;
    for (const { method, path } of samples) {
      const response =
        method === 'get'
          ? await request.get(`${API_PREFIX}${path}`)
          : await request.post(`${API_PREFIX}${path}`).send({});
      assert.notEqual(response.status, 404, `${path} must be registered`);
      assert.equal(response.status, 401, `${path} must require authentication`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
    // Authentication runs before validation: an unauthenticated clock-in
    // with a malformed body is 401, never a 400 leak.
    const bad = await request
      .post(`${API_PREFIX}/attendance/clock-in`)
      .send({});
    assert.equal(bad.status, 401);
  });
});
