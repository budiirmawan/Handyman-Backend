import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-18F — Reading Evidence focused validation.
 *
 * Covers only this PART: binding BE-07 evidence to an existing BE-18E Meter
 * Reading, getting / listing Reading Evidence, validating required evidence,
 * and soft-removing where BE-07 rules allow — plus the guard rails: invalid
 * Meter Reading, invalid evidence requirement, evidence type mismatch,
 * Building mismatch, evidence count rules, RBAC and Client / Building
 * isolation.
 *
 * No separate utility evidence engine exists: every assertion below is
 * against the shared BE-07 `evidence_requirements` / `evidence_submissions`
 * tables. Consumption (BE-18G) is deliberately not exercised.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE evidence_submissions, evidence_requirements,
       utility_meter_readings, utility_meter_tenant_assignments,
       utility_meter_hierarchies, utility_type_uoms,
       utility_type_configurations, utility_meters, units_of_measure,
       tenant_space_relationships, tenant_pics, tenant_companies,
       functional_locations, spaces, rooms, areas, floors,
       user_building_assignments, buildings, properties, users, roles,
       permissions, role_permission_assignments, user_role_assignments,
       clients CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

async function createUom(clientId: string) {
  const created = await api()
    .post(`/api/v1/clients/${clientId}/uoms`)
    .set(auth())
    .send({
      code: `UOM_${suffix()}`,
      name: 'Measurement unit',
      symbol: 'kWh',
      category: 'ENERGY',
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data.id as string;
}

/** Client → Property → Building → Floor → Area → Room → Space (BE-04 chain). */
async function createStructure(options: { assignUserId?: string | null } = {}) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Utility Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Utility Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Utility Building',
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
    name: 'Retail area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `RM_${suffix()}`,
    name: 'Unit room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `SP_${suffix()}`,
    name: 'Tenant unit',
  });

  const assignUserId =
    options.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  const uomId = await createUom(client.id);
  return { client, property, building, floor, area, room, space, uomId };
}

type Fixture = Awaited<ReturnType<typeof createStructure>>;

