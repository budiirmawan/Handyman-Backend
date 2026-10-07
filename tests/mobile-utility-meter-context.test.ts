import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { credentialService } from '../src/modules/auth';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { floorService } from '../src/modules/floors';
import { functionalLocationService } from '../src/modules/functional-locations';
import { organizationService } from '../src/modules/organizations';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { userService } from '../src/modules/users';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 00 — Utility Meter field identity +
 * technician authority foundation.
 *
 * Proves the two things PART 00 owns and nothing else:
 *
 *   1. AUTHORITY — a field actor is authorized for a BE-18 utility meter ONLY
 *      through the existing reading-due → generated-task → task-assignment
 *      chain. Building access, `utility_meter.read`, `utility_meter.manage` and
 *      role names are each proven INSUFFICIENT on their own.
 *   2. CONTEXT — the mobile read returns exact canonical BE-18 facts, with no
 *      billing, no delta, no abnormality and no action vocabulary.
 *
 * Deliberately NOT exercised here (later PARTs own them): reading submission,
 * Idempotency-Key, reading concurrency, evidence, OCR candidates, abnormal
 * evaluation, recheck/correction, offline sync, and any `availableActions`
 * token. The existing BE-10C `METER_READING` sync kind is untouched and is
 * regression-guarded by tests/mobile-sync-kinds-contract.test.ts.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

let adminUserId = '';
let adminToken = '';

let workerUserId = '';
let workerToken = '';
let workerProfileId = '';
let otherWorkerUserId = '';
let otherWorkerToken = '';
let otherWorkerProfileId = '';
let manageOnlyUserId = '';
let manageOnlyToken = '';
let readOnlyToken = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const id = () => randomUUID();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

const CTX_PATH = '/api/v1/mobile/utility-reading-dues';

function q(text: string, params: unknown[] = []) {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
}

async function insertRow(
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const rowId = id();
  const entries = Object.entries(values);
  const columns = entries.map(([column]) => column).join(', ');
  const placeholders = entries.map((_, index) => `$${index + 2}`).join(', ');
  await q(
    `INSERT INTO ${table} (id, ${columns}) VALUES ($1, ${placeholders})`,
    [rowId, ...entries.map(([, value]) => value)],
  );
  return rowId;
}

