import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { shiftService } from '../src/modules/shifts';
import { workforceService } from '../src/modules/workforce';
import { assignShiftToWorkforce } from '../src/modules/workforce-shifts';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-MOB-05 PART 02 — Workforce Attendance focused validation.
 *
 * Proves the backend-authoritative clock-in / clock-out contract:
 * authentication + RBAC, valid lifecycle (no duplicate active clock-in, no
 * clock-out without active attendance), Building isolation (403 outside the
 * accessible set), authoritative identity (session-derived, never
 * caller-supplied), authoritative timestamps (database clock, client fields
 * ignored), the optional shift binding ("when available"), validation
 * errors, and per-profile uniqueness.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       workforce_shift_assignments, shifts,
       workforce_profiles, positions, departments, organizations,
       user_building_assignments, buildings, properties,
       users, roles, permissions, clients, attendance_records
     CASCADE`,
  );
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const TZ = 'Asia/Jakarta';

type Fixture = Awaited<ReturnType<typeof seed>>;

/**
 * Creates a fully isolated fixture: a fresh admin user (with the seeded
 * attendance permissions), a fresh Client hierarchy, and a Workforce Profile
 * linked to that user. Each test gets its own user + profile so attendance
 * state never leaks between tests (`workforce_profiles.user_id` is unique).
 */
async function seed() {
  const manager = await createAdminUser();
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Attendance client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A',
    timezone: TZ,
  });
  // Inaccessible building: never assigned to the manager.
  const buildingB = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building B',
    timezone: TZ,
  });
  // INACTIVE building.
  const buildingInactive = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building Inactive',
    timezone: TZ,
    status: 'INACTIVE',
  });
  await buildingAssignmentService.createAssignment(manager.userId, {
    buildingId: buildingA.id,
  });

  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `O_${suffix()}`,
    name: 'Organization',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Department',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `P_${suffix()}`,
    name: 'Technician',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: manager.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Mobile Worker',
  });

  return {
    token: manager.token,
    userId: manager.userId,
    client,
    profile,
    buildingA,
    buildingB,
    buildingInactive,
  };
}

function assertServerTimestamp(value: string): Date {
  const parsed = new Date(value);
  assert.ok(
    !Number.isNaN(parsed.getTime()) && Math.abs(Date.now() - parsed.getTime()) < 120_000,
    `timestamp must be a recent server-set ISO-8601 instant (got ${value})`,
  );
  return parsed;
}

describe('CR-BE-MOB-05 PART 02 — workforce attendance', () => {
  it('rejects unauthenticated requests with 401, never 404', async () => {
    for (const [method, path] of [
      ['post', '/api/v1/attendance/clock-in'],
      ['post', '/api/v1/attendance/clock-out'],
      ['get', '/api/v1/attendance/current'],
    ] as const) {
      const response =
        method === 'get'
          ? await api().get(path)
          : await api().post(path).send({});
      assert.equal(response.status, 401, `${method.toUpperCase()} ${path}`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });

  it('rejects an authenticated user without attendance permissions with 403', async (t) => {
    if (!ready(t)) return;
    const token = await createPlainSession();
    for (const [method, path, body] of [
      ['post', '/api/v1/attendance/clock-in', { buildingId: randomUUID() }],
      ['post', '/api/v1/attendance/clock-out', {}],
      ['get', '/api/v1/attendance/current', undefined],
    ] as const) {
      const response =
        method === 'get'
          ? await api().get(path).set({ Authorization: `Bearer ${token}` })
          : await api().post(path).set({ Authorization: `Bearer ${token}` }).send(body);
      assert.equal(response.status, 403, `${method.toUpperCase()} ${path}`);
      assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    }
  });

  it('rejects a missing or malformed buildingId with 400', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const missing = await api()
      .post('/api/v1/attendance/clock-in')
      .set({ Authorization: `Bearer ${f.token}` })
      .send({});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');

    const malformed = await api()
      .post('/api/v1/attendance/clock-in')
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ buildingId: 'not-a-uuid' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 for an unknown Building', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const response = await api()
      .post('/api/v1/attendance/clock-in')
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ buildingId: '00000000-0000-4000-8000-000000000001' });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'BUILDING_NOT_FOUND');
  });

  it('rejects clock-in at an inaccessible Building with 403', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const response = await api()
      .post('/api/v1/attendance/clock-in')
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ buildingId: f.buildingB.id });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('rejects clock-in at an INACTIVE Building (never accessible → 403)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    // BE-02F/BE-02G only resolves ACTIVE Buildings, so an INACTIVE Building
    // is never in the accessible set — the 403 is the isolation guarantee
    // (an inactive Building leaks no clock-in surface).
    const response = await api()
      .post('/api/v1/attendance/clock-in')
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ buildingId: f.buildingInactive.id });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('clocks in with server-authoritative identity, building and timestamps', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // A caller-supplied workforceProfileId / clockInAt must be IGNORED —
    // identity comes from the session and timestamps from the database.
    const response = await api()
      .post('/api/v1/attendance/clock-in')
      .set({ Authorization: `Bearer ${f.token}` })
      .send({
        buildingId: f.buildingA.id,
        workforceProfileId: '00000000-0000-4000-8000-000000000099',
        clockInAt: '1999-01-01T00:00:00.000Z',
      });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.ok(response.body.success);
    const record = response.body.data;
    assert.equal(record.status, 'CLOCKED_IN');
    assert.equal(record.workforceProfileId, f.profile.id);
    assert.equal(record.buildingId, f.buildingA.id);
    assert.equal(record.clientId, f.client.id);
    assert.equal(record.employeeCode, f.profile.employeeCode);
    assert.equal(record.buildingCode, f.buildingA.code);
    assert.ok(record.id && typeof record.id === 'string');
    assert.equal(record.workforceShiftAssignmentId, null);
    assert.equal(record.shiftId, null);
    assert.equal(record.clockOutAt, null);
    const clockInAt = assertServerTimestamp(record.clockInAt);
    assert.ok(
      clockInAt.getTime() > new Date('1999-01-01T00:00:00Z').getTime(),
      'the client-supplied clockInAt must never be used',
    );
  });

  it('binds the applicable ACTIVE roster assignment when available', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const shift = await shiftService.createShift({
      clientId: f.client.id,
      buildingId: f.buildingA.id,
      code: `S_${suffix()}`,
      name: 'Morning shift',
      startTime: '07:00:00',
      endTime: '15:00:00',
    });
    const assignment = await assignShiftToWorkforce({
      workforceProfileId: f.profile.id,
      shiftId: shift.id,
    });

    const response = await api()
      .post('/api/v1/attendance/clock-in')
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ buildingId: f.buildingA.id });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const record = response.body.data;
    assert.equal(record.workforceShiftAssignmentId, assignment.id);
    assert.equal(record.shiftId, shift.id);
    assert.equal(record.shiftCode, shift.code);
    assert.equal(record.shiftName, shift.name);
  });

  it('rejects a duplicate active clock-in with 409', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const first = await api()
      .post('/api/v1/attendance/clock-in')
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ buildingId: f.buildingA.id });
    assert.equal(first.status, 201);

    const second = await api()
      .post('/api/v1/attendance/clock-in')
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ buildingId: f.buildingA.id });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'ATTENDANCE_ACTIVE_ALREADY_EXISTS');
  });

  it('allows one open clock-in per profile (two users can be clocked in)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const other = await createAdminUser();
    await buildingAssignmentService.createAssignment(other.userId, {
      buildingId: f.buildingA.id,
    });
    const organization2 = await organizationService.createOrganization({
      clientId: f.client.id,
      code: `O_${suffix()}`,
      name: 'Organization 2',
    });
    const department2 = await departmentService.createDepartment({
      organizationId: organization2.id,
      code: `D_${suffix()}`,
      name: 'Department 2',
    });
    const position2 = await positionService.createPosition({
      organizationId: organization2.id,
      code: `P_${suffix()}`,
      name: 'Technician 2',
    });
    await workforceService.createWorkforceProfile({
      organizationId: organization2.id,
      departmentId: department2.id,
      positionId: position2.id,
      userId: other.userId,
      employeeCode: `WF_${suffix()}`,
      fullName: 'Mobile Worker 2',
    });

    const first = await api()
      .post('/api/v1/attendance/clock-in')
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ buildingId: f.buildingA.id });
    const second = await api()
      .post('/api/v1/attendance/clock-in')
      .set({ Authorization: `Bearer ${other.token}` })
      .send({ buildingId: f.buildingA.id });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201, 'a different profile may hold its own open clock-in');
    assert.notEqual(first.body.data.workforceProfileId, second.body.data.workforceProfileId);
  });

  it('returns the current open record, then null after clock-out', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const before = await api()
      .get('/api/v1/attendance/current')
      .set({ Authorization: `Bearer ${f.token}` });
    assert.equal(before.status, 200);
    assert.equal(before.body.data, null);

    const clockIn = await api()
      .post('/api/v1/attendance/clock-in')
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ buildingId: f.buildingA.id });
    assert.equal(clockIn.status, 201);

    const during = await api()
      .get('/api/v1/attendance/current')
      .set({ Authorization: `Bearer ${f.token}` });
    assert.equal(during.status, 200);
    assert.equal(during.body.data.id, clockIn.body.data.id);
    assert.equal(during.body.data.status, 'CLOCKED_IN');

    const clockOut = await api()
      .post('/api/v1/attendance/clock-out')
      .set({ Authorization: `Bearer ${f.token}` })
      .send({});
    assert.equal(clockOut.status, 200, JSON.stringify(clockOut.body));
    const closed = clockOut.body.data;
    assert.equal(closed.id, clockIn.body.data.id, 'clock-out closes the same record');
    assert.equal(closed.status, 'CLOCKED_OUT');
    const clockOutAt = assertServerTimestamp(closed.clockOutAt);
    const clockInAt = assertServerTimestamp(closed.clockInAt);
    assert.ok(
      clockOutAt.getTime() >= clockInAt.getTime(),
      'clockOutAt must be the same as or after clockInAt',
    );

    const afterOut = await api()
      .get('/api/v1/attendance/current')
      .set({ Authorization: `Bearer ${f.token}` });
    assert.equal(afterOut.body.data, null);
  });

  it('rejects clock-out without an active attendance with 409', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const response = await api()
      .post('/api/v1/attendance/clock-out')
      .set({ Authorization: `Bearer ${f.token}` })
      .send({});
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'ATTENDANCE_NOT_ACTIVE');
  });

  it('returns null current attendance for a user without a linked profile', async (t) => {
    if (!ready(t)) return;
    // The user must hold attendance.read to reach the service; without a
    // linked Workforce Profile the self-service read is still 200 + null.
    const token = await createSessionWithPermissions([
      { code: 'attendance.read', name: 'Read Own Attendance' },
    ]);
    const response = await api()
      .get('/api/v1/attendance/current')
      .set({ Authorization: `Bearer ${token}` });
    assert.equal(response.status, 200);
    assert.equal(response.body.data, null);
  });
});