/** BE-18A Meter — BE-18F never creates meters, it only reads through them. */
async function createMeter(fixture: Fixture) {
  const created = await api()
    .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
    .set(auth())
    .send({
      code: `MTR_${suffix()}`,
      name: 'Utility meter',
      utilityType: 'ELECTRICITY',
      uomId: fixture.uomId,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data as { id: string };
}

/** BE-18E Meter Reading — the subject BE-18F binds evidence to. */
async function createReading(meterId: string, readingAt: string) {
  const created = await api()
    .post(`/api/v1/utility/meters/${meterId}/readings`)
    .set(auth())
    .send({ readingValue: 100, readingAt });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data as { id: string; buildingId: string };
}

/** A Building, a Meter, and one Reading ready to carry evidence. */
async function readingScenario(readingAt = '2026-03-01T08:00:00.000Z') {
  const fixture = await createStructure();
  const meter = await createMeter(fixture);
  const reading = await createReading(meter.id, readingAt);
  return { fixture, meter, reading };
}

/**
 * Creates an ACTIVE BE-07 evidence requirement targeting a Meter Reading.
 * Written straight to the shared BE-07 table — proof that BE-18F reuses the
 * engine rather than owning a utility-specific one.
 */
async function createRequirement(
  meterReadingId: string,
  clientId: string,
  evidenceType: string,
  opts: {
    minimumCount?: number;
    maximumCount?: number | null;
    required?: boolean;
  } = {},
): Promise<string> {
  const result = await pool!.query<{ id: string }>(
    `INSERT INTO evidence_requirements
       (id, client_id, target_type, target_id, evidence_type, required,
        minimum_count, maximum_count, description, status)
     VALUES ($1, $2, 'UTILITY_METER_READING', $3, $4, $5, $6, $7, $8, 'ACTIVE')
     RETURNING id`,
    [
      randomUUID(),
      clientId,
      meterReadingId,
      evidenceType,
      opts.required ?? true,
      opts.minimumCount ?? 1,
      opts.maximumCount === undefined ? null : opts.maximumCount,
      `Require ${evidenceType} evidence`,
    ],
  );
  return result.rows[0].id;
}

function submitVia(
  meterReadingId: string,
  body: object,
  token = adminToken,
) {
  return api()
    .post(`/api/v1/utility/meter-readings/${meterReadingId}/evidence`)
    .set(auth(token))
    .send(body);
}

/** `fileReference` is a storage pointer — no binary ever enters PostgreSQL. */
const PHOTO_BODY = {
  evidenceType: 'PHOTO',
  fileReference: 'object-storage://utility/readings/meter-1.jpg',
  originalFileName: 'meter-1.jpg',
  mimeType: 'image/jpeg',
  fileSize: 2048,
};

describe('BE-18F reading evidence — valid reading evidence', () => {
  it('resolves the BE-07 requirements bound to a meter reading', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, reading } = await readingScenario();
    await createRequirement(reading.id, fixture.client.id, 'PHOTO');

    const response = await api()
      .get(
        `/api/v1/utility/meter-readings/${reading.id}/evidence-requirements`,
      )
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].meterReadingId, reading.id);
    assert.equal(response.body.data[0].evidenceType, 'PHOTO');
  });

  it('binds evidence to a meter reading against a requirement', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, reading } = await readingScenario();
    const requirementId = await createRequirement(
      reading.id,
      fixture.client.id,
      'PHOTO',
    );

    const response = await submitVia(reading.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: requirementId,
      capturedAt: '2026-03-01T08:05:00.000Z',
    });

    assert.equal(response.status, 201, JSON.stringify(response.body));
    const evidence = response.body.data;
    assert.equal(evidence.meterReadingId, reading.id);
    assert.equal(evidence.evidenceRequirementId, requirementId);
    assert.equal(evidence.evidenceType, 'PHOTO');
    assert.equal(evidence.status, 'ACTIVE');
    assert.equal(evidence.submittedByUserId, adminUserId);
    assert.equal(evidence.capturedAt, '2026-03-01T08:05:00.000Z');
    // Client is derived from the reading, never supplied by the caller.
    assert.equal(evidence.clientId, fixture.client.id);
    // The storage pointer is preserved verbatim.
    assert.equal(evidence.fileReference, PHOTO_BODY.fileReference);
  });

  it('accepts evidence with no requirement (ad-hoc attachment)', async (t) => {
    if (!requireDatabase(t)) return;
    const { reading } = await readingScenario();

    const response = await submitVia(reading.id, PHOTO_BODY);

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.evidenceRequirementId, null);
  });

  it('stores the submission in the shared BE-07 table, not a utility table', async (t) => {
    if (!requireDatabase(t)) return;
    const { reading } = await readingScenario();
    const created = await submitVia(reading.id, PHOTO_BODY);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const row = await pool!.query(
      `SELECT execution_type, execution_id FROM evidence_submissions
       WHERE id = $1`,
      [created.body.data.id],
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].execution_type, 'UTILITY_METER_READING');
    assert.equal(row.rows[0].execution_id, reading.id);

    // And no bespoke utility evidence table was introduced.
    const tables = await pool!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE '%reading_evidence%'`,
    );
    assert.equal(tables.rowCount, 0);
  });

  it('gets and lists reading evidence', async (t) => {
    if (!requireDatabase(t)) return;
    const { reading } = await readingScenario();
    const created = await submitVia(reading.id, PHOTO_BODY);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const fetched = await api()
      .get(`/api/v1/utility/meter-reading-evidence/${created.body.data.id}`)
      .set(auth());
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.id, created.body.data.id);

    const listed = await api()
      .get(`/api/v1/utility/meter-readings/${reading.id}/evidence`)
      .set(auth());
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 1);
    assert.equal(listed.body.data[0].meterReadingId, reading.id);
  });

  it('lists evidence filtered by meter and by building', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, reading } = await readingScenario();
    await submitVia(reading.id, PHOTO_BODY);

    const byMeter = await api()
      .get('/api/v1/utility/meter-reading-evidence')
      .query({ meterId: meter.id })
      .set(auth());
    assert.equal(byMeter.status, 200, JSON.stringify(byMeter.body));
    assert.equal(byMeter.body.data.length, 1);

    const byBuilding = await api()
      .get('/api/v1/utility/meter-reading-evidence')
      .query({ buildingId: fixture.building.id })
      .set(auth());
    assert.equal(byBuilding.status, 200, JSON.stringify(byBuilding.body));
    assert.equal(byBuilding.body.data.length, 1);
  });

  it('requires at least one list filter', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get('/api/v1/utility/meter-reading-evidence')
      .set(auth());

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-18F reading evidence — invalid meter reading rejected', () => {
  it('rejects an unknown meter reading', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await submitVia(randomUUID(), PHOTO_BODY);

    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_METER_READING_NOT_FOUND');
  });

  it('rejects a malformed meter reading id', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await submitVia('not-a-uuid', PHOTO_BODY);

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 for unknown evidence', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/utility/meter-reading-evidence/${randomUUID()}`)
      .set(auth());

    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_READING_EVIDENCE_NOT_FOUND',
    );
  });
});

