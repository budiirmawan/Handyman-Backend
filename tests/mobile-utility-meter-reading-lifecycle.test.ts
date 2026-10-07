import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { credentialService } from '../src/modules/auth';
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { workforceService } from '../src/modules/workforce';
import { sha256Hex } from '../src/shared/hash';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 03 — closing the field meter reading lifecycle.
 *
 * ONE focused suite over the PART 03 surface: the recheck commands, the
 * caller-specific `availableActions`, and the BE-18 offline sync kind. It proves
 * exactly the eight contracts this part introduces and nothing else:
 *
 *   A  the ORIGINAL reading is never edited, deleted or unlinked — not by
 *      requesting a recheck, not by staging a reread, not by either resolution
 *   B  a recheck is EXPLICITLY linked to the original reading (and to the field
 *      execution that produced it), on the EXISTING exception register: its own
 *      type, its own lifecycle, its own audit events, one active recheck per
 *      source, and every authority fact server-derived
 *   C  resolving by CONFIRMING the original closes the recheck and creates NO
 *      reading at all, and says so explicitly
 *   D  resolving by ACCEPTING a staged reread creates EXACTLY ONE new canonical
 *      BE-18E reading, linked back to the recheck — written by the SAME
 *      application service every other caller uses, atomically with the resolve
 *   E  an unauthorized actor can neither recheck nor resolve: a field actor of
 *      another execution, a read-only field actor, an unauthenticated caller, a
 *      recheck of somebody else's reading, a wrong execution identity
 *   F  `availableActions` is backend-derived and CALLER-SPECIFIC: it advertises
 *      only commands that genuinely succeed now, never one the route would
 *      refuse, and the resolution actions disappear once the recheck is terminal
 *   G  the BE-25H `METER_READING` kind still targets BE-10C, unchanged, and
 *      cannot be used to reach a BE-18 Reading Due
 *   H  the new `UTILITY_METER_READING` sync kind writes through the SAME
 *      canonical BE-18 field service, with the same field authority, a
 *      deterministic replay-safe operation identity, and no duplicated reading
 *
 * Deliberately NOT exercised here: PART 00's context authority, PART 01's submit
 * / idempotency / concurrency / history contracts and PART 02's evidence, OCR
 * and abnormal-signal projections (each already proven by its own suite), the
 * exception register's management routes (severity re-triage, cancellation,
 * listing), BE-18G consumption calculation, BE-18J abnormality detection, QR,
 * and billing. No second workflow engine, no recheck table and no new lifecycle
 * state exists in this part, so none is tested for.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

let adminUserId = '';
let adminToken = '';

/** The authorized technician: field.read + field.record + field.evidence. */
let workerUserId = '';
let workerToken = '';
/** A second authorized technician, assigned to a DIFFERENT field execution. */
let otherWorkerToken = '';
/** field.read ONLY — proves `availableActions` is permission-gated per action. */
let readOnlyUserId = '';
let readOnlyToken = '';
/** field.read + field.record, but NOT field.evidence. */
let recordOnlyUserId = '';
let recordOnlyToken = '';
/** The offline submitter: field codes PLUS the BE-10C code, for contract G. */
let syncWorkerUserId = '';
let syncWorkerToken = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const id = () => randomUUID();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

const DUE_PATH = '/api/v1/mobile/utility-reading-dues';
const SYNC_URL = '/api/v1/mobile/sync';
const readingsUrl = (readingDueId: string) =>
  `${DUE_PATH}/${readingDueId}/readings`;
const readingUrl = (readingDueId: string, readingId: string) =>
  `${readingsUrl(readingDueId)}/${readingId}`;
const recheckUrl = (readingDueId: string, readingId: string) =>
  `${readingUrl(readingDueId, readingId)}/recheck`;
const rereadUrl = (
  readingDueId: string,
  readingId: string,
  recheckId: string,
) => `${recheckUrl(readingDueId, readingId)}/${recheckId}/reread`;
const resolveUrl = (
  readingDueId: string,
  readingId: string,
  recheckId: string,
) => `${recheckUrl(readingDueId, readingId)}/${recheckId}/resolve`;

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
  await q(`INSERT INTO ${table} (id, ${columns}) VALUES ($1, ${placeholders})`, [
    rowId,
    ...entries.map(([, value]) => value),
  ]);
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

/** Client → Property → Building (+ the admin's own Building assignment). */
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
  return { clientId: client.id, buildingId: building.id };
}

/**
 * Cached workforce profile per user: `workforce_profiles` links a user to
 * exactly ONE profile platform-wide.
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

async function createUom(clientId: string): Promise<string> {
  const uom = await api()
    .post(`/api/v1/clients/${clientId}/uoms`)
    .set(auth())
    .send({
      code: `U_${suffix()}`,
      name: 'Kilowatt hour',
      symbol: 'kWh',
      category: 'ENERGY',
    });
  assert.equal(uom.status, 201, JSON.stringify(uom.body));
  return uom.body.data.id as string;
}

async function createMeter(buildingId: string, uomId: string): Promise<string> {
  const meter = await api()
    .post(`/api/v1/buildings/${buildingId}/utility-meters`)
    .set(auth())
    .send({
      code: `MTR_${suffix()}`,
      name: 'Main incoming meter',
      utilityType: 'ELECTRICITY',
      purpose: 'BUILDING',
      uomId,
    });
  assert.equal(meter.status, 201, JSON.stringify(meter.body));
  return meter.body.data.id as string;
}

type FieldExecution = {
  clientId: string;
  buildingId: string;
  uomId: string;
  meterId: string;
  generatedTaskId: string;
  readingDueId: string;
  /** The reading PART 01 recorded for the due, when `submit` was requested. */
  readingId: string | null;
  readingValue: number;
  readingAt: string | null;
  /** An instant safely inside the due period. */
  insidePeriod: (offsetDays?: number) => string;
};

/**
 * The canonical PART 03 fixture: Building → Meter → generated task ACTIVE-
 * assigned to `actorUserId` → Reading Due, and (unless `submit: false`) the
 * field reading PART 01 recorded for that due, which also completed it.
 *
 * `submit: false` leaves an executable due with NO reading, which is the state
 * an offline device replays into (contract H).
 */