/** A session whose role carries EXACTLY the given permission codes. */
async function createUserWithPermissions(
  prefix: string,
  codes: readonly string[],
): Promise<{ userId: string; token: string }> {
  const password = 'FieldPass123';
  const user = await userService.createUser({
    email: `${prefix}-${suffix().toLowerCase()}@example.com`,
    displayName: `${prefix} Field User`,
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${prefix.toUpperCase()}_${suffix()}`,
    name: `${prefix} role`,
  });
  for (const code of codes) {
    const existing = await permissionRepository.findByCode(code);
    const permission =
      existing ?? (await permissionService.createPermission({ code, name: code }));
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  return { userId: user.id, token: login.body.data.sessionToken as string };
}

/**
 * One meter + one generated task targeting it + one reading due bound to that
 * task — the full field execution identity chain.
 */
async function createFieldExecution(options: {
  buildingId: string;
  clientId: string;
  assignToProfileId?: string | null;
  dueStatus?: 'DUE' | 'COMPLETED' | 'CANCELLED';
  withGeneratedTask?: boolean;
  taskTargetMeterId?: string;
  withReading?: boolean;
  readingValue?: number;
  utilityType?: 'ELECTRICITY' | 'WATER' | 'GAS';
  purpose?: 'TENANT' | 'BUILDING' | 'COMMON_AREA' | 'ENERGY_SOURCE';
  serialNumber?: string;
  spaceId?: string | null;
  functionalLocationId?: string | null;
  decimalPrecision?: number | null;
  periodStart?: string;
}) {
  const utilityType = options.utilityType ?? 'ELECTRICITY';

  if (options.decimalPrecision !== undefined) {
    const configured = await api()
      .post(`/api/v1/clients/${options.clientId}/utility-type-configurations`)
      .set(auth())
      .send({
        utilityType,
        name: `${utilityType} config`,
        decimalPrecision: options.decimalPrecision,
      });
    assert.equal(configured.status, 201, JSON.stringify(configured.body));
  }

  const uom = await api()
    .post(`/api/v1/clients/${options.clientId}/uoms`)
    .set(auth())
    .send({
      code: `U_${suffix()}`,
      name: utilityType === 'WATER' ? 'Cubic metre' : 'Kilowatt hour',
      symbol: utilityType === 'WATER' ? 'm3' : 'kWh',
      category: 'ENERGY',
    });
  assert.equal(uom.status, 201, JSON.stringify(uom.body));
  const uomId = uom.body.data.id as string;

  const meter = await api()
    .post(`/api/v1/buildings/${options.buildingId}/utility-meters`)
    .set(auth())
    .send({
      code: `MTR_${suffix()}`,
      name: 'Main incoming meter',
      utilityType,
      purpose: options.purpose ?? 'BUILDING',
      uomId,
      ...(options.serialNumber === undefined
        ? {}
        : { serialNumber: options.serialNumber }),
      ...(options.spaceId ? { spaceId: options.spaceId } : {}),
      ...(options.functionalLocationId
        ? { functionalLocationId: options.functionalLocationId }
        : {}),
    });
  assert.equal(meter.status, 201, JSON.stringify(meter.body));
  const meterId = meter.body.data.id as string;

  // A period override shifts the whole window, so `periodEnd > periodStart`
  // (enforced by both the service and the DB CHECK) always holds.
  const periodStart = new Date(options.periodStart ?? '2027-01-01T00:00:00.000Z');
  const periodEnd = new Date(periodStart.getTime() + 31 * 86_400_000);
  const dueAt = new Date(periodEnd.getTime() + 86_400_000);

  let readingId: string | null = null;
  if (options.withReading) {
    // Placed inside the period window so a COMPLETED due can link it
    // (`completeUtilityReadingDue` rejects a reading outside the period).
    const reading = await api()
      .post(`/api/v1/utility/meters/${meterId}/readings`)
      .set(auth())
      .send({
        readingValue: options.readingValue ?? 1234.5,
        readingAt: new Date(periodStart.getTime() + 14 * 86_400_000).toISOString(),
      });
    assert.equal(reading.status, 201, JSON.stringify(reading.body));
    readingId = reading.body.data.id as string;
  }

  let generatedTaskId: string | null = null;
  let scheduleDefinitionId: string | null = null;
  if (options.withGeneratedTask !== false) {
    scheduleDefinitionId = await insertRow('schedule_definitions', {
      client_id: options.clientId,
      code: `SD_${suffix()}`,
      name: 'Meter reading schedule',
      target_type: 'UTILITY_METER',
      target_id: meterId,
      building_id: options.buildingId,
      start_at: '2027-01-01T00:00:00Z',
      timezone: 'Asia/Jakarta',
      status: 'ACTIVE',
    });
    generatedTaskId = await insertRow('generated_tasks', {
      client_id: options.clientId,
      schedule_definition_id: scheduleDefinitionId,
      occurrence_at: '2027-01-20T01:00:00Z',
      target_type: 'UTILITY_METER',
      // Allows a deliberately mis-targeted task (gate 4 of the field seam).
      target_id: options.taskTargetMeterId ?? meterId,
      building_id: options.buildingId,
      status: 'OPEN',
    });
    if (options.assignToProfileId) {
      await insertRow('task_assignments', {
        task_id: generatedTaskId,
        assignee_type: 'WORKFORCE',
        workforce_profile_id: options.assignToProfileId,
        team_id: null,
        assigned_by_user_id: adminUserId,
        status: 'ACTIVE',
      });
    }
  }

  const due = await api()
    .post(`/api/v1/utility/meters/${meterId}/reading-dues`)
    .set(auth())
    .send({
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      dueAt: dueAt.toISOString(),
      ...(scheduleDefinitionId ? { scheduleDefinitionId } : {}),
      ...(generatedTaskId ? { generatedTaskId } : {}),
    });
  assert.equal(due.status, 201, JSON.stringify(due.body));
  const readingDueId = due.body.data.id as string;

  if (options.dueStatus === 'COMPLETED') {
    assert.ok(readingId, 'a COMPLETED due needs a reading to link');
    const completed = await api()
      .post(`/api/v1/utility/reading-dues/${readingDueId}/complete`)
      .set(auth())
      .send({ meterReadingId: readingId });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
  }
  if (options.dueStatus === 'CANCELLED') {
    const cancelled = await api()
      .post(`/api/v1/utility/reading-dues/${readingDueId}/cancel`)
      .set(auth())
      .send({ reason: 'Meter replaced, period void.' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  }

  return { meterId, uomId, readingDueId, generatedTaskId, readingId, meter: meter.body.data };
}

const ctxUrl = (readingDueId: string) =>
  `${CTX_PATH}/${readingDueId}/meter-context`;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  database = db;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE utility_reading_dues, utility_meter_ocr_candidates,
       utility_meter_consumptions, utility_meter_readings,
       utility_meter_tenant_assignments, utility_meters, utility_type_uoms,
       utility_type_configurations, units_of_measure, task_assignments,
       generated_tasks, schedule_recurrence, schedule_definitions,
       workforce_profiles, positions, departments, organizations, teams,
       user_building_assignments, spaces, rooms, areas, floors,
       functional_locations, buildings, properties, users, roles, permissions,
       role_permission_assignments, user_role_assignments, clients CASCADE`,
  );

  const admin = await createAdminUser();
  adminUserId = admin.userId;
  adminToken = admin.token;

  // The field actor: a workforce profile, so the existing WORKFORCE / TEAM
  // assignment authority has something to resolve. NO role name is involved.
  const worker = await createUserWithPermissions('worker', [
    'utility_meter.field.read',
  ]);
  workerUserId = worker.userId;
  workerToken = worker.token;

  const otherWorker = await createUserWithPermissions('other', [
    'utility_meter.field.read',
  ]);
  otherWorkerUserId = otherWorker.userId;
  otherWorkerToken = otherWorker.token;

  // Management-permission holders WITHOUT the dedicated field permission.
  // FULL meter administration authority, but NOT the dedicated field permission.
  const manageOnly = await createUserWithPermissions('mgr', [
    'utility_meter.read',
    'utility_meter.manage',
  ]);
  manageOnlyUserId = manageOnly.userId;
  manageOnlyToken = manageOnly.token;
  readOnlyToken = (
    await createUserWithPermissions('rdr', ['utility_meter.read'])
  ).token;
});