describe('BE-18F reading evidence — invalid evidence requirement rejected', () => {
  it('rejects an unknown requirement', async (t) => {
    if (!requireDatabase(t)) return;
    const { reading } = await readingScenario();

    const response = await submitVia(reading.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: randomUUID(),
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_READING_EVIDENCE_REQUIREMENT_MISMATCH',
    );
  });

  it("rejects a requirement belonging to another reading", async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, reading } = await readingScenario();
    const otherReading = await createReading(
      meter.id,
      '2026-03-02T08:00:00.000Z',
    );
    const foreignRequirementId = await createRequirement(
      otherReading.id,
      fixture.client.id,
      'PHOTO',
    );

    const response = await submitVia(reading.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: foreignRequirementId,
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_READING_EVIDENCE_REQUIREMENT_MISMATCH',
    );
  });

  it('rejects an INACTIVE requirement', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, reading } = await readingScenario();
    const requirementId = await createRequirement(
      reading.id,
      fixture.client.id,
      'PHOTO',
    );
    await pool!.query(
      `UPDATE evidence_requirements SET status = 'INACTIVE' WHERE id = $1`,
      [requirementId],
    );

    const response = await submitVia(reading.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: requirementId,
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_READING_EVIDENCE_REQUIREMENT_MISMATCH',
    );
  });

  it('rejects a malformed requirement id', async (t) => {
    if (!requireDatabase(t)) return;
    const { reading } = await readingScenario();

    const response = await submitVia(reading.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: 'nope',
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-18F reading evidence — evidence type mismatch rejected', () => {
  it('rejects evidence whose type differs from the requirement', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, reading } = await readingScenario();
    const documentRequirementId = await createRequirement(
      reading.id,
      fixture.client.id,
      'DOCUMENT',
    );

    const response = await submitVia(reading.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: documentRequirementId,
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_READING_EVIDENCE_REQUIREMENT_MISMATCH',
    );
  });

  it('rejects an unsupported evidence type', async (t) => {
    if (!requireDatabase(t)) return;
    const { reading } = await readingScenario();

    const response = await submitVia(reading.id, {
      ...PHOTO_BODY,
      evidenceType: 'VIDEO',
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a MIME type that does not match the evidence type', async (t) => {
    if (!requireDatabase(t)) return;
    const { reading } = await readingScenario();

    const response = await submitVia(reading.id, {
      ...PHOTO_BODY,
      mimeType: 'application/pdf', // valid for DOCUMENT, not for PHOTO
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_READING_EVIDENCE_REQUIREMENT_MISMATCH',
    );
  });

  it('rejects a file exceeding the BE-07 size ceiling', async (t) => {
    if (!requireDatabase(t)) return;
    const { reading } = await readingScenario();

    const response = await submitVia(reading.id, {
      ...PHOTO_BODY,
      fileSize: 52_428_801,
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-18F reading evidence — building mismatch rejected', () => {
  it("rejects a requirement raised under another client", async (t) => {
    if (!requireDatabase(t)) return;
    const { reading } = await readingScenario();
    const other = await createStructure();
    // A requirement targeting this reading but owned by a different Client.
    const foreignRequirementId = await createRequirement(
      reading.id,
      other.client.id,
      'PHOTO',
    );

    const response = await submitVia(reading.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: foreignRequirementId,
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_READING_EVIDENCE_BUILDING_MISMATCH',
    );
  });

  it('rejects a meter and building filter combination that contradict', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, reading } = await readingScenario();
    await submitVia(reading.id, PHOTO_BODY);
    const other = await createStructure();

    const response = await api()
      .get('/api/v1/utility/meter-reading-evidence')
      .query({ meterId: meter.id, buildingId: other.building.id })
      .set(auth());

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_READING_EVIDENCE_BUILDING_MISMATCH',
    );
  });

  it('never returns evidence from another building', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, reading } = await readingScenario();
    await submitVia(reading.id, PHOTO_BODY);

    // A second building with its own reading and evidence.
    const otherFixture = await createStructure();
    const otherMeter = await createMeter(otherFixture);
    const otherReading = await createReading(
      otherMeter.id,
      '2026-03-03T08:00:00.000Z',
    );
    await submitVia(otherReading.id, PHOTO_BODY);

    const response = await api()
      .get('/api/v1/utility/meter-reading-evidence')
      .query({ buildingId: fixture.building.id })
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].meterReadingId, reading.id);
  });
});

