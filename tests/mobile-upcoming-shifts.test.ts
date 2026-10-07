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
import { resolveUpcomingShifts } from '../src/modules/mobile-current-shift';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-MOB-05 PART 01 — Mobile Upcoming Shifts focused validation.
 *
 * Proves the derivation contract for `GET /mobile/upcoming-shifts`: the
 * authenticated user's current/future shift schedule is resolved from the
 * linked Workforce Profile (BE-03C), the Shift roster (BE-03E), the BE-02F/G
 * Building access authority and the roster effective window — without
 * duplicating the BE-25M current-shift wall-clock engine. Also proves the
 * safety boundaries: authentication, caller scoping, inaccessible Buildings,
 * Buildings without a valid timezone, INACTIVE shifts / assignments, expired
 * roster windows, overnight shift shapes, optional dateFrom/dateTo windowing,
 * empty results and validation errors.
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
       users, roles, permissions, clients
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
 * Creates a fully isolated fixture: a fresh admin user, a fresh Client
 * hierarchy and a Workforce Profile linked to that user. Each test gets its
 * own user + profile so roster state never leaks between tests
 * (`workforce_profiles.user_id` is unique).
 */
async function seed() {
  const manager = await createAdminUser();
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Upcoming shift client',
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
  // Accessible building WITHOUT a timezone (wall-clock cannot be interpreted).
  const buildingNoTz = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building NoTz',
  });
  await buildingAssignmentService.createAssignment(manager.userId, {
    buildingId: buildingA.id,
  });
  await buildingAssignmentService.createAssignment(manager.userId, {
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
    userId: manager.userId,
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
  const shiftAfternoon = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Afternoon shift',
    startTime: '15:00:00',
    endTime: '23:00:00',
  });
  const shiftNight = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Night shift',
    startTime: '22:00:00',
    endTime: '06:00:00',
  });
  // Built ACTIVE, assigned, then deactivated: the fixture keeps an ACTIVE
  // roster assignment of an INACTIVE Shift (the service refuses to assign an
  // INACTIVE Shift, so the deactivation must happen after the assignment).
  const shiftInactive = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Inactive shift',
    startTime: '07:00:00',
    endTime: '15:00:00',
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
    shiftId: shiftAfternoon.id,
  });
  await assignShiftToWorkforce({
    workforceProfileId: profile.id,
    shiftId: shiftNight.id,
  });
  await assignShiftToWorkforce({
    workforceProfileId: profile.id,
    shiftId: shiftInactive.id,
  });
  await shiftService.updateShiftStatus(shiftInactive.id, 'INACTIVE');
  await assignShiftToWorkforce({
    workforceProfileId: profile.id,
    shiftId: shiftNoTz.id,
  });
  await assignShiftToWorkforce({
    workforceProfileId: profile.id,
    shiftId: shiftOtherBuilding.id,
  });

  return {
    token: manager.token,
    userId: manager.userId,
    client,
    profile,
    buildingA,
    buildingB,
    buildingNoTz,
    shiftMorning,
    shiftAfternoon,
    shiftNight,
    shiftInactive,
    shiftNoTz,
    shiftOtherBuilding,
    morningAssignment,
  };
}