async function createFieldExecution(options: {
  actorUserId: string;
  actorToken: string;
  periodStart?: string;
  readingValue?: number;
  submit?: boolean;
  /**
   * `field` (default) records through PART 01's own route as the assignee.
   * `management` records through BE-18E's management route as the admin and
   * completes the due, which is how a fixture is built for an assignee whose
   * session deliberately CANNOT record — the read-only actor of contract F, whose
   * `availableActions` must be empty because of permissions and not because the
   * reading is missing.
   */
  submitVia?: 'field' | 'management';
}): Promise<FieldExecution> {
  const structure = await createStructure();
  const profileId = await createProfile(options.actorUserId);
  await buildingAssignmentService.createAssignment(options.actorUserId, {
    buildingId: structure.buildingId,
  });

  const uomId = await createUom(structure.clientId);
  const meterId = await createMeter(structure.buildingId, uomId);

  const periodStart = new Date(
    options.periodStart ?? '2027-01-01T00:00:00.000Z',
  );
  const periodEnd = new Date(periodStart.getTime() + 31 * 86_400_000);
  const dueAt = new Date(periodEnd.getTime() + 86_400_000);
  const insidePeriod = (offsetDays = 14) =>
    new Date(periodStart.getTime() + offsetDays * 86_400_000).toISOString();

  const scheduleDefinitionId = await insertRow('schedule_definitions', {
    client_id: structure.clientId,
    code: `SD_${suffix()}`,
    name: 'Meter reading schedule',
    target_type: 'UTILITY_METER',
    target_id: meterId,
    building_id: structure.buildingId,
    start_at: '2027-01-01T00:00:00Z',
    timezone: 'Asia/Jakarta',
    status: 'ACTIVE',
  });
  const generatedTaskId = await insertRow('generated_tasks', {
    client_id: structure.clientId,
    schedule_definition_id: scheduleDefinitionId,
    occurrence_at: '2027-01-20T01:00:00Z',
    target_type: 'UTILITY_METER',
    target_id: meterId,
    building_id: structure.buildingId,
    status: 'OPEN',
  });
  await insertRow('task_assignments', {
    task_id: generatedTaskId,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: profileId,
    team_id: null,
    assigned_by_user_id: adminUserId,
    status: 'ACTIVE',
  });

  const due = await api()
    .post(`/api/v1/utility/meters/${meterId}/reading-dues`)
    .set(auth())
    .send({
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      dueAt: dueAt.toISOString(),
      scheduleDefinitionId,
      generatedTaskId,
    });
  assert.equal(due.status, 201, JSON.stringify(due.body));
  const readingDueId = due.body.data.id as string;

  const base: FieldExecution = {
    clientId: structure.clientId,
    buildingId: structure.buildingId,
    uomId,
    meterId,
    generatedTaskId,
    readingDueId,
    readingId: null,
    readingValue: options.readingValue ?? 1234.5,
    readingAt: null,
    insidePeriod,
  };
  if (options.submit === false) {
    return base;
  }

  if (options.submitVia === 'management') {
    const recorded = await api()
      .post(`/api/v1/utility/meters/${meterId}/readings`)
      .set(auth())
      .send({ readingValue: base.readingValue, readingAt: insidePeriod() });
    assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
    const managementReadingId = recorded.body.data.id as string;
    const completed = await api()
      .post(`/api/v1/utility/reading-dues/${readingDueId}/complete`)
      .set(auth())
      .send({ meterReadingId: managementReadingId });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    return {
      ...base,
      readingId: managementReadingId,
      readingAt: recorded.body.data.readingAt as string,
    };
  }

  const submitted = await api()
    .post(readingsUrl(readingDueId))
    .set(auth(options.actorToken))
    .set('Idempotency-Key', `p03-${id()}`)
    .send({ readingValue: base.readingValue, readingAt: insidePeriod() });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  return {
    ...base,
    readingId: submitted.body.data.reading.id as string,
    readingAt: submitted.body.data.reading.readingAt as string,
  };
}

/** The persisted reading row, for "nothing mutated it" assertions. */
async function readReadingRow(readingId: string) {
  const result = await q(
    `SELECT id, meter_id, building_id, client_id, uom_id, reading_value,
            reading_at, source, reading_type, notes, recorded_by_user_id,
            created_at, updated_at
       FROM utility_meter_readings WHERE id = $1`,
    [readingId],
  );
  return result.rows[0] as Record<string, unknown> | undefined;
}

async function countReadings(meterId: string): Promise<number> {
  const result = await q(
    'SELECT COUNT(*)::int AS count FROM utility_meter_readings WHERE meter_id = $1',
    [meterId],
  );
  return result.rows[0]?.count ?? 0;
}

async function loadDue(readingDueId: string) {
  const result = await q(
    `SELECT id, meter_id, status, meter_reading_id, updated_at
       FROM utility_reading_dues WHERE id = $1`,
    [readingDueId],
  );
  return result.rows[0] as {
    id: string;
    meter_id: string;
    status: string;
    meter_reading_id: string | null;
    updated_at: Date;
  };
}

/** The persisted register row behind a recheck. */
async function readExceptionRow(recheckId: string) {
  const result = await q(
    `SELECT id, client_id, building_id, utility_type, meter_id, meter_reading_id,
            reading_due_id, exception_type, severity, status, summary, details,
            detected_by_user_id, reviewer_user_id, review_started_at,
            proposed_reading_value, proposed_reading_at, proposed_reading_notes,
            replacement_meter_reading_id, resolved_by_user_id, resolved_at,
            resolution_notes, created_at, updated_at
       FROM utility_operational_exceptions WHERE id = $1`,
    [recheckId],
  );
  return result.rows[0] as Record<string, unknown> | undefined;
}

async function countRechecks(readingId: string): Promise<number> {
  const result = await q(
    `SELECT COUNT(*)::int AS count FROM utility_operational_exceptions
      WHERE exception_type = 'READING_RECHECK' AND meter_reading_id = $1`,
    [readingId],
  );
  return result.rows[0]?.count ?? 0;
}

async function countExceptionEvents(
  recheckId: string,
  eventType: string,
): Promise<number> {
  const result = await q(
    `SELECT COUNT(*)::int AS count FROM operational_events
      WHERE entity_type = 'UTILITY_OPERATIONAL_EXCEPTION'
        AND entity_id = $1 AND event_type = $2`,
    [recheckId, eventType],
  );
  return result.rows[0]?.count ?? 0;
}

