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
 * BE-18J — Abnormal Consumption focused validation.
 *
 * Covers only this PART: detecting abnormalities from authoritative BE-18G
 * consumptions and the BE-18H history, against configurable rules — high
 * usage, sudden change, normal usage left alone, invalid consumption,
 * threshold validation, duplicate handling, BE-09 Finding reuse,
 * Tenant/Building context, RBAC, and Client / Building isolation.
 *
 * Verification (BE-18K), tariffs and billing are deliberately never
 * exercised. Nor is any generic anomaly behaviour: every rule under test is
 * one explicit comparison.
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
    `TRUNCATE utility_abnormal_consumptions, utility_abnormality_rules,
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

/**
 * Builds a meter whose consumption series is given by `deltas`, one month
 * apart starting Jan 2026. Returns the consumption records in order.
 */
async function createSeries(meterId: string, deltas: readonly number[]) {
  let running = 0;
  let month = 0;
  const iso = (m: number) =>
    new Date(Date.UTC(2026, m, 1)).toISOString();

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

async function createRule(
  clientId: string,
  overrides: Record<string, unknown> = {},
) {
  return api()
    .post(`/api/v1/clients/${clientId}/utility-abnormality-rules`)
    .set(auth())
    .send({
      utilityType: 'ELECTRICITY',
      abnormalityType: 'HIGH_USAGE',
      name: 'High usage rule',
      thresholdValue: 500,
      comparisonMode: 'ABSOLUTE',
      ...overrides,
    });
}

async function evaluate(consumptionId: string, body: unknown = {}) {
  return api()
    .post(`/api/v1/utility/consumptions/${consumptionId}/abnormality-evaluations`)
    .set(auth())
    .send(body as object);
}

const types = (body: { data: { detections: { abnormalityType: string }[] } }) =>
  body.data.detections.map((d) => d.abnormalityType);

describe('BE-18J abnormal consumption — high usage detected', () => {
  it('flags a consumption above an absolute threshold', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    const rule = await createRule(fixture.client.id, { thresholdValue: 500 });
    assert.equal(rule.status, 201, JSON.stringify(rule.body));

    const response = await evaluate(consumption.id);

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.normal, false);
    assert.deepEqual(types(response.body), ['HIGH_USAGE']);
    const detection = response.body.data.detections[0];
    assert.equal(detection.detectedValue, 900);
    assert.equal(detection.thresholdValue, 500);
    assert.equal(detection.referenceValue, 500);
    assert.equal(detection.status, 'OPEN');
    assert.equal(detection.consumptionId, consumption.id);
    assert.equal(detection.meterId, meter.id);
    assert.equal(detection.buildingId, fixture.building.id);
    assert.ok(detection.detectedAt);
    // Backend-authoritative, never derived by the client.
    assert.deepEqual(detection.availableActions, [
      'RESOLVE',
      'DISMISS',
      'LINK_FINDING',
    ]);
  });

  it('flags high usage measured as a percentage of the baseline', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    // Baseline of 100, then a 300 period — 300% of baseline.
    const series = await createSeries(meter.id, [100, 100, 100, 300]);
    await createRule(fixture.client.id, {
      thresholdValue: 200,
      comparisonMode: 'PERCENT_OF_BASELINE',
      baselineWindow: 3,
    });

    const response = await evaluate(series[3].id);

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.deepEqual(types(response.body), ['HIGH_USAGE']);
    assert.equal(response.body.data.baselineValue, 100);
    assert.equal(response.body.data.detections[0].referenceValue, 100);
  });

  it('detects zero usage on a live meter', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const series = await createSeries(meter.id, [100, 0]);
    await createRule(fixture.client.id, {
      abnormalityType: 'ZERO_USAGE',
      name: 'Zero usage rule',
      thresholdValue: null,
    });

    const normal = await evaluate(series[0].id);
    assert.equal(normal.body.data.normal, true);

    const flagged = await evaluate(series[1].id);
    assert.equal(flagged.status, 201, JSON.stringify(flagged.body));
    assert.deepEqual(types(flagged.body), ['ZERO_USAGE']);
    assert.equal(flagged.body.data.detections[0].detectedValue, 0);
  });

  it('flags low usage below an absolute threshold', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [5]);
    await createRule(fixture.client.id, {
      abnormalityType: 'LOW_USAGE',
      name: 'Low usage rule',
      thresholdValue: 50,
    });

    const response = await evaluate(consumption.id);

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.deepEqual(types(response.body), ['LOW_USAGE']);
  });

  it('raises several abnormality types at once', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const series = await createSeries(meter.id, [100, 0]);
    await createRule(fixture.client.id, {
      abnormalityType: 'ZERO_USAGE',
      name: 'Zero usage rule',
      thresholdValue: null,
    });
    await createRule(fixture.client.id, {
      abnormalityType: 'SUDDEN_CHANGE',
      name: 'Sudden change rule',
      thresholdValue: 50,
      baselineWindow: 3,
    });

    const response = await evaluate(series[1].id);

    assert.equal(response.status, 201, JSON.stringify(response.body));
    // A drop from 100 to 0 is both zero usage and a sudden change.
    assert.deepEqual(types(response.body).sort(), [
      'SUDDEN_CHANGE',
      'ZERO_USAGE',
    ]);
    assert.equal(response.body.data.rulesEvaluated, 2);
  });
});

describe('BE-18J abnormal consumption — sudden change detected', () => {
  it('flags a spike against the recent baseline', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    // Steady 100, then 400 — a 300% swing.
    const series = await createSeries(meter.id, [100, 100, 100, 400]);
    await createRule(fixture.client.id, {
      abnormalityType: 'SUDDEN_CHANGE',
      name: 'Sudden change rule',
      thresholdValue: 50,
      baselineWindow: 3,
    });

    const response = await evaluate(series[3].id);

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.deepEqual(types(response.body), ['SUDDEN_CHANGE']);
    assert.equal(response.body.data.baselineValue, 100);
    assert.equal(response.body.data.baselinePeriods, 3);
    assert.equal(response.body.data.detections[0].detectedValue, 400);
    assert.equal(response.body.data.detections[0].referenceValue, 100);
  });

  it('flags a sudden collapse as well as a spike', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    // Steady 200, then 20 — a 90% drop.
    const series = await createSeries(meter.id, [200, 200, 200, 20]);
    await createRule(fixture.client.id, {
      abnormalityType: 'SUDDEN_CHANGE',
      name: 'Sudden change rule',
      thresholdValue: 50,
      baselineWindow: 3,
    });

    const response = await evaluate(series[3].id);

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.deepEqual(types(response.body), ['SUDDEN_CHANGE']);
  });

  it('does not flag the first ever period as a sudden change', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [first] = await createSeries(meter.id, [5000]);
    await createRule(fixture.client.id, {
      abnormalityType: 'SUDDEN_CHANGE',
      name: 'Sudden change rule',
      thresholdValue: 50,
      baselineWindow: 3,
    });

    const response = await evaluate(first.id);

    // With no history there is nothing to have changed from.
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.normal, true);
    assert.equal(response.body.data.baselineValue, null);
    assert.equal(response.body.data.baselinePeriods, 0);
  });
});

describe('BE-18J abnormal consumption — normal usage not flagged', () => {
  it('leaves a consumption inside the threshold alone', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [100]);
    await createRule(fixture.client.id, { thresholdValue: 500 });

    const response = await evaluate(consumption.id);

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.normal, true);
    assert.deepEqual(response.body.data.detections, []);
    assert.equal(response.body.data.evaluatedValue, 100);
    assert.equal(response.body.data.rulesEvaluated, 1);

    const stored = await api()
      .get(`/api/v1/utility/consumptions/${consumption.id}/abnormal-consumptions`)
      .set(auth());
    assert.equal(stored.body.data.length, 0);
  });

  it('leaves a steady series alone under a sudden-change rule', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const series = await createSeries(meter.id, [100, 105, 98, 102]);
    await createRule(fixture.client.id, {
      abnormalityType: 'SUDDEN_CHANGE',
      name: 'Sudden change rule',
      thresholdValue: 50,
      baselineWindow: 3,
    });

    const response = await evaluate(series[3].id);

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.normal, true);
  });

  it('flags nothing when no rule is configured', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [99999]);

    const response = await evaluate(consumption.id);

    // Detection is opt-in: without configured rules nothing is abnormal.
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.normal, true);
    assert.equal(response.body.data.rulesEvaluated, 0);
  });

  it('ignores a rule for another utility type, and an inactive rule', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, {
      utilityType: 'WATER',
      name: 'Water high usage',
      thresholdValue: 10,
    });
    await createRule(fixture.client.id, {
      abnormalityType: 'LOW_USAGE',
      name: 'Retired rule',
      thresholdValue: 99999,
      status: 'INACTIVE',
    });

    const response = await evaluate(consumption.id);

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.normal, true);
    assert.equal(response.body.data.rulesEvaluated, 0);
  });

  it('never alters the source consumption or its readings', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 100 });

    const before = await pool!.query(
      `SELECT consumption_value, period_start, period_end, updated_at
       FROM utility_meter_consumptions WHERE id = $1`,
      [consumption.id],
    );
    const readingsBefore = await pool!.query(
      'SELECT id, reading_value, updated_at FROM utility_meter_readings WHERE meter_id = $1 ORDER BY id',
      [meter.id],
    );

    const flagged = await evaluate(consumption.id);
    assert.equal(flagged.status, 201, JSON.stringify(flagged.body));

    const after = await pool!.query(
      `SELECT consumption_value, period_start, period_end, updated_at
       FROM utility_meter_consumptions WHERE id = $1`,
      [consumption.id],
    );
    const readingsAfter = await pool!.query(
      'SELECT id, reading_value, updated_at FROM utility_meter_readings WHERE meter_id = $1 ORDER BY id',
      [meter.id],
    );

    // Detection observes; it must never correct the data it observed.
    assert.deepEqual(after.rows, before.rows);
    assert.deepEqual(readingsAfter.rows, readingsBefore.rows);
  });
});

describe('BE-18J abnormal consumption — invalid consumption rejected', () => {
  it('rejects an unknown consumption', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await evaluate(randomUUID());

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_ABNORMAL_CONSUMPTION_INVALID',
    );
  });

  it('rejects a malformed consumption id', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .post('/api/v1/utility/consumptions/not-a-uuid/abnormality-evaluations')
      .set(auth())
      .send({});

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a caller-supplied verdict', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [100]);

    for (const body of [
      { detectedValue: 1 },
      { abnormalityType: 'HIGH_USAGE' },
      { status: 'RESOLVED' },
    ]) {
      const response = await evaluate(consumption.id, body);
      assert.equal(
        response.status,
        400,
        `${JSON.stringify(body)} → ${JSON.stringify(response.body)}`,
      );
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('returns 404 for an unknown abnormality record', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/utility/abnormal-consumptions/${randomUUID()}`)
      .set(auth());

    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_ABNORMAL_CONSUMPTION_NOT_FOUND',
    );
  });
});