after(async () => {
  if (pool) {
    await closePool(pool);
  }
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

/** Client → Property → Building (+ optional Space / Functional Location). */
async function createStructure() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Field Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
    timezone: 'Asia/Jakarta',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });

  // Optional finer placement, created through the SAME services the BE-18A
  // meter-master tests use, so the fixture can never drift from the real
  // structure semantics.
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `FL_${suffix()}`,
    name: 'Ground floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `AR_${suffix()}`,
    name: 'Plant area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `RM_${suffix()}`,
    name: 'Panel room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `SP_${suffix()}`,
    name: 'Panel bay',
  });
  const functionalLocation =
    await functionalLocationService.createFunctionalLocation({
      buildingId: building.id,
      code: `FLOC_${suffix()}`,
      name: 'Main electrical riser',
      spaceId: space.id,
    });

  return {
    clientId: client.id,
    buildingId: building.id,
    spaceId: space.id,
    functionalLocationId: functionalLocation.id,
  };
}

/** Cached workforce profile per user. */
const profileCache = new Map<string, string>();

/**
 * A workforce profile for `userId`.
 *
 * Created at most ONCE per user and then cached: `workforce_profiles` allows a
 * user to be linked to exactly one profile platform-wide
 * (`WORKFORCE_USER_ALREADY_LINKED`), so a fresh profile per fixture is
 * impossible. That is also why field authority works across clients —
 * `isBoundTaskExecutableByUser` matches the ASSIGNMENT's profile/team against
 * the actor's single profile, and never re-derives a client scope from it.
 */
async function createProfile(userId: string): Promise<string> {
  const cached = profileCache.get(userId);
  if (cached) {
    return cached;
  }
  const client = await clientService.createClient({
    code: `WF_${suffix()}`,
    name: 'Workforce home client',
  });
  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `O_${suffix()}`,
    name: 'Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `PO_${suffix()}`,
    name: 'Field Worker',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Field Worker',
  });
  profileCache.set(userId, profile.id);
  return profile.id;
}