describe('BE-18F reading evidence — count and rule validation', () => {
  it('rejects a submission exceeding the requirement maximum', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, reading } = await readingScenario();
    const requirementId = await createRequirement(
      reading.id,
      fixture.client.id,
      'PHOTO',
      { minimumCount: 1, maximumCount: 1 },
    );

    const first = await submitVia(reading.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: requirementId,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await submitVia(reading.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: requirementId,
    });
    assert.equal(second.status, 400, JSON.stringify(second.body));
    assert.equal(
      second.body.error.code,
      'UTILITY_METER_READING_EVIDENCE_COUNT_VIOLATION',
    );
  });

  it('reports missing required evidence, then readiness once satisfied', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, reading } = await readingScenario();
    const requirementId = await createRequirement(
      reading.id,
      fixture.client.id,
      'PHOTO',
      { minimumCount: 2 },
    );

    const before = await api()
      .get(`/api/v1/utility/meter-readings/${reading.id}/evidence-validation`)
      .set(auth());
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.data.ready, false);
    assert.deepEqual(before.body.data.missingEvidenceTypes, ['PHOTO']);
    assert.equal(before.body.data.requirements[0].activeCount, 0);

    await submitVia(reading.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: requirementId,
    });

    const partial = await api()
      .get(`/api/v1/utility/meter-readings/${reading.id}/evidence-validation`)
      .set(auth());
    // One of two is still not enough.
    assert.equal(partial.body.data.ready, false);
    assert.equal(partial.body.data.requirements[0].activeCount, 1);

    await submitVia(reading.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: requirementId,
    });

    const after = await api()
      .get(`/api/v1/utility/meter-readings/${reading.id}/evidence-validation`)
      .set(auth());
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.equal(after.body.data.ready, true);
    assert.deepEqual(after.body.data.missingEvidenceTypes, []);
    assert.equal(after.body.data.requirements[0].activeCount, 2);
  });

  it('treats an optional requirement as never blocking', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, reading } = await readingScenario();
    await createRequirement(reading.id, fixture.client.id, 'DOCUMENT', {
      minimumCount: 1,
      required: false,
    });

    const response = await api()
      .get(`/api/v1/utility/meter-readings/${reading.id}/evidence-validation`)
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.ready, true);
    assert.equal(response.body.data.requirements[0].satisfied, true);
  });

  it('reports a reading with no requirements as ready', async (t) => {
    if (!requireDatabase(t)) return;
    const { reading } = await readingScenario();

    const response = await api()
      .get(`/api/v1/utility/meter-readings/${reading.id}/evidence-validation`)
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.ready, true);
    assert.deepEqual(response.body.data.requirements, []);
  });
});

describe('BE-18F reading evidence — removal preserves history', () => {
  it('soft-removes evidence and keeps it in the history', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, reading } = await readingScenario();
    const requirementId = await createRequirement(
      reading.id,
      fixture.client.id,
      'PHOTO',
    );
    const created = await submitVia(reading.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: requirementId,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const evidenceId = created.body.data.id;

    const removed = await api()
      .patch(`/api/v1/utility/meter-reading-evidence/${evidenceId}`)
      .set(auth())
      .send({});
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.data.status, 'REMOVED');

    // Gone from the active set...
    const active = await api()
      .get(`/api/v1/utility/meter-readings/${reading.id}/evidence`)
      .set(auth());
    assert.equal(active.body.data.length, 0);

    // ...but the row is preserved, not deleted.
    const history = await api()
      .get(`/api/v1/utility/meter-readings/${reading.id}/evidence`)
      .query({ includeRemoved: 'true' })
      .set(auth());
    assert.equal(history.body.data.length, 1);
    assert.equal(history.body.data[0].id, evidenceId);
    assert.equal(history.body.data[0].status, 'REMOVED');

    const row = await pool!.query(
      'SELECT status FROM evidence_submissions WHERE id = $1',
      [evidenceId],
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].status, 'REMOVED');
  });

  it('frees requirement capacity once evidence is removed', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, reading } = await readingScenario();
    const requirementId = await createRequirement(
      reading.id,
      fixture.client.id,
      'PHOTO',
      { minimumCount: 1, maximumCount: 1 },
    );

    const first = await submitVia(reading.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: requirementId,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    await api()
      .patch(`/api/v1/utility/meter-reading-evidence/${first.body.data.id}`)
      .set(auth())
      .send({});

    // A replacement now fits, because only ACTIVE rows count.
    const replacement = await submitVia(reading.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: requirementId,
    });
    assert.equal(replacement.status, 201, JSON.stringify(replacement.body));
  });

  it('returns 404 when removing unknown evidence', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .patch(`/api/v1/utility/meter-reading-evidence/${randomUUID()}`)
      .set(auth())
      .send({});

    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_READING_EVIDENCE_NOT_FOUND',
    );
  });

  it('leaves the BE-18E reading itself untouched', async (t) => {
    if (!requireDatabase(t)) return;
    const { reading } = await readingScenario();
    const created = await submitVia(reading.id, PHOTO_BODY);
    await api()
      .patch(`/api/v1/utility/meter-reading-evidence/${created.body.data.id}`)
      .set(auth())
      .send({});

    // Evidence comes and goes; the measurement is append-only and unaffected.
    const fetched = await api()
      .get(`/api/v1/utility/meter-readings/${reading.id}`)
      .set(auth());
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.readingValue, 100);
  });
});

