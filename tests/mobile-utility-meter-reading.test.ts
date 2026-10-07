import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
 * CR-BE-RN12-METER-FIELD-01 PART 01 — Field Meter Reading Submit / Read /
 * History.
 *
 * Proves the technician-safe BE-18 reading contract over the PART 00 foundation:
 *
 *   §27 FIELD AUTHORITY       (1–8)   dedicated field.record permission + seam
 *   §28 VALUE CONTRACT        (9–17)  server-derived provenance, no client authority
 *   §29 IDEMPOTENCY          (18–31)  replay, conflict, namespace, no poisoning
 *   §30 CONCURRENCY          (32–39)  one reading per due, deterministic loser
 *   §31 DUE LIFECYCLE        (40–44)  link + canonical completion + replay after
 *   §32 READ / HISTORY       (45–52)  meter derived from the due, canonical order
 *   §33 RECONCILIATION       (53–57)  submittedReading, independent of latest
 *   §34 SCOPE GUARDS         (58–66)  nothing outside PART 01 was touched
 *
 * Deliberately NOT exercised (later PARTs own them): evidence, OCR candidates,
 * abnormality evaluation, recheck/correction, `availableActions`, QR resolution.
 * BE-25H `METER_READING` and BE-10C `meterReadingBindingService` are asserted
 * UNCHANGED rather than merely unused.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

let adminUserId = '';
let adminToken = '';

/** Holds BOTH field codes — the fully authorized technician. */
let workerUserId = '';
let workerToken = '';
let workerProfileId = '';
/** A second fully authorized technician, for concurrency + namespace tests. */
let otherWorkerUserId = '';
let otherWorkerToken = '';
let otherWorkerProfileId = '';
/** field.read WITHOUT field.record — proves the write half is separately gated. */
let readOnlyFieldUserId = '';
let readOnlyFieldToken = '';
/** Full meter administration, no field code. */
let manageOnlyToken = '';
/** BE-10C engineering binding administration, no field code. */
let bindingManagerToken = '';
/** Neither field code at all. */
let noFieldToken = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const id = () => randomUUID();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const DUE_PATH = '/api/v1/mobile/utility-reading-dues';
const CTX_PATH = '/api/v1/mobile/utility-reading-dues';

const readingsUrl = (readingDueId: string) =>
  `${DUE_PATH}/${readingDueId}/readings`;
const readingUrl = (readingDueId: string, readingId: string) =>
  `${DUE_PATH}/${readingDueId}/readings/${readingId}`;
const ctxUrl = (readingDueId: string) =>
  `${CTX_PATH}/${readingDueId}/meter-context`;

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

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

/** Client → Property → Building (+ Space / Functional Location). */
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

/**
 * Cached workforce profile per user.
 *
 * `workforce_profiles` links a user to exactly ONE profile platform-wide, so a
 * fresh profile per fixture is impossible — and unnecessary, because
 * `isBoundTaskExecutableByUser` matches the ASSIGNMENT's profile/team and never
 * re-derives a client scope from it.
 */
const profileCache = new Map<string, string>();

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

async function grantBuildingAccess(userId: string, buildingId: string) {
  await buildingAssignmentService.createAssignment(userId, { buildingId });
}

type FieldExecution = {
  meterId: string;
  uomId: string;
  readingDueId: string;
  generatedTaskId: string | null;
  readingId: string | null;
  periodStart: Date;
  periodEnd: Date;
  /** An instant safely inside the due period, so completion can link it. */
  insidePeriod: (offsetDays?: number) => string;
};

/**
 * One meter + one generated task targeting it + one reading due bound to that
 * task — the full field execution identity chain, identical in construction to
 * the PART 00 fixture so both suites exercise the same canonical shape.
 */
async function createFieldExecution(options: {
  buildingId: string;
  clientId: string;
  /**
   * At most ONE: `task_active_assignment_unique` is a partial unique index on
   * `task_assignments(task_id) WHERE status='ACTIVE'`, so a generated task has
   * exactly one active assignee (a WORKFORCE profile or a TEAM).
   */
  assignToProfileId?: string;
  withGeneratedTask?: boolean;
  taskTargetMeterId?: string;
  withReading?: boolean;
  readingValue?: number;
  dueStatus?: 'DUE' | 'COMPLETED' | 'CANCELLED';
  utilityType?: 'ELECTRICITY' | 'WATER' | 'GAS';
  decimalPrecision?: number | null;
  periodStart?: string;
}): Promise<FieldExecution> {
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
      purpose: 'BUILDING',
      uomId,
    });
  assert.equal(meter.status, 201, JSON.stringify(meter.body));
  const meterId = meter.body.data.id as string;

  const periodStart = new Date(options.periodStart ?? '2027-01-01T00:00:00.000Z');
  const periodEnd = new Date(periodStart.getTime() + 31 * 86_400_000);
  const dueAt = new Date(periodEnd.getTime() + 86_400_000);
  const insidePeriod = (offsetDays = 14) =>
    new Date(periodStart.getTime() + offsetDays * 86_400_000).toISOString();

  let readingId: string | null = null;
  if (options.withReading) {
    const reading = await api()
      .post(`/api/v1/utility/meters/${meterId}/readings`)
      .set(auth())
      .send({
        readingValue: options.readingValue ?? 1234.5,
        readingAt: insidePeriod(),
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

  return {
    meterId,
    uomId,
    readingDueId,
    generatedTaskId,
    readingId,
    periodStart,
    periodEnd,
    insidePeriod,
  };
}

/**
 * A second field execution — its own schedule, generated task, ACTIVE assignment
 * and Reading Due — over an ALREADY EXISTING meter.
 *
 * The main fixture always mints a new meter, but several canonical cases need two
 * independent field executions on the SAME meter (`UNIQUE (meter_id,
 * period_start, period_end)` explicitly allows it).
 */
async function createDueOnExistingMeter(options: {
  meterId: string;
  clientId: string;
  buildingId: string;
  assignToProfileId: string;
  periodStart: string;
}): Promise<{ readingDueId: string; insidePeriod: (offsetDays?: number) => string }> {
  const scheduleDefinitionId = await insertRow('schedule_definitions', {
    client_id: options.clientId,
    code: `SD_${suffix()}`,
    name: 'Second meter reading schedule',
    target_type: 'UTILITY_METER',
    target_id: options.meterId,
    building_id: options.buildingId,
    start_at: '2027-01-01T00:00:00Z',
    timezone: 'Asia/Jakarta',
    status: 'ACTIVE',
  });
  const generatedTaskId = await insertRow('generated_tasks', {
    client_id: options.clientId,
    schedule_definition_id: scheduleDefinitionId,
    occurrence_at: '2027-01-20T01:00:00Z',
    target_type: 'UTILITY_METER',
    target_id: options.meterId,
    building_id: options.buildingId,
    status: 'OPEN',
  });
  await insertRow('task_assignments', {
    task_id: generatedTaskId,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: options.assignToProfileId,
    team_id: null,
    assigned_by_user_id: adminUserId,
    status: 'ACTIVE',
  });

  const periodStart = new Date(options.periodStart);
  const periodEnd = new Date(periodStart.getTime() + 31 * 86_400_000);
  const dueAt = new Date(periodEnd.getTime() + 86_400_000);
  const due = await api()
    .post(`/api/v1/utility/meters/${options.meterId}/reading-dues`)
    .set(auth())
    .send({
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      dueAt: dueAt.toISOString(),
      scheduleDefinitionId,
      generatedTaskId,
    });
  assert.equal(due.status, 201, JSON.stringify(due.body));
  return {
    readingDueId: due.body.data.id as string,
    insidePeriod: (offsetDays = 14) =>
      new Date(periodStart.getTime() + offsetDays * 86_400_000).toISOString(),
  };
}

/** A field submit with NO Idempotency-Key header at all. */
function submitWithoutKey(
  readingDueId: string,
  body: Record<string, unknown>,
  token?: string,
) {
  return api()
    .post(readingsUrl(readingDueId))
    .set(auth(token ?? workerToken))
    .send(body);
}

async function countReadings(meterId: string): Promise<number> {
  const result = await q(
    'SELECT COUNT(*)::int AS count FROM utility_meter_readings WHERE meter_id = $1',
    [meterId],
  );
  return result.rows[0]?.count ?? 0;
}

async function countEvents(
  entityType: string,
  eventType: string,
  entityId?: string,
): Promise<number> {
  const result = await q(
    `SELECT COUNT(*)::int AS count FROM operational_events
      WHERE entity_type = $1 AND event_type = $2
        ${entityId ? 'AND entity_id = $3' : ''}`,
    entityId ? [entityType, eventType, entityId] : [entityType, eventType],
  );
  return result.rows[0]?.count ?? 0;
}

async function loadDue(readingDueId: string) {
  const result = await q(
    `SELECT id, meter_id, status, meter_reading_id, completed_at, completed_by_user_id
       FROM utility_reading_dues WHERE id = $1`,
    [readingDueId],
  );
  return result.rows[0] as {
    id: string;
    meter_id: string;
    status: string;
    meter_reading_id: string | null;
    completed_at: string | null;
    completed_by_user_id: string | null;
  };
}

async function countIdempotencyRecords(): Promise<number> {
  const result = await q(
    `SELECT COUNT(*)::int AS count FROM request_idempotency_records
      WHERE operation_key = 'recordMobileUtilityMeterReading'`,
  );
  return result.rows[0]?.count ?? 0;
}

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  database = db;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE request_idempotency_records, operational_events,
       utility_reading_dues, utility_meter_ocr_candidates,
       utility_meter_consumptions, utility_abnormal_consumptions,
       utility_abnormality_rules, utility_operational_exceptions,
       evidence_submissions, utility_meter_readings,
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

  const worker = await createUserWithPermissions('worker', [
    'utility_meter.field.read',
    'utility_meter.field.record',
  ]);
  workerUserId = worker.userId;
  workerToken = worker.token;

  const otherWorker = await createUserWithPermissions('other', [
    'utility_meter.field.read',
    'utility_meter.field.record',
  ]);
  otherWorkerUserId = otherWorker.userId;
  otherWorkerToken = otherWorker.token;

  const readOnlyField = await createUserWithPermissions('rofield', [
    'utility_meter.field.read',
  ]);
  readOnlyFieldUserId = readOnlyField.userId;
  readOnlyFieldToken = readOnlyField.token;
  manageOnlyToken = (
    await createUserWithPermissions('mgr', [
      'utility_meter.read',
      'utility_meter.manage',
    ])
  ).token;
  bindingManagerToken = (
    await createUserWithPermissions('binder', ['meter_reading_binding.manage'])
  ).token;
  noFieldToken = (
    await createUserWithPermissions('nofield', ['utility_meter.read'])
  ).token;
});