describe('BE-18J abnormal consumption — threshold validation', () => {
  it('creates and lists a configurable rule', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const created = await createRule(fixture.client.id, { thresholdValue: 750 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.thresholdValue, 750);
    assert.equal(created.body.data.comparisonMode, 'ABSOLUTE');
    assert.equal(created.body.data.baselineWindow, 3);
    assert.equal(created.body.data.status, 'ACTIVE');

    const listed = await api()
      .get(`/api/v1/clients/${fixture.client.id}/utility-abnormality-rules`)
      .set(auth());
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 1);
  });

  it('rejects a negative or non-numeric threshold', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    for (const thresholdValue of [-1, 'high']) {
      const response = await createRule(fixture.client.id, { thresholdValue });
      assert.equal(
        response.status,
        400,
        `${String(thresholdValue)} → ${JSON.stringify(response.body)}`,
      );
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('requires a threshold for rules that compare against one', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const response = await createRule(fixture.client.id, {
      abnormalityType: 'HIGH_USAGE',
      thresholdValue: null,
    });

    // Better to refuse at configuration time than never fire.
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_ABNORMALITY_THRESHOLD_INVALID',
    );
  });

  it('allows a structural rule to omit a threshold', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    for (const abnormalityType of ['ZERO_USAGE', 'NEGATIVE_OR_INVALID']) {
      const response = await createRule(fixture.client.id, {
        abnormalityType,
        name: `${abnormalityType} rule`,
        thresholdValue: null,
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.equal(response.body.data.thresholdValue, null);
    }
  });

  it('rejects a LOW_USAGE percentage threshold at or above 100%', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const response = await createRule(fixture.client.id, {
      abnormalityType: 'LOW_USAGE',
      name: 'Impossible low usage',
      thresholdValue: 100,
      comparisonMode: 'PERCENT_OF_BASELINE',
    });

    // Would flag every normal period.
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_ABNORMALITY_THRESHOLD_INVALID',
    );
  });

  it('rejects an unknown abnormality type, mode or baseline window', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    for (const overrides of [
      { abnormalityType: 'WEIRD_USAGE' },
      { comparisonMode: 'FUZZY' },
      { baselineWindow: 0 },
      { baselineWindow: 99 },
    ]) {
      const response = await createRule(fixture.client.id, overrides);
      assert.equal(
        response.status,
        400,
        `${JSON.stringify(overrides)} → ${JSON.stringify(response.body)}`,
      );
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('refuses a second rule for the same client, type and abnormality', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const first = await createRule(fixture.client.id);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await createRule(fixture.client.id, {
      name: 'Contradictory rule',
      thresholdValue: 10,
    });

    // Two contradictory thresholds for one check cannot both be right.
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(
      second.body.error.code,
      'UTILITY_ABNORMALITY_RULE_ALREADY_EXISTS',
    );
  });
});