/** Grants `userId` BE-02G access to `buildingId`. */
async function grantBuildingAccess(userId: string, buildingId: string) {
  await buildingAssignmentService.createAssignment(userId, { buildingId });
}

/* -------------------------------------------------------------------------
 * §20 — AUTHORITY CHAIN
 * ---------------------------------------------------------------------- */

describe('RN-12 PART 00 — field authority chain', () => {
  it('1. a reading due resolves exactly one utility meter', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    workerProfileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: workerProfileId,
    });

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.meter.id, execution.meterId);

    // The relation is NOT NULL in the schema, so exactly one meter is
    // guaranteed structurally, not merely by this response.
    const row = await q(
      `SELECT meter_id FROM utility_reading_dues WHERE id = $1`,
      [execution.readingDueId],
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].meter_id, execution.meterId);
  });

  it('2. a generated task resolves exactly one reading due', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    // `utility_reading_due_task_unique UNIQUE (generated_task_id)` makes the
    // task → due direction at most one-to-one at the storage layer.
    const rows = await q(
      `SELECT id FROM utility_reading_dues WHERE generated_task_id = $1`,
      [execution.generatedTaskId],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].id, execution.readingDueId);

    const constraint = await q(
      `SELECT conname FROM pg_constraint WHERE conname = 'utility_reading_due_task_unique'`,
    );
    assert.equal(constraint.rows.length, 1);
  });

  it('3. an assigned field actor can read the meter context', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.readingDue.generatedTaskId, execution.generatedTaskId);
  });

  it('4. an unassigned actor is denied', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(otherWorkerUserId, structure.buildingId);
    otherWorkerProfileId = await createProfile(otherWorkerUserId);

    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId, // assigned to `worker`, not `otherWorker`
    });

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(otherWorkerToken));
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_READING_DUE_FIELD_UNAUTHORIZED',
    );
    assert.notEqual(otherWorkerProfileId, profileId);
  });

  it('5. an actor assigned to a DIFFERENT generated task is denied', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const workerProfile = await createProfile(workerUserId);
    const otherProfile = await createProfile(otherWorkerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    await grantBuildingAccess(otherWorkerUserId, structure.buildingId);

    // Two separate meters, two separate tasks, two separate dues — the other
    // worker is genuinely authorized for THEIR task, just not this one.
    const mine = await createFieldExecution({
      ...structure,
      assignToProfileId: workerProfile,
    });
    await createFieldExecution({
      ...structure,
      assignToProfileId: otherProfile,
      periodStart: '2027-03-01T00:00:00.000Z',
    });

    const crossed = await api()
      .get(ctxUrl(mine.readingDueId))
      .set(auth(otherWorkerToken));
    assert.equal(crossed.status, 403, JSON.stringify(crossed.body));
    assert.equal(
      crossed.body.error.code,
      'UTILITY_READING_DUE_FIELD_UNAUTHORIZED',
    );

    // …and the same actor still succeeds on their own due.
    const own = await api()
      .get(ctxUrl(mine.readingDueId))
      .set(auth(workerToken));
    assert.equal(own.status, 200, JSON.stringify(own.body));
  });

  it('6. Building access alone is insufficient', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);

    // A third actor with the field permission and FULL Building access but NO
    // task assignment at all.
    // Holds the field permission AND the management read permission AND full
    // Building access — the strongest possible non-assignee — and is still
    // denied, because assignment, not access, is the authority.
    const intruder = await createUserWithPermissions('intruder', [
      'utility_meter.field.read',
      'utility_meter.read',
    ]);
    await grantBuildingAccess(intruder.userId, structure.buildingId);

    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const canAccessBuilding = await api()
      .get(`/api/v1/buildings/${structure.buildingId}/utility-meters`)
      .set(auth(intruder.token));
    // Prove the Building grant is real, so the denial below cannot be
    // attributed to missing Building access.
    assert.notEqual(canAccessBuilding.status, 403);

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(intruder.token));
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_READING_DUE_FIELD_UNAUTHORIZED',
    );
  });

  it('6b. a due with NO generated task cannot be field-authorized', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    // No task ⇒ no assignment ⇒ no provable field actor. This must NOT fall
    // back to Building access, `utility_meter.manage`, or a role name — even
    // for the ADMIN, who holds every permission and every Building.
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      withGeneratedTask: false,
    });
    assert.equal(execution.generatedTaskId, null);

    // Both of these DO hold `utility_meter.field.read`, so they pass the
    // permission gate and are denied inside the seam itself — proving the seam,
    // not the permission, is what refuses a taskless due.
    for (const token of [workerToken, adminToken]) {
      const response = await api()
        .get(ctxUrl(execution.readingDueId))
        .set(auth(token));
      assert.equal(response.status, 403, JSON.stringify(response.body));
      assert.equal(
        response.body.error.code,
        'UTILITY_READING_DUE_NO_FIELD_TASK',
        `token=${token.slice(0, 8)}`,
      );
    }

    // A management-only actor never even reaches the seam.
    const manageDenied = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(manageOnlyToken));
    assert.equal(manageDenied.status, 403, JSON.stringify(manageDenied.body));
    assert.equal(manageDenied.body.error.code, 'PERMISSION_DENIED');

    // The same due remains fully readable through the management route, so the
    // denial is a field-authority boundary, not a data-visibility regression.
    const management = await api()
      .get(`/api/v1/utility/reading-dues/${execution.readingDueId}`)
      .set(auth());
    assert.equal(management.status, 200, JSON.stringify(management.body));
  });

  it('6c. a task re-pointed at another meter is denied', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    const victim = await createFieldExecution({
      ...structure,
      periodStart: '2027-04-01T00:00:00.000Z',
    });
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      periodStart: '2027-05-01T00:00:00.000Z',
    });

    // `createUtilityReadingDue` already REFUSES to issue a due whose generated
    // task targets a different meter (UTILITY_READING_DUE_SCHEDULE_INVALID), so
    // the mismatch can only arise from drift AFTER issuance. Re-point the task
    // directly to prove the seam re-asserts the invariant on read rather than
    // trusting the write-time check forever.
    await q(`UPDATE generated_tasks SET target_id = $2 WHERE id = $1`, [
      execution.generatedTaskId,
      victim.meterId,
    ]);

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_READING_DUE_FIELD_TASK_MISMATCH',
    );
  });

  it('7. utility_meter.manage alone is insufficient', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    // Building access for the manager too, so the denial below is attributable
    // to the missing FIELD permission and not to missing scope.
    await grantBuildingAccess(manageOnlyUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    // `manageOnly` holds the full management pair but NOT utility_meter.field.read.
    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(manageOnlyToken));
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');

    // …yet the same actor CAN administer the meter, proving the two authorities
    // are genuinely independent rather than one being a superset of the other.
    const management = await api()
      .get(`/api/v1/utility/meters/${execution.meterId}`)
      .set(auth(manageOnlyToken));
    assert.equal(management.status, 200, JSON.stringify(management.body));
  });

  it('8. utility_meter.read alone is insufficient', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(readOnlyToken));
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('9. the dedicated field permission is required', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    // `manageOnlyToken` holds utility_meter.read + utility_meter.manage and has
    // Building access, but NOT utility_meter.field.read.
    const denied = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(manageOnlyToken));
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const unauthenticated = await api().get(ctxUrl(execution.readingDueId));
    assert.equal(unauthenticated.status, 401);

    const malformed = await api()
      .get(`${CTX_PATH}/not-a-uuid/meter-context`)
      .set(auth(workerToken));
    assert.equal(malformed.status, 400, JSON.stringify(malformed.body));
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');
    assert.equal(malformed.body.error.details[0].field, 'readingDueId');

    const unknown = await api()
      .get(ctxUrl(randomUUID()))
      .set(auth(workerToken));
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(unknown.body.error.code, 'UTILITY_READING_DUE_NOT_FOUND');
  });

  it('10. no role-name check exists in the field authority seam', async () => {
    const source = readFileSync(
      resolve(
        __dirname,
        '../src/modules/utility-reading-dues/utility-reading-due.field-authority.ts',
      ),
      'utf8',
    );
    // Authority is derived from assignment data, never from a role label.
    for (const roleName of [
      "'TECHNICIAN'",
      "'ENGINEER'",
      "'SUPERVISOR'",
      '"TECHNICIAN"',
      '"ENGINEER"',
      '"SUPERVISOR"',
    ]) {
      assert.ok(
        !source.includes(roleName),
        `field authority must not hard-code role name ${roleName}`,
      );
    }
    // Authority is derived from assignment data, never from a role label — the
    // seam does not consult the role tables at all.
    assert.doesNotMatch(source, /roleService|role_permission|FROM roles\b/);
    // It delegates to the EXISTING assignment authority instead of copying it.
    assert.match(source, /isBoundTaskExecutableByUser/);
    assert.match(source, /from '..\/mobile-task-authority'/);

    const routes = readFileSync(
      resolve(
        __dirname,
        '../src/modules/mobile-utility-meter-context/mobile-utility-meter-context.routes.ts',
      ),
      'utf8',
    );
    // The ONLY permission guard on the route is the dedicated field permission.
    const guards = [...routes.matchAll(/requirePermission\('([^']+)'\)/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(guards, ['utility_meter.field.read']);
  });
});