after(async () => {
  if (pool) {
    await closePool();
  }
});

// ===========================================================================
// §27 — FIELD AUTHORITY (tests 1–8)
// ===========================================================================
describe('CR-BE-RN12-METER-FIELD-01 PART 01 §27 — field authority', () => {
  it('1. an authorized field actor can submit a reading', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k1-${id()}`)
      .send({ readingValue: 100.5, readingAt: execution.insidePeriod() });

    assert.equal(response.status, 201, JSON.stringify(response.body));
    const reading = response.body.data.reading;
    assert.equal(reading.meterId, execution.meterId);
    assert.equal(reading.readingValue, 100.5);
    assert.equal(reading.source, 'MANUAL');
    assert.equal(reading.readingType, 'ACTUAL');
    assert.equal(reading.recordedByUserId, workerUserId);
  });

  it('2. utility_meter.field.read WITHOUT field.record is denied', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    // This actor is the ASSIGNEE of the due's task and holds Building access, so
    // it satisfies the PART 00 field-actor seam completely. The ONLY thing it
    // lacks is `utility_meter.field.record`, which is exactly what this test
    // isolates: the write half of the field permission pair is separately gated.
    const readOnlyProfile = await createProfile(readOnlyFieldUserId);
    await grantBuildingAccess(readOnlyFieldUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: readOnlyProfile,
    });

    // The PART 00 context read succeeds — full field authority is present.
    const canRead = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(readOnlyFieldToken));
    assert.equal(canRead.status, 200, JSON.stringify(canRead.body));

    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(readOnlyFieldToken))
      .set('Idempotency-Key', `k2-${id()}`)
      .send({ readingValue: 10, readingAt: execution.insidePeriod() });

    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    assert.equal(await countReadings(execution.meterId), 0);
  });

  it('3. Building access failure is denied', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    // Deliberately NO grantBuildingAccess for this Building.
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k3-${id()}`)
      .send({ readingValue: 10, readingAt: execution.insidePeriod() });

    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal(await countReadings(execution.meterId), 0);
  });

  it('4. an unassigned actor is denied', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const workerProfile = await createProfile(workerUserId);
    const intruderProfile = await createProfile(otherWorkerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    await grantBuildingAccess(otherWorkerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: workerProfile, // NOT intruderProfile
    });

    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(otherWorkerToken))
      .set('Idempotency-Key', `k4-${id()}`)
      .send({ readingValue: 10, readingAt: execution.insidePeriod() });

    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_READING_DUE_FIELD_UNAUTHORIZED',
    );
    assert.equal(await countReadings(execution.meterId), 0);
  });

  it('5. utility_meter.manage alone does not substitute the field permission', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(manageOnlyToken))
      .set('Idempotency-Key', `k5-${id()}`)
      .send({ readingValue: 10, readingAt: execution.insidePeriod() });

    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('6. meter_reading_binding.manage alone does not substitute it either', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    // BE-10C engineering binding administration is a different authority from
    // standing in front of a meter, and is never a substitute for it.
    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(bindingManagerToken))
      .set('Idempotency-Key', `k6-${id()}`)
      .send({ readingValue: 10, readingAt: execution.insidePeriod() });

    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('7. the mobile body cannot choose another meter', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });
    const foreign = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      periodStart: '2027-04-01T00:00:00.000Z',
    });

    // A smuggled meterId is REFUSED, not silently ignored — silence would leave
    // a client believing it had steered the reading.
    const refused = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k7-${id()}`)
      .send({
        readingValue: 10,
        readingAt: execution.insidePeriod(),
        meterId: foreign.meterId,
      });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, 'VALIDATION_ERROR');
    const detail = refused.body.error.details.find(
      (d: { field: string }) => d.field === 'meterId',
    );
    assert.ok(detail, 'meterId must be refused with an explicit reason');
    assert.match(detail.message, /derived from the Reading Due/i);

    // And the reading that IS accepted always lands on the due's own meter.
    const accepted = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k7b-${id()}`)
      .send({ readingValue: 10, readingAt: execution.insidePeriod() });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.reading.meterId, execution.meterId);
    assert.equal(await countReadings(foreign.meterId), 0);
  });

  it('8. the mobile body cannot choose UOM, actor, source or type', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    for (const [field, value] of [
      ['uomId', id()],
      ['recordedByUserId', id()],
      ['source', 'ENGINEERING'],
      ['readingType', 'ESTIMATED'],
      ['clientId', id()],
      ['buildingId', id()],
    ] as const) {
      const response = await api()
        .post(readingsUrl(execution.readingDueId))
        .set(auth(workerToken))
        .set('Idempotency-Key', `k8-${field}-${id()}`)
        .send({
          readingValue: 10,
          readingAt: execution.insidePeriod(),
          [field]: value,
        });
      assert.equal(response.status, 400, `${field}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      const detail = response.body.error.details.find(
        (d: { field: string }) => d.field === field,
      );
      assert.ok(detail, `${field} must be refused with an explicit reason`);
    }
    assert.equal(await countReadings(execution.meterId), 0);
  });
});

// ===========================================================================
// §28 — VALUE CONTRACT (tests 9–17)
// ===========================================================================
describe('CR-BE-RN12-METER-FIELD-01 PART 01 §28 — value contract', () => {
  it('9. a valid canonical reading succeeds', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const readingAt = execution.insidePeriod();
    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k9-${id()}`)
      .send({ readingValue: 250.25, readingAt, notes: 'Panel 3, dry weather' });

    assert.equal(response.status, 201, JSON.stringify(response.body));
    const reading = response.body.data.reading;
    assert.deepEqual(Object.keys(reading).sort(), [
      'createdAt',
      'id',
      'meterId',
      'notes',
      'readingAt',
      'readingType',
      'readingValue',
      'recordedByUserId',
      'source',
      'uomId',
    ]);
    assert.equal(reading.readingValue, 250.25);
    assert.equal(reading.readingAt, readingAt);
    assert.equal(reading.notes, 'Panel 3, dry weather');
    assert.equal(await countReadings(execution.meterId), 1);
  });

  it('10. a negative reading is rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k10-${id()}`)
      .send({ readingValue: -1, readingAt: execution.insidePeriod() });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.equal(await countReadings(execution.meterId), 0);
  });

  it('11. decimal precision is enforced from BE-18B configuration', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      decimalPrecision: 2,
    });

    const tooPrecise = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k11a-${id()}`)
      .send({ readingValue: 10.1234, readingAt: execution.insidePeriod() });
    assert.equal(tooPrecise.status, 400, JSON.stringify(tooPrecise.body));
    assert.equal(
      tooPrecise.body.error.code,
      'UTILITY_METER_READING_VALUE_INVALID',
    );

    // Exactly at the configured precision is accepted — the rule is a bound,
    // not a rounding, and the field path enforces the SAME canonical check.
    const exact = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k11b-${id()}`)
      .send({ readingValue: 10.12, readingAt: execution.insidePeriod() });
    assert.equal(exact.status, 201, JSON.stringify(exact.body));
    assert.equal(await countReadings(execution.meterId), 1);
  });

  it('12. the meter UOM is server-derived', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k12-${id()}`)
      .send({ readingValue: 5, readingAt: execution.insidePeriod() });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.reading.uomId, execution.uomId);
  });

  it('13/14. source and readingType are server-derived', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k13-${id()}`)
      .send({ readingValue: 5, readingAt: execution.insidePeriod() });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    // A technician physically reading a meter and entering the value is a human
    // capture of an observed value. ENGINEERING belongs to the BE-10C Asset +
    // Form Instance workflow, IMPORT to bulk loads, SYSTEM to generated values,
    // and ESTIMATED to a value nobody observed.
    assert.equal(response.body.data.reading.source, 'MANUAL');
    assert.equal(response.body.data.reading.readingType, 'ACTUAL');

    const stored = await q(
      'SELECT source, reading_type FROM utility_meter_readings WHERE meter_id = $1',
      [execution.meterId],
    );
    assert.equal(stored.rows[0].source, 'MANUAL');
    assert.equal(stored.rows[0].reading_type, 'ACTUAL');
  });

  it('15. recordedBy is the authenticated actor', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const otherProfile = await createProfile(otherWorkerUserId);
    await grantBuildingAccess(otherWorkerUserId, structure.buildingId);
    // A task has exactly ONE active assignee, so the actor under test must be
    // the assignee of the execution it submits against.
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: otherProfile,
    });

    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(otherWorkerToken))
      .set('Idempotency-Key', `k15-${id()}`)
      .send({ readingValue: 7, readingAt: execution.insidePeriod() });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.reading.recordedByUserId, otherWorkerUserId);
    assert.notEqual(otherWorkerUserId, workerUserId);
    // The stored row carries the same attribution.
    const stored = await q(
      'SELECT recorded_by_user_id FROM utility_meter_readings WHERE id = $1',
      [response.body.data.reading.id],
    );
    assert.equal(stored.rows[0].recorded_by_user_id, otherWorkerUserId);
  });

  it('16/17. no previousReadingId and no consumption/delta are accepted', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    for (const field of [
      'previousReadingId',
      'previousReadingValue',
      'consumption',
      'delta',
      'difference',
      'usage',
    ]) {
      const response = await api()
        .post(readingsUrl(execution.readingDueId))
        .set(auth(workerToken))
        .set('Idempotency-Key', `k16-${field}-${id()}`)
        .send({
          readingValue: 10,
          readingAt: execution.insidePeriod(),
          [field]: field === 'previousReadingId' ? id() : 1,
        });
      assert.equal(response.status, 400, `${field}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      const detail = response.body.error.details.find(
        (d: { field: string }) => d.field === field,
      );
      assert.ok(detail, `${field} must be refused with an explicit reason`);
    }
    assert.equal(await countReadings(execution.meterId), 0);
  });
});

// ===========================================================================
// §29 — IDEMPOTENCY (tests 18–31)
// ===========================================================================
describe('CR-BE-RN12-METER-FIELD-01 PART 01 §29 — idempotency', () => {
  it('18. a missing Idempotency-Key is rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const missing = await submitWithoutKey(execution.readingDueId, {
      readingValue: 10,
      readingAt: execution.insidePeriod(),
    });
    assert.equal(missing.status, 400, JSON.stringify(missing.body));
    assert.equal(missing.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const blank = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', '   ')
      .send({ readingValue: 10, readingAt: execution.insidePeriod() });
    assert.equal(blank.status, 400, JSON.stringify(blank.body));
    assert.equal(blank.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    assert.equal(await countReadings(execution.meterId), 0);
  });

  it('19–23. a first call creates once; an identical replay adds nothing', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const key = `k19-${id()}`;
    const body = { readingValue: 321.75, readingAt: execution.insidePeriod(10) };

    const first = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', key)
      .send(body);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    // Counts are scoped to THIS reading and THIS due: the suite shares one
    // database, so an unscoped count would measure every earlier test too.
    const readingId = first.body.data.reading.id as string;
    assert.equal(await countReadings(execution.meterId), 1); // 19
    assert.equal(
      await countEvents(
        'UTILITY_METER_READING',
        'UTILITY_METER_READING_RECORDED',
        readingId,
      ),
      1,
    );
    assert.equal(
      await countEvents(
        'UTILITY_READING_DUE',
        'UTILITY_READING_DUE_COMPLETED',
        execution.readingDueId,
      ),
      1,
    );

    // 20 — identical replay returns the SAME reading id and the SAME body.
    const replay = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', key)
      .send(body);
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.deepEqual(replay.body.data, first.body.data);
    assert.equal(replay.body.data.reading.id, first.body.data.reading.id);

    // 21 — no second reading. 22 — no duplicate event. 23 — no duplicate
    // transition or link.
    assert.equal(await countReadings(execution.meterId), 1);
    assert.equal(
      await countEvents(
        'UTILITY_METER_READING',
        'UTILITY_METER_READING_RECORDED',
        readingId,
      ),
      1,
    );
    assert.equal(
      await countEvents(
        'UTILITY_READING_DUE',
        'UTILITY_READING_DUE_COMPLETED',
        execution.readingDueId,
      ),
      1,
    );
    const due = await loadDue(execution.readingDueId);
    assert.equal(due.status, 'COMPLETED');
    assert.equal(due.meter_reading_id, readingId);
  });

  it('24/25/26. a changed value, readingAt or notes under the same key conflicts', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    const variants: Array<{
      label: string;
      first: Record<string, unknown>;
      second: (first: Record<string, unknown>) => Record<string, unknown>;
    }> = [
      {
        label: '24 readingValue',
        first: { readingValue: 10, readingAt: '2027-01-15T00:00:00.000Z' },
        second: (f) => ({ ...f, readingValue: 11 }),
      },
      {
        label: '25 readingAt',
        first: { readingValue: 10, readingAt: '2027-01-15T00:00:00.000Z' },
        second: (f) => ({ ...f, readingAt: '2027-01-16T00:00:00.000Z' }),
      },
      {
        label: '26 notes',
        first: {
          readingValue: 10,
          readingAt: '2027-01-15T00:00:00.000Z',
          notes: 'first',
        },
        second: (f) => ({ ...f, notes: 'second' }),
      },
    ];

    for (const variant of variants) {
      const execution = await createFieldExecution({
        ...structure,
        assignToProfileId: profileId,
      });
      const key = `k-${variant.label.replace(/\s/g, '-')}-${id()}`;

      const first = await api()
        .post(readingsUrl(execution.readingDueId))
        .set(auth(workerToken))
        .set('Idempotency-Key', key)
        .send(variant.first);
      assert.equal(first.status, 201, `${variant.label}: ${JSON.stringify(first.body)}`);

      const second = await api()
        .post(readingsUrl(execution.readingDueId))
        .set(auth(workerToken))
        .set('Idempotency-Key', key)
        .send(variant.second(variant.first));
      assert.equal(second.status, 409, `${variant.label}: ${JSON.stringify(second.body)}`);
      assert.equal(second.body.error.code, 'IDEMPOTENCY_CONFLICT');
      // The conflict leaks no stored response, fingerprint or raw key.
      assert.ok(!JSON.stringify(second.body).includes(first.body.data.reading.id));
      assert.equal(await countReadings(execution.meterId), 1);
    }
  });

  it('27. a different actor with the same key is an independent namespace', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const workerProfile = await createProfile(workerUserId);
    const otherProfile = await createProfile(otherWorkerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    await grantBuildingAccess(otherWorkerUserId, structure.buildingId);

    const sharedKey = `k27-${id()}`;
    const executionA = await createFieldExecution({
      ...structure,
      assignToProfileId: workerProfile,
    });
    const executionB = await createFieldExecution({
      ...structure,
      assignToProfileId: otherProfile,
      periodStart: '2027-04-01T00:00:00.000Z',
    });

    const byWorker = await api()
      .post(readingsUrl(executionA.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', sharedKey)
      .send({ readingValue: 11, readingAt: executionA.insidePeriod() });
    assert.equal(byWorker.status, 201, JSON.stringify(byWorker.body));

    // Same raw key, different actor, different semantic request: NOT a conflict,
    // because identity is scoped by actor. Each namespace is independent.
    const byOther = await api()
      .post(readingsUrl(executionB.readingDueId))
      .set(auth(otherWorkerToken))
      .set('Idempotency-Key', sharedKey)
      .send({ readingValue: 22, readingAt: executionB.insidePeriod() });
    assert.equal(byOther.status, 201, JSON.stringify(byOther.body));
    assert.notEqual(
      byOther.body.data.reading.id,
      byWorker.body.data.reading.id,
    );
    assert.equal(byOther.body.data.reading.recordedByUserId, otherWorkerUserId);

    const rows = await q(
      `SELECT actor_user_id FROM request_idempotency_records
        WHERE idempotency_key_hash = $1`,
      [sha256(sharedKey)],
    );
    assert.equal(rows.rowCount, 2);
    assert.deepEqual(
      rows.rows.map((r) => r.actor_user_id).sort(),
      [workerUserId, otherWorkerUserId].sort(),
    );
  });

  it('28. an authority or validation failure does not poison the key', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const key = `k28-${id()}`;
    const hash = sha256(key);
    const before = await countIdempotencyRecords();

    // Validation failure — rejected in the controller, before any claim.
    const invalid = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', key)
      .send({ readingValue: -5, readingAt: execution.insidePeriod() });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));

    // Authority failure — also before any claim.
    const unauthorized = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(manageOnlyToken))
      .set('Idempotency-Key', key)
      .send({ readingValue: 5, readingAt: execution.insidePeriod() });
    assert.equal(unauthorized.status, 403, JSON.stringify(unauthorized.body));

    const claims = await q(
      'SELECT COUNT(*)::int AS count FROM request_idempotency_records WHERE idempotency_key_hash = $1',
      [hash],
    );
    assert.equal(claims.rows[0].count, 0, 'no claim may survive a failed attempt');
    assert.equal(await countIdempotencyRecords(), before);

    // The very same key still works for a legitimate first execution.
    const success = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', key)
      .send({ readingValue: 5, readingAt: execution.insidePeriod() });
    assert.equal(success.status, 201, JSON.stringify(success.body));
    assert.equal(await countReadings(execution.meterId), 1);
  });

  it('29. an event failure rolls back the reading, the due link and the claim', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const key = `k29-${id()}`;
    const hash = sha256(key);

    // Force the audit event to fail AFTER the reading row is written, which is
    // precisely the pre-existing weakness: two separate statements, no shared
    // transaction. If atomicity holds, nothing at all survives.
    await q(`
      CREATE OR REPLACE FUNCTION rn12_fail_reading_event() RETURNS trigger AS $fn$
        BEGIN
          RAISE EXCEPTION 'RN12 forced UTILITY_METER_READING_RECORDED failure';
        END
      $fn$ LANGUAGE plpgsql;
    `);
    await q(`
      CREATE TRIGGER rn12_fail_reading_event_trg
      BEFORE INSERT ON operational_events
      FOR EACH ROW
      WHEN (NEW.event_type = 'UTILITY_METER_READING_RECORDED')
      EXECUTE FUNCTION rn12_fail_reading_event();
    `);

    try {
      const response = await api()
        .post(readingsUrl(execution.readingDueId))
        .set(auth(workerToken))
        .set('Idempotency-Key', key)
        .send({ readingValue: 42, readingAt: execution.insidePeriod() });
      assert.ok(
        response.status >= 400,
        `expected a failure, got ${response.status}`,
      );

      // No reading committed without its event.
      assert.equal(await countReadings(execution.meterId), 0);
      // No due transition or link.
      const due = await loadDue(execution.readingDueId);
      assert.equal(due.status, 'DUE');
      assert.equal(due.meter_reading_id, null);
      assert.equal(due.completed_at, null);
      // No poisoned idempotency record — the key stays retryable.
      const claims = await q(
        'SELECT COUNT(*)::int AS count FROM request_idempotency_records WHERE idempotency_key_hash = $1',
        [hash],
      );
      assert.equal(claims.rows[0].count, 0);
    } finally {
      await q('DROP TRIGGER IF EXISTS rn12_fail_reading_event_trg ON operational_events');
      await q('DROP FUNCTION IF EXISTS rn12_fail_reading_event()');
    }

    // Same key, same body, now succeeds — proof the failure left no residue.
    const retry = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', key)
      .send({ readingValue: 42, readingAt: execution.insidePeriod() });
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.equal(await countReadings(execution.meterId), 1);
  });

  it('30. a due-link failure rolls back the reading, the event and the claim', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const key = `k30-${id()}`;
    const hash = sha256(key);
    const eventsBefore = await countEvents(
      'UTILITY_METER_READING',
      'UTILITY_METER_READING_RECORDED',
    );

    // A capture instant OUTSIDE the due period: the reading itself is perfectly
    // valid, but the canonical completion refuses to link it. Because the whole
    // command is one transaction, the valid reading must not survive either.
    const outsidePeriod = new Date(
      execution.periodEnd.getTime() + 5 * 86_400_000,
    ).toISOString();

    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', key)
      .send({ readingValue: 99, readingAt: outsidePeriod });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_READING_DUE_READING_MISMATCH',
    );
    assert.equal(await countReadings(execution.meterId), 0);
    assert.equal(
      await countEvents('UTILITY_METER_READING', 'UTILITY_METER_READING_RECORDED'),
      eventsBefore,
    );
    const due = await loadDue(execution.readingDueId);
    assert.equal(due.status, 'DUE');
    assert.equal(due.meter_reading_id, null);
    const claims = await q(
      'SELECT COUNT(*)::int AS count FROM request_idempotency_records WHERE idempotency_key_hash = $1',
      [hash],
    );
    assert.equal(claims.rows[0].count, 0);

    // The same key with a corrected instant is a fresh, successful first execution.
    const corrected = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', key)
      .send({ readingValue: 99, readingAt: execution.insidePeriod() });
    assert.equal(corrected.status, 201, JSON.stringify(corrected.body));
  });

  it('31. the raw Idempotency-Key is never persisted', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    // A distinctive raw key that would be trivially findable if it leaked.
    const rawKey = `RN12-RAW-SECRET-${suffix()}`;
    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', rawKey)
      .send({ readingValue: 3, readingAt: execution.insidePeriod() });
    assert.equal(response.status, 201, JSON.stringify(response.body));

    // Only the SHA-256 hash is stored, never the raw value.
    const record = await q(
      `SELECT idempotency_key_hash, response_body::text AS body
         FROM request_idempotency_records
        WHERE operation_key = 'recordMobileUtilityMeterReading'
          AND idempotency_key_hash = $1`,
      [sha256(rawKey)],
    );
    assert.equal(record.rowCount, 1);
    assert.equal(record.rows[0].idempotency_key_hash, sha256(rawKey));
    assert.ok(!record.rows[0].body.includes(rawKey));

    // No table anywhere in the command's footprint stores the raw key.
    const scanned = await q(
      `SELECT COUNT(*)::int AS count FROM request_idempotency_records
        WHERE idempotency_key_hash = $1 OR response_body::text LIKE $2`,
      [rawKey, `%${rawKey}%`],
    );
    assert.equal(scanned.rows[0].count, 0);
    const eventLeak = await q(
      `SELECT COUNT(*)::int AS count FROM operational_events
        WHERE metadata::text LIKE $1 OR summary LIKE $1`,
      [`%${rawKey}%`],
    );
    assert.equal(eventLeak.rows[0].count, 0);

    // And the response never echoes it back.
    assert.ok(!JSON.stringify(response.body).includes(rawKey));
  });
});

// ===========================================================================
// §30 — CONCURRENCY (tests 32–39)
// ===========================================================================
describe('CR-BE-RN12-METER-FIELD-01 PART 01 §30 — concurrency', () => {
  it('32–37. two concurrent different-key submissions: exactly one wins', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const keyA = `k32a-${id()}`;
    const keyB = `k32b-${id()}`;

    // DIFFERENT idempotency keys AND different capture instants, so neither the
    // idempotency core nor the meter+instant unique index can be what stops the
    // second one. Only the field-execution cardinality can.
    const [a, b] = await Promise.all([
      api()
        .post(readingsUrl(execution.readingDueId))
        .set(auth(workerToken))
        .set('Idempotency-Key', keyA)
        .send({ readingValue: 100, readingAt: execution.insidePeriod(5) }),
      api()
        .post(readingsUrl(execution.readingDueId))
        .set(auth(workerToken))
        .set('Idempotency-Key', keyB)
        .send({ readingValue: 200, readingAt: execution.insidePeriod(6) }),
    ]);

    const statuses = [a.status, b.status].sort();
    // 33 — exactly one first execution wins. 34 — the loser gets a
    // deterministic DOMAIN conflict, not a 500 and not a silent success.
    assert.deepEqual(statuses, [201, 409], `a=${a.status} b=${b.status}`);
    const loser = a.status === 409 ? a : b;
    const winner = a.status === 201 ? a : b;
    const winnerKey = a.status === 201 ? keyA : keyB;
    const loserKey = a.status === 201 ? keyB : keyA;
    assert.equal(
      loser.body.error.code,
      'UTILITY_READING_DUE_TRANSITION_INVALID',
      JSON.stringify(loser.body),
    );

    // 35 — no orphan second reading remains.
    assert.equal(await countReadings(execution.meterId), 1);
    // 36 — the due links exactly one reading, and it is the winner's.
    const due = await loadDue(execution.readingDueId);
    assert.equal(due.status, 'COMPLETED');
    assert.equal(due.meter_reading_id, winner.body.data.reading.id);
    // 37 — event count matches committed reading count: exactly one RECORDED
    // event for the one committed reading, and one COMPLETED event for the due.
    assert.equal(
      await countEvents(
        'UTILITY_METER_READING',
        'UTILITY_METER_READING_RECORDED',
        winner.body.data.reading.id,
      ),
      1,
    );
    assert.equal(
      await countEvents(
        'UTILITY_READING_DUE',
        'UTILITY_READING_DUE_COMPLETED',
        execution.readingDueId,
      ),
      1,
    );
    // The winner's claim is stored COMPLETED; the loser's rolled back with its
    // transaction, so its key was never poisoned and stays retryable.
    const claims = await q(
      `SELECT idempotency_key_hash, status FROM request_idempotency_records
        WHERE idempotency_key_hash = ANY($1::text[])`,
      [[sha256(keyA), sha256(keyB)]],
    );
    assert.equal(claims.rowCount, 1);
    assert.equal(claims.rows[0].idempotency_key_hash, sha256(winnerKey));
    assert.equal(claims.rows[0].status, 'COMPLETED');
    assert.notEqual(sha256(winnerKey), sha256(loserKey));
  });

  it('38. two legitimate dues on one meter stay independently executable', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    // The same meter may carry several OPEN dues for different periods
    // (UNIQUE (meter_id, period_start, period_end)), and each is its own field
    // execution. Locking the DUE — not the meter — is what preserves that.
    const first = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      periodStart: '2027-01-01T00:00:00.000Z',
    });
    const secondMeter = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      periodStart: '2027-03-01T00:00:00.000Z',
    });
    assert.notEqual(first.meterId, secondMeter.meterId);

    const firstSubmit = await api()
      .post(readingsUrl(first.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k38a-${id()}`)
      .send({ readingValue: 10, readingAt: first.insidePeriod() });
    assert.equal(firstSubmit.status, 201, JSON.stringify(firstSubmit.body));

    const secondSubmit = await api()
      .post(readingsUrl(secondMeter.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k38b-${id()}`)
      .send({ readingValue: 20, readingAt: secondMeter.insidePeriod() });
    assert.equal(secondSubmit.status, 201, JSON.stringify(secondSubmit.body));

    assert.equal((await loadDue(first.readingDueId)).status, 'COMPLETED');
    assert.equal((await loadDue(secondMeter.readingDueId)).status, 'COMPLETED');
  });

  it('39. the meter + readingAt unique guard is preserved', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);

    const first = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      periodStart: '2027-01-01T00:00:00.000Z',
    });
    // A DIFFERENT due on a DIFFERENT meter, but submitted at the SAME instant as
    // a reading that already exists on the first meter — proving the canonical
    // meter-level guard still fires and was not weakened by the field path.
    const sameInstant = first.insidePeriod(9);
    const posted = await api()
      .post(readingsUrl(first.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k39a-${id()}`)
      .send({ readingValue: 10, readingAt: sameInstant });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));

    // Same meter, a SECOND legitimate field execution (own task, own assignment,
    // own due, overlapping period), submitted at the SAME instant → the
    // canonical meter-level duplicate guard must still fire. The field path
    // neither removes nor relies on it as command idempotency.
    const secondDue = await createDueOnExistingMeter({
      meterId: first.meterId,
      clientId: structure.clientId,
      buildingId: structure.buildingId,
      assignToProfileId: profileId,
      periodStart: '2027-01-05T00:00:00.000Z',
    });
    const duplicate = await api()
      .post(readingsUrl(secondDue.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k39b-${id()}`)
      .send({ readingValue: 11, readingAt: sameInstant });

    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(
      duplicate.body.error.code,
      'UTILITY_METER_READING_ALREADY_EXISTS',
    );
    assert.equal(await countReadings(first.meterId), 1);
  });
});

// ===========================================================================
// §31 — DUE LIFECYCLE (tests 40–44)
// ===========================================================================
describe('CR-BE-RN12-METER-FIELD-01 PART 01 §31 — due lifecycle', () => {
  it('40/41. a successful submission links meter_reading_id and completes the due', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const before = await loadDue(execution.readingDueId);
    assert.equal(before.status, 'DUE');
    assert.equal(before.meter_reading_id, null);

    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k40-${id()}`)
      .send({ readingValue: 55.5, readingAt: execution.insidePeriod() });
    assert.equal(response.status, 201, JSON.stringify(response.body));

    const after = await loadDue(execution.readingDueId);
    // 40 — the canonical correlation column is attached.
    assert.equal(after.meter_reading_id, response.body.data.reading.id);
    // 41 — canonical completion, performed by the EXISTING due service: the
    // stored status, timestamp and actor are all set, and the canonical
    // UTILITY_READING_DUE_COMPLETED event was written.
    assert.equal(after.status, 'COMPLETED');
    assert.ok(after.completed_at, 'completed_at must be set');
    assert.equal(after.completed_by_user_id, workerUserId);
    assert.equal(
      await countEvents(
        'UTILITY_READING_DUE',
        'UTILITY_READING_DUE_COMPLETED',
        execution.readingDueId,
      ),
      1,
    );
  });

  it('42. a CANCELLED due rejects a first submission', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      dueStatus: 'CANCELLED',
    });

    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k42-${id()}`)
      .send({ readingValue: 10, readingAt: execution.insidePeriod() });

    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_READING_DUE_TRANSITION_INVALID',
    );
    assert.equal(await countReadings(execution.meterId), 0);
    assert.equal((await loadDue(execution.readingDueId)).status, 'CANCELLED');
  });

  it('43/44. a COMPLETED due rejects a new intent but replays its own', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const key = `k43-${id()}`;
    const body = { readingValue: 77, readingAt: execution.insidePeriod() };
    const first = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', key)
      .send(body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal((await loadDue(execution.readingDueId)).status, 'COMPLETED');

    // 43 — a DIFFERENT idempotency intent against the now-completed due is
    // refused. This is the guard that makes one-due-one-reading real.
    const differentIntent = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k43-other-${id()}`)
      .send({ readingValue: 88, readingAt: execution.insidePeriod(11) });
    assert.equal(differentIntent.status, 409, JSON.stringify(differentIntent.body));
    assert.equal(
      differentIntent.body.error.code,
      'UTILITY_READING_DUE_TRANSITION_INVALID',
    );
    assert.equal(await countReadings(execution.meterId), 1);

    // 44 — the SAME key still replays the stored success, even though the due is
    // now COMPLETED. The state guard lives inside the idempotent execution
    // precisely so this retry is not punished.
    const replay = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', key)
      .send(body);
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.deepEqual(replay.body.data, first.body.data);
    assert.equal(await countReadings(execution.meterId), 1);
  });
});