describe('CR-BE-MOB-05 PART 01 — mobile upcoming shifts', () => {
  it('rejects unauthenticated requests with 401, never 404', async () => {
    const response = await api().get('/api/v1/mobile/upcoming-shifts');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });

  it('returns an empty schedule for an authenticated user without a linked profile', async (t) => {
    if (!ready(t)) return;
    const token = await createPlainSession();
    const response = await api()
      .get('/api/v1/mobile/upcoming-shifts')
      .set({ Authorization: `Bearer ${token}` });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.success);
    assert.ok(typeof response.body.data.asOf === 'string');
    assert.equal(response.body.data.dateFrom, response.body.data.asOf);
    assert.equal(response.body.data.dateTo, null);
    assert.deepEqual(response.body.data.shifts, []);
  });

  it('rejects invalid dateFrom/dateTo query parameters with 400', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const samples = [
      { dateFrom: 'not-a-date' },
      { dateFrom: '2026-08-31', dateTo: '2026-08-01' },
      { dateFrom: '2026-01-01', dateTo: '2027-12-31' },
    ];
    for (const query of samples) {
      const response = await api()
        .get('/api/v1/mobile/upcoming-shifts')
        .query(query)
        .set({ Authorization: `Bearer ${f.token}` });
      assert.equal(response.status, 400, JSON.stringify(query));
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('lists the undated standing roster plus future-dated assignments, excluding expired ones', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const now = new Date('2026-08-20T02:00:00Z');

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

    const expiredShift = await shiftService.createShift({
      clientId: f.client.id,
      buildingId: f.buildingA.id,
      code: `S_${suffix()}`,
      name: 'Expired shift',
      startTime: '07:00:00',
      endTime: '15:00:00',
    });
    await assignShiftToWorkforce({
      workforceProfileId: f.profile.id,
      shiftId: expiredShift.id,
      effectiveFrom: new Date('2026-08-01T00:00:00Z'),
      effectiveUntil: new Date('2026-08-10T00:00:00Z'),
    });

    const context = await resolveUpcomingShifts(f.userId, {}, now);
    const ids = context.shifts.map((shift) => shift.shiftId);
    assert.deepEqual(ids, [
      f.shiftMorning.id,
      f.shiftAfternoon.id,
      f.shiftNight.id,
      futureShift.id,
    ]);
    assert.ok(
      !ids.includes(expiredShift.id),
      'expired roster must not appear in the schedule',
    );
    // Order: undated roster first (by building code, start time, code), then
    // future-dated by effective_from.
    assert.equal(context.shifts[0].shiftId, f.shiftMorning.id);
    assert.equal(context.shifts[3].shiftId, futureShift.id);
    assert.equal(context.dateTo, null, 'no dateTo -> unbounded');

    const first = context.shifts[0];
    assert.equal(first.assignmentId, f.morningAssignment.id);
    assert.equal(first.shiftId, f.shiftMorning.id);
    assert.equal(first.workforceProfileId, f.profile.id);
    assert.equal(first.employeeCode, f.profile.employeeCode);
    assert.equal(first.clientId, f.client.id);
    assert.equal(first.buildingId, f.buildingA.id);
    assert.equal(first.code, f.shiftMorning.code);
    assert.equal(first.startTime, '07:00:00');
    assert.equal(first.endTime, '15:00:00');
    assert.equal(first.status, 'ACTIVE');
    assert.equal(first.effectiveFrom, null);
    assert.equal(first.effectiveUntil, null);
  });

  it('bounds the roster window with dateFrom/dateTo and treats date-only dateTo as a full UTC day', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const now = new Date('2026-08-20T02:00:00Z');

    // Runs 2026-08-21T00:00:00Z → 2026-08-23T00:00:00Z (a closed window).
    const shift21 = await shiftService.createShift({
      clientId: f.client.id,
      buildingId: f.buildingA.id,
      code: `S_${suffix()}`,
      name: 'Shift on the 21st',
      startTime: '07:00:00',
      endTime: '15:00:00',
    });
    await assignShiftToWorkforce({
      workforceProfileId: f.profile.id,
      shiftId: shift21.id,
      effectiveFrom: new Date('2026-08-21T00:00:00Z'),
      effectiveUntil: new Date('2026-08-23T00:00:00Z'),
    });
    // Starts 2026-08-25T00:00:00Z.
    const shift25 = await shiftService.createShift({
      clientId: f.client.id,
      buildingId: f.buildingA.id,
      code: `S_${suffix()}`,
      name: 'Shift on the 25th',
      startTime: '07:00:00',
      endTime: '15:00:00',
    });
    await assignShiftToWorkforce({
      workforceProfileId: f.profile.id,
      shiftId: shift25.id,
      effectiveFrom: new Date('2026-08-25T00:00:00Z'),
    });
    // Ends 2026-08-10T00:00:00Z — before the window.
    const expired = await shiftService.createShift({
      clientId: f.client.id,
      buildingId: f.buildingA.id,
      code: `S_${suffix()}`,
      name: 'Expired shift',
      startTime: '07:00:00',
      endTime: '15:00:00',
    });
    await assignShiftToWorkforce({
      workforceProfileId: f.profile.id,
      shiftId: expired.id,
      effectiveFrom: new Date('2026-08-01T00:00:00Z'),
      effectiveUntil: new Date('2026-08-10T00:00:00Z'),
    });

    // dateTo='2026-08-21' (date-only) is inclusive of the whole UTC day, so
    // the exclusive bound is 2026-08-22T00:00:00Z: shift21 qualifies,
    // shift25 does not, expired does not.
    const windowed = await resolveUpcomingShifts(
      f.userId,
      { dateFrom: '2026-08-20', dateTo: '2026-08-21' },
      now,
    );
    const windowIds = windowed.shifts.map((shift) => shift.shiftId);
    assert.ok(windowIds.includes(shift21.id), 'shift starting on dateTo day is included');
    assert.ok(!windowIds.includes(shift25.id), 'shift after dateTo is excluded');
    assert.ok(!windowIds.includes(expired.id), 'assignment ended before dateFrom is excluded');
    assert.equal(
      windowed.dateTo,
      new Date('2026-08-22T00:00:00Z').toISOString(),
      'date-only dateTo is inclusive of that whole UTC day',
    );

    // A future window [2026-08-25, 2026-08-31) admits shift25 only among the
    // dated assignments (the undated standing roster still qualifies).
    const future = await resolveUpcomingShifts(
      f.userId,
      { dateFrom: '2026-08-25', dateTo: '2026-08-31' },
      now,
    );
    const futureIds = future.shifts.map((shift) => shift.shiftId);
    assert.ok(futureIds.includes(shift25.id));
    assert.ok(!futureIds.includes(shift21.id));
    assert.ok(!futureIds.includes(expired.id));
  });

  it('excludes shifts in Buildings the caller cannot access', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const context = await resolveUpcomingShifts(
      f.userId,
      {},
      new Date('2026-08-20T02:00:00Z'),
    );
    assert.ok(
      context.shifts.every((shift) => shift.buildingId !== f.buildingB.id),
      'inaccessible Building roster must be excluded',
    );
  });

  it('excludes shifts whose Building has no valid timezone', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const context = await resolveUpcomingShifts(
      f.userId,
      {},
      new Date('2026-08-20T02:00:00Z'),
    );
    assert.ok(
      context.shifts.every((shift) => shift.buildingId !== f.buildingNoTz.id),
      'no-timezone Building roster must be excluded',
    );
  });

  it('preserves the overnight shift shape in the schedule', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const context = await resolveUpcomingShifts(
      f.userId,
      {},
      new Date('2026-08-20T02:00:00Z'),
    );
    const night = context.shifts.find(
      (shift) => shift.shiftId === f.shiftNight.id,
    );
    assert.ok(night, 'night shift must be in the schedule');
    assert.equal(night.startTime, '22:00:00');
    assert.equal(night.endTime, '06:00:00');
  });

  it('excludes an assignment deactivated to INACTIVE', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const extraShift = await shiftService.createShift({
      clientId: f.client.id,
      buildingId: f.buildingA.id,
      code: `S_${suffix()}`,
      name: 'Removed shift',
      startTime: '07:00:00',
      endTime: '15:00:00',
    });
    await assignShiftToWorkforce({
      workforceProfileId: f.profile.id,
      shiftId: extraShift.id,
    });
    await updateWorkforceShiftAssignment(f.profile.id, extraShift.id, {
      status: 'INACTIVE',
    });

    const context = await resolveUpcomingShifts(
      f.userId,
      {},
      new Date('2026-08-20T02:00:00Z'),
    );
    assert.ok(
      context.shifts.every((shift) => shift.shiftId !== extraShift.id),
      'INACTIVE roster assignment must be excluded',
    );
  });

  it('excludes an ACTIVE assignment of an INACTIVE Shift', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const context = await resolveUpcomingShifts(
      f.userId,
      {},
      new Date('2026-08-20T02:00:00Z'),
    );
    assert.ok(
      context.shifts.every((shift) => shift.shiftId !== f.shiftInactive.id),
      'INACTIVE Shift must be excluded',
    );
  });

  it('returns an empty schedule for a user with a profile but no roster', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const second = await createAdminUser();
    await buildingAssignmentService.createAssignment(second.userId, {
      buildingId: f.buildingA.id,
    });
    const organization = await organizationService.createOrganization({
      clientId: f.client.id,
      code: `O_${suffix()}`,
      name: 'Organization 2',
    });
    const department = await departmentService.createDepartment({
      organizationId: organization.id,
      code: `D_${suffix()}`,
      name: 'Department 2',
    });
    const position = await positionService.createPosition({
      organizationId: organization.id,
      code: `P_${suffix()}`,
      name: 'Technician 2',
    });
    await workforceService.createWorkforceProfile({
      organizationId: organization.id,
      departmentId: department.id,
      positionId: position.id,
      userId: second.userId,
      employeeCode: `WF_${suffix()}`,
      fullName: 'Mobile Worker 2',
    });

    const now = new Date('2026-08-20T02:00:00Z');
    const context = await resolveUpcomingShifts(second.userId, {}, now);
    assert.deepEqual(context.shifts, []);
    assert.equal(context.dateFrom, now.toISOString());
    assert.equal(context.dateTo, null);
  });
});