/* -------------------------------------------------------------------------
 * §21 — CONTEXT
 * ---------------------------------------------------------------------- */

describe('RN-12 PART 00 — mobile field meter context payload', () => {
  it('11-19. returns exact canonical BE-18 meter identity facts', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      serialNumber: 'SN-RN12-0001',
      spaceId: structure.spaceId,
      functionalLocationId: structure.functionalLocationId,
      utilityType: 'WATER',
      purpose: 'COMMON_AREA',
    });

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { meter, readingDue } = response.body.data;

    // 11 — exact meter id
    assert.equal(meter.id, execution.meterId);
    // 12 — code / name / serial exact
    assert.equal(meter.code, execution.meter.code);
    assert.equal(meter.name, 'Main incoming meter');
    assert.equal(meter.serialNumber, 'SN-RN12-0001');
    // 13 — utilityType exact
    assert.equal(meter.utilityType, 'WATER');
    // 14 — purpose exact
    assert.equal(meter.purpose, 'COMMON_AREA');
    // 15 — meter status exact
    assert.equal(meter.status, 'ACTIVE');
    // 16 — Building exact
    assert.equal(meter.buildingId, structure.buildingId);
    // 17 — optional Space exact
    assert.equal(meter.spaceId, structure.spaceId);
    // 18 — optional Functional Location exact
    assert.equal(meter.functionalLocationId, structure.functionalLocationId);
    // 19 — UOM exact
    assert.equal(meter.uom.id, execution.uomId);
    assert.equal(typeof meter.uom.code, 'string');
    assert.equal(typeof meter.uom.name, 'string');
    assert.equal(typeof meter.uom.symbol, 'string');

    // readingDue block exact
    assert.equal(readingDue.id, execution.readingDueId);
    assert.equal(readingDue.status, 'DUE');
    assert.equal(readingDue.generatedTaskId, execution.generatedTaskId);
    assert.equal(readingDue.periodStart, '2027-01-01T00:00:00.000Z');
    assert.equal(readingDue.periodEnd, '2027-02-01T00:00:00.000Z');
    assert.equal(readingDue.dueAt, '2027-02-02T00:00:00.000Z');

    // Bounded shape: exactly the three documented top-level keys.
    assert.deepEqual(Object.keys(response.body.data).sort(), [
      'latestReading',
      'meter',
      'readingDue',
      'submittedReading',
    ]);
    // PART 01 added the correlation field; an OPEN due has submitted nothing.
    assert.equal(response.body.data.submittedReading, null);
  });

  it('17b/18b. optional Space and Functional Location are null when unset', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      periodStart: '2027-06-01T00:00:00.000Z',
      // Explicitly unset: `...structure` carries the Space / Functional Location
      // the fixture created, and this case proves the meter's own nulls.
      spaceId: undefined,
      functionalLocationId: undefined,
    });

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.meter.spaceId, null);
    assert.equal(response.body.data.meter.functionalLocationId, null);
    assert.equal(response.body.data.meter.serialNumber, null);
  });

  it('20. decimalPrecision is null when the client has no BE-18B configuration', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    // No utility-type-configuration created ⇒ BE-18B is opt-in and applies NO
    // precision constraint, so the canonical answer is null, not a default.
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.meter.decimalPrecision, null);
  });

  it('20b. decimalPrecision is exact when BE-18B configures it', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      decimalPrecision: 3,
    });

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.meter.decimalPrecision, 3);
  });

  it('20c. decimalPrecision is null when the configuration leaves it unset', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      decimalPrecision: null,
    });

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.meter.decimalPrecision, null);
  });

  it('21. latestReading returns the exact canonical BE-18E latest reading', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      withReading: true,
      readingValue: 4242.75,
    });
    // A newer reading must become the latest — resolved by the backend query,
    // never by client-side sorting.
    const newer = await api()
      .post(`/api/v1/utility/meters/${execution.meterId}/readings`)
      .set(auth())
      .send({
        readingValue: 4400,
        readingAt: '2027-01-18T02:00:00.000Z',
        readingType: 'ESTIMATED',
        source: 'SYSTEM',
      });
    assert.equal(newer.status, 201, JSON.stringify(newer.body));

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const latest = response.body.data.latestReading;
    assert.equal(latest.id, newer.body.data.id);
    assert.equal(latest.readingValue, 4400);
    assert.equal(latest.readingAt, '2027-01-18T02:00:00.000Z');
    assert.equal(latest.readingType, 'ESTIMATED');
    assert.equal(latest.source, 'SYSTEM');
    assert.deepEqual(Object.keys(latest).sort(), [
      'id',
      'readingAt',
      'readingType',
      'readingValue',
      'source',
    ]);

    // It agrees with the canonical management latest-reading read.
    const canonical = await api()
      .get(`/api/v1/utility/meters/${execution.meterId}/readings/latest`)
      .set(auth());
    assert.equal(canonical.status, 200);
    assert.equal(canonical.body.data.id, latest.id);
  });

  it('22. latestReading is null for a meter never read', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      periodStart: '2027-07-01T00:00:00.000Z',
    });

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.latestReading, null);
  });

  it('23-25. exposes no tariff, rate, currency, delta, or abnormality', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      withReading: true,
      readingValue: 1000,
      periodStart: '2027-08-01T00:00:00.000Z',
    });

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));

    // 23/24/25 + §14/§15/§17 are proven by the EXHAUSTIVE key-set assertions
    // below rather than by substring scanning: every object's complete key list
    // is pinned with `deepEqual`, so a tariff, rate, currency, amount,
    // consumption, delta, previous-reading, abnormality, OCR, evidence,
    // `availableActions` or idempotency field could not appear without failing
    // them. (Substring scanning is unsound here — the legitimate
    // `generatedTaskId` contains "rate".)
    const data = response.body.data;

    // The complete, exact contract per object — nothing beyond these keys.
    assert.deepEqual(Object.keys(data).sort(), [
      'latestReading',
      'meter',
      'readingDue',
      'submittedReading',
    ]);
    // The correlation field is part of the contract but carries no billing,
    // delta, abnormality or action vocabulary of its own.
    assert.equal(data.submittedReading, null);
    assert.deepEqual(Object.keys(data.readingDue).sort(), [
      'dueAt',
      'generatedTaskId',
      'id',
      'periodEnd',
      'periodStart',
      'status',
    ]);
    assert.deepEqual(Object.keys(data.meter).sort(), [
      'buildingId',
      'code',
      'decimalPrecision',
      'functionalLocationId',
      'id',
      'name',
      'purpose',
      'serialNumber',
      'spaceId',
      'status',
      'uom',
      'utilityType',
    ]);
    assert.deepEqual(Object.keys(data.meter.uom).sort(), [
      'code',
      'id',
      'name',
      'symbol',
    ]);
    assert.deepEqual(Object.keys(data.latestReading).sort(), [
      'id',
      'readingAt',
      'readingType',
      'readingValue',
      'source',
    ]);
  });
});