// ===========================================================================
// §32 — READ / HISTORY (tests 45–52)
// ===========================================================================
describe('CR-BE-RN12-METER-FIELD-01 PART 01 §32 — read and history', () => {
  it('45–48. history derives the meter from the due, in canonical order, bounded', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    // Seed three canonical readings directly on the DUE'S meter, plus one on a
    // different meter that must never appear.
    const instants = [3, 10, 17].map((day) => execution.insidePeriod(day));
    for (const [index, readingAt] of instants.entries()) {
      const created = await api()
        .post(`/api/v1/utility/meters/${execution.meterId}/readings`)
        .set(auth())
        .send({ readingValue: (index + 1) * 100, readingAt });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    }
    const foreign = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      periodStart: '2027-05-01T00:00:00.000Z',
    });
    const foreignReading = await api()
      .post(`/api/v1/utility/meters/${foreign.meterId}/readings`)
      .set(auth())
      .send({ readingValue: 999, readingAt: foreign.insidePeriod() });
    assert.equal(foreignReading.status, 201, JSON.stringify(foreignReading.body));

    const response = await api()
      .get(readingsUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const readings = response.body.data;

    // 45 — the meter came from the due; the caller supplied no meterId.
    assert.equal(readings.length, 3);
    assert.ok(readings.every((r: { meterId: string }) => r.meterId === execution.meterId));
    // 48 — another meter's reading is excluded.
    assert.ok(!readings.some((r: { id: string }) => r.id === foreignReading.body.data.id));

    // 46 — canonical order: reading_at DESC, created_at DESC. Server-sorted,
    // never client-sorted.
    const values = readings.map((r: { readingValue: number }) => r.readingValue);
    assert.deepEqual(values, [300, 200, 100]);
    const timestamps = readings.map((r: { readingAt: string }) => r.readingAt);
    assert.deepEqual(timestamps, [...timestamps].sort().reverse());

    // 47 — bounded by the EXISTING canonical limit semantics.
    const limited = await api()
      .get(`${readingsUrl(execution.readingDueId)}?limit=2`)
      .set(auth(workerToken));
    assert.equal(limited.status, 200, JSON.stringify(limited.body));
    assert.equal(limited.body.data.length, 2);
    assert.deepEqual(
      limited.body.data.map((r: { readingValue: number }) => r.readingValue),
      [300, 200],
    );

    const tooLarge = await api()
      .get(`${readingsUrl(execution.readingDueId)}?limit=501`)
      .set(auth(workerToken));
    assert.equal(tooLarge.status, 400, JSON.stringify(tooLarge.body));
    assert.equal(tooLarge.body.error.code, 'VALIDATION_ERROR');
  });

  it('49/50. detail returns a same-meter reading and never another meter’s', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });
    const foreign = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
      periodStart: '2027-06-01T00:00:00.000Z',
    });

    const own = await api()
      .post(`/api/v1/utility/meters/${execution.meterId}/readings`)
      .set(auth())
      .send({ readingValue: 12, readingAt: execution.insidePeriod() });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    const foreignReading = await api()
      .post(`/api/v1/utility/meters/${foreign.meterId}/readings`)
      .set(auth())
      .send({ readingValue: 34, readingAt: foreign.insidePeriod() });
    assert.equal(foreignReading.status, 201, JSON.stringify(foreignReading.body));

    // 49 — a reading of the due's own meter is returned.
    const ok = await api()
      .get(readingUrl(execution.readingDueId, own.body.data.id))
      .set(auth(workerToken));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.id, own.body.data.id);
    assert.equal(ok.body.data.meterId, execution.meterId);

    // 50 — a reading of ANOTHER meter is not exposed under this due, and the
    // mismatch is reported as 404 (never confirming the row exists) rather than
    // 403.
    const leaked = await api()
      .get(readingUrl(execution.readingDueId, foreignReading.body.data.id))
      .set(auth(workerToken));
    assert.equal(leaked.status, 404, JSON.stringify(leaked.body));
    assert.equal(
      leaked.body.error.code,
      'UTILITY_METER_READING_NOT_FOUND',
    );
  });

  it('51/52. the read routes require the field permission and field authority', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const workerProfile = await createProfile(workerUserId);
    const otherProfile = await createProfile(otherWorkerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    await grantBuildingAccess(otherWorkerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: workerProfile, // otherWorker is NOT assigned
    });

    const routes = [
      readingsUrl(execution.readingDueId),
      readingUrl(execution.readingDueId, id()),
    ];

    // 51 — no field.read permission → 403 PERMISSION_DENIED.
    for (const url of routes) {
      const response = await api().get(url).set(auth(noFieldToken));
      assert.equal(response.status, 403, `${url}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    }

    // 52 — field.read but NOT an assigned executor → 403 FIELD_UNAUTHORIZED.
    for (const url of routes) {
      const response = await api().get(url).set(auth(otherWorkerToken));
      assert.equal(response.status, 403, `${url}: ${JSON.stringify(response.body)}`);
      assert.equal(
        response.body.error.code,
        'UTILITY_READING_DUE_FIELD_UNAUTHORIZED',
      );
    }

    // And unauthenticated is 401, before any permission is considered.
    for (const url of routes) {
      const response = await api().get(url);
      assert.equal(response.status, 401, `${url}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });
});

