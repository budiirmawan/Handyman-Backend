import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
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
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 02 — Reading Evidence / OCR Confirmation /
 * Canonical Abnormal Signal.
 *
 * ONE focused suite over the PART 02 verification surface. It proves exactly the
 * seven contracts this part introduces and nothing else:
 *
 *   A  an authorized field actor reads the ENRICHED reading detail (PART 01
 *      fields intact + four strictly additive projections; the list stays light)
 *   B  a management-only reading with no Reading Due is denied from every field
 *      verification route — and survives the denial untouched
 *   C  `UTILITY_METER_READING` is accepted by the EXISTING shared/mobile
 *      evidence engine (both doors, one table, canonical parent projection)
 *   D  evidence readiness is BE-18F's canonical report, and missing evidence
 *      never invalidates, reopens or deletes a genuine reading
 *   E  an EXISTING OCR candidate is SUGGESTION ONLY: readable by the field actor,
 *      acceptance links the already-recorded reading and creates no second
 *      reading, a mismatched value is refused, rejection mutates only the
 *      candidate, and no field route can author a candidate
 *   F  `abnormalSignals` is a READ projection: `[]` means only "no persisted
 *      signal", one persisted downstream signal comes back verbatim, and reading
 *      it creates neither a consumption nor an evaluation
 *   G  a field actor of ANOTHER reading is denied, their own reading is not, and
 *      a wrong execution identity in the path is a 404
 *
 * Deliberately NOT exercised here: PART 00's context authority, PART 01's
 * submit / idempotency / concurrency / history contracts (both already proven by
 * their own suites), BE-18F's management evidence routes, BE-18's OCR staging
 * and decision internals, BE-18G consumption calculation, BE-18J abnormality
 * detection, BE-25H mobile sync, QR resolution, recheck/correction,
 * `availableActions` and billing. No OCR or vision engine exists in this
 * repository and none is created by these tests: candidates are staged through
 * BE-18's own management route, exactly as an integration would.
 */

const STORAGE_DIR = resolve(
  process.env.EVIDENCE_STORAGE_DIR ?? '.data/evidence',
);

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

let adminUserId = '';
let adminToken = '';

/** The authorized technician: field.read + field.record + field.evidence. */
let workerUserId = '';
let workerToken = '';
/** A second authorized technician, assigned to a DIFFERENT field execution. */
let otherWorkerUserId = '';
let otherWorkerToken = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const id = () => randomUUID();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

const DUE_PATH = '/api/v1/mobile/utility-reading-dues';
const readingsUrl = (readingDueId: string) =>
  `${DUE_PATH}/${readingDueId}/readings`;
const readingUrl = (readingDueId: string, readingId: string) =>
  `${readingsUrl(readingDueId)}/${readingId}`;
const evidenceUrl = (readingDueId: string, readingId: string) =>
  `${readingUrl(readingDueId, readingId)}/evidence`;
const evidenceItemUrl = (
  readingDueId: string,
  readingId: string,
  evidenceId: string,
) => `${evidenceUrl(readingDueId, readingId)}/${evidenceId}`;
const validationUrl = (readingDueId: string, readingId: string) =>
  `${readingUrl(readingDueId, readingId)}/evidence-validation`;
const ocrUrl = (readingDueId: string, readingId: string) =>
  `${readingUrl(readingDueId, readingId)}/ocr-candidates`;
const ocrDecisionUrl = (
  readingDueId: string,
  readingId: string,
  candidateId: string,
  verb: 'confirm' | 'reject',
) => `${ocrUrl(readingDueId, readingId)}/${candidateId}/${verb}`;
const signalsUrl = (readingDueId: string, readingId: string) =>
  `${readingUrl(readingDueId, readingId)}/abnormal-signals`;

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
      existing ??
      (await permissionService.createPermission({ code, name: code }));
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

async function grantBuildingAccess(userId: string, buildingId: string) {
  await buildingAssignmentService.createAssignment(userId, { buildingId });
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

type FieldReading = {
  clientId: string;
  buildingId: string;
  uomId: string;
  meterId: string;
  generatedTaskId: string;
  readingDueId: string;
  readingId: string;
  readingValue: number;
  readingAt: string;
  /** An instant safely inside the due period. */
  insidePeriod: (offsetDays?: number) => string;
};

/**
 * The canonical PART 02 fixture: Building → Meter → generated task ACTIVE-
 * assigned to `actorUserId` → Reading Due → the field reading PART 01 created
 * for that due (which also completed it). Every verification route hangs off
 * this already-recorded reading; nothing here is a PART 02 invention.
 */
async function createFieldReading(options: {
  actorUserId: string;
  actorToken: string;
  periodStart?: string;
  readingValue?: number;
}): Promise<FieldReading> {
  const structure = await createStructure();
  const profileId = await createProfile(options.actorUserId);
  await grantBuildingAccess(options.actorUserId, structure.buildingId);

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

  const readingValue = options.readingValue ?? 1234.5;
  const submitted = await api()
    .post(readingsUrl(readingDueId))
    .set(auth(options.actorToken))
    .set('Idempotency-Key', `p02-${id()}`)
    .send({ readingValue, readingAt: insidePeriod() });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));

  return {
    clientId: structure.clientId,
    buildingId: structure.buildingId,
    uomId,
    meterId,
    generatedTaskId,
    readingDueId,
    readingId: submitted.body.data.reading.id as string,
    readingValue,
    readingAt: submitted.body.data.reading.readingAt as string,
    insidePeriod,
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
    `SELECT id, meter_id, status, meter_reading_id
       FROM utility_reading_dues WHERE id = $1`,
    [readingDueId],
  );
  return result.rows[0] as {
    id: string;
    meter_id: string;
    status: string;
    meter_reading_id: string | null;
  };
}