async function countReadingEvents(readingId: string): Promise<number> {
  const result = await q(
    `SELECT COUNT(*)::int AS count FROM operational_events
      WHERE entity_type = 'UTILITY_METER_READING' AND entity_id = $1
        AND event_type = 'UTILITY_METER_READING_RECORDED'`,
    [readingId],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * The PART 03 reading detail. PART 01's DTO is the reading itself, flattened, so
 * the reading's own fields sit beside PART 02's projections and PART 03's two
 * additive keys.
 */
async function getDetail(readingDueId: string, readingId: string, token: string) {
  const response = await api()
    .get(readingUrl(readingDueId, readingId))
    .set(auth(token));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data as Record<string, any> & {
    id: string;
    readingValue: number;
    rechecks: any[];
    availableActions: string[];
  };
}

/** Files a recheck and returns the register row id (asserting the 201). */
async function openRecheck(
  execution: FieldExecution,
  token: string,
  reason?: string,
): Promise<string> {
  const response = await api()
    .post(recheckUrl(execution.readingDueId, execution.readingId as string))
    .set(auth(token))
    .send(reason === undefined ? {} : { reason });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data.recheck.id as string;
}

async function submitReread(
  execution: FieldExecution,
  recheckId: string,
  token: string,
  body: Record<string, unknown>,
) {
  return api()
    .post(
      rereadUrl(execution.readingDueId, execution.readingId as string, recheckId),
    )
    .set(auth(token))
    .send(body);
}

async function resolveRecheck(
  execution: FieldExecution,
  recheckId: string,
  token: string,
  body: Record<string, unknown>,
) {
  return api()
    .post(
      resolveUrl(
        execution.readingDueId,
        execution.readingId as string,
        recheckId,
      ),
    )
    .set(auth(token))
    .send(body);
}

/** One offline sync operation, addressed by the BE-18 Reading Due. */
function utilitySyncOperation(options: {
  readingDueId: string;
  readingValue: number;
  readingAt: string;
  notes?: string;
  baseVersion?: string;
  operationId?: string;
}) {
  return {
    operationId: options.operationId ?? `p03sync-${randomUUID()}`,
    resourceType: 'UTILITY_METER_READING',
    resourceId: options.readingDueId,
    operation: 'SUBMIT',
    clientTimestamp: new Date().toISOString(),
    data: {
      readingValue: options.readingValue,
      readingAt: options.readingAt,
      ...(options.notes === undefined ? {} : { notes: options.notes }),
      ...(options.baseVersion === undefined
        ? {}
        : { baseVersion: options.baseVersion }),
    },
  };
}

async function postSync(token: string, operations: unknown[]) {
  return api().post(SYNC_URL).set(auth(token)).send({ operations });
}

const SOURCE = readFileSync(
  resolve(__dirname, '../src/modules/mobile-sync/mobile-sync.service.ts'),
  'utf8',
);
const CONFLICT_SOURCE = readFileSync(
  resolve(__dirname, '../src/modules/mobile-sync/mobile-sync-conflict.ts'),
  'utf8',
);
const CONTROLLER_SOURCE = readFileSync(
  resolve(__dirname, '../src/modules/mobile-sync/mobile-sync.controller.ts'),
  'utf8',
);
const SPEC = parse(
  readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
) as any;
const SYNC_DOC = SPEC.paths['/mobile/sync'].post;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  database = db;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE request_idempotency_records, mobile_sync_idempotency,
       operational_events, utility_reading_dues, utility_meter_ocr_candidates,
       utility_meter_consumptions, utility_abnormal_consumptions,
       utility_abnormality_rules, utility_operational_exceptions,
       evidence_submissions, evidence_requirements, utility_meter_readings,
       utility_meter_tenant_assignments, utility_meters, utility_type_uoms,
       utility_type_configurations, units_of_measure, task_assignments,
       generated_tasks, schedule_recurrence, schedule_definitions,
       workforce_profiles, positions, departments, organizations, teams,
       user_building_assignments, buildings, properties, users, roles,
       permissions, role_permission_assignments, user_role_assignments,
       clients CASCADE`,
  );

  const admin = await createAdminUser();
  adminUserId = admin.userId;
  adminToken = admin.token;

  const worker = await createUserWithPermissions('p03worker', [
    'utility_meter.field.read',
    'utility_meter.field.record',
    'utility_meter.field.evidence',
  ]);
  workerUserId = worker.userId;
  workerToken = worker.token;

  const otherWorker = await createUserWithPermissions('p03other', [
    'utility_meter.field.read',
    'utility_meter.field.record',
    'utility_meter.field.evidence',
  ]);
  otherWorkerToken = otherWorker.token;

  const readOnly = await createUserWithPermissions('p03read', [
    'utility_meter.field.read',
  ]);
  readOnlyUserId = readOnly.userId;
  readOnlyToken = readOnly.token;

  const recordOnly = await createUserWithPermissions('p03record', [
    'utility_meter.field.read',
    'utility_meter.field.record',
  ]);
  recordOnlyUserId = recordOnly.userId;
  recordOnlyToken = recordOnly.token;

  // Contract G needs an actor who clears the BE-10C kind's own permission gate,
  // so that what fails is the DOMAIN mismatch and not the RBAC check.
  const syncWorker = await createUserWithPermissions('p03sync', [
    'utility_meter.field.read',
    'utility_meter.field.record',
    'meter_reading_binding.manage',
  ]);
  syncWorkerUserId = syncWorker.userId;
  syncWorkerToken = syncWorker.token;
});

after(async () => {
  if (pool) {
    await closePool();
  }
});

describe('CR-BE-RN12-METER-FIELD-01 PART 03 — field reading lifecycle', () => {
  it('A. the original reading is never edited, deleted or unlinked', async (t) => {
    if (!requireDatabase(t)) return;
    const execution = await createFieldExecution({
      actorUserId: workerUserId,
      actorToken: workerToken,
      periodStart: '2027-02-01T00:00:00.000Z',
    });
    const originalId = execution.readingId as string;
    const before = await readReadingRow(originalId);
    assert.ok(before, 'the field reading exists');
    const snapshot = JSON.stringify(before);

    // 1. requesting a recheck changes nothing about the reading.
    const recheckId = await openRecheck(execution, workerToken, 'Dial looked off');
    assert.equal(JSON.stringify(await readReadingRow(originalId)), snapshot);
    assert.equal(await countReadings(execution.meterId), 1);

    // 2. staging a reread changes nothing either: a proposal is not a reading.
    const staged = await submitReread(execution, recheckId, workerToken, {
      readingValue: 1300.75,
      readingAt: execution.insidePeriod(15),
      notes: 'Re-read at the meter',
    });
    assert.equal(staged.status, 200, JSON.stringify(staged.body));
    assert.equal(JSON.stringify(await readReadingRow(originalId)), snapshot);
    assert.equal(await countReadings(execution.meterId), 1);

    // 3. confirming the original changes nothing, and creates nothing.
    const confirmed = await resolveRecheck(execution, recheckId, workerToken, {
      decision: 'CONFIRM_ORIGINAL',
      resolutionNotes: 'Verified against the meter plate; the value stands.',
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(JSON.stringify(await readReadingRow(originalId)), snapshot);
    assert.equal(await countReadings(execution.meterId), 1);

    // The due still points at the reading its own field execution produced.
    const due = await loadDue(execution.readingDueId);
    assert.equal(due.meter_reading_id, originalId);
    assert.equal(due.status, 'COMPLETED');

    // The reading the detail projects is still the original, unmodified.
    const detail = await getDetail(
      execution.readingDueId,
      originalId,
      workerToken,
    );
    assert.equal(detail.id, originalId);
    assert.equal(detail.readingValue, execution.readingValue);
    assert.deepEqual(detail.rechecks[0].replacementReading, null);
  });

  it('B. a recheck is explicitly linked to the original reading, on the existing register', async (t) => {
    if (!requireDatabase(t)) return;
    const execution = await createFieldExecution({
      actorUserId: workerUserId,
      actorToken: workerToken,
      periodStart: '2027-03-01T00:00:00.000Z',
    });
    const originalId = execution.readingId as string;

    const response = await api()
      .post(recheckUrl(execution.readingDueId, originalId))
      .set(auth(workerToken))
      .send({ reason: '  Consumption looked twice the usual load.  ' });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const recheck = response.body.data.recheck;
    const recheckId = recheck.id as string;

    // Linked to the ORIGINAL reading and to the field execution behind it.
    assert.equal(recheck.meterReadingId, originalId);
    assert.equal(recheck.readingDueId, execution.readingDueId);
    assert.equal(recheck.status, 'OPEN');
    assert.equal(recheck.severity, 'MEDIUM');
    assert.equal(recheck.requestedByUserId, workerUserId);
    assert.equal(recheck.reason, 'Consumption looked twice the usual load.');
    assert.equal(recheck.outcome, null);
    assert.equal(recheck.replacementReading, null);
    assert.equal(recheck.proposedReadingValue, null);
    assert.equal(recheck.proposedReadingAt, null);
    assert.ok(
      typeof recheck.summary === 'string' && recheck.summary.length > 0,
      'the summary is server-derived and present',
    );

    // It is one row of the EXISTING register: no recheck table, no new state.
    const row = await readExceptionRow(recheckId);
    assert.ok(row, 'the recheck is a utility_operational_exceptions row');
    assert.equal(row.exception_type, 'READING_RECHECK');
    assert.equal(row.meter_reading_id, originalId);
    assert.equal(row.reading_due_id, execution.readingDueId);
    assert.equal(row.meter_id, execution.meterId);
    assert.equal(row.client_id, execution.clientId);
    assert.equal(row.building_id, execution.buildingId);
    assert.equal(row.utility_type, 'ELECTRICITY');
    assert.equal(row.status, 'OPEN');
    assert.equal(row.detected_by_user_id, workerUserId);
    assert.equal(await countRechecks(originalId), 1);
    assert.equal(await countExceptionEvents(recheckId, 'UTILITY_EXCEPTION_CREATED'), 1);

    // Authority facts a caller must never choose are refused, not dropped.
    const smuggled = await api()
      .post(recheckUrl(execution.readingDueId, originalId))
      .set(auth(workerToken))
      .send({
        reason: 'second attempt',
        severity: 'CRITICAL',
        status: 'RESOLVED',
        exceptionType: 'OTHER',
        meterReadingId: id(),
        replacementMeterReadingId: id(),
      });
    assert.equal(smuggled.status, 400, JSON.stringify(smuggled.body));
    assert.equal(smuggled.body.error.code, 'VALIDATION_ERROR');
    const fields = (smuggled.body.error.details ?? []).map((d: any) => d.field);
    for (const field of [
      'severity',
      'status',
      'exceptionType',
      'meterReadingId',
      'replacementMeterReadingId',
    ]) {
      assert.ok(fields.includes(field), `${field} must be refused explicitly`);
    }
    assert.equal(await countRechecks(originalId), 1, 'nothing was written');

    // The register's own unique-active-source rule: one ACTIVE recheck per source.
    const duplicate = await api()
      .post(recheckUrl(execution.readingDueId, originalId))
      .set(auth(workerToken))
      .send({ reason: 'again' });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.error.code, 'UTILITY_EXCEPTION_ALREADY_OPEN');
    assert.equal(await countRechecks(originalId), 1);

    // The detail projects the recheck, newest first and bounded.
    const detail = await getDetail(execution.readingDueId, originalId, workerToken);
    assert.equal(detail.rechecks.length, 1);
    assert.equal(detail.rechecks[0].id, recheckId);
    assert.equal(detail.rechecks[0].meterReadingId, originalId);
    assert.equal(detail.rechecks[0].status, 'OPEN');

    // No reading was created by filing a recheck.
    assert.equal(await countReadings(execution.meterId), 1);
  });

  it('C. confirming the original resolves the recheck and creates no reading', async (t) => {
    if (!requireDatabase(t)) return;
    const execution = await createFieldExecution({
      actorUserId: workerUserId,
      actorToken: workerToken,
      periodStart: '2027-04-01T00:00:00.000Z',
    });
    const originalId = execution.readingId as string;
    const recheckId = await openRecheck(execution, workerToken, 'Value queried by the site supervisor');

    // The register's own required resolution notes.
    const missingNotes = await resolveRecheck(execution, recheckId, workerToken, {
      decision: 'CONFIRM_ORIGINAL',
    });
    assert.equal(missingNotes.status, 400, JSON.stringify(missingNotes.body));
    assert.equal(missingNotes.body.error.code, 'VALIDATION_ERROR');

    // An unknown decision token is refused, never defaulted.
    const unknownDecision = await resolveRecheck(
      execution,
      recheckId,
      workerToken,
      { decision: 'MARK_NORMAL', resolutionNotes: 'nope' },
    );
    assert.equal(unknownDecision.status, 400, JSON.stringify(unknownDecision.body));
    assert.equal(unknownDecision.body.error.code, 'VALIDATION_ERROR');

    const resolved = await resolveRecheck(execution, recheckId, workerToken, {
      decision: 'CONFIRM_ORIGINAL',
      resolutionNotes: 'Re-read on site with the supervisor: the recorded value is correct.',
    });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    const recheck = resolved.body.data.recheck;

    // The outcome is stated by the backend, not inferred by the client.
    assert.equal(resolved.body.data.replacementReading, null);
    assert.equal(recheck.status, 'RESOLVED');
    assert.equal(recheck.outcome, 'CONFIRMED_ORIGINAL');
    assert.equal(recheck.replacementReading, null);
    assert.equal(recheck.resolvedByUserId, workerUserId);
    assert.equal(
      recheck.resolutionNotes,
      'Re-read on site with the supervisor: the recorded value is correct.',
    );
    assert.ok(recheck.resolvedAt, 'resolvedAt is stamped');

    // NOTHING was created: the meter still has exactly its original reading.
    assert.equal(await countReadings(execution.meterId), 1);
    const row = await readExceptionRow(recheckId);
    assert.equal(row.replacement_meter_reading_id, null);
    assert.equal(row.proposed_reading_value, null);
    assert.equal(await countExceptionEvents(recheckId, 'UTILITY_EXCEPTION_RESOLVED'), 1);
    // The register resolves only from UNDER_REVIEW, so confirming an OPEN recheck
    // runs the register's OWN review transition first — its existing guard, its
    // existing stamps and its existing canonical event, not a new field state.
    assert.equal(
      await countExceptionEvents(recheckId, 'UTILITY_EXCEPTION_REVIEW_STARTED'),
      1,
    );
    assert.ok(recheck.reviewerUserId, 'the reviewer is stamped by the transition');
    assert.ok(recheck.reviewStartedAt);
    assert.equal(recheck.proposedReadingValue, null, 'no reread was ever staged');

    const due = await loadDue(execution.readingDueId);
    assert.equal(due.meter_reading_id, originalId);
    assert.equal(due.status, 'COMPLETED');

    // A resolved recheck is terminal: it can never be resolved or staged again.
    const again = await resolveRecheck(execution, recheckId, workerToken, {
      decision: 'CONFIRM_ORIGINAL',
      resolutionNotes: 'try again',
    });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.error.code, 'UTILITY_EXCEPTION_TRANSITION_INVALID');

    const lateReread = await submitReread(execution, recheckId, workerToken, {
      readingValue: 9000.5,
      readingAt: execution.insidePeriod(20),
    });
    assert.equal(lateReread.status, 409, JSON.stringify(lateReread.body));
    assert.equal(lateReread.body.error.code, 'UTILITY_EXCEPTION_TRANSITION_INVALID');
    assert.equal(await countReadings(execution.meterId), 1);
  });

  it('D. accepting a staged reread creates exactly one linked replacement reading', async (t) => {
    if (!requireDatabase(t)) return;
    const execution = await createFieldExecution({
      actorUserId: workerUserId,
      actorToken: workerToken,
      periodStart: '2027-05-01T00:00:00.000Z',
    });
    const originalId = execution.readingId as string;
    const originalRow = JSON.stringify(await readReadingRow(originalId));
    const recheckId = await openRecheck(execution, workerToken, 'Transposed digits');

    // A replacement cannot be accepted before anything is staged.
    const premature = await resolveRecheck(execution, recheckId, workerToken, {
      decision: 'ACCEPT_REPLACEMENT',
      resolutionNotes: 'Nothing staged yet.',
    });
    assert.equal(premature.status, 409, JSON.stringify(premature.body));
    assert.equal(premature.body.error.code, 'UTILITY_EXCEPTION_TRANSITION_INVALID');
    assert.equal(await countReadings(execution.meterId), 1);

    // A staged instant that already exists on this meter can never become a
    // reading, so BE-18E's own uniqueness refuses it now — and stages nothing.
    const collision = await submitReread(execution, recheckId, workerToken, {
      readingValue: 1400.5,
      readingAt: execution.readingAt as string,
    });
    assert.equal(collision.status, 409, JSON.stringify(collision.body));
    assert.equal(collision.body.error.code, 'UTILITY_METER_READING_ALREADY_EXISTS');
    const afterCollision = await readExceptionRow(recheckId);
    assert.equal(afterCollision.status, 'OPEN');
    assert.equal(afterCollision.proposed_reading_value, null);
    assert.equal(await countReadings(execution.meterId), 1);

    // PART 01's own body rule applies to a reread: authority keys are refused.
    const smuggledReread = await submitReread(execution, recheckId, workerToken, {
      readingValue: 1400.5,
      readingAt: execution.insidePeriod(16),
      meterId: execution.meterId,
      uomId: execution.uomId,
      source: 'IMPORT',
      readingType: 'ESTIMATED',
      recordedByUserId: adminUserId,
    });
    assert.equal(smuggledReread.status, 400, JSON.stringify(smuggledReread.body));
    assert.equal(smuggledReread.body.error.code, 'VALIDATION_ERROR');

    // Staging: the register's own OPEN → UNDER_REVIEW, and still no reading.
    const staged = await submitReread(execution, recheckId, workerToken, {
      readingValue: 1450.25,
      readingAt: execution.insidePeriod(15),
      notes: 'Re-read after resetting the display',
    });
    assert.equal(staged.status, 200, JSON.stringify(staged.body));
    assert.equal(staged.body.data.recheck.status, 'UNDER_REVIEW');
    assert.equal(staged.body.data.recheck.proposedReadingValue, 1450.25);
    assert.equal(
      staged.body.data.recheck.proposedReadingAt,
      execution.insidePeriod(15),
    );
    assert.equal(
      staged.body.data.recheck.proposedReadingNotes,
      'Re-read after resetting the display',
    );
    assert.equal(staged.body.data.recheck.reviewerUserId, workerUserId);
    assert.ok(staged.body.data.recheck.reviewStartedAt);
    assert.equal(staged.body.data.recheck.replacementReading, null);
    assert.equal(await countReadings(execution.meterId), 1, 'staging writes no reading');
    assert.equal(
      await countExceptionEvents(recheckId, 'UTILITY_EXCEPTION_REVIEW_STARTED'),
      1,
    );

    // Staging is correctable while the review is open (still no reading).
    const restaged = await submitReread(execution, recheckId, workerToken, {
      readingValue: 1451.5,
      readingAt: execution.insidePeriod(16),
    });
    assert.equal(restaged.status, 200, JSON.stringify(restaged.body));
    assert.equal(restaged.body.data.recheck.status, 'UNDER_REVIEW');
    assert.equal(restaged.body.data.recheck.proposedReadingValue, 1451.5);
    assert.equal(await countReadings(execution.meterId), 1);

    // Accepting the replacement creates EXACTLY ONE canonical reading.
    const accepted = await resolveRecheck(execution, recheckId, workerToken, {
      decision: 'ACCEPT_REPLACEMENT',
      resolutionNotes: 'The first value missed a digit; the reread is correct.',
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const replacement = accepted.body.data.replacementReading;
    assert.ok(replacement, 'the replacement reading is returned');
    assert.notEqual(replacement.id, originalId);
    assert.equal(replacement.readingValue, 1451.5, 'the STAGED value, not a body value');
    assert.equal(replacement.readingAt, execution.insidePeriod(16));
    assert.equal(replacement.source, 'MANUAL');
    assert.equal(replacement.readingType, 'ACTUAL');
    assert.equal(replacement.recordedByUserId, workerUserId);
    assert.equal(accepted.body.data.recheck.status, 'RESOLVED');
    assert.equal(accepted.body.data.recheck.outcome, 'ACCEPTED_REPLACEMENT');
    assert.equal(accepted.body.data.recheck.replacementReading.id, replacement.id);

    // Exactly one new reading, written by the canonical BE-18E service.
    assert.equal(await countReadings(execution.meterId), 2);
    const replacementRow = await readReadingRow(replacement.id);
    assert.ok(replacementRow, 'the replacement reading is persisted');
    assert.equal(replacementRow.meter_id, execution.meterId);
    assert.equal(replacementRow.client_id, execution.clientId);
    assert.equal(replacementRow.building_id, execution.buildingId);
    assert.equal(replacementRow.uom_id, execution.uomId, 'UOM resolved by BE-18E');
    assert.equal(Number(replacementRow.reading_value), 1451.5);
    assert.equal(replacementRow.source, 'MANUAL');
    assert.equal(replacementRow.reading_type, 'ACTUAL');
    assert.equal(replacementRow.recorded_by_user_id, workerUserId);
    assert.equal(await countReadingEvents(replacement.id), 1);

    // The link is auditable from the register row itself.
    const resolvedRow = await readExceptionRow(recheckId);
    assert.equal(resolvedRow.replacement_meter_reading_id, replacement.id);
    assert.equal(resolvedRow.meter_reading_id, originalId, 'the original stays linked');
    assert.equal(resolvedRow.status, 'RESOLVED');
    assert.equal(await countExceptionEvents(recheckId, 'UTILITY_EXCEPTION_RESOLVED'), 1);

    // The ORIGINAL reading is untouched and the due still points at it.
    assert.equal(JSON.stringify(await readReadingRow(originalId)), originalRow);
    const due = await loadDue(execution.readingDueId);
    assert.equal(due.meter_reading_id, originalId);
    assert.equal(due.status, 'COMPLETED');

    // The detail projects both sides of the relation.
    const detail = await getDetail(execution.readingDueId, originalId, workerToken);
    assert.equal(detail.rechecks.length, 1);
    assert.equal(detail.rechecks[0].meterReadingId, originalId);
    assert.equal(detail.rechecks[0].replacementReading.id, replacement.id);
    assert.equal(detail.rechecks[0].outcome, 'ACCEPTED_REPLACEMENT');
    assert.equal(detail.id, originalId, 'the detail is still the original');
  });

  it('E. an unauthorized actor can neither recheck nor resolve', async (t) => {
    if (!requireDatabase(t)) return;
    const own = await createFieldExecution({
      actorUserId: workerUserId,
      actorToken: workerToken,
      periodStart: '2027-06-01T00:00:00.000Z',
    });
    const ownReadingId = own.readingId as string;
    const ownRecheckId = await openRecheck(own, workerToken, 'my own recheck');

    // 1. A field actor of ANOTHER execution: refused by the SAME seam PART 00 /
    //    PART 02 use, before any register row is touched.
    const outsiderAttempts = await Promise.all([
      api()
        .post(recheckUrl(own.readingDueId, ownReadingId))
        .set(auth(otherWorkerToken))
        .send({ reason: 'not my reading' }),
      submitReread(own, ownRecheckId, otherWorkerToken, {
        readingValue: 10,
        readingAt: own.insidePeriod(3),
      }),
      resolveRecheck(own, ownRecheckId, otherWorkerToken, {
        decision: 'ACCEPT_REPLACEMENT',
        resolutionNotes: 'not my recheck',
      }),
    ]);
    for (const attempt of outsiderAttempts) {
      assert.equal(attempt.status, 403, JSON.stringify(attempt.body));
      assert.equal(
        attempt.body.error.code,
        'UTILITY_READING_DUE_FIELD_UNAUTHORIZED',
      );
    }
    assert.equal(await countRechecks(ownReadingId), 1, 'no second recheck was filed');
    assert.equal(await countReadings(own.meterId), 1, 'no reading was written');
    const untouched = await readExceptionRow(ownRecheckId);
    assert.equal(untouched.status, 'OPEN', 'the recheck was not advanced');
    assert.equal(untouched.proposed_reading_value, null);

    // 2. A read-only field actor: the route's own permission gate refuses first.
    const readOnlyAttempts = await Promise.all([
      api()
        .post(recheckUrl(own.readingDueId, ownReadingId))
        .set(auth(readOnlyToken))
        .send({}),
      submitReread(own, ownRecheckId, readOnlyToken, {
        readingValue: 10,
        readingAt: own.insidePeriod(4),
      }),
      resolveRecheck(own, ownRecheckId, readOnlyToken, {
        decision: 'CONFIRM_ORIGINAL',
        resolutionNotes: 'read only',
      }),
    ]);
    for (const attempt of readOnlyAttempts) {
      assert.equal(attempt.status, 403, JSON.stringify(attempt.body));
      assert.equal(attempt.body.error.code, 'PERMISSION_DENIED');
    }
    assert.equal(await countRechecks(ownReadingId), 1);

    // 3. Unauthenticated.
    const anonymous = await api()
      .post(recheckUrl(own.readingDueId, ownReadingId))
      .send({});
    assert.equal(anonymous.status, 401, JSON.stringify(anonymous.body));
    assert.equal(anonymous.body.error.code, 'AUTHENTICATION_REQUIRED');

    // 4. A recheck of ANOTHER reading is not found through this path, and the
    //    refusal happens before the decision: the foreign recheck survives.
    const foreign = await createFieldExecution({
      actorUserId: workerUserId,
      actorToken: workerToken,
      periodStart: '2027-07-01T00:00:00.000Z',
    });
    const foreignReadingId = foreign.readingId as string;
    const foreignRecheckId = await openRecheck(foreign, workerToken, 'foreign recheck');
    const crossReading = await resolveRecheck(own, foreignRecheckId, workerToken, {
      decision: 'ACCEPT_REPLACEMENT',
      resolutionNotes: 'resolve somebody else’s recheck through my path',
    });
    assert.equal(crossReading.status, 404, JSON.stringify(crossReading.body));
    assert.equal(crossReading.body.error.code, 'UTILITY_EXCEPTION_NOT_FOUND');
    const foreignRow = await readExceptionRow(foreignRecheckId);
    assert.equal(foreignRow.status, 'OPEN', 'the foreign recheck was not advanced');
    assert.equal(foreignRow.meter_reading_id, foreignReadingId);
    assert.equal(await countReadings(foreign.meterId), 1);

    // A register row of a DIFFERENT exception type is equally invisible here:
    // PART 03 commands only ever act on a READING_RECHECK of this reading.
    const otherExceptionId = await insertRow('utility_operational_exceptions', {
      client_id: own.clientId,
      building_id: own.buildingId,
      utility_type: 'ELECTRICITY',
      meter_id: own.meterId,
      meter_reading_id: ownReadingId,
      reading_due_id: own.readingDueId,
      exception_type: 'ABNORMAL_CONSUMPTION',
      severity: 'HIGH',
      status: 'OPEN',
      summary: 'Not a recheck',
      detected_at: new Date().toISOString(),
      detected_by_user_id: adminUserId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const wrongType = await resolveRecheck(own, otherExceptionId, workerToken, {
      decision: 'CONFIRM_ORIGINAL',
      resolutionNotes: 'advance a different exception type',
    });
    assert.equal(wrongType.status, 404, JSON.stringify(wrongType.body));
    assert.equal(wrongType.body.error.code, 'UTILITY_EXCEPTION_NOT_FOUND');
    const wrongTypeRow = await readExceptionRow(otherExceptionId);
    assert.equal(wrongTypeRow.status, 'OPEN');

    // 5. A wrong execution identity in the path is a 404, on the PART 02 seam.
    const wrongDue = await api()
      .post(recheckUrl(foreign.readingDueId, ownReadingId))
      .set(auth(workerToken))
      .send({});
    assert.equal(wrongDue.status, 404, JSON.stringify(wrongDue.body));
    assert.equal(wrongDue.body.error.code, 'UTILITY_METER_READING_NOT_FOUND');
    assert.equal(await countRechecks(ownReadingId), 1, 'only the legitimate recheck');

    // The authorized actor's own command still works, so every refusal above is
    // about authority and not about a broken route.
    const authorized = await resolveRecheck(own, ownRecheckId, workerToken, {
      decision: 'CONFIRM_ORIGINAL',
      resolutionNotes: 'The authorized technician resolves their own recheck.',
    });
    assert.equal(authorized.status, 200, JSON.stringify(authorized.body));
    assert.equal(authorized.body.data.replacementReading, null);
  });

  it('F. availableActions are caller-specific, executable, and vanish when terminal', async (t) => {
    if (!requireDatabase(t)) return;
    const execution = await createFieldExecution({
      actorUserId: workerUserId,
      actorToken: workerToken,
      periodStart: '2027-09-01T00:00:00.000Z',
    });
    const readingId = execution.readingId as string;
    // A reading with no recheck: evidence plus the recheck request, in the
    // documented order.
    const fresh = await getDetail(execution.readingDueId, readingId, workerToken);
    assert.deepEqual(fresh.availableActions, ['ADD_EVIDENCE', 'SUBMIT_RECHECK']);

    // CALLER-SPECIFIC: the same reading, a read-only field actor. It can read the
    // detail, and sees no action at all — nothing is advertised that its own
    // permissions would make the route refuse.
    const readOnlyExecution = await createFieldExecution({
      actorUserId: readOnlyUserId,
      actorToken: readOnlyToken,
      periodStart: '2027-10-01T00:00:00.000Z',
      submitVia: 'management',
    });
    const readOnlyDetail = await getDetail(
      readOnlyExecution.readingDueId,
      readOnlyExecution.readingId as string,
      readOnlyToken,
    );
    assert.deepEqual(readOnlyDetail.availableActions, []);
    assert.deepEqual(readOnlyDetail.rechecks, []);

    // And an actor holding the record code but NOT the evidence code: each action
    // is gated on ITS OWN permission, so the write action stays and the evidence
    // action is absent — the list is per action, not per role.
    const recordOnlyExecution = await createFieldExecution({
      actorUserId: recordOnlyUserId,
      actorToken: recordOnlyToken,
      periodStart: '2027-11-01T00:00:00.000Z',
    });
    const recordOnlyDetail = await getDetail(
      recordOnlyExecution.readingDueId,
      recordOnlyExecution.readingId as string,
      recordOnlyToken,
    );
    assert.deepEqual(recordOnlyDetail.availableActions, ['SUBMIT_RECHECK']);
    const recordOnlyRecheck = await api()
      .post(
        recheckUrl(
          recordOnlyExecution.readingDueId,
          recordOnlyExecution.readingId as string,
        ),
      )
      .set(auth(recordOnlyToken))
      .send({ reason: 'the advertised action really is executable' });
    assert.equal(recordOnlyRecheck.status, 201, JSON.stringify(recordOnlyRecheck.body));

    // Every advertised action is genuinely executable — the list is not advisory.
    const recheckResponse = await api()
      .post(recheckUrl(execution.readingDueId, readingId))
      .set(auth(workerToken))
      .send({ reason: 'Value queried' });
    assert.equal(recheckResponse.status, 201, 'SUBMIT_RECHECK was advertised and works');
    const recheckId = recheckResponse.body.data.recheck.id as string;

    // An active recheck removes SUBMIT_RECHECK (the register forbids a second
    // active one) and offers the reread.
    const openDetail = await getDetail(execution.readingDueId, readingId, workerToken);
    assert.deepEqual(openDetail.availableActions, [
      'ADD_EVIDENCE',
      'SUBMIT_REREAD',
      'CONFIRM_READING',
    ]);
    assert.equal(openDetail.rechecks.length, 1);
    assert.ok(
      !openDetail.availableActions.includes('ACCEPT_REPLACEMENT'),
      'nothing can be accepted before a reread is staged',
    );

    const rereadResponse = await submitReread(execution, recheckId, workerToken, {
      readingValue: 1600.5,
      readingAt: execution.insidePeriod(17),
    });
    assert.equal(rereadResponse.status, 200, 'SUBMIT_REREAD was advertised and works');

    // UNDER_REVIEW with a staged reread: both resolution decisions are offered.
    const reviewDetail = await getDetail(execution.readingDueId, readingId, workerToken);
    assert.deepEqual(reviewDetail.availableActions, [
      'ADD_EVIDENCE',
      'SUBMIT_REREAD',
      'CONFIRM_READING',
      'ACCEPT_REPLACEMENT',
    ]);

    // A terminal recheck removes every recheck action; SUBMIT_RECHECK returns
    // because the register permits a fresh recheck of the same reading — and the
    // command genuinely succeeds again, which is why the action is honest.
    const resolved = await resolveRecheck(execution, recheckId, workerToken, {
      decision: 'CONFIRM_ORIGINAL',
      resolutionNotes: 'Confirmed on site.',
    });
    assert.equal(resolved.status, 200, 'CONFIRM_READING was advertised and works');
    const terminalDetail = await getDetail(execution.readingDueId, readingId, workerToken);
    assert.deepEqual(terminalDetail.availableActions, [
      'ADD_EVIDENCE',
      'SUBMIT_RECHECK',
    ]);
    assert.equal(terminalDetail.rechecks.length, 1);
    assert.equal(terminalDetail.rechecks[0].status, 'RESOLVED');

    // An action that is NOT advertised is genuinely refused: no client can walk a
    // resolved recheck forward because the list told it that it could.
    const notAdvertised = await resolveRecheck(execution, recheckId, workerToken, {
      decision: 'CONFIRM_ORIGINAL',
      resolutionNotes: 'second resolution',
    });
    assert.equal(notAdvertised.status, 409, JSON.stringify(notAdvertised.body));

    // ACCEPT_REPLACEMENT is offered ONLY once something is staged — the action
    // never appears where its command would fail.
    const secondRecheckId = await openRecheck(execution, workerToken, 'Second query');
    const unstagedDetail = await getDetail(execution.readingDueId, readingId, workerToken);
    assert.deepEqual(unstagedDetail.availableActions, [
      'ADD_EVIDENCE',
      'SUBMIT_REREAD',
      'CONFIRM_READING',
    ]);
    assert.ok(
      !unstagedDetail.availableActions.includes('ACCEPT_REPLACEMENT'),
      'no acceptance without a staged reread',
    );
    const unstagedAccept = await resolveRecheck(
      execution,
      secondRecheckId,
      workerToken,
      { decision: 'ACCEPT_REPLACEMENT', resolutionNotes: 'nothing staged' },
    );
    assert.equal(unstagedAccept.status, 409, JSON.stringify(unstagedAccept.body));

    // A second ACTIVE recheck is refused, which is exactly why SUBMIT_RECHECK is
    // absent while one is open.
    const secondActive = await api()
      .post(recheckUrl(execution.readingDueId, readingId))
      .set(auth(workerToken))
      .send({});
    assert.equal(secondActive.status, 409, JSON.stringify(secondActive.body));
    assert.equal(secondActive.body.error.code, 'UTILITY_EXCEPTION_ALREADY_OPEN');

    // The list is documented, and every token names a real command on this surface.
    const actionSchema = SPEC.components.schemas.MobileReadingAvailableAction;
    assert.deepEqual(actionSchema.enum, [
      'ADD_EVIDENCE',
      'SUBMIT_RECHECK',
      'SUBMIT_REREAD',
      'CONFIRM_READING',
      'ACCEPT_REPLACEMENT',
    ]);
    for (const path of [
      '/mobile/utility-reading-dues/{readingDueId}/readings/{readingId}/recheck',
      '/mobile/utility-reading-dues/{readingDueId}/readings/{readingId}/recheck/{recheckId}/reread',
      '/mobile/utility-reading-dues/{readingDueId}/readings/{readingId}/recheck/{recheckId}/resolve',
    ]) {
      assert.ok(SPEC.paths[path]?.post, `${path} must be documented`);
      assert.equal(
        SPEC.paths[path].post['x-required-permission'],
        'utility_meter.field.record',
      );
    }
    // The detail that carries `availableActions` is PART 01's own published read
    // operation — PART 03 enriched its handler, it did not fork the route.
    assert.equal(
      SPEC.paths[
        '/mobile/utility-reading-dues/{readingDueId}/readings/{readingId}'
      ].get.operationId,
      'getMobileUtilityMeterReading',
    );
    assert.deepEqual(
      SPEC.components.schemas.MobileUtilityMeterReadingLifecycleDetail.allOf[1]
        .required,
      ['rechecks', 'availableActions'],
    );
  });

  it('G. BE-25H METER_READING still targets BE-10C, unchanged and unreachable for BE-18', async (t) => {
    if (!requireDatabase(t)) return;

    // The BE-10C kind keeps its own verb, published operation, permission and
    // write target; PART 03 added a kind beside it and repurposed nothing.
    const documented = SYNC_DOC['x-sync-supported-resource-types'];
    const meterReading = documented.find((e: any) => e.resourceType === 'METER_READING');
    assert.deepEqual(meterReading.operations, ['SUBMIT']);
    assert.deepEqual(meterReading.operationIds, ['submitMeterReading']);
    assert.equal(meterReading.permission, 'meter_reading_binding.manage');
    assert.match(
      SOURCE,
      /METER_READING:\s*'meter_reading_binding\.manage'/,
      'the BE-10C permission is unchanged',
    );
    assert.match(
      SOURCE,
      /meterReadingBindingService\.submitMeterReading\(/,
      'the BE-10C kind still delegates to its own service',
    );
    assert.ok(
      !/utility_meter_readings/.test(
        SOURCE.slice(SOURCE.indexOf("case 'METER_READING'"), SOURCE.indexOf("case 'UTILITY_METER_READING'")),
      ),
      'the BE-10C case never touches the BE-18 table',
    );
    const itemSchema = SPEC.components.schemas.MobileSyncOperationItem;
    assert.deepEqual(itemSchema.properties.resourceType.enum, [
      'TASK_EXECUTION',
      'CHECKLIST_RESPONSES',
      'EVIDENCE_SUBMISSION',
      'TASK_ASSIGNMENT',
      'PATROL_EXECUTION',
      'PATROL_POINT_VISIT',
      'METER_READING',
      'UTILITY_METER_READING',
    ]);
    assert.equal(
      documented.findIndex((e: any) => e.resourceType === 'UTILITY_METER_READING'),
      documented.findIndex((e: any) => e.resourceType === 'METER_READING') + 1,
      'the new kind is additive, in the implemented order',
    );

    // Runtime: the BE-10C kind cannot be pointed at a BE-18 Reading Due. The
    // actor holds BOTH permissions, so what fails is the domain, not RBAC.
    const execution = await createFieldExecution({
      actorUserId: syncWorkerUserId,
      actorToken: syncWorkerToken,
      periodStart: '2027-12-01T00:00:00.000Z',
      submit: false,
    });
    const response = await postSync(syncWorkerToken, [
      {
        operationId: `p03be10c-${randomUUID()}`,
        resourceType: 'METER_READING',
        resourceId: execution.readingDueId,
        operation: 'SUBMIT',
        clientTimestamp: new Date().toISOString(),
        data: { value: 4242.5 },
      },
    ]);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const result = response.body.data.results[0];
    assert.equal(result.success, false, 'a BE-18 due is not a BE-10C resource');
    assert.equal(result.status, 'FAILED');
    assert.ok(result.error.code, 'the failure carries an authoritative code');
    assert.notEqual(result.error.code, 'PERMISSION_DENIED');

    // No BE-18 reading was written through the BE-10C kind, and the due is
    // still executable — the two domains never touched each other.
    assert.equal(await countReadings(execution.meterId), 0);
    const due = await loadDue(execution.readingDueId);
    assert.equal(due.status, 'DUE');
    assert.equal(due.meter_reading_id, null);
  });

  it('H. the UTILITY_METER_READING sync kind writes through the canonical service, replay-safe', async (t) => {
    if (!requireDatabase(t)) return;

    // ONE canonical write path: the dispatcher calls the SAME published field
    // service the online route calls, and the sync module writes no reading SQL.
    assert.match(
      SOURCE,
      /recordMobileUtilityMeterReading\(/,
      'the sync dispatcher delegates to the published BE-18 field service',
    );
    assert.match(
      SOURCE,
      /parseMobileUtilityMeterReadingBody\(/,
      'the offline body is parsed by PART 01’s own parser',
    );
    assert.ok(
      !/INSERT\s+INTO\s+utility_meter_readings/i.test(SOURCE),
      'the sync module never writes the reading table itself',
    );
    assert.ok(
      !/recordUtilityMeterReading\(/.test(SOURCE),
      'no second, lower-level reading authority is called from sync',
    );
    assert.match(
      SOURCE,
      /UTILITY_METER_READING:\s*'utility_meter\.field\.record'/,
      'the offline kind requires the same permission as the online route',
    );
    // The client supplies measurement facts only: no UOM, no range.
    assert.ok(
      !/uomId|minimumValue|maximumValue/.test(CONTROLLER_SOURCE),
      'the sync contract never accepts a UOM or a measurement range',
    );
    assert.match(
      CONTROLLER_SOURCE,
      /data\.readingValue must be a finite number for UTILITY_METER_READING/,
    );
    assert.match(
      CONFLICT_SOURCE,
      /UTILITY_METER_READING:\s*'\/mobile\/utility-reading-dues\/\{readingDueId\}/,
      'the conflict reload target is the BE-18 field execution read',
    );

    const execution = await createFieldExecution({
      actorUserId: syncWorkerUserId,
      actorToken: syncWorkerToken,
      periodStart: '2028-01-01T00:00:00.000Z',
      submit: false,
    });

    // 1. The offline submit applies end-to-end, through the canonical service.
    const operationId = `p03offline-${randomUUID()}`;
    const operation = utilitySyncOperation({
      readingDueId: execution.readingDueId,
      readingValue: 2250.75,
      readingAt: execution.insidePeriod(10),
      notes: 'Recorded offline in the basement',
      operationId,
    });
    const first = await postSync(syncWorkerToken, [operation]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.results.length, 1);
    const applied = first.body.data.results[0];
    assert.equal(applied.success, true, JSON.stringify(applied));
    assert.equal(applied.status, 'SUCCESS');
    assert.equal(applied.operationId, operationId);
    const readingId = applied.result.reading.id as string;
    assert.ok(readingId, 'the canonical reading id comes back');
    assert.equal(applied.result.reading.readingValue, 2250.75);
    assert.equal(applied.result.reading.source, 'MANUAL');
    assert.equal(applied.result.reading.readingType, 'ACTUAL');
    assert.equal(applied.result.reading.uomId, execution.uomId);
    assert.equal(applied.result.reading.recordedByUserId, syncWorkerUserId);

    // Exactly ONE reading, with the canonical provenance, and the due completed
    // by the same command — identical to what the online route produces.
    assert.equal(await countReadings(execution.meterId), 1);
    const row = await readReadingRow(readingId);
    assert.ok(row, 'the offline reading is persisted');
    assert.equal(row.meter_id, execution.meterId);
    assert.equal(row.client_id, execution.clientId);
    assert.equal(row.building_id, execution.buildingId);
    assert.equal(row.uom_id, execution.uomId);
    assert.equal(Number(row.reading_value), 2250.75);
    assert.equal(row.source, 'MANUAL');
    assert.equal(row.reading_type, 'ACTUAL');
    assert.equal(row.notes, 'Recorded offline in the basement');
    assert.equal(row.recorded_by_user_id, syncWorkerUserId);
    assert.equal(await countReadingEvents(readingId), 1);
    const due = await loadDue(execution.readingDueId);
    assert.equal(due.status, 'COMPLETED');
    assert.equal(due.meter_reading_id, readingId);

    // 2. Replay-safe operation identity: a deterministic, namespaced key through
    //    the SAME idempotency engine the online route uses.
    // The sync-derived key is itself a digest (bounded, namespaced, and out of
    // the charset an online `Idempotency-Key` header would occupy), and the
    // shared idempotency engine hashes whatever key it is handed — hence two
    // digests. Pinning the composition is what makes the identity replay-safe:
    // it is derived from the operation identity the client already committed to,
    // so it cannot vary between attempts.
    const expectedKeyHash = sha256Hex(
      sha256Hex(`mobile-sync:UTILITY_METER_READING:${syncWorkerUserId}:${operationId}`),
    );
    const claimed = await q(
      `SELECT operation_key, status FROM request_idempotency_records
        WHERE actor_user_id = $1 AND idempotency_key_hash = $2`,
      [syncWorkerUserId, expectedKeyHash],
    );
    assert.equal(claimed.rowCount, 1, 'one idempotency claim for the derived key');
    assert.equal(claimed.rows[0].operation_key, 'recordMobileUtilityMeterReading');
    assert.equal(claimed.rows[0].status, 'COMPLETED');

    // 3. Replaying the SAME operation returns the stored result and writes
    //    nothing again — no duplicate reading, no duplicate claim.
    const replay = await postSync(syncWorkerToken, [operation]);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    const replayed = replay.body.data.results[0];
    assert.equal(replayed.success, true, JSON.stringify(replayed));
    assert.equal(replayed.result.reading.id, readingId, 'the ORIGINAL stored result');
    assert.equal(await countReadings(execution.meterId), 1, 'replay did not duplicate');
    assert.equal(await countReadingEvents(readingId), 1);
    const claimsAfterReplay = await q(
      `SELECT COUNT(*)::int AS count FROM request_idempotency_records
        WHERE actor_user_id = $1 AND idempotency_key_hash = $2`,
      [syncWorkerUserId, expectedKeyHash],
    );
    assert.equal(claimsAfterReplay.rows[0].count, 1);

    // A different operationId for the same already-completed due is refused by
    // the canonical service, exactly as a second online submit would be.
    const secondAttempt = await postSync(syncWorkerToken, [
      utilitySyncOperation({
        readingDueId: execution.readingDueId,
        readingValue: 2260.5,
        readingAt: execution.insidePeriod(11),
      }),
    ]);
    assert.equal(secondAttempt.body.data.results[0].success, false);
    assert.equal(await countReadings(execution.meterId), 1);

    // 4. The SAME field authority applies offline: an actor who is not the
    //    executor of this due writes nothing.
    const unauthorized = await postSync(workerToken, [
      utilitySyncOperation({
        readingDueId: execution.readingDueId,
        readingValue: 3000.5,
        readingAt: execution.insidePeriod(12),
      }),
    ]);
    assert.equal(unauthorized.status, 200, JSON.stringify(unauthorized.body));
    const refused = unauthorized.body.data.results[0];
    assert.equal(refused.success, false, JSON.stringify(refused));
    assert.equal(refused.error.code, 'UTILITY_READING_DUE_FIELD_UNAUTHORIZED');
    assert.equal(await countReadings(execution.meterId), 1);

    // 5. BE-25I conflict handling covers the new kind, with the Reading Due as
    //    the authoritative version and its own reload target.
    const conflicted = await createFieldExecution({
      actorUserId: syncWorkerUserId,
      actorToken: syncWorkerToken,
      periodStart: '2028-02-01T00:00:00.000Z',
      submit: false,
    });
    const staleDue = await loadDue(conflicted.readingDueId);
    const staleVersion = staleDue.updated_at.toISOString();
    await q(
      `UPDATE utility_reading_dues SET updated_at = updated_at + INTERVAL '2 hours'
        WHERE id = $1`,
      [conflicted.readingDueId],
    );
    const conflictResponse = await postSync(syncWorkerToken, [
      utilitySyncOperation({
        readingDueId: conflicted.readingDueId,
        readingValue: 750.25,
        readingAt: conflicted.insidePeriod(9),
        baseVersion: staleVersion,
      }),
    ]);
    assert.equal(conflictResponse.status, 200, JSON.stringify(conflictResponse.body));
    const conflictResult = conflictResponse.body.data.results[0];
    assert.equal(conflictResult.success, false, JSON.stringify(conflictResult));
    assert.equal(conflictResult.error.code, 'SYNC_CONFLICT');
    // The reload target is PART 00's own published scoped read — the same
    // projection the conflict's `current` payload carries, so a client reloads
    // exactly what the server compared against.
    assert.equal(
      conflictResult.error.conflict.guidance.reloadEndpoint,
      `/mobile/utility-reading-dues/${conflicted.readingDueId}/meter-context`,
    );
    assert.equal(
      conflictResult.error.conflict.current.readingDue.id,
      conflicted.readingDueId,
    );
    assert.equal(await countReadings(conflicted.meterId), 0, 'a stale base wrote nothing');
    const untouchedDue = await loadDue(conflicted.readingDueId);
    assert.equal(untouchedDue.status, 'DUE');
    assert.equal(untouchedDue.meter_reading_id, null);

    // 6. The kind is documented as supported, with its own permission and the
    //    SAME published operationId as the online field route.
    const documented = SYNC_DOC['x-sync-supported-resource-types'].find(
      (e: any) => e.resourceType === 'UTILITY_METER_READING',
    );
    assert.deepEqual(documented.operations, ['SUBMIT']);
    assert.deepEqual(documented.operationIds, ['recordMobileUtilityMeterReading']);
    assert.equal(documented.permission, 'utility_meter.field.record');
    const onlineOperationId =
      SPEC.paths['/mobile/utility-reading-dues/{readingDueId}/readings'].post
        .operationId;
    assert.equal(
      documented.operationIds[0],
      onlineOperationId,
      'offline and online are the same published command',
    );
    assert.ok(
      !SPEC.paths['/mobile/sync'].post['x-sync-unsupported-resource-types'].some(
        (e: any) => e.resourceType === 'UTILITY_METER_READING',
      ),
      'the kind is supported, not documented as local-only',
    );
  });
});