/* -------------------------------------------------------------------------
 * §22 — READING DUE STATES
 * ---------------------------------------------------------------------- */

describe('RN-12 PART 00 — reading due state semantics', () => {
  it('26. context never cross-links another due or meter', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    // Two OPEN dues for the SAME meter in different periods — legal, because the
    // unique key is (meter_id, period_start, period_end). Each must resolve only
    // itself.
    const first = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      periodStart: '2027-01-01T00:00:00.000Z',
    });
    const second = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      periodStart: '2027-09-01T00:00:00.000Z',
    });
    assert.notEqual(first.meterId, second.meterId);

    const firstResponse = await api()
      .get(ctxUrl(first.readingDueId))
      .set(auth(workerToken));
    const secondResponse = await api()
      .get(ctxUrl(second.readingDueId))
      .set(auth(workerToken));
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(firstResponse.body.data.meter.id, first.meterId);
    assert.equal(secondResponse.body.data.meter.id, second.meterId);
    assert.equal(firstResponse.body.data.readingDue.periodStart, '2027-01-01T00:00:00.000Z');
    assert.equal(secondResponse.body.data.readingDue.periodStart, '2027-09-01T00:00:00.000Z');
    assert.notEqual(
      firstResponse.body.data.readingDue.generatedTaskId,
      secondResponse.body.data.readingDue.generatedTaskId,
    );
  });

  it('27. a COMPLETED due stays readable, preserving existing semantics', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      withReading: true,
      readingValue: 777,
      dueStatus: 'COMPLETED',
      periodStart: '2027-10-01T00:00:00.000Z',
    });

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.readingDue.status, 'COMPLETED');
    assert.equal(response.body.data.latestReading.readingValue, 777);
    // PART 00 derives NO command eligibility from status: the payload is
    // identical in shape to an open due, with no action vocabulary added.
    assert.deepEqual(Object.keys(response.body.data).sort(), [
      'latestReading',
      'meter',
      'readingDue',
      'submittedReading',
    ]);
    // PART 01 — a COMPLETED due is linked to exactly the reading that completed
    // it. This is the canonical correlation a field client reconciles against,
    // and it is derived from the due's own `meter_reading_id`, independent of
    // `latestReading`.
    assert.equal(response.body.data.submittedReading.id, execution.readingId);
    assert.equal(response.body.data.submittedReading.readingValue, 777);
    assert.equal(response.body.data.submittedReading.meterId, execution.meterId);
  });

  it('28. a CANCELLED due stays readable', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      dueStatus: 'CANCELLED',
      periodStart: '2027-11-01T00:00:00.000Z',
    });

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.readingDue.status, 'CANCELLED');
  });

  it('28b. OVERDUE is surfaced by the existing derived projection', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    // A window wholly in the past ⇒ due_at < NOW(), so the existing reading-due
    // repository derives OVERDUE from (status='DUE' AND due_at < NOW()). PART 00
    // reuses that projection and adds no status logic of its own.
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      periodStart: '2020-01-01T00:00:00.000Z',
    });

    const response = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.readingDue.status, 'OVERDUE');
  });

  it('29. another client’s meter cannot leak through a foreign due id', async (t) => {
    if (!requireDatabase(t)) return;
    const structureA = await createStructure();
    const structureB = await createStructure();
    const profileA = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structureA.buildingId);

    const mine = await createFieldExecution({
      ...structureA,
      assignToProfileId: profileA,
      periodStart: '2027-12-01T00:00:00.000Z',
    });

    // A second, isolated client/building with its own due. The worker has the
    // field permission globally but no assignment and no Building access there.
    const foreignProfile = await createProfile(otherWorkerUserId);
    const foreign = await createFieldExecution({
      ...structureB,
      assignToProfileId: foreignProfile,
      periodStart: '2027-12-01T00:00:00.000Z',
    });
    assert.notEqual(structureA.clientId, structureB.clientId);

    const leaked = await api()
      .get(ctxUrl(foreign.readingDueId))
      .set(auth(workerToken));
    assert.equal(leaked.status, 403, JSON.stringify(leaked.body));
    assert.ok(
      [
        'UTILITY_READING_DUE_FIELD_UNAUTHORIZED',
        'BUILDING_ACCESS_DENIED',
      ].includes(leaked.body.error.code),
      `unexpected code ${leaked.body.error.code}`,
    );
    assert.ok(!JSON.stringify(leaked.body).includes(foreign.meterId));

    const own = await api()
      .get(ctxUrl(mine.readingDueId))
      .set(auth(workerToken));
    assert.equal(own.status, 200);
    assert.equal(own.body.data.meter.id, mine.meterId);
  });
});