/** A field PHOTO upload through the PART 02 route (multipart field `file`). */
async function uploadFieldPhoto(
  readingDueId: string,
  readingId: string,
  token: string,
  options: { requirementId?: string; bytes?: string; fileName?: string } = {},
) {
  let request = api()
    .post(evidenceUrl(readingDueId, readingId))
    .set(auth(token))
    .field('evidenceType', 'PHOTO');
  if (options.requirementId) {
    request = request.field('evidenceRequirementId', options.requirementId);
  }
  return request.attach(
    'file',
    Buffer.from(options.bytes ?? 'meter-reading-photo-bytes'),
    {
      filename: options.fileName ?? 'meter.jpg',
      contentType: 'image/jpeg',
    },
  );
}

async function countEvidenceRows(readingId: string): Promise<number> {
  const result = await q(
    `SELECT COUNT(*)::int AS count FROM evidence_submissions
      WHERE execution_type = 'UTILITY_METER_READING' AND execution_id = $1`,
    [readingId],
  );
  return result.rows[0]?.count ?? 0;
}

/** BE-18's management staging route — the ONLY way a candidate comes to exist. */
async function stageCandidate(
  evidenceId: string,
  candidateReadingValue: number,
  confidence = 0.9,
): Promise<string> {
  const staged = await api()
    .post(`/api/v1/utility/meter-reading-evidence/${evidenceId}/ocr-candidates`)
    .set(auth())
    .send({ candidateReadingValue, confidence });
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  return staged.body.data.id as string;
}

async function countDownstreamRows(meterId: string) {
  const consumptions = await q(
    'SELECT COUNT(*)::int AS count FROM utility_meter_consumptions WHERE meter_id = $1',
    [meterId],
  );
  const abnormal = await q(
    'SELECT COUNT(*)::int AS count FROM utility_abnormal_consumptions WHERE meter_id = $1',
    [meterId],
  );
  return {
    consumptions: consumptions.rows[0]?.count ?? 0,
    abnormal: abnormal.rows[0]?.count ?? 0,
  };
}

/** The exact persisted keys of each projection — no invented verdict fields. */
const EVIDENCE_ITEM_KEYS = [
  'capturedAt',
  'createdAt',
  'evidenceRequirementId',
  'evidenceType',
  'fileAvailable',
  'fileSize',
  'id',
  'meterReadingId',
  'mimeType',
  'originalFileName',
  'status',
  'submittedByUserId',
  'uploadStatus',
];
const OCR_SUGGESTION_KEYS = [
  'acceptedReadingId',
  'candidateReadingValue',
  'confidence',
  'createdAt',
  'decisionNotes',
  'evidenceId',
  'id',
  'status',
  'verifiedAt',
  'verifiedByUserId',
];
const ABNORMAL_SIGNAL_KEYS = [
  'abnormalityType',
  'comparisonMode',
  'consumptionId',
  'detectedAt',
  'detectedByUserId',
  'detectedValue',
  'findingId',
  'id',
  'notes',
  'periodEnd',
  'periodStart',
  'referenceValue',
  'resolutionNotes',
  'resolvedAt',
  'resolvedByUserId',
  'ruleId',
  'status',
  'thresholdValue',
  'uomId',
];

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  database = db;
  rmSync(STORAGE_DIR, { recursive: true, force: true });

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE request_idempotency_records, operational_events,
       utility_reading_dues, utility_meter_ocr_candidates,
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

  // `evidence.read` is the PRE-EXISTING gate of the shared mobile evidence read
  // door (`GET /mobile/evidence/:id`), not a PART 02 permission; the field
  // sessions carry it so contract C can read back what the same engine stored.
  const worker = await createUserWithPermissions('p02worker', [
    'utility_meter.field.read',
    'utility_meter.field.record',
    'utility_meter.field.evidence',
    'evidence.read',
  ]);
  workerUserId = worker.userId;
  workerToken = worker.token;

  const otherWorker = await createUserWithPermissions('p02other', [
    'utility_meter.field.read',
    'utility_meter.field.record',
    'utility_meter.field.evidence',
    'evidence.read',
  ]);
  otherWorkerUserId = otherWorker.userId;
  otherWorkerToken = otherWorker.token;
});

after(async () => {
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  if (pool) {
    await closePool();
  }
});