// ===========================================================================
// §33 — RECONCILIATION (tests 53–57)
// ===========================================================================
describe('CR-BE-RN12-METER-FIELD-01 PART 01 §33 — reconciliation', () => {
  it('53–57. submittedReading is the exact correlation, independent of latestReading', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    // 53 — before any submission the correlation read shows nothing submitted.
    const beforeCtx = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(beforeCtx.status, 200, JSON.stringify(beforeCtx.body));
    assert.equal(beforeCtx.body.data.submittedReading, null);
    assert.equal(beforeCtx.body.data.latestReading, null);

    const key = `k53-${id()}`;
    const body = { readingValue: 500, readingAt: execution.insidePeriod(8) };
    const submitted = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', key)
      .send(body);
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    const submittedId = submitted.body.data.reading.id;

    // 54 — after submission the context returns exactly the linked reading, so
    // an ambiguous client needs no second arbitrary lookup.
    const afterCtx = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(afterCtx.status, 200, JSON.stringify(afterCtx.body));
    assert.equal(afterCtx.body.data.submittedReading.id, submittedId);
    assert.equal(afterCtx.body.data.submittedReading.readingValue, 500);
    assert.equal(afterCtx.body.data.submittedReading.meterId, execution.meterId);
    assert.equal(afterCtx.body.data.latestReading.id, submittedId);

    // Now a LATER legitimate reading lands on the same meter through the
    // management path (an engineer, a correction, an import).
    const later = await api()
      .post(`/api/v1/utility/meters/${execution.meterId}/readings`)
      .set(auth())
      .send({ readingValue: 999, readingAt: execution.insidePeriod(20) });
    assert.equal(later.status, 201, JSON.stringify(later.body));

    const finalCtx = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(finalCtx.status, 200, JSON.stringify(finalCtx.body));
    // 55 — the due correlation did NOT move.
    assert.equal(finalCtx.body.data.submittedReading.id, submittedId);
    assert.equal(finalCtx.body.data.submittedReading.readingValue, 500);
    // 56 — while latestReading DID move. This divergence is exactly why the
    // correlation cannot be derived from "the latest reading".
    assert.equal(finalCtx.body.data.latestReading.id, later.body.data.id);
    assert.notEqual(
      finalCtx.body.data.latestReading.id,
      finalCtx.body.data.submittedReading.id,
    );

    // 57 — a same-key replay still returns the original response, so the client
    // resolves ambiguity by key or by correlation, never by inferring success
    // from a matching value or a nearby timestamp.
    const replay = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', key)
      .send(body);
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.reading.id, submittedId);
    assert.equal(await countReadings(execution.meterId), 2);
  });
});

