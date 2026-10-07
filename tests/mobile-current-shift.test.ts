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

async function seed() {
  // One caller per seed() invocation. `workforce_profiles.user_id` carries a
  // UNIQUE constraint (one profile per user), so a shared module-level user
  // could only ever be linked by the first seed(); every later test would die
  // on WORKFORCE_USER_ALREADY_LINKED before reaching the behaviour it means to
  // prove. This mirrors the BE-25N sibling suite (tests/mobile-my-team.test.ts).
  const manager = await createAdminUser();

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
  const shiftNight = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Night shift',
    startTime: '22:00:00',
    endTime: '06:00:00',
  });
  // Created ACTIVE on purpose: `assignShiftToWorkforce` correctly refuses an
  // INACTIVE Shift (SHIFT_INACTIVE), so the inactive-shift boundary has to be
  // reached by deactivating AFTER the roster row exists — the legitimate
  // historical state BE-03E describes ("Deactivating is not a delete: existing
  // assignments are retained, they simply stop being assignable targets").
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
    shiftId: shiftNight.id,
  });
  const inactiveAssignment = await assignShiftToWorkforce({
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

  // Deactivate through the BE-03E service path only AFTER the roster row
  // exists. The assignment stays ACTIVE while the Shift becomes INACTIVE, which
  // is exactly the state `GET /mobile/current-shift` must exclude on
  // `s.status = 'ACTIVE'` — distinct from test "excludes an assignment
  // deactivated to INACTIVE", which deactivates the roster row instead.
  await shiftService.updateShiftStatus(shiftInactive.id, 'INACTIVE');

  return {
    client,
    profile,
    manager,
    buildingA,
    buildingB,
    buildingNoTz,
    shiftMorning,
    shiftNight,
    shiftInactive,
    shiftNoTz,
    shiftOtherBuilding,
    morningAssignment,
    inactiveAssignment,
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

    // 2026-08-20T02:00:00Z == 09:00 Asia/Jakarta — inside 07:00–15:00. The
    // seeded INACTIVE shift shares this exact window, Building and an ACTIVE
    // roster row, so the count of 1 is what proves the ACTIVE-shift requirement
    // (`s.status = 'ACTIVE'`); assert it by name as well so the boundary stays
    // explicit rather than incidental to the fixture.
    const context = await resolveCurrentShifts(
      f.manager.userId,
      new Date('2026-08-20T02:00:00Z'),
    );
    // Fixture state the exclusion depends on, re-read rather than assumed: the
    // roster row is still ACTIVE while the Shift it points at was deactivated
    // afterwards through the BE-03E service path.
    assert.equal(f.inactiveAssignment.status, 'ACTIVE');
    assert.equal(
      (await shiftService.getShiftById(f.shiftInactive.id)).status,
      'INACTIVE',
    );
    assert.ok(
      context.shifts.every((s) => s.shiftId !== f.shiftInactive.id),
      'a shift deactivated to INACTIVE must be excluded even with an ACTIVE roster row',
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
      f.manager.userId,
      new Date('2026-08-20T18:00:00Z'),
    );
    assert.equal(context.shifts.length, 1);
    assert.equal(context.shifts[0].shiftId, f.shiftNight.id);
  });

  it('returns an empty context outside every assigned window', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // 2026-08-20T09:00:00Z == 16:00 Asia/Jakarta — between 15:00 and 22:00.
    const context = await resolveCurrentShifts(
      f.manager.userId,
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
      f.manager.userId,
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
      f.manager.userId,
      new Date('2026-08-20T10:00:00Z'),
    );
    assert.deepEqual(context.shifts, []);
  });

  it('excludes shifts in Buildings the caller cannot access', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // 2026-08-20T01:00:00Z == 08:00 Jakarta — inside BOTH buildingB's
    // 08:00–16:00 shift and buildingA's 07:00–15:00 morning shift. Both shifts
    // are ACTIVE with ACTIVE roster rows and both Buildings carry the same IANA
    // timezone, so Building access is the ONLY differing variable: buildingB was
    // never assigned to the caller and must not resolve, while the morning shift
    // must. Asserting the positive control too is what makes this a real
    // isolation proof rather than a blanket-empty result.
    const context = await resolveCurrentShifts(
      f.manager.userId,
      new Date('2026-08-20T01:00:00Z'),
    );
    assert.ok(
      context.shifts.every((shift) => shift.buildingId !== f.buildingB.id),
      'no shift in a Building the caller cannot access may resolve',
    );
    assert.ok(
      context.shifts.every((shift) => shift.shiftId !== f.shiftOtherBuilding.id),
      'the inaccessible Building shift must be excluded',
    );
    assert.equal(context.shifts.length, 1);
    assert.equal(context.shifts[0].shiftId, f.shiftMorning.id);
    assert.equal(context.shifts[0].buildingId, f.buildingA.id);
  });

  it('excludes shifts whose Building has no timezone (cannot affirm "current")', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // 2026-08-20T03:00:00Z == 10:00 Jakarta — inside BOTH buildingNoTz's
    // 08:00–16:00 shift and buildingA's 07:00–15:00 morning shift. buildingNoTz
    // IS assigned to the caller but carries no IANA timezone, so the local
    // wall-clock cannot be determined and "current" cannot be affirmed: the row
    // is excluded, never guessed. The morning shift still resolves, proving the
    // exclusion is timezone-specific and not a blanket-empty result.
    const context = await resolveCurrentShifts(
      f.manager.userId,
      new Date('2026-08-20T03:00:00Z'),
    );
    assert.ok(
      context.shifts.every((shift) => shift.buildingId !== f.buildingNoTz.id),
      'no shift in a Building without a timezone may resolve',
    );
    assert.ok(
      context.shifts.every((shift) => shift.shiftId !== f.shiftNoTz.id),
      'the no-timezone Building shift must be excluded, never guessed',
    );
    assert.equal(context.shifts.length, 1);
    assert.equal(context.shifts[0].shiftId, f.shiftMorning.id);
    assert.equal(context.shifts[0].buildingId, f.buildingA.id);
  });
});