describe('BE-18F reading evidence — client and building isolation', () => {
  it('denies evidence on a building the user is not assigned to', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, reading } = await readingScenario();
    const created = await submitVia(reading.id, PHOTO_BODY);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // A second administrator with full RBAC but no assignment to this Building.
    const outsider = await createAdminUser();

    const submitted = await submitVia(reading.id, PHOTO_BODY, outsider.token);
    assert.equal(submitted.status, 403, JSON.stringify(submitted.body));
    assert.equal(submitted.body.error.code, 'BUILDING_ACCESS_DENIED');

    const fetched = await api()
      .get(`/api/v1/utility/meter-reading-evidence/${created.body.data.id}`)
      .set(auth(outsider.token));
    assert.equal(fetched.status, 403, JSON.stringify(fetched.body));

    const listed = await api()
      .get(`/api/v1/utility/meter-readings/${reading.id}/evidence`)
      .set(auth(outsider.token));
    assert.equal(listed.status, 403, JSON.stringify(listed.body));

    const requirements = await api()
      .get(
        `/api/v1/utility/meter-readings/${reading.id}/evidence-requirements`,
      )
      .set(auth(outsider.token));
    assert.equal(requirements.status, 403, JSON.stringify(requirements.body));

    const validation = await api()
      .get(`/api/v1/utility/meter-readings/${reading.id}/evidence-validation`)
      .set(auth(outsider.token));
    assert.equal(validation.status, 403, JSON.stringify(validation.body));

    const byMeter = await api()
      .get('/api/v1/utility/meter-reading-evidence')
      .query({ meterId: meter.id })
      .set(auth(outsider.token));
    assert.equal(byMeter.status, 403, JSON.stringify(byMeter.body));

    const byBuilding = await api()
      .get('/api/v1/utility/meter-reading-evidence')
      .query({ buildingId: fixture.building.id })
      .set(auth(outsider.token));
    assert.equal(byBuilding.status, 403, JSON.stringify(byBuilding.body));

    const removed = await api()
      .patch(`/api/v1/utility/meter-reading-evidence/${created.body.data.id}`)
      .set(auth(outsider.token))
      .send({});
    assert.equal(removed.status, 403, JSON.stringify(removed.body));
  });
});

describe('BE-18F reading evidence — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) return;
    const { reading } = await readingScenario();

    const submitted = await api()
      .post(`/api/v1/utility/meter-readings/${reading.id}/evidence`)
      .send(PHOTO_BODY);
    assert.equal(submitted.status, 401, JSON.stringify(submitted.body));

    const listed = await api().get(
      `/api/v1/utility/meter-readings/${reading.id}/evidence`,
    );
    assert.equal(listed.status, 401, JSON.stringify(listed.body));
  });

  it('denies a user without utility_meter permissions (default-deny)', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, reading } = await readingScenario();
    const plainToken = await createPlainSession();

    const submitted = await submitVia(reading.id, PHOTO_BODY, plainToken);
    assert.equal(submitted.status, 403, JSON.stringify(submitted.body));

    const listed = await api()
      .get(`/api/v1/utility/meter-readings/${reading.id}/evidence`)
      .set(auth(plainToken));
    assert.equal(listed.status, 403);

    const requirements = await api()
      .get(
        `/api/v1/utility/meter-readings/${reading.id}/evidence-requirements`,
      )
      .set(auth(plainToken));
    assert.equal(requirements.status, 403);

    const validation = await api()
      .get(`/api/v1/utility/meter-readings/${reading.id}/evidence-validation`)
      .set(auth(plainToken));
    assert.equal(validation.status, 403);

    const byBuilding = await api()
      .get('/api/v1/utility/meter-reading-evidence')
      .query({ buildingId: fixture.building.id })
      .set(auth(plainToken));
    assert.equal(byBuilding.status, 403);

    const removed = await api()
      .patch(`/api/v1/utility/meter-reading-evidence/${randomUUID()}`)
      .set(auth(plainToken))
      .send({});
    assert.equal(removed.status, 403);
  });
});
