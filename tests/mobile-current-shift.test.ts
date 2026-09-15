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
import {
  assignShiftToWorkforce,
  updateWorkforceShiftAssignment,
} from '../src/modules/workforce-shifts';
import { resolveCurrentShifts } from '../src/modules/mobile-current-shift';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-25M — Mobile Current Shift focused validation.
 *
 * Proves the derivation contract for `GET /mobile/current-shift`: the
 * authenticated user's effective current shift is resolved from the linked
 * Workforce Profile (BE-03C), the Shift roster (BE-03E), the BE-02F/G
 * Building access authority, the Building timezone and the current instant.
 * Also proves the safety boundaries: authentication, inactive shifts /
 * assignments, inaccessible Buildings, roster effective windows, missing
 * Building timezone, and overnight shift windows.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerToken = '';
let managerUserId = '';

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
       users, roles, permissions, clients
     CASCADE`,
  );
  const manager = await createAdminUser();
  managerToken = manager.token;
  managerUserId = manager.userId;
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

async function seed() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Current shift client',
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
  // Accessible building WITHOUT a timezone (cannot affirm "current").
  const buildingNoTz = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building NoTz',
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingNoTz.id,
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
    userId: managerUserId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Mobile Worker',
  });

  const shiftMorning = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Morning shift',
    startTime: '07:00:00',
    endTime: '15:00:00',
  });
  const shiftNight = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Night shift',
    startTime: '22:00:00',
    endTime: '06:00:00',
  });
  const shiftInactive = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Inactive shift',
    startTime: '07:00:00',
    endTime: '15:00:00',
    status: 'INACTIVE',
  });
  const shiftNoTz = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingNoTz.id,
    code: `S_${suffix()}`,
    name: 'No-timezone shift',
    startTime: '08:00:00',
    endTime: '16:00:00',
  });
  const shiftOtherBuilding = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingB.id,
    code: `S_${suffix()}`,
    name: 'Other building shift',
    startTime: '08:00:00',
    endTime: '16:00:00',
  });

  const morningAssignment = await assignShiftToWorkforce({
    workforceProfileId: profile.id,
    shiftId: shiftMorning.id,
  });
  await assignShiftToWorkforce({
    workforceProfileId: profile.id,
    shiftId: shiftNight.id,
  });
  await assignShiftToWorkforce({
    workforceProfileId: profile.id,
    shiftId: shiftInactive.id,
  });
  await assignShiftToWorkforce({
    workforceProfileId: profile.id,
    shiftId: shiftNoTz.id,
  });
  await assignShiftToWorkforce({
    workforceProfileId: profile.id,
    shiftId: shiftOtherBuilding.id,
  });

  return {
    client,
    profile,
    buildingA,
    shiftMorning,
    shiftNight,
    morningAssignment,
  };
}

describe('BE-25M mobile current shift', () => {
  it('rejects unauthenticated requests with 401, never 404', async () => {
    const response = await api().get('/api/v1/mobile/current-shift');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });

  it('returns an empty context for an authenticated user without a linked profile', async (t) => {
    if (!ready(t)) return;
    const token = await createPlainSession();
    const response = await api()
      .get('/api/v1/mobile/current-shift')
      .set({ Authorization: `Bearer ${token}` });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.success);
    assert.ok(typeof response.body.data.asOf === 'string');
    assert.deepEqual(response.body.data.shifts, []);
  });

  it('derives the same-day current shift from the roster, timezone and instant', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // 2026-08-20T02:00:00Z == 09:00 Asia/Jakarta — inside 07:00–15:00.
    const context = await resolveCurrentShifts(
      managerUserId,
      new Date('2026-08-20T02:00:00Z'),
    );
    assert.equal(context.shifts.length, 1);
    const shift = context.shifts[0];
    assert.equal(shift.shiftId, f.shiftMorning.id);
    assert.equal(shift.assignmentId, f.morningAssignment.id);
    assert.equal(shift.workforceProfileId, f.profile.id);
    assert.equal(shift.employeeCode, f.profile.employeeCode);
    assert.equal(shift.clientId, f.client.id);
    assert.equal(shift.buildingId, f.buildingA.id);
    assert.equal(shift.code, f.shiftMorning.code);
    assert.equal(shift.startTime, '07:00:00');
    assert.equal(shift.endTime, '15:00:00');
    assert.equal(shift.status, 'ACTIVE');
  });

  it('honours overnight windows and excludes the out-of-window shift', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // 2026-08-20T18:00:00Z == 01:00 Asia/Jakarta — inside the overnight
    // 22:00–06:00 window, outside 07:00–15:00.
    const context = await resolveCurrentShifts(
      managerUserId,
      new Date('2026-08-20T18:00:00Z'),
    );
    assert.equal(context.shifts.length, 1);
    assert.equal(context.shifts[0].shiftId, f.shiftNight.id);
  });

  it('returns an empty context outside every assigned window', async (t) => {
    if (!ready(t)) return;
    await seed();

    // 2026-08-20T09:00:00Z == 16:00 Asia/Jakarta — between 15:00 and 22:00.
    const context = await resolveCurrentShifts(
      managerUserId,
      new Date('2026-08-20T09:00:00Z'),
    );
    assert.deepEqual(context.shifts, []);
  });

  it('excludes a roster assignment whose effective window does not contain now', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const futureShift = await shiftService.createShift({
      clientId: f.client.id,
      buildingId: f.buildingA.id,
      code: `S_${suffix()}`,
      name: 'Future shift',
      startTime: '07:00:00',
      endTime: '15:00:00',
    });
    await assignShiftToWorkforce({
      workforceProfileId: f.profile.id,
      shiftId: futureShift.id,
      effectiveFrom: new Date('2026-08-21T00:00:00Z'),
    });

    // 09:00 Jakarta on the 20th — futureShift's roster starts on the 21st.
    const context = await resolveCurrentShifts(
      managerUserId,
      new Date('2026-08-20T02:00:00Z'),
    );
    assert.ok(
      context.shifts.every((shift) => shift.shiftId !== futureShift.id),
      'future roster must not appear before its effective window',
    );
    assert.equal(context.shifts.length, 1);
  });

  it('excludes an assignment deactivated to INACTIVE', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const extraShift = await shiftService.createShift({
      clientId: f.client.id,
      buildingId: f.buildingA.id,
      code: `S_${suffix()}`,
      name: 'Afternoon shift',
      startTime: '15:00:00',
      endTime: '23:00:00',
    });
    await assignShiftToWorkforce({
      workforceProfileId: f.profile.id,
      shiftId: extraShift.id,
    });
    await updateWorkforceShiftAssignment(f.profile.id, extraShift.id, {
      status: 'INACTIVE',
    });

    // 2026-08-20T10:00:00Z == 17:00 Jakarta — inside 15:00–23:00.
    const context = await resolveCurrentShifts(
      managerUserId,
      new Date('2026-08-20T10:00:00Z'),
    );
    assert.deepEqual(context.shifts, []);
  });

  it('excludes shifts in Buildings the caller cannot access', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // 2026-08-20T01:00:00Z == 08:00 Jakarta — inside buildingB's 08:00–16:00
    // shift, but buildingB was never assigned to the manager.
    const context = await resolveCurrentShifts(
      managerUserId,
      new Date('2026-08-20T01:00:00Z'),
    );
    assert.equal(context.shifts.length, 0);
    void f;
  });

  it('excludes shifts whose Building has no timezone (cannot affirm "current")', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // 2026-08-20T03:00:00Z == 10:00 Jakarta — inside buildingNoTz's
    // 08:00–16:00 shift, but that Building carries no IANA timezone.
    const context = await resolveCurrentShifts(
      managerUserId,
      new Date('2026-08-20T03:00:00Z'),
    );
    assert.deepEqual(context.shifts, []);
    void f;
  });
});