// ===========================================================================
// §34 — SCOPE GUARDS (tests 58–66)
// ===========================================================================
describe('CR-BE-RN12-METER-FIELD-01 PART 01 §34 — scope guards', () => {
  it('58–63. a field submission creates no downstream or deferred artefact', async (t) => {
    if (!requireDatabase(t)) return;
    const structure = await createStructure();
    const profileId = await createProfile(workerUserId);
    await grantBuildingAccess(workerUserId, structure.buildingId);
    const execution = await createFieldExecution({
      ...structure,
      assignToProfileId: profileId,
    });

    const snapshot = async () => {
      const [consumptions, abnormal, abnormalRules, ocr, exceptions, evidence] =
        await Promise.all([
          q('SELECT COUNT(*)::int AS c FROM utility_meter_consumptions'),
          q('SELECT COUNT(*)::int AS c FROM utility_abnormal_consumptions'),
          q('SELECT COUNT(*)::int AS c FROM utility_abnormality_rules'),
          q('SELECT COUNT(*)::int AS c FROM utility_meter_ocr_candidates'),
          q('SELECT COUNT(*)::int AS c FROM utility_operational_exceptions'),
          q('SELECT COUNT(*)::int AS c FROM evidence_submissions'),
        ]);
      return {
        consumptions: consumptions.rows[0].c,
        abnormal: abnormal.rows[0].c,
        abnormalRules: abnormalRules.rows[0].c,
        ocr: ocr.rows[0].c,
        exceptions: exceptions.rows[0].c,
        evidence: evidence.rows[0].c,
      };
    };

    const before = await snapshot();

    const response = await api()
      .post(readingsUrl(execution.readingDueId))
      .set(auth(workerToken))
      .set('Idempotency-Key', `k58-${id()}`)
      .send({ readingValue: 1234, readingAt: execution.insidePeriod() });
    assert.equal(response.status, 201, JSON.stringify(response.body));

    const after = await snapshot();
    // 58 — no consumption row, no current-minus-previous arithmetic.
    assert.equal(after.consumptions, before.consumptions);
    // 59 — no abnormality evaluation.
    assert.equal(after.abnormal, before.abnormal);
    assert.equal(after.abnormalRules, before.abnormalRules);
    assert.equal(after.exceptions, before.exceptions);
    // 60 — no evidence mutation. 61 — no OCR mutation.
    assert.equal(after.evidence, before.evidence);
    assert.equal(after.ocr, before.ocr);

    // 63 — no action vocabulary anywhere in either response.
    for (const body of [response.body]) {
      assert.ok(!JSON.stringify(body).toLowerCase().includes('availableactions'));
      assert.ok(!JSON.stringify(body).toLowerCase().includes('allowedactions'));
    }
    const ctx = await api()
      .get(ctxUrl(execution.readingDueId))
      .set(auth(workerToken));
    assert.equal(ctx.status, 200);
    assert.ok(!JSON.stringify(ctx.body).toLowerCase().includes('availableactions'));

    // The reading DTO exposes no billing, delta or abnormality field.
    const reading = response.body.data.reading;
    for (const banned of [
      'tariff',
      'rate',
      'currency',
      'amount',
      'consumption',
      'delta',
      'abnormal',
      'ocr',
      'evidence',
      'previous',
    ]) {
      assert.ok(
        !Object.keys(reading).some((key) => key.toLowerCase().includes(banned)),
        `reading DTO must not expose a "${banned}" field`,
      );
    }
  });

  it('62. no recheck or correction entity or route exists', async (t) => {
    if (!requireDatabase(t)) return;
    const tables = await q(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND (tablename LIKE '%recheck%' OR tablename LIKE '%correction%')`,
    );
    assert.deepEqual(tables.rows, []);

    // Assert on ACTUAL route registrations, not on prose: module doc comments
    // legitimately name deferred scope, and a substring scan over them produces
    // false positives. Extracting the registered `router.<method>('<path>')`
    // literals is both precise and meaningful.
    const routeFiles = [
      resolve(__dirname, '../src/routes/index.ts'),
      resolve(
        __dirname,
        '../src/modules/mobile-utility-meter-reading/mobile-utility-meter-reading.routes.ts',
      ),
      resolve(
        __dirname,
        '../src/modules/mobile-utility-meter-context/mobile-utility-meter-context.routes.ts',
      ),
    ];
    const registeredPaths: string[] = [];
    for (const file of routeFiles) {
      const source = readFileSync(file, 'utf8');
      const matches = source.matchAll(
        /router\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g,
      );
      for (const match of matches) registeredPaths.push(match[1]);
    }
    assert.ok(
      registeredPaths.length > 0,
      'the probe must actually find registered routes',
    );
    for (const path of registeredPaths) {
      assert.doesNotMatch(path, /recheck/i, `no recheck route may exist: ${path}`);
      assert.doesNotMatch(
        path,
        /correction/i,
        `no correction route may exist: ${path}`,
      );
    }

    // No recheck / correction module is imported anywhere in the router.
    const routerSource = readFileSync(
      resolve(__dirname, '../src/routes/index.ts'),
      'utf8',
    );
    assert.doesNotMatch(routerSource, /from '[^']*(?:recheck|correction)[^']*'/i);
  });

  it('64. no QR resolution surface was added or changed', async (t) => {
    if (!requireDatabase(t)) return;
    const qrRoutes = readFileSync(
      resolve(__dirname, '../src/modules/mobile-qr-resolution/mobile-qr.routes.ts'),
      'utf8',
    );
    // The PART 01 module must not appear in the QR surface at all.
    assert.ok(!/utility-meter-reading|utility_reading_due/i.test(qrRoutes));

    const response = await api()
      .get(`/api/v1/mobile/qr/resolve/${encodeURIComponent('RN12-PROBE')}`);
    // Unauthenticated: handled by the existing QR route, never a 404 fall-through
    // and never a new utility behaviour.
    assert.ok(
      [401, 404].includes(response.status),
      `unexpected QR status ${response.status}`,
    );
  });

  it('65/66. BE-25H METER_READING and mobile-sync resources are unchanged', async (t) => {
    if (!requireDatabase(t)) return;
    // The BE-10C / BE-25H engineering METER_READING sync kind keeps its exact
    // existing permission, conflict route and resource mapping — PART 01 adds a
    // canonical BE-18E reading, which is a different thing entirely.
    const syncService = readFileSync(
      resolve(__dirname, '../src/modules/mobile-sync/mobile-sync.service.ts'),
      'utf8',
    );
    assert.match(
      syncService,
      /METER_READING:\s*'meter_reading_binding\.manage'/,
      'BE-25H METER_READING permission mapping must be unchanged',
    );

    const syncConflict = readFileSync(
      resolve(__dirname, '../src/modules/mobile-sync/mobile-sync-conflict.ts'),
      'utf8',
    );
    assert.match(
      syncConflict,
      /METER_READING:\s*'\/engineering\/meter-reading-executions\/\{executionId\}'/,
      'BE-25H METER_READING conflict route must be unchanged',
    );

    // No RN-12 field module is wired into mobile-sync in any way.
    for (const file of [syncService, syncConflict]) {
      assert.ok(
        !/mobile-utility-meter-reading|recordMobileUtilityMeterReading/i.test(file),
        'mobile-sync must not reference the RN-12 field reading module',
      );
    }

    // The engineering binding service is untouched by the field path.
    const fieldService = readFileSync(
      resolve(
        __dirname,
        '../src/modules/mobile-utility-meter-reading/mobile-utility-meter-reading.service.ts',
      ),
      'utf8',
    );
    assert.ok(
      !/meterReadingBinding|formInstance/i.test(fieldService),
      'the field reading service must not touch BE-10C engineering linkage',
    );
  });

  it('the field permission is seeded and the route gates on it', async (t) => {
    if (!requireDatabase(t)) return;
    const permission = await q(
      `SELECT code, name FROM permissions WHERE code = 'utility_meter.field.record'`,
    );
    assert.equal(permission.rowCount, 1);
    assert.equal(
      permission.rows[0].name,
      'Record Field Utility Meter Reading',
    );

    const routes = readFileSync(
      resolve(
        __dirname,
        '../src/modules/mobile-utility-meter-reading/mobile-utility-meter-reading.routes.ts',
      ),
      'utf8',
    );
    // The write gate is exactly the dedicated field record permission.
    const guards = [...routes.matchAll(/requirePermission\('([^']+)'\)/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(guards, [
      'utility_meter.field.record',
      'utility_meter.field.read',
      'utility_meter.field.read',
    ]);
    // Authority is assignment data, never a role label.
    assert.ok(!/'TECHNICIAN'|'ENGINEER'|'SUPERVISOR'/.test(routes));
    const seam = readFileSync(
      resolve(
        __dirname,
        '../src/modules/utility-reading-dues/utility-reading-due.field-authority.ts',
      ),
      'utf8',
    );
    assert.doesNotMatch(seam, /roleService|role_permission|FROM roles\b/);
  });
});