describe('BE-18J abnormal consumption — duplicate detection handling', () => {
  it('does not raise a second open flag when re-evaluated', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });

    const first = await evaluate(consumption.id);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const detectionId = first.body.data.detections[0].id;

    const second = await evaluate(consumption.id);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    // The same record comes back, not a new one.
    assert.equal(second.body.data.detections.length, 1);
    assert.equal(second.body.data.detections[0].id, detectionId);

    const stored = await api()
      .get(`/api/v1/utility/consumptions/${consumption.id}/abnormal-consumptions`)
      .set(auth());
    assert.equal(stored.body.data.length, 1);
  });

  it('allows a recurrence to be raised after the flag is resolved', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });

    const first = await evaluate(consumption.id);
    const firstId = first.body.data.detections[0].id;

    const resolved = await api()
      .post(`/api/v1/utility/abnormal-consumptions/${firstId}/resolve`)
      .set(auth())
      .send({ status: 'RESOLVED', resolutionNotes: 'Faulty meter replaced.' });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.data.status, 'RESOLVED');
    assert.equal(resolved.body.data.resolvedByUserId, adminUserId);
    assert.ok(resolved.body.data.resolvedAt);
    // A closed flag offers no further actions.
    assert.deepEqual(resolved.body.data.availableActions, []);

    const again = await evaluate(consumption.id);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.notEqual(again.body.data.detections[0].id, firstId);

    const history = await api()
      .get(`/api/v1/utility/consumptions/${consumption.id}/abnormal-consumptions`)
      .set(auth());
    // Both the resolved flag and its recurrence survive.
    assert.equal(history.body.data.length, 2);
  });

  it('refuses to close an already closed flag', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });
    const detected = await evaluate(consumption.id);
    const detectionId = detected.body.data.detections[0].id;

    const dismissed = await api()
      .post(`/api/v1/utility/abnormal-consumptions/${detectionId}/resolve`)
      .set(auth())
      .send({ status: 'DISMISSED' });
    assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));

    const again = await api()
      .post(`/api/v1/utility/abnormal-consumptions/${detectionId}/resolve`)
      .set(auth())
      .send({ status: 'RESOLVED' });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(
      again.body.error.code,
      'UTILITY_ABNORMAL_CONSUMPTION_NOT_OPEN',
    );
  });

  it('rejects an invalid closure status', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });
    const detected = await evaluate(consumption.id);

    const response = await api()
      .post(
        `/api/v1/utility/abnormal-consumptions/${detected.body.data.detections[0].id}/resolve`,
      )
      .set(auth())
      .send({ status: 'OPEN' });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('filters records by status, type and period', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });
    await evaluate(consumption.id);

    const open = await api()
      .get(`/api/v1/utility/meters/${meter.id}/abnormal-consumptions`)
      .query({ status: 'OPEN' })
      .set(auth());
    assert.equal(open.status, 200, JSON.stringify(open.body));
    assert.equal(open.body.data.length, 1);

    const resolved = await api()
      .get(`/api/v1/utility/meters/${meter.id}/abnormal-consumptions`)
      .query({ status: 'RESOLVED' })
      .set(auth());
    assert.equal(resolved.body.data.length, 0);

    const byType = await api()
      .get(`/api/v1/utility/meters/${meter.id}/abnormal-consumptions`)
      .query({ abnormalityType: 'ZERO_USAGE' })
      .set(auth());
    assert.equal(byType.body.data.length, 0);

    const outsidePeriod = await api()
      .get(`/api/v1/utility/meters/${meter.id}/abnormal-consumptions`)
      .query({ from: '2027-01-01T00:00:00.000Z' })
      .set(auth());
    assert.equal(outsidePeriod.body.data.length, 0);

    const bad = await api()
      .get(`/api/v1/utility/meters/${meter.id}/abnormal-consumptions`)
      .query({ status: 'ESCALATED' })
      .set(auth());
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
  });
});