describe('CR-BE-RN12-METER-FIELD-01 PART 02 — reading evidence and verification', () => {
  it('A. an authorized field actor reads the enriched reading detail', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createFieldReading({
      actorUserId: workerUserId,
      actorToken: workerToken,
    });

    const detail = await api()
      .get(readingUrl(fixture.readingDueId, fixture.readingId))
      .set(auth(workerToken));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const data = detail.body.data;

    // PART 01's bounded DTO keeps every name, type and value.
    assert.equal(data.id, fixture.readingId);
    assert.equal(data.meterId, fixture.meterId);
    assert.equal(data.readingValue, fixture.readingValue);
    assert.equal(data.readingAt, fixture.readingAt);
    assert.equal(data.source, 'MANUAL');
    assert.equal(data.readingType, 'ACTUAL');
    assert.equal(data.recordedByUserId, workerUserId);

    // The four additive projections, in their empty-but-honest state.
    assert.deepEqual(data.evidenceValidation, {
      meterReadingId: fixture.readingId,
      ready: true,
      missingEvidenceTypes: [],
      requirements: [],
    });
    assert.deepEqual(data.evidenceSummary, {
      activeTotal: 0,
      activeByType: { PHOTO: 0, DOCUMENT: 0, SIGNATURE: 0 },
      truncated: false,
      items: [],
    });
    assert.deepEqual(data.ocrCandidates, []);
    assert.deepEqual(data.abnormalSignals, {
      consumptionId: null,
      evaluated: false,
      truncated: false,
      signals: [],
    });

    // No verdict is derived anywhere on the reading itself.
    for (const forbidden of [
      'isAbnormal',
      'abnormalReason',
      'requiresRecheck',
      'photoRequired',
    ]) {
      assert.equal(forbidden in data, false, `${forbidden} must not exist`);
    }

    // The LIST route stays on the lightweight DTO: no enrichment leaked into it.
    const list = await api()
      .get(readingsUrl(fixture.readingDueId))
      .set(auth(workerToken));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const item = (list.body.data as { id: string }[]).find(
      (row) => row.id === fixture.readingId,
    );
    assert.ok(item, 'the reading is listed');
    for (const projection of [
      'evidenceValidation',
      'evidenceSummary',
      'ocrCandidates',
      'abnormalSignals',
    ]) {
      assert.equal(
        projection in (item as Record<string, unknown>),
        false,
        `${projection} must stay out of the list`,
      );
    }
  });

  it('B. a management-only reading with no Reading Due is denied from the field surface', async (t) => {
    if (!requireDatabase(t)) return;

    // A reading created by MANAGEMENT only — no Reading Due, so no field
    // execution identity exists for it at all.
    const structure = await createStructure();
    const uomId = await createUom(structure.clientId);
    const meterId = await createMeter(structure.buildingId, uomId);
    const management = await api()
      .post(`/api/v1/utility/meters/${meterId}/readings`)
      .set(auth())
      .send({ readingValue: 500, readingAt: '2027-02-10T02:00:00.000Z' });
    assert.equal(management.status, 201, JSON.stringify(management.body));
    const managementReadingId = management.body.data.id as string;
    const before = await readReadingRow(managementReadingId);
    assert.ok(before, 'the management reading exists');

    // A REAL field execution of the authorized actor, used only as the path
    // identity: authority is resolved from the READING, so a valid due cannot
    // lend the actor a reading that has no due of its own.
    const field = await createFieldReading({
      actorUserId: workerUserId,
      actorToken: workerToken,
    });

    const deniedRoutes = [
      readingUrl(field.readingDueId, managementReadingId),
      evidenceUrl(field.readingDueId, managementReadingId),
      validationUrl(field.readingDueId, managementReadingId),
      ocrUrl(field.readingDueId, managementReadingId),
      signalsUrl(field.readingDueId, managementReadingId),
    ];
    for (const url of deniedRoutes) {
      const denied = await api().get(url).set(auth(workerToken));
      assert.equal(denied.status, 404, `${url} → ${denied.status}`);
      assert.equal(
        denied.body.error.code,
        'UTILITY_METER_READING_NOT_FOUND',
        `${url} → ${JSON.stringify(denied.body)}`,
      );
    }

    // The write door refuses it identically (a real file is attached, so the
    // refusal can only come from field authority).
    const upload = await uploadFieldPhoto(
      field.readingDueId,
      managementReadingId,
      workerToken,
    );
    assert.equal(upload.status, 404, JSON.stringify(upload.body));
    assert.equal(
      upload.body.error.code,
      'UTILITY_METER_READING_NOT_FOUND',
      JSON.stringify(upload.body),
    );
    assert.equal(await countEvidenceRows(managementReadingId), 0);

    // Denial is not deletion: the reading survives, byte for byte, and stays
    // readable through its OWN management surface.
    const after = await readReadingRow(managementReadingId);
    assert.deepEqual(after, before);
    const history = await api()
      .get(`/api/v1/utility/meters/${meterId}/readings`)
      .set(auth());
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.ok(
      (history.body.data as { id: string }[]).some(
        (row) => row.id === managementReadingId,
      ),
    );
  });

  it('C. the existing shared and mobile evidence engines accept UTILITY_METER_READING', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createFieldReading({
      actorUserId: workerUserId,
      actorToken: workerToken,
    });

    // The MOBILE door: same endpoint, same multipart contract, same response
    // contract as every pre-existing kind — one new executionType value.
    const mobile = await api()
      .post('/api/v1/mobile/evidence')
      .set(auth(workerToken))
      .field('evidenceType', 'PHOTO')
      .field('executionType', 'UTILITY_METER_READING')
      .field('executionId', fixture.readingId)
      .attach('file', Buffer.from('mobile-door-photo-bytes'), {
        filename: 'mobile-door.jpg',
        contentType: 'image/jpeg',
      });
    assert.equal(mobile.status, 201, JSON.stringify(mobile.body));
    const contract = mobile.body.data;
    assert.equal(contract.target.executionType, 'UTILITY_METER_READING');
    assert.equal(contract.target.executionId, fixture.readingId);
    assert.deepEqual(contract.target.meterReading, {
      id: fixture.readingId,
      meterId: fixture.meterId,
      readingValue: fixture.readingValue,
      readingAt: fixture.readingAt,
      source: 'MANUAL',
      readingType: 'ACTUAL',
    });
    // Every pre-existing parent reference stays null — the projection of any
    // other kind is unchanged by the one nullable additive field.
    assert.equal(contract.target.checklist, null);
    assert.equal(contract.target.form, null);
    assert.equal(contract.target.finding, null);
    assert.equal(contract.target.rework, null);
    assert.equal(contract.target.verification, null);
    assert.equal(contract.building.id, fixture.buildingId);
    assert.equal(contract.evidenceType, 'PHOTO');
    assert.equal(contract.status, 'ACTIVE');
    assert.equal(contract.submittedByUserId, workerUserId);
    assert.equal(contract.file.uploadStatus, 'UPLOADED');
    assert.equal(contract.file.fileAvailable, true);
    assert.equal(contract.file.originalFileName, 'mobile-door.jpg');
    // The internal storage key is never exposed to a mobile client.
    assert.equal('fileReference' in contract, false);
    assert.equal('fileReference' in contract.file, false);

    // The READ side of the same engine resolves the reading parent too.
    const read = await api()
      .get(`/api/v1/mobile/evidence/${contract.id}`)
      .set(auth(workerToken));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.target.meterReading.id, fixture.readingId);
    assert.equal(read.body.data.target.executionType, 'UTILITY_METER_READING');

    // The SHARED metadata door admits the type as well (utility_meter.manage),
    // through the same execution loader that every other kind uses.
    const generic = await api()
      .post('/api/v1/evidence')
      .set(auth())
      .send({
        evidenceType: 'PHOTO',
        executionType: 'UTILITY_METER_READING',
        executionId: fixture.readingId,
        fileReference: `evidence/${id()}`,
        originalFileName: 'shared-door.png',
        mimeType: 'image/png',
        fileSize: 2048,
      });
    assert.equal(generic.status, 201, JSON.stringify(generic.body));
    // `evidence_submissions` stores no building of its own — the Building is
    // resolved from the execution, which is exactly what the loader did to let
    // this submission through.
    const genericRow = await q(
      `SELECT execution_type, execution_id, client_id, evidence_type, status
         FROM evidence_submissions WHERE id = $1`,
      [generic.body.data.id as string],
    );
    assert.equal(genericRow.rows[0]?.execution_type, 'UTILITY_METER_READING');
    assert.equal(genericRow.rows[0]?.execution_id, fixture.readingId);
    assert.equal(genericRow.rows[0]?.client_id, fixture.clientId);
    assert.equal(genericRow.rows[0]?.evidence_type, 'PHOTO');
    assert.equal(genericRow.rows[0]?.status, 'ACTIVE');

    // ONE evidence table, ONE upload path — no second model was introduced.
    assert.equal(await countEvidenceRows(fixture.readingId), 2);
    const fieldList = await api()
      .get(evidenceUrl(fixture.readingDueId, fixture.readingId))
      .set(auth(workerToken));
    assert.equal(fieldList.status, 200, JSON.stringify(fieldList.body));
    const items = fieldList.body.data as Record<string, unknown>[];
    assert.equal(items.length, 2);
    for (const item of items) {
      assert.deepEqual(Object.keys(item).sort(), EVIDENCE_ITEM_KEYS);
      assert.equal(item.meterReadingId, fixture.readingId);
      assert.equal(item.evidenceType, 'PHOTO');
      assert.equal(item.status, 'ACTIVE');
    }
    assert.ok(
      items.some((item) => item.id === contract.id),
      'the mobile-door submission is listed by the field route',
    );

    // Removal is soft, scoped to THIS reading, and preserves history.
    const removed = await api()
      .patch(evidenceItemUrl(fixture.readingDueId, fixture.readingId, contract.id))
      .set(auth(workerToken))
      .send({ notes: 'Blurry meter dial, re-shot on site.' });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.data.status, 'REMOVED');
    assert.equal(removed.body.data.id, contract.id);
    const preserved = await q(
      `SELECT status FROM evidence_submissions WHERE id = $1`,
      [contract.id],
    );
    assert.equal(preserved.rows[0]?.status, 'REMOVED');
    assert.equal(await countEvidenceRows(fixture.readingId), 2);

    // A foreign evidence id is a 404 that never confirms the row exists.
    const foreign = await api()
      .patch(
        evidenceItemUrl(fixture.readingDueId, fixture.readingId, id()),
      )
      .set(auth(workerToken))
      .send({ notes: 'Not this reading.' });
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    assert.equal(
      foreign.body.error.code,
      'UTILITY_METER_READING_EVIDENCE_NOT_FOUND',
    );

    // The reading is untouched by all of it.
    const row = await readReadingRow(fixture.readingId);
    assert.equal(Number(row?.reading_value), fixture.readingValue);
    assert.equal(await countReadings(fixture.meterId), 1);
  });

  it('D. evidence readiness is canonical and missing evidence never invalidates the reading', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createFieldReading({
      actorUserId: workerUserId,
      actorToken: workerToken,
    });
    const readingBefore = await readReadingRow(fixture.readingId);
    const dueBefore = await loadDue(fixture.readingDueId);

    // A requirement is PERSISTED by BE-07 — the field surface never invents one,
    // and nothing in this repository makes a meter photo globally required.
    const requirementId = await insertRow('evidence_requirements', {
      client_id: fixture.clientId,
      target_type: 'UTILITY_METER_READING',
      target_id: fixture.readingId,
      evidence_type: 'PHOTO',
      required: true,
      minimum_count: 1,
      maximum_count: null,
      status: 'ACTIVE',
    });

    const fieldReadiness = await api()
      .get(validationUrl(fixture.readingDueId, fixture.readingId))
      .set(auth(workerToken));
    assert.equal(fieldReadiness.status, 200, JSON.stringify(fieldReadiness.body));
    const expected = {
      meterReadingId: fixture.readingId,
      ready: false,
      missingEvidenceTypes: ['PHOTO'],
      requirements: [
        {
          evidenceRequirementId: requirementId,
          evidenceType: 'PHOTO',
          required: true,
          minimumCount: 1,
          maximumCount: null,
          activeCount: 0,
          satisfied: false,
        },
      ],
    };
    assert.deepEqual(fieldReadiness.body.data, expected);

    // Canonical, not a field-specific variant: BE-18F's management projection of
    // the same reading is identical.
    const managementReadiness = await api()
      .get(`/api/v1/utility/meter-readings/${fixture.readingId}/evidence-validation`)
      .set(auth());
    assert.equal(
      managementReadiness.status,
      200,
      JSON.stringify(managementReadiness.body),
    );
    assert.deepEqual(managementReadiness.body.data, fieldReadiness.body.data);

    // The detail carries the SAME readiness object.
    const detail = await api()
      .get(readingUrl(fixture.readingDueId, fixture.readingId))
      .set(auth(workerToken));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.deepEqual(detail.body.data.evidenceValidation, expected);

    // MISSING EVIDENCE DOES NOT INVALIDATE THE READING. Readiness is a report
    // about evidence, a separate statement from reading validity: the reading
    // keeps its value and provenance and its due stays COMPLETED and linked.
    assert.deepEqual(await readReadingRow(fixture.readingId), readingBefore);
    assert.deepEqual(await loadDue(fixture.readingDueId), dueBefore);
    assert.equal(dueBefore.status, 'COMPLETED');
    assert.equal(dueBefore.meter_reading_id, fixture.readingId);

    // Satisfying the requirement flips readiness — reported, still not enforced.
    const upload = await uploadFieldPhoto(
      fixture.readingDueId,
      fixture.readingId,
      workerToken,
      { requirementId, bytes: 'satisfying-photo-bytes' },
    );
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    assert.equal(upload.body.data.evidenceRequirementId, requirementId);
    assert.equal(upload.body.data.uploadStatus, 'UPLOADED');
    assert.equal(upload.body.data.fileAvailable, true);

    const satisfied = await api()
      .get(validationUrl(fixture.readingDueId, fixture.readingId))
      .set(auth(workerToken));
    assert.equal(satisfied.status, 200, JSON.stringify(satisfied.body));
    assert.equal(satisfied.body.data.ready, true);
    assert.deepEqual(satisfied.body.data.missingEvidenceTypes, []);
    assert.equal(satisfied.body.data.requirements[0].activeCount, 1);
    assert.equal(satisfied.body.data.requirements[0].satisfied, true);

    // The reading is still exactly what PART 01 recorded, and the evidence
    // summary in the detail now counts the upload.
    assert.deepEqual(await readReadingRow(fixture.readingId), readingBefore);
    assert.equal(await countReadings(fixture.meterId), 1);
    const enriched = await api()
      .get(readingUrl(fixture.readingDueId, fixture.readingId))
      .set(auth(workerToken));
    assert.equal(enriched.status, 200, JSON.stringify(enriched.body));
    assert.equal(enriched.body.data.evidenceSummary.activeTotal, 1);
    assert.deepEqual(enriched.body.data.evidenceSummary.activeByType, {
      PHOTO: 1,
      DOCUMENT: 0,
      SIGNATURE: 0,
    });
    assert.equal(enriched.body.data.evidenceSummary.truncated, false);
    assert.equal(enriched.body.data.evidenceSummary.items.length, 1);
    assert.equal(enriched.body.data.evidenceValidation.ready, true);
  });

  it('E1. an existing OCR candidate is a suggestion: acceptance links the recorded reading and creates none', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createFieldReading({
      actorUserId: workerUserId,
      actorToken: workerToken,
    });
    const photo = await uploadFieldPhoto(
      fixture.readingDueId,
      fixture.readingId,
      workerToken,
    );
    assert.equal(photo.status, 201, JSON.stringify(photo.body));
    const evidenceId = photo.body.data.id as string;

    // Staged by MANAGEMENT through BE-18's own route — the only origin a
    // candidate has in this repository. No OCR engine, no candidate from image.
    const candidateId = await stageCandidate(evidenceId, fixture.readingValue);
    const readingBefore = await readReadingRow(fixture.readingId);
    const dueBefore = await loadDue(fixture.readingDueId);

    // The field actor READS the suggestion.
    const listed = await api()
      .get(ocrUrl(fixture.readingDueId, fixture.readingId))
      .set(auth(workerToken));
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 1);
    const suggestion = listed.body.data[0];
    assert.deepEqual(Object.keys(suggestion).sort(), OCR_SUGGESTION_KEYS);
    assert.equal(suggestion.id, candidateId);
    assert.equal(suggestion.evidenceId, evidenceId);
    assert.equal(suggestion.candidateReadingValue, fixture.readingValue);
    assert.equal(suggestion.confidence, 0.9);
    assert.equal(suggestion.status, 'PENDING_REVIEW');
    assert.equal(suggestion.acceptedReadingId, null);
    assert.equal(suggestion.verifiedByUserId, null);
    assert.equal(suggestion.verifiedAt, null);
    // No verdict, no recommendation, no comparison result is projected.
    for (const forbidden of [
      'matchesReading',
      'shouldAccept',
      'recommended',
      'isCorrect',
      'verdict',
    ]) {
      assert.equal(
        forbidden in suggestion,
        false,
        `${forbidden} must not exist`,
      );
    }

    // ACCEPT links the EXISTING canonical reading — `notes` is the only input a
    // field caller may send.
    const confirmed = await api()
      .post(
        ocrDecisionUrl(
          fixture.readingDueId,
          fixture.readingId,
          candidateId,
          'confirm',
        ),
      )
      .set(auth(workerToken))
      .send({ notes: 'Dial photo agrees with the value I recorded.' });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const decided = confirmed.body.data.candidate;
    assert.equal(decided.id, candidateId);
    assert.equal(decided.status, 'ACCEPTED');
    assert.equal(decided.acceptedReadingId, fixture.readingId);
    assert.equal(decided.verifiedByUserId, workerUserId);
    assert.ok(decided.verifiedAt, 'the decision is stamped');
    assert.equal(decided.candidateReadingValue, fixture.readingValue);

    // NO SECOND READING is created, and the recorded reading is not mutated:
    // acceptance never carries `readingAt`, which is what BE-18 would need to
    // create one, and never writes the candidate value anywhere.
    assert.equal(await countReadings(fixture.meterId), 1);
    assert.deepEqual(await readReadingRow(fixture.readingId), readingBefore);
    // The due stays COMPLETED against the SAME reading — no second completion.
    assert.deepEqual(await loadDue(fixture.readingDueId), dueBefore);

    // BE-18's own semantics are preserved: the canonical event was recorded and
    // the decision is terminal.
    const events = await q(
      `SELECT COUNT(*)::int AS count FROM operational_events
        WHERE entity_id = $1 AND event_type = 'UTILITY_OCR_CANDIDATE_ACCEPTED'`,
      [candidateId],
    );
    assert.equal(events.rows[0]?.count, 1);
    const replay = await api()
      .post(
        ocrDecisionUrl(
          fixture.readingDueId,
          fixture.readingId,
          candidateId,
          'confirm',
        ),
      )
      .set(auth(workerToken))
      .send({});
    assert.equal(replay.status, 409, JSON.stringify(replay.body));
    assert.equal(replay.body.error.code, 'UTILITY_OCR_DECISION_FINAL');
    assert.equal(await countReadings(fixture.meterId), 1);

    // The detail exposes the same suggestion, decided.
    const detail = await api()
      .get(readingUrl(fixture.readingDueId, fixture.readingId))
      .set(auth(workerToken));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.ocrCandidates.length, 1);
    assert.equal(detail.body.data.ocrCandidates[0].status, 'ACCEPTED');
    assert.equal(
      detail.body.data.ocrCandidates[0].acceptedReadingId,
      fixture.readingId,
    );
  });

  it('E2. a mismatched candidate cannot be accepted, a rejection mutates only the candidate, and no field route authors one', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createFieldReading({
      actorUserId: workerUserId,
      actorToken: workerToken,
      readingValue: 1234.5,
    });
    const photo = await uploadFieldPhoto(
      fixture.readingDueId,
      fixture.readingId,
      workerToken,
      { bytes: 'second-photo-bytes', fileName: 'second.jpg' },
    );
    assert.equal(photo.status, 201, JSON.stringify(photo.body));
    // A candidate whose staged value DISAGREES with the recorded reading.
    const candidateId = await stageCandidate(
      photo.body.data.id as string,
      9999.75,
    );
    const readingBefore = await readReadingRow(fixture.readingId);
    const dueBefore = await loadDue(fixture.readingDueId);

    const mismatched = await api()
      .post(
        ocrDecisionUrl(fixture.readingDueId, fixture.readingId, candidateId, 'confirm'),
      )
      .set(auth(workerToken))
      .send({});
    assert.equal(mismatched.status, 400, JSON.stringify(mismatched.body));
    assert.equal(mismatched.body.error.code, 'UTILITY_OCR_READING_MISMATCH');
    // The refusal created nothing and changed nothing.
    assert.equal(await countReadings(fixture.meterId), 1);
    assert.deepEqual(await readReadingRow(fixture.readingId), readingBefore);
    const stillPending = await q(
      `SELECT status, accepted_reading_id, verified_by_user_id
         FROM utility_meter_ocr_candidates WHERE id = $1`,
      [candidateId],
    );
    assert.equal(stillPending.rows[0]?.status, 'PENDING_REVIEW');
    assert.equal(stillPending.rows[0]?.accepted_reading_id, null);
    assert.equal(stillPending.rows[0]?.verified_by_user_id, null);

    // A field caller may not instruct the linkage: the reading is the one from
    // the path, and the candidate-creating keys are refused outright.
    for (const body of [
      { meterReadingId: id() },
      { readingAt: fixture.insidePeriod(2) },
      { readingDueId: id() },
      { candidateReadingValue: 9999.75 },
    ]) {
      const refused = await api()
        .post(
          ocrDecisionUrl(
            fixture.readingDueId,
            fixture.readingId,
            candidateId,
            'confirm',
          ),
        )
        .set(auth(workerToken))
        .send(body);
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
    }
    assert.equal(await countReadings(fixture.meterId), 1);

    // REJECT mutates only the candidate: `decisionNotes` is required, the row
    // keeps `accepted_reading_id` null, and the reading is untouched.
    const withoutNotes = await api()
      .post(
        ocrDecisionUrl(fixture.readingDueId, fixture.readingId, candidateId, 'reject'),
      )
      .set(auth(workerToken))
      .send({});
    assert.equal(withoutNotes.status, 400, JSON.stringify(withoutNotes.body));

    const rejected = await api()
      .post(
        ocrDecisionUrl(fixture.readingDueId, fixture.readingId, candidateId, 'reject'),
      )
      .set(auth(workerToken))
      .send({ decisionNotes: 'Photo shows the previous billing period dial.' });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.data.candidate.status, 'REJECTED');
    assert.equal(rejected.body.data.candidate.acceptedReadingId, null);
    assert.equal(rejected.body.data.candidate.verifiedByUserId, workerUserId);
    assert.equal(
      rejected.body.data.candidate.decisionNotes,
      'Photo shows the previous billing period dial.',
    );
    assert.deepEqual(await readReadingRow(fixture.readingId), readingBefore);
    assert.deepEqual(await loadDue(fixture.readingDueId), dueBefore);
    assert.equal(await countReadings(fixture.meterId), 1);
    const rejectedEvents = await q(
      `SELECT COUNT(*)::int AS count FROM operational_events
        WHERE entity_id = $1 AND event_type = 'UTILITY_OCR_CANDIDATE_REJECTED'`,
      [candidateId],
    );
    assert.equal(rejectedEvents.rows[0]?.count, 1);

    // NO FIELD ROUTE CREATES A CANDIDATE: the collection accepts reads only, and
    // BE-18's staging route stays a management act.
    const noFieldCreate = await api()
      .post(ocrUrl(fixture.readingDueId, fixture.readingId))
      .set(auth(workerToken))
      .send({ candidateReadingValue: fixture.readingValue });
    assert.equal(noFieldCreate.status, 404, JSON.stringify(noFieldCreate.body));
    const managementOnly = await api()
      .post(
        `/api/v1/utility/meter-reading-evidence/${photo.body.data.id}/ocr-candidates`,
      )
      .set(auth(workerToken))
      .send({ candidateReadingValue: fixture.readingValue, confidence: 0.8 });
    assert.equal(managementOnly.status, 403, JSON.stringify(managementOnly.body));
    assert.equal(managementOnly.body.error.code, 'PERMISSION_DENIED');
    const candidates = await q(
      `SELECT COUNT(*)::int AS count FROM utility_meter_ocr_candidates
        WHERE meter_id = $1`,
      [fixture.meterId],
    );
    assert.equal(candidates.rows[0]?.count, 1);

    // A candidate of another reading is not decidable here, and is reported as
    // not found rather than confirmed to exist.
    const foreign = await api()
      .post(
        ocrDecisionUrl(fixture.readingDueId, fixture.readingId, id(), 'confirm'),
      )
      .set(auth(workerToken))
      .send({});
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    assert.equal(foreign.body.error.code, 'UTILITY_OCR_CANDIDATE_NOT_FOUND');
  });

  it('F. abnormalSignals is a read projection: [] means only "no persisted signal"', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createFieldReading({
      actorUserId: workerUserId,
      actorToken: workerToken,
    });
    const downstreamBefore = await countDownstreamRows(fixture.meterId);
    assert.deepEqual(downstreamBefore, { consumptions: 0, abnormal: 0 });

    // No consumption is anchored on this reading yet: the projection says so
    // precisely, and claims NOTHING about the meter being normal.
    const empty = await api()
      .get(signalsUrl(fixture.readingDueId, fixture.readingId))
      .set(auth(workerToken));
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body.data, {
      consumptionId: null,
      evaluated: false,
      truncated: false,
      signals: [],
    });
    for (const forbidden of ['isAbnormal', 'normal', 'verdict', 'reason']) {
      assert.equal(
        forbidden in empty.body.data,
        false,
        `${forbidden} must not be derived`,
      );
    }

    // READING IT CREATED NOTHING: no consumption was calculated and no
    // abnormality was evaluated by this contract.
    assert.deepEqual(await countDownstreamRows(fixture.meterId), downstreamBefore);

    // Persist the downstream facts through their OWN commands (BE-18G then a
    // BE-18J-shaped row), then prove the field surface only projects them.
    const previous = await api()
      .post(`/api/v1/utility/meters/${fixture.meterId}/readings`)
      .set(auth())
      .send({ readingValue: 1000, readingAt: fixture.insidePeriod(1) });
    assert.equal(previous.status, 201, JSON.stringify(previous.body));
    const consumption = await api()
      .post(`/api/v1/utility/meters/${fixture.meterId}/consumptions`)
      .set(auth())
      .send({
        currentReadingId: fixture.readingId,
        previousReadingId: previous.body.data.id as string,
      });
    assert.equal(consumption.status, 201, JSON.stringify(consumption.body));
    const consumptionId = consumption.body.data.id as string;
    const persisted = await q(
      `SELECT consumption_value, uom_id, period_start, period_end
         FROM utility_meter_consumptions WHERE id = $1`,
      [consumptionId],
    );
    const signalId = await insertRow('utility_abnormal_consumptions', {
      client_id: fixture.clientId,
      building_id: fixture.buildingId,
      meter_id: fixture.meterId,
      utility_type: 'ELECTRICITY',
      consumption_id: consumptionId,
      rule_id: null,
      abnormality_type: 'HIGH_USAGE',
      comparison_mode: 'ABSOLUTE',
      detected_value: persisted.rows[0]?.consumption_value,
      reference_value: 200,
      threshold_value: 100,
      uom_id: persisted.rows[0]?.uom_id,
      period_start: persisted.rows[0]?.period_start,
      period_end: persisted.rows[0]?.period_end,
      detected_by_user_id: adminUserId,
      status: 'OPEN',
      notes: 'Persisted downstream, projected read-only to the field.',
    });
    const downstreamAfterPersist = await countDownstreamRows(fixture.meterId);
    assert.deepEqual(downstreamAfterPersist, { consumptions: 1, abnormal: 1 });

    // One persisted signal comes back VERBATIM — persisted columns only.
    const projected = await api()
      .get(signalsUrl(fixture.readingDueId, fixture.readingId))
      .set(auth(workerToken));
    assert.equal(projected.status, 200, JSON.stringify(projected.body));
    const data = projected.body.data;
    assert.equal(data.consumptionId, consumptionId);
    assert.equal(data.evaluated, true);
    assert.equal(data.truncated, false);
    assert.equal(data.signals.length, 1);
    const signal = data.signals[0];
    assert.deepEqual(Object.keys(signal).sort(), ABNORMAL_SIGNAL_KEYS);
    assert.equal(signal.id, signalId);
    assert.equal(signal.consumptionId, consumptionId);
    assert.equal(signal.ruleId, null);
    assert.equal(signal.abnormalityType, 'HIGH_USAGE');
    assert.equal(signal.comparisonMode, 'ABSOLUTE');
    assert.equal(
      signal.detectedValue,
      Number(persisted.rows[0]?.consumption_value),
    );
    assert.equal(signal.referenceValue, 200);
    assert.equal(signal.thresholdValue, 100);
    assert.equal(signal.uomId, persisted.rows[0]?.uom_id);
    assert.equal(
      signal.periodStart,
      (persisted.rows[0]?.period_start as Date).toISOString(),
    );
    assert.equal(
      signal.periodEnd,
      (persisted.rows[0]?.period_end as Date).toISOString(),
    );
    assert.equal(signal.status, 'OPEN');
    assert.equal(signal.detectedByUserId, adminUserId);
    assert.equal(signal.findingId, null);
    assert.equal(signal.resolvedAt, null);
    // No management workflow is derived for a field actor.
    assert.equal('availableActions' in signal, false);
    assert.equal('availableActions' in data, false);

    // Reading the projection created nothing further.
    assert.deepEqual(await countDownstreamRows(fixture.meterId), downstreamAfterPersist);

    // The detail carries the identical projection.
    const detail = await api()
      .get(readingUrl(fixture.readingDueId, fixture.readingId))
      .set(auth(workerToken));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.deepEqual(detail.body.data.abnormalSignals, data);

    // The reading itself is still exactly what PART 01 recorded, and no
    // reading-level verdict was derived from the persisted signal.
    const row = await readReadingRow(fixture.readingId);
    assert.equal(Number(row?.reading_value), fixture.readingValue);
    for (const forbidden of ['isAbnormal', 'abnormalReason', 'requiresRecheck']) {
      assert.equal(
        forbidden in detail.body.data,
        false,
        `${forbidden} must not exist`,
      );
    }
  });

  it('G. a field actor of another reading is denied, their own is not, and a wrong execution identity is a 404', async (t) => {
    if (!requireDatabase(t)) return;
    const own = await createFieldReading({
      actorUserId: workerUserId,
      actorToken: workerToken,
    });
    const foreign = await createFieldReading({
      actorUserId: otherWorkerUserId,
      actorToken: otherWorkerToken,
      periodStart: '2027-06-01T00:00:00.000Z',
    });

    // `worker` holds Building access to its own Building only and is NOT the
    // assignee of the other execution's task.
    const deniedRoutes = [
      evidenceUrl(foreign.readingDueId, foreign.readingId),
      validationUrl(foreign.readingDueId, foreign.readingId),
      ocrUrl(foreign.readingDueId, foreign.readingId),
      signalsUrl(foreign.readingDueId, foreign.readingId),
    ];
    for (const url of deniedRoutes) {
      const denied = await api().get(url).set(auth(workerToken));
      assert.equal(denied.status, 403, `${url} → ${denied.status}`);
      assert.equal(
        denied.body.error.code,
        'UTILITY_READING_DUE_FIELD_UNAUTHORIZED',
        `${url} → ${JSON.stringify(denied.body)}`,
      );
    }

    // The WRITE doors refuse the same actor: an upload and a candidate decision
    // on somebody else's reading.
    const photo = await uploadFieldPhoto(
      foreign.readingDueId,
      foreign.readingId,
      otherWorkerToken,
    );
    assert.equal(photo.status, 201, JSON.stringify(photo.body));
    const candidateId = await stageCandidate(
      photo.body.data.id as string,
      foreign.readingValue,
    );
    const deniedUpload = await uploadFieldPhoto(
      foreign.readingDueId,
      foreign.readingId,
      workerToken,
    );
    assert.equal(deniedUpload.status, 403, JSON.stringify(deniedUpload.body));
    assert.equal(
      deniedUpload.body.error.code,
      'UTILITY_READING_DUE_FIELD_UNAUTHORIZED',
    );
    const deniedConfirm = await api()
      .post(
        ocrDecisionUrl(
          foreign.readingDueId,
          foreign.readingId,
          candidateId,
          'confirm',
        ),
      )
      .set(auth(workerToken))
      .send({});
    assert.equal(deniedConfirm.status, 403, JSON.stringify(deniedConfirm.body));
    assert.equal(
      deniedConfirm.body.error.code,
      'UTILITY_READING_DUE_FIELD_UNAUTHORIZED',
    );
    // The denial mutated nothing.
    const untouched = await q(
      `SELECT status, accepted_reading_id FROM utility_meter_ocr_candidates
        WHERE id = $1`,
      [candidateId],
    );
    assert.equal(untouched.rows[0]?.status, 'PENDING_REVIEW');
    assert.equal(untouched.rows[0]?.accepted_reading_id, null);
    assert.equal(await countEvidenceRows(foreign.readingId), 1);

    // The assigned actor reads its own reading through the same routes.
    const allowed = await api()
      .get(evidenceUrl(foreign.readingDueId, foreign.readingId))
      .set(auth(otherWorkerToken));
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.data.length, 1);
    const allowedSignals = await api()
      .get(signalsUrl(foreign.readingDueId, foreign.readingId))
      .set(auth(otherWorkerToken));
    assert.equal(allowedSignals.status, 200, JSON.stringify(allowedSignals.body));
    assert.deepEqual(allowedSignals.body.data.signals, []);

    // A wrong execution identity in the path is a 404 even for a reading the
    // actor IS authorized for: the due addressed must be the due that produced
    // the reading.
    const wrongDue = await api()
      .get(evidenceUrl(foreign.readingDueId, own.readingId))
      .set(auth(workerToken));
    assert.equal(wrongDue.status, 404, JSON.stringify(wrongDue.body));
    assert.equal(
      wrongDue.body.error.code,
      'UTILITY_METER_READING_NOT_FOUND',
      JSON.stringify(wrongDue.body),
    );

    // And the authorized actor's own surface still works.
    const ownEvidence = await api()
      .get(evidenceUrl(own.readingDueId, own.readingId))
      .set(auth(workerToken));
    assert.equal(ownEvidence.status, 200, JSON.stringify(ownEvidence.body));
    assert.deepEqual(ownEvidence.body.data, []);
    assert.equal(await countReadings(own.meterId), 1);
    assert.equal(await countReadings(foreign.meterId), 1);
  });
});
