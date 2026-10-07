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
 * BE-18K — Utility Verification focused validation.
 *
 * Covers only this PART: verifying a BE-18J abnormal consumption through the
 * shared BE-07 review primitive — APPROVED, REJECTED and REWORK_REQUIRED
 * decisions, invalid / non-reviewable context, unauthorized reviewer, the
 * protection of a final decision, Building / Tenant mismatch, RBAC, and
 * Client / Building isolation.
 *
 * Tenant Approval Binding (BE-18L) is deliberately never exercised.
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
    `TRUNCATE reviews, utility_abnormal_consumptions, utility_abnormality_rules,
       utility_calculations, utility_calculation_bases,
       utility_meter_consumptions, evidence_submissions,
       evidence_requirements, utility_meter_readings,
       utility_meter_tenant_assignments, utility_meter_hierarchies,
       utility_type_uoms, utility_type_configurations, utility_meters,
       units_of_measure, finding_assignments, finding_rework_cycles,
       findings, finding_classifications, finding_severities,
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

async function createUom(clientId: string, symbol = 'kWh') {
  const created = await api()
    .post(`/api/v1/clients/${clientId}/uoms`)
    .set(auth())
    .send({
      code: `UOM_${suffix()}`,
      name: 'Measurement unit',
      symbol,
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

async function createReading(
  meterId: string,
  readingValue: number,
  readingAt: string,
) {
  const created = await api()
    .post(`/api/v1/utility/meters/${meterId}/readings`)
    .set(auth())
    .send({ readingValue, readingAt });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data as { id: string };
}

async function calculateConsumption(meterId: string, currentReadingId: string) {
  const created = await api()
    .post(`/api/v1/utility/meters/${meterId}/consumptions`)
    .set(auth())
    .send({ currentReadingId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data as { id: string; consumptionValue: number };
}

async function createSeries(meterId: string, deltas: readonly number[]) {
  let running = 0;
  let month = 0;
  const iso = (m: number) => new Date(Date.UTC(2026, m, 1)).toISOString();

  await createReading(meterId, running, iso(month));
  const consumptions: { id: string; consumptionValue: number }[] = [];

  for (const delta of deltas) {
    running += delta;
    month += 1;
    const reading = await createReading(meterId, running, iso(month));
    consumptions.push(await calculateConsumption(meterId, reading.id));
  }
  return consumptions;
}

/**
 * Produces one OPEN BE-18J abnormality on a fresh meter — the reviewable
 * utility context every verification test starts from.
 */
async function createAbnormality(fixture: Fixture) {
  const meter = await createMeter(fixture);
  const [consumption] = await createSeries(meter.id, [900]);

  const rule = await api()
    .post(`/api/v1/clients/${fixture.client.id}/utility-abnormality-rules`)
    .set(auth())
    .send({
      utilityType: 'ELECTRICITY',
      abnormalityType: 'HIGH_USAGE',
      name: 'High usage rule',
      thresholdValue: 500,
      comparisonMode: 'ABSOLUTE',
    });
  assert.equal(rule.status, 201, JSON.stringify(rule.body));

  const detected = await api()
    .post(`/api/v1/utility/consumptions/${consumption.id}/abnormality-evaluations`)
    .set(auth())
    .send({});
  assert.equal(detected.status, 201, JSON.stringify(detected.body));

  return {
    meter,
    consumption,
    abnormalityId: detected.body.data.detections[0].id as string,
  };
}

const verificationUrl = (id: string) =>
  `/api/v1/utility/abnormal-consumptions/${id}/verification`;

async function openVerification(
  abnormalityId: string,
  body: object = {},
  token = adminToken,
) {
  return api()
    .post(`${verificationUrl(abnormalityId)}/open`)
    .set(auth(token))
    .send(body);
}

async function submitVerification(
  abnormalityId: string,
  body: object,
  token = adminToken,
) {
  return api().post(verificationUrl(abnormalityId)).set(auth(token)).send(body);
}

describe('BE-18K utility verification — approved decision', () => {
  it('records an APPROVED verification against the shared review primitive', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId, meter, consumption } =
      await createAbnormality(fixture);

    const opened = await openVerification(abnormalityId, {
      notes: 'Assigned for review.',
    });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.data.currentReview.status, 'PENDING');
    assert.equal(opened.body.data.currentReview.reviewerUserId, adminUserId);
    assert.equal(opened.body.data.currentReview.decision, null);
    assert.equal(opened.body.data.currentReview.verifiedAt, null);
    // Backend-authoritative, never derived by the client.
    assert.deepEqual(opened.body.data.availableActions, ['SUBMIT_DECISION']);

    const response = await submitVerification(abnormalityId, {
      decision: 'APPROVED',
      notes: 'Reading confirmed against the site log.',
    });

    assert.equal(response.status, 201, JSON.stringify(response.body));
    const latest = response.body.data.latestVerification;
    assert.equal(latest.decision, 'APPROVED');
    assert.equal(latest.status, 'COMPLETED');
    assert.equal(latest.reviewerUserId, adminUserId);
    assert.equal(latest.notes, 'Reading confirmed against the site log.');
    assert.ok(latest.verifiedAt, 'verifiedAt must be stamped on completion');
    assert.equal(latest.abnormalConsumptionId, abnormalityId);
    assert.equal(response.body.data.currentReview, null);

    // The reviewable utility context is resolved, not copied.
    assert.equal(response.body.data.meterId, meter.id);
    assert.equal(response.body.data.consumptionId, consumption.id);
    assert.equal(response.body.data.buildingId, fixture.building.id);
    assert.equal(response.body.data.clientId, fixture.client.id);
    assert.equal(response.body.data.abnormalityType, 'HIGH_USAGE');
    assert.equal(response.body.data.detectedValue, 900);

    // BE-18K judges; it never edits the detection behind it.
    const detection = await api()
      .get(`/api/v1/utility/abnormal-consumptions/${abnormalityId}`)
      .set(auth());
    assert.equal(detection.body.data.status, 'OPEN');
  });

  it('stores the decision on the BE-07 reviews table, not a new one', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);

    await openVerification(abnormalityId);
    await submitVerification(abnormalityId, { decision: 'APPROVED' });

    const rows = await pool!.query(
      `SELECT target_type, target_id, decision, status, reviewed_at, client_id
       FROM reviews WHERE target_id = $1`,
      [abnormalityId],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].target_type, 'UTILITY_ABNORMAL_CONSUMPTION');
    assert.equal(rows.rows[0].decision, 'APPROVED');
    assert.equal(rows.rows[0].status, 'COMPLETED');
    assert.equal(rows.rows[0].client_id, fixture.client.id);
    assert.ok(rows.rows[0].reviewed_at);
  });
});

describe('BE-18K utility verification — rejected decision', () => {
  it('records a REJECTED verification and leaves the detection untouched', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);

    await openVerification(abnormalityId);
    const response = await submitVerification(abnormalityId, {
      decision: 'REJECTED',
      notes: 'Meter was mis-read; figure is not credible.',
    });

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.latestVerification.decision, 'REJECTED');
    assert.equal(response.body.data.latestVerification.status, 'COMPLETED');
    assert.ok(response.body.data.latestVerification.verifiedAt);

    const detection = await api()
      .get(`/api/v1/utility/abnormal-consumptions/${abnormalityId}`)
      .set(auth());
    assert.equal(detection.body.data.status, 'OPEN');
    assert.equal(detection.body.data.detectedValue, 900);
  });
});

describe('BE-18K utility verification — rework required decision', () => {
  it('records REWORK_REQUIRED and allows a fresh review afterwards', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);

    await openVerification(abnormalityId);
    const rework = await submitVerification(abnormalityId, {
      decision: 'REWORK_REQUIRED',
      notes: 'Re-read the meter and resubmit.',
    });

    assert.equal(rework.status, 201, JSON.stringify(rework.body));
    assert.equal(
      rework.body.data.latestVerification.decision,
      'REWORK_REQUIRED',
    );
    // Rework is not a terminal verdict: the context stays open for review.
    assert.deepEqual(rework.body.data.availableActions, ['OPEN_REVIEW']);

    const reopened = await openVerification(abnormalityId);
    assert.equal(reopened.status, 201, JSON.stringify(reopened.body));
    const approved = await submitVerification(abnormalityId, {
      decision: 'APPROVED',
    });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));

    // Both verdicts survive; the first is not overwritten by the second.
    assert.equal(approved.body.data.verifications.length, 2);
    assert.deepEqual(
      approved.body.data.verifications.map(
        (v: { decision: string }) => v.decision,
      ),
      ['REWORK_REQUIRED', 'APPROVED'],
    );
    assert.equal(approved.body.data.latestVerification.decision, 'APPROVED');
  });

  it('rejects an unknown decision value', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);
    await openVerification(abnormalityId);

    const response = await submitVerification(abnormalityId, {
      decision: 'MAYBE',
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-18K utility verification — invalid or non-reviewable context', () => {
  it('rejects a verification against an unknown abnormal consumption', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await openVerification(randomUUID());

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_VERIFICATION_CONTEXT_INVALID',
    );
  });

  it('rejects verifying a closed abnormal consumption', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);

    const resolved = await api()
      .post(`/api/v1/utility/abnormal-consumptions/${abnormalityId}/resolve`)
      .set(auth())
      .send({ status: 'RESOLVED', resolutionNotes: 'Faulty meter replaced.' });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));

    const response = await openVerification(abnormalityId);

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_VERIFICATION_CONTEXT_INVALID',
    );

    // A closed context offers no verification actions at all.
    const context = await api()
      .get(verificationUrl(abnormalityId))
      .set(auth());
    assert.equal(context.status, 200, JSON.stringify(context.body));
    assert.equal(context.body.data.reviewable, false);
    assert.deepEqual(context.body.data.availableActions, []);
  });

  it('refuses a decision when no review is open', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);

    const response = await submitVerification(abnormalityId, {
      decision: 'APPROVED',
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_VERIFICATION_CONTEXT_INVALID',
    );
  });

  it('refuses to open a second concurrent review', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);

    await openVerification(abnormalityId);
    const response = await openVerification(abnormalityId);

    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_VERIFICATION_ALREADY_OPEN');
  });

  it('rejects a malformed target id', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get('/api/v1/utility/abnormal-consumptions/not-a-uuid/verification')
      .set(auth());

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-18K utility verification — unauthorized reviewer', () => {
  it('refuses a decision from someone other than the assigned reviewer', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);

    // A second reviewer, properly assigned to the same Building.
    const reviewer = await createAdminUser();
    await buildingAssignmentService.createAssignment(reviewer.userId, {
      buildingId: fixture.building.id,
    });

    const opened = await openVerification(abnormalityId, {
      reviewerUserId: reviewer.userId,
    });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.data.currentReview.reviewerUserId, reviewer.userId);

    // The opener is not the reviewer of record and may not decide.
    const response = await submitVerification(abnormalityId, {
      decision: 'APPROVED',
    });

    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_VERIFICATION_REVIEWER_MISMATCH',
    );

    // The reviewer of record still can.
    const allowed = await submitVerification(
      abnormalityId,
      { decision: 'APPROVED' },
      reviewer.token,
    );
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
    assert.equal(
      allowed.body.data.latestVerification.reviewerUserId,
      reviewer.userId,
    );
  });

  it('refuses to assign a reviewer without access to the Building', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);

    // Full RBAC, but no assignment to this Building.
    const outsider = await createAdminUser();

    const response = await openVerification(abnormalityId, {
      reviewerUserId: outsider.userId,
    });

    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');

    const rows = await pool!.query(
      'SELECT id FROM reviews WHERE target_id = $1',
      [abnormalityId],
    );
    assert.equal(rows.rowCount, 0);
  });
});

describe('BE-18K utility verification — final decision protected', () => {
  it('never silently overwrites a completed verification', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);

    await openVerification(abnormalityId);
    const first = await submitVerification(abnormalityId, {
      decision: 'APPROVED',
      notes: 'Confirmed.',
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const firstId = first.body.data.latestVerification.id;

    const second = await submitVerification(abnormalityId, {
      decision: 'REJECTED',
      notes: 'Changed my mind.',
    });

    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(
      second.body.error.code,
      'UTILITY_VERIFICATION_ALREADY_COMPLETED',
    );

    // The original verdict is intact, in place and in history.
    const latest = await api()
      .get(`${verificationUrl(abnormalityId)}/latest`)
      .set(auth());
    assert.equal(latest.status, 200, JSON.stringify(latest.body));
    assert.equal(latest.body.data.id, firstId);
    assert.equal(latest.body.data.decision, 'APPROVED');
    assert.equal(latest.body.data.notes, 'Confirmed.');

    const history = await api()
      .get(`/api/v1/utility/abnormal-consumptions/${abnormalityId}/verifications`)
      .set(auth());
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data.length, 1);
    assert.equal(history.body.meta.total, 1);
  });

  it('reports a null latest result before any decision is recorded', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);

    const latest = await api()
      .get(`${verificationUrl(abnormalityId)}/latest`)
      .set(auth());
    assert.equal(latest.status, 200, JSON.stringify(latest.body));
    assert.equal(latest.body.data, null);

    const history = await api()
      .get(`/api/v1/utility/abnormal-consumptions/${abnormalityId}/verifications`)
      .set(auth());
    assert.deepEqual(history.body.data, []);

    const context = await api().get(verificationUrl(abnormalityId)).set(auth());
    assert.equal(context.body.data.reviewable, true);
    assert.deepEqual(context.body.data.availableActions, ['OPEN_REVIEW']);
  });

  it('keeps a PENDING review from being completed twice concurrently', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);
    await openVerification(abnormalityId);

    const [a, b] = await Promise.all([
      submitVerification(abnormalityId, { decision: 'APPROVED' }),
      submitVerification(abnormalityId, { decision: 'REJECTED' }),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);

    const rows = await pool!.query(
      "SELECT id FROM reviews WHERE target_id = $1 AND status = 'COMPLETED'",
      [abnormalityId],
    );
    assert.equal(rows.rowCount, 1);
  });
});

describe('BE-18K utility verification — building and tenant mismatch', () => {
  it('rejects a context whose meter has moved to another building', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);
    const otherFixture = await createStructure();

    // Force the stored Building to disagree with the Meter's own Building.
    await pool!.query(
      'UPDATE utility_abnormal_consumptions SET building_id = $2 WHERE id = $1',
      [abnormalityId, otherFixture.building.id],
    );

    const response = await api()
      .get(verificationUrl(abnormalityId))
      .set(auth());

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_VERIFICATION_CONTEXT_MISMATCH',
    );
  });

  it('rejects a context whose tenant disagrees with its consumption', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);

    const tenant = await api()
      .post(`/api/v1/clients/${fixture.client.id}/tenant-companies`)
      .set(auth())
      .send({ tenantCode: `TEN_${suffix()}`, tenantName: 'Tenant Co' });
    assert.equal(tenant.status, 201, JSON.stringify(tenant.body));

    // The detection claims a Tenant its own consumption never had.
    await pool!.query(
      'UPDATE utility_abnormal_consumptions SET tenant_company_id = $2 WHERE id = $1',
      [abnormalityId, tenant.body.data.id],
    );

    const response = await openVerification(abnormalityId);

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_VERIFICATION_CONTEXT_MISMATCH',
    );
  });
});

describe('BE-18K utility verification — RBAC', () => {
  it('requires authentication on every verification endpoint', async (t) => {
    if (!requireDatabase(t)) return;
    const id = randomUUID();

    for (const response of [
      await api().get(verificationUrl(id)),
      await api().get(`${verificationUrl(id)}/latest`),
      await api().get(`/api/v1/utility/abnormal-consumptions/${id}/verifications`),
      await api().post(`${verificationUrl(id)}/open`).send({}),
      await api().post(verificationUrl(id)).send({ decision: 'APPROVED' }),
    ]) {
      assert.equal(response.status, 401, JSON.stringify(response.body));
    }
  });

  it('denies a session without the utility permissions', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);
    const plainToken = await createPlainSession();

    const read = await api()
      .get(verificationUrl(abnormalityId))
      .set(auth(plainToken));
    assert.equal(read.status, 403, JSON.stringify(read.body));

    const opened = await openVerification(abnormalityId, {}, plainToken);
    assert.equal(opened.status, 403, JSON.stringify(opened.body));

    const submitted = await submitVerification(
      abnormalityId,
      { decision: 'APPROVED' },
      plainToken,
    );
    assert.equal(submitted.status, 403, JSON.stringify(submitted.body));
  });
});

describe('BE-18K utility verification — client and building isolation', () => {
  it('denies reading and deciding across buildings', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const { abnormalityId } = await createAbnormality(fixture);
    await openVerification(abnormalityId);

    // A second administrator with full RBAC but no assignment to this Building.
    const outsider = await createAdminUser();

    const context = await api()
      .get(verificationUrl(abnormalityId))
      .set(auth(outsider.token));
    assert.equal(context.status, 403, JSON.stringify(context.body));
    assert.equal(context.body.error.code, 'BUILDING_ACCESS_DENIED');

    const latest = await api()
      .get(`${verificationUrl(abnormalityId)}/latest`)
      .set(auth(outsider.token));
    assert.equal(latest.status, 403, JSON.stringify(latest.body));

    const history = await api()
      .get(`/api/v1/utility/abnormal-consumptions/${abnormalityId}/verifications`)
      .set(auth(outsider.token));
    assert.equal(history.status, 403, JSON.stringify(history.body));

    const submitted = await submitVerification(
      abnormalityId,
      { decision: 'APPROVED' },
      outsider.token,
    );
    assert.equal(submitted.status, 403, JSON.stringify(submitted.body));
    assert.equal(submitted.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Nothing was recorded on the way out.
    const rows = await pool!.query(
      "SELECT id FROM reviews WHERE target_id = $1 AND status = 'COMPLETED'",
      [abnormalityId],
    );
    assert.equal(rows.rowCount, 0);
  });

  it('keeps verification history scoped to its own client', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const first = await createAbnormality(fixture);
    await openVerification(first.abnormalityId);
    await submitVerification(first.abnormalityId, { decision: 'APPROVED' });

    const otherFixture = await createStructure();
    const second = await createAbnormality(otherFixture);

    const history = await api()
      .get(
        `/api/v1/utility/abnormal-consumptions/${second.abnormalityId}/verifications`,
      )
      .set(auth());
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.deepEqual(history.body.data, []);

    const mine = await api()
      .get(
        `/api/v1/utility/abnormal-consumptions/${first.abnormalityId}/verifications`,
      )
      .set(auth());
    assert.equal(mine.body.data.length, 1);
    assert.equal(mine.body.data[0].clientId, fixture.client.id);
    assert.notEqual(mine.body.data[0].clientId, otherFixture.client.id);
  });
});