describe('BE-18J abnormal consumption — BE-09 finding binding reuse', () => {
  it('creates a BE-09 finding for follow-up and reflects its state', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });
    const detected = await evaluate(consumption.id);
    const detectionId = detected.body.data.detections[0].id;

    const linked = await api()
      .post(`/api/v1/utility/abnormal-consumptions/${detectionId}/finding`)
      .set(auth())
      .send({ title: 'Investigate high electricity usage' });

    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    assert.ok(linked.body.data.findingId);
    // The Finding itself is BE-09's, and is read back from there.
    assert.equal(
      linked.body.data.finding.title,
      'Investigate high electricity usage',
    );
    assert.equal(linked.body.data.finding.status, 'OPEN');
    assert.equal(linked.body.data.finding.buildingId, fixture.building.id);
    assert.equal(linked.body.data.finding.clientId, fixture.client.id);
    // BE-09 remains the authority for what can be done to the Finding.
    assert.ok(Array.isArray(linked.body.data.findingAvailableActions));
    // LINK_FINDING is gone now that one exists.
    assert.deepEqual(linked.body.data.availableActions, ['RESOLVE', 'DISMISS']);

    // The Finding is a real BE-09 record, reachable on BE-09's own route.
    const viaFindings = await api()
      .get(`/api/v1/findings/${linked.body.data.findingId}`)
      .set(auth());
    assert.equal(viaFindings.status, 200, JSON.stringify(viaFindings.body));
    assert.equal(viaFindings.body.data.id, linked.body.data.findingId);
  });

  it('links an existing BE-09 finding', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });
    const detected = await evaluate(consumption.id);
    const detectionId = detected.body.data.detections[0].id;

    const finding = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/findings`)
      .set(auth())
      .send({
        clientId: fixture.client.id,
        findingNumber: `FND_${suffix()}`,
        title: 'Existing utility finding',
      });
    assert.equal(finding.status, 201, JSON.stringify(finding.body));

    const linked = await api()
      .post(`/api/v1/utility/abnormal-consumptions/${detectionId}/finding`)
      .set(auth())
      .send({ findingId: finding.body.data.id });

    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    assert.equal(linked.body.data.findingId, finding.body.data.id);
  });

  it('refuses to replace an existing finding link', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });
    const detected = await evaluate(consumption.id);
    const detectionId = detected.body.data.detections[0].id;

    const first = await api()
      .post(`/api/v1/utility/abnormal-consumptions/${detectionId}/finding`)
      .set(auth())
      .send({ title: 'First follow-up' });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await api()
      .post(`/api/v1/utility/abnormal-consumptions/${detectionId}/finding`)
      .set(auth())
      .send({ title: 'Second follow-up' });

    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(
      second.body.error.code,
      'UTILITY_ABNORMAL_CONSUMPTION_FINDING_CONFLICT',
    );
  });

  it("refuses a finding from another building", async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });
    const detected = await evaluate(consumption.id);
    const detectionId = detected.body.data.detections[0].id;

    const otherFixture = await createStructure();
    const foreign = await api()
      .post(`/api/v1/buildings/${otherFixture.building.id}/findings`)
      .set(auth())
      .send({
        clientId: otherFixture.client.id,
        findingNumber: `FND_${suffix()}`,
        title: 'Unrelated finding',
      });
    assert.equal(foreign.status, 201, JSON.stringify(foreign.body));

    const linked = await api()
      .post(`/api/v1/utility/abnormal-consumptions/${detectionId}/finding`)
      .set(auth())
      .send({ findingId: foreign.body.data.id });

    // The link must not become a way across an isolation boundary.
    assert.equal(linked.status, 409, JSON.stringify(linked.body));
    assert.equal(
      linked.body.error.code,
      'UTILITY_ABNORMAL_CONSUMPTION_FINDING_CONFLICT',
    );
  });

  it('rejects supplying both an existing finding and new finding details', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });
    const detected = await evaluate(consumption.id);

    const response = await api()
      .post(
        `/api/v1/utility/abnormal-consumptions/${detected.body.data.detections[0].id}/finding`,
      )
      .set(auth())
      .send({ findingId: randomUUID(), title: 'Ambiguous' });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('refuses follow-up on a closed flag', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });
    const detected = await evaluate(consumption.id);
    const detectionId = detected.body.data.detections[0].id;
    await api()
      .post(`/api/v1/utility/abnormal-consumptions/${detectionId}/resolve`)
      .set(auth())
      .send({ status: 'DISMISSED' });

    const response = await api()
      .post(`/api/v1/utility/abnormal-consumptions/${detectionId}/finding`)
      .set(auth())
      .send({ title: 'Late follow-up' });

    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_ABNORMAL_CONSUMPTION_NOT_OPEN',
    );
  });

  it('exposes no finding workflow routes of its own', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });
    const detected = await evaluate(consumption.id);
    const detectionId = detected.body.data.detections[0].id;

    // Workflow stays on BE-09's routes — BE-18J must not duplicate it.
    for (const path of [
      `/api/v1/utility/abnormal-consumptions/${detectionId}/assign`,
      `/api/v1/utility/abnormal-consumptions/${detectionId}/verify`,
      `/api/v1/utility/abnormal-consumptions/${detectionId}/state`,
    ]) {
      const response = await api().post(path).set(auth()).send({});
      assert.equal(response.status, 404, `${path} → ${response.status}`);
    }

    const patched = await api()
      .patch(`/api/v1/utility/abnormal-consumptions/${detectionId}`)
      .set(auth())
      .send({ detectedValue: 1 });
    assert.equal(patched.status, 404, JSON.stringify(patched.body));
  });
});

describe('BE-18J abnormal consumption — tenant and building context', () => {
  it('carries the tenant context from the consumption', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);

    const tenant = await api()
      .post(`/api/v1/clients/${fixture.client.id}/tenant-companies`)
      .set(auth())
      .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company' });
    assert.equal(tenant.status, 201, JSON.stringify(tenant.body));
    await api()
      .post(`/api/v1/tenant-companies/${tenant.body.data.id}/spaces`)
      .set(auth())
      .send({ buildingId: fixture.building.id, spaceId: fixture.space.id });
    const assigned = await api()
      .post(`/api/v1/utility/meters/${meter.id}/tenant-assignments`)
      .set(auth())
      .send({
        tenantCompanyId: tenant.body.data.id,
        spaceId: fixture.space.id,
      });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });

    const detected = await evaluate(consumption.id);
    assert.equal(detected.status, 201, JSON.stringify(detected.body));
    assert.equal(
      detected.body.data.detections[0].tenantCompanyId,
      tenant.body.data.id,
    );
    assert.equal(
      detected.body.data.detections[0].tenantAssignmentId,
      assigned.body.data.id,
    );

    const byTenant = await api()
      .get(
        `/api/v1/tenant-companies/${tenant.body.data.id}/abnormal-consumptions`,
      )
      .set(auth());
    assert.equal(byTenant.status, 200, JSON.stringify(byTenant.body));
    assert.equal(byTenant.body.data.length, 1);
  });

  it('leaves tenant context null for a common-area meter', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });

    const detected = await evaluate(consumption.id);

    assert.equal(detected.status, 201, JSON.stringify(detected.body));
    assert.equal(detected.body.data.detections[0].tenantCompanyId, null);
  });

  it('returns 404 for an unknown tenant company', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/tenant-companies/${randomUUID()}/abnormal-consumptions`)
      .set(auth());

    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'TENANT_COMPANY_NOT_FOUND');
  });

  it('scopes a building listing to that building alone', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });
    await evaluate(consumption.id);

    const here = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/abnormal-consumptions`)
      .set(auth());
    assert.equal(here.status, 200, JSON.stringify(here.body));
    assert.equal(here.body.data.length, 1);
    assert.equal(here.body.data[0].buildingId, fixture.building.id);

    const otherFixture = await createStructure();
    const elsewhere = await api()
      .get(`/api/v1/buildings/${otherFixture.building.id}/abnormal-consumptions`)
      .set(auth());
    assert.equal(elsewhere.body.data.length, 0);
  });
});

describe('BE-18J abnormal consumption — client and building isolation', () => {
  it('denies evaluating and reading across buildings', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });
    const detected = await evaluate(consumption.id);
    const detectionId = detected.body.data.detections[0].id;

    // A second administrator with full RBAC but no assignment to this Building.
    const outsider = await createAdminUser();

    const evaluated = await api()
      .post(
        `/api/v1/utility/consumptions/${consumption.id}/abnormality-evaluations`,
      )
      .set(auth(outsider.token))
      .send({});
    assert.equal(evaluated.status, 403, JSON.stringify(evaluated.body));
    assert.equal(evaluated.body.error.code, 'BUILDING_ACCESS_DENIED');

    const fetched = await api()
      .get(`/api/v1/utility/abnormal-consumptions/${detectionId}`)
      .set(auth(outsider.token));
    assert.equal(fetched.status, 403, JSON.stringify(fetched.body));

    const resolved = await api()
      .post(`/api/v1/utility/abnormal-consumptions/${detectionId}/resolve`)
      .set(auth(outsider.token))
      .send({ status: 'RESOLVED' });
    assert.equal(resolved.status, 403, JSON.stringify(resolved.body));

    const linked = await api()
      .post(`/api/v1/utility/abnormal-consumptions/${detectionId}/finding`)
      .set(auth(outsider.token))
      .send({ title: 'Outsider follow-up' });
    assert.equal(linked.status, 403, JSON.stringify(linked.body));

    const byMeter = await api()
      .get(`/api/v1/utility/meters/${meter.id}/abnormal-consumptions`)
      .set(auth(outsider.token));
    assert.equal(byMeter.status, 403, JSON.stringify(byMeter.body));

    const byBuilding = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/abnormal-consumptions`)
      .set(auth(outsider.token));
    assert.equal(byBuilding.status, 403, JSON.stringify(byBuilding.body));
  });

  it("denies managing another client's detection rules", async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const outsider = await createAdminUser();

    const created = await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-abnormality-rules`)
      .set(auth(outsider.token))
      .send({
        utilityType: 'ELECTRICITY',
        abnormalityType: 'HIGH_USAGE',
        name: 'Foreign rule',
        thresholdValue: 5,
      });
    assert.equal(created.status, 403, JSON.stringify(created.body));

    const listed = await api()
      .get(`/api/v1/clients/${fixture.client.id}/utility-abnormality-rules`)
      .set(auth(outsider.token));
    assert.equal(listed.status, 403, JSON.stringify(listed.body));
  });

  it("hides a tenant's abnormalities from a user outside that client", async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const tenant = await api()
      .post(`/api/v1/clients/${fixture.client.id}/tenant-companies`)
      .set(auth())
      .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company' });
    await api()
      .post(`/api/v1/tenant-companies/${tenant.body.data.id}/spaces`)
      .set(auth())
      .send({ buildingId: fixture.building.id, spaceId: fixture.space.id });
    await api()
      .post(`/api/v1/utility/meters/${meter.id}/tenant-assignments`)
      .set(auth())
      .send({
        tenantCompanyId: tenant.body.data.id,
        spaceId: fixture.space.id,
      });
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });
    await evaluate(consumption.id);

    const outsider = await createAdminUser();

    const response = await api()
      .get(
        `/api/v1/tenant-companies/${tenant.body.data.id}/abnormal-consumptions`,
      )
      .set(auth(outsider.token));

    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('BE-18J abnormal consumption — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);

    const evaluated = await api()
      .post(
        `/api/v1/utility/consumptions/${consumption.id}/abnormality-evaluations`,
      )
      .send({});
    assert.equal(evaluated.status, 401, JSON.stringify(evaluated.body));

    const listed = await api().get(
      `/api/v1/buildings/${fixture.building.id}/abnormal-consumptions`,
    );
    assert.equal(listed.status, 401, JSON.stringify(listed.body));
  });

  it('denies a user without utility_meter permissions (default-deny)', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const [consumption] = await createSeries(meter.id, [900]);
    await createRule(fixture.client.id, { thresholdValue: 500 });
    const detected = await evaluate(consumption.id);
    const detectionId = detected.body.data.detections[0].id;
    const plainToken = await createPlainSession();

    const evaluated = await api()
      .post(
        `/api/v1/utility/consumptions/${consumption.id}/abnormality-evaluations`,
      )
      .set(auth(plainToken))
      .send({});
    assert.equal(evaluated.status, 403, JSON.stringify(evaluated.body));

    const resolved = await api()
      .post(`/api/v1/utility/abnormal-consumptions/${detectionId}/resolve`)
      .set(auth(plainToken))
      .send({ status: 'RESOLVED' });
    assert.equal(resolved.status, 403);

    const linked = await api()
      .post(`/api/v1/utility/abnormal-consumptions/${detectionId}/finding`)
      .set(auth(plainToken))
      .send({ title: 'Follow-up' });
    assert.equal(linked.status, 403);

    const fetched = await api()
      .get(`/api/v1/utility/abnormal-consumptions/${detectionId}`)
      .set(auth(plainToken));
    assert.equal(fetched.status, 403);

    const byMeter = await api()
      .get(`/api/v1/utility/meters/${meter.id}/abnormal-consumptions`)
      .set(auth(plainToken));
    assert.equal(byMeter.status, 403);

    const rules = await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-abnormality-rules`)
      .set(auth(plainToken))
      .send({
        utilityType: 'ELECTRICITY',
        abnormalityType: 'LOW_USAGE',
        name: 'Rule',
        thresholdValue: 1,
      });
    assert.equal(rules.status, 403);
  });
});
