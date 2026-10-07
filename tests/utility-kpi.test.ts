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
 * BE-23I — Utility KPI focused validation.
 *
 * Covers ONLY the BE-23I KPI surface:
 *  - electricity consumption
 *  - water consumption
 *  - gas consumption
 *  - abnormal consumption count
 *  - verified reading count
 *  - consumption trend summary
 *
 * Plus the access rules the KPI must not break: RBAC, Building access
 * assertion, multi-Building rollup, and Client isolation.
 *
 * The KPI delegates every figure to BE-18M, so one test pins the KPI
 * against the BE-18M aggregation endpoint to prove they cannot diverge.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';
// Privileged setup user always assigned to the fixture Building, used to
// seed Client-scoped fixture data (e.g. UOM) even when the actor under test
// is deliberately left unassigned to the Building — mirrors the pattern
// established in tests/utility-meters.test.ts and tests/utility-tenant-approvals.test.ts
// (CR-BE-TEST-01).
let setupToken = '';
let setupUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE tenant_approval_bindings, tenant_utility_requests,
       tenant_complaints, tenant_service_requests, tenant_building_contexts,
       reviews, utility_abnormal_consumptions, utility_abnormality_rules,
       utility_calculations, utility_calculation_bases,
       utility_meter_consumptions, evidence_submissions,
       evidence_requirements, utility_meter_readings,
       utility_meter_tenant_assignments, utility_meter_hierarchies,
       utility_type_uoms, utility_type_configurations, utility_meters,
       units_of_measure, tenant_space_relationships, tenant_pics,
       tenant_companies, functional_locations, spaces, rooms, areas, floors,
       user_building_assignments, buildings, properties, users, roles,
       permissions, role_permission_assignments, user_role_assignments,
       clients CASCADE`,
  );
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const setup = await createAdminUser();
  setupToken = setup.token;
  setupUserId = setup.userId;
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
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

const KPI_PATH = '/api/v1/utility/reports/kpi';

async function kpi(query: Record<string, string>, token = adminToken) {
  return api().get(KPI_PATH).query(query).set(auth(token));
}

async function createUom(clientId: string) {
  // UOM is Client-scoped and access is derived from Building assignments, so
  // seed it with the setup user (always assigned to the fixture Building)
  // even when the actor under test is deliberately left unassigned.
  const created = await api()
    .post(`/api/v1/clients/${clientId}/uoms`)
    .set(auth(setupToken))
    .send({
      code: `UOM_${suffix()}`,
      name: 'Measurement unit',
      symbol: 'kWh',
      category: 'ENERGY',
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data.id as string;
}

/** Client → Property → Building → Floor → Area → Room → Space. */
async function createStructure(options: { assignUserId?: string | null } = {}) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Utility KPI Client',
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
  // The setup user is always assigned so shared fixture data (e.g. UOM) can
  // be seeded by `createUom` regardless of the actor-under-test assignment.
  await buildingAssignmentService.createAssignment(setupUserId, {
    buildingId: building.id,
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  const uomId = await createUom(client.id);
  return { client, property, building, floor, area, room, space, uomId };
}

type Fixture = Awaited<ReturnType<typeof createStructure>>;

async function createMeter(
  fixture: Fixture,
  utilityType: 'ELECTRICITY' | 'WATER' | 'GAS' = 'ELECTRICITY',
  uomId = fixture.uomId,
  buildingId = fixture.building.id,
) {
  const created = await api()
    .post(`/api/v1/buildings/${buildingId}/utility-meters`)
    .set(auth())
    .send({
      code: `MTR_${suffix()}`,
      name: 'Utility meter',
      utilityType,
      uomId,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data as { id: string; code: string };
}

const iso = (month: number) => new Date(Date.UTC(2026, month, 1)).toISOString();

/**
 * Produces BE-18G consumptions on `meterId` from a series of deltas, one
 * month apart starting Jan 2026. Uses the real BE-18E reading and
 * BE-18G consumption endpoints, so every figure the KPI reports is
 * genuinely derived by the Utility domain.
 */
async function createSeries(meterId: string, deltas: readonly number[]) {
  let running = 0;
  let month = 0;

  const first = await api()
    .post(`/api/v1/utility/meters/${meterId}/readings`)
    .set(auth())
    .send({ readingValue: running, readingAt: iso(month) });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const consumptions: { id: string; consumptionValue: number }[] = [];
  for (const delta of deltas) {
    running += delta;
    month += 1;
    const reading = await api()
      .post(`/api/v1/utility/meters/${meterId}/readings`)
      .set(auth())
      .send({ readingValue: running, readingAt: iso(month) });
    assert.equal(reading.status, 201, JSON.stringify(reading.body));

    const consumption = await api()
      .post(`/api/v1/utility/meters/${meterId}/consumptions`)
      .set(auth())
      .send({ currentReadingId: reading.body.data.id });
    assert.equal(consumption.status, 201, JSON.stringify(consumption.body));
    consumptions.push(consumption.body.data);
  }
  return consumptions;
}

/**
 * Full three-utility fixture: electricity 100+200, water 50, gas 30.
 */
async function seed() {
  const fixture = await createStructure();
  const waterUom = await createUom(fixture.client.id);
  const gasUom = await createUom(fixture.client.id);

  const electricity = await createMeter(fixture, 'ELECTRICITY');
  const water = await createMeter(fixture, 'WATER', waterUom);
  const gas = await createMeter(fixture, 'GAS', gasUom);

  const electricitySeries = await createSeries(electricity.id, [100, 200]);
  await createSeries(water.id, [50]);
  await createSeries(gas.id, [30]);

  return {
    ...fixture,
    electricity,
    water,
    gas,
    electricitySeries,
  };
}

describe('BE-23I utility KPI', () => {
  it('reports electricity, water and gas consumption', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.building.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, f.building.id);
    assert.deepEqual(data.buildingScope, [f.building.id]);

    assert.equal(data.electricity.utilityType, 'ELECTRICITY');
    assert.equal(data.electricity.totalConsumption, 300);
    assert.equal(data.electricity.consumptionCount, 2);
    assert.equal(data.electricity.meterCount, 1);

    assert.equal(data.water.utilityType, 'WATER');
    assert.equal(data.water.totalConsumption, 50);
    assert.equal(data.water.consumptionCount, 1);

    assert.equal(data.gas.utilityType, 'GAS');
    assert.equal(data.gas.totalConsumption, 30);
    assert.equal(data.gas.consumptionCount, 1);

    // Headline totals are the sum of the three types.
    assert.equal(data.totals.totalConsumption, 380);
    assert.equal(data.totals.consumptionCount, 4);
    assert.equal(data.totals.meterCount, 3);
  });

  it('always reports all three utility types, zeroed when absent', async (t) => {
    if (!ready(t)) return;
    const fixture = await createStructure();
    const electricity = await createMeter(fixture, 'ELECTRICITY');
    await createSeries(electricity.id, [75]);

    const response = await kpi({ buildingId: fixture.building.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.electricity.totalConsumption, 75);
    // No water or gas meters exist — the blocks are still present and zeroed.
    assert.equal(data.water.totalConsumption, 0);
    assert.equal(data.water.consumptionCount, 0);
    assert.equal(data.water.meterCount, 0);
    assert.equal(data.water.uomId, null);
    assert.equal(data.gas.totalConsumption, 0);
  });

  it('narrows every figure by utilityType', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({
      buildingId: f.building.id,
      utilityType: 'WATER',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.utilityType, 'WATER');
    assert.equal(data.water.totalConsumption, 50);
    // Electricity and gas are filtered out of the aggregate entirely.
    assert.equal(data.electricity.totalConsumption, 0);
    assert.equal(data.gas.totalConsumption, 0);
    assert.equal(data.totals.totalConsumption, 50);
  });

  it('counts abnormal consumptions detected by BE-18J', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Before any rule fires there is nothing abnormal.
    const before = await kpi({ buildingId: f.building.id });
    assert.equal(before.body.data.abnormal.total, 0);

    await api()
      .post(`/api/v1/clients/${f.client.id}/utility-abnormality-rules`)
      .set(auth())
      .send({
        utilityType: 'ELECTRICITY',
        abnormalityType: 'HIGH_USAGE',
        name: 'High usage rule',
        thresholdValue: 150,
        comparisonMode: 'ABSOLUTE',
      });

    // Only the 200 delta breaches the 150 threshold.
    for (const item of f.electricitySeries) {
      await api()
        .post(`/api/v1/utility/consumptions/${item.id}/abnormality-evaluations`)
        .set(auth())
        .send({});
    }

    const after = await kpi({ buildingId: f.building.id });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    const abnormal = after.body.data.abnormal;

    assert.equal(abnormal.total, 1);
    assert.equal(abnormal.open, 1);
    assert.equal(abnormal.resolved, 0);
    assert.equal(abnormal.dismissed, 0);
    assert.equal(abnormal.byType.HIGH_USAGE, 1);
  });

  it('counts verified readings through the BE-18K verification decision', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    await api()
      .post(`/api/v1/clients/${f.client.id}/utility-abnormality-rules`)
      .set(auth())
      .send({
        utilityType: 'ELECTRICITY',
        abnormalityType: 'HIGH_USAGE',
        name: 'High usage rule',
        thresholdValue: 150,
        comparisonMode: 'ABSOLUTE',
      });
    const detected = await api()
      .post(
        `/api/v1/utility/consumptions/${f.electricitySeries[1].id}/abnormality-evaluations`,
      )
      .set(auth())
      .send({});
    assert.equal(detected.status, 201, JSON.stringify(detected.body));
    const abnormalityId = detected.body.data.detections[0].id as string;

    // Unverified before any review is opened.
    const initial = await kpi({ buildingId: f.building.id });
    assert.equal(initial.body.data.verification.unverified, 1);
    assert.equal(initial.body.data.verification.verified, 0);

    // Opening a review moves it to PENDING.
    await api()
      .post(
        `/api/v1/utility/abnormal-consumptions/${abnormalityId}/verification/open`,
      )
      .set(auth())
      .send({});
    const pending = await kpi({ buildingId: f.building.id });
    assert.equal(pending.body.data.verification.pending, 1);
    assert.equal(pending.body.data.verification.unverified, 0);

    // An APPROVED decision is the domain's notion of "verified".
    await api()
      .post(`/api/v1/utility/abnormal-consumptions/${abnormalityId}/verification`)
      .set(auth())
      .send({ decision: 'APPROVED' });
    const verified = await kpi({ buildingId: f.building.id });
    assert.equal(verified.body.data.verification.verified, 1);
    assert.equal(verified.body.data.verification.pending, 0);
  });

  it('returns a consumption trend summary bucketed by interval', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const monthly = await kpi({
      buildingId: f.building.id,
      utilityType: 'ELECTRICITY',
      interval: 'MONTH',
    });
    assert.equal(monthly.status, 200, JSON.stringify(monthly.body));
    assert.equal(monthly.body.data.interval, 'MONTH');

    const trend = monthly.body.data.trend;
    // Two electricity consumptions, one month apart -> two buckets.
    assert.equal(trend.length, 2);
    const trendTotal = trend.reduce(
      (sum: number, point: { totalConsumption: number }) =>
        sum + point.totalConsumption,
      0,
    );
    assert.equal(trendTotal, 300);

    // Buckets are ascending by interval start.
    const starts = trend.map((p: { intervalStart: string }) => p.intervalStart);
    assert.deepEqual(starts, [...starts].sort());

    // A YEAR interval collapses them into a single bucket.
    const yearly = await kpi({
      buildingId: f.building.id,
      utilityType: 'ELECTRICITY',
      interval: 'YEAR',
    });
    assert.equal(yearly.body.data.interval, 'YEAR');
    assert.equal(yearly.body.data.trend.length, 1);
    assert.equal(yearly.body.data.trend[0].totalConsumption, 300);
  });

  it('agrees exactly with the BE-18M aggregation it delegates to', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const kpiResponse = await kpi({ buildingId: f.building.id });
    const aggregation = await api()
      .get(
        `/api/v1/utility/aggregations/consumption?buildingId=${f.building.id}&groupBy=UTILITY_TYPE`,
      )
      .set(auth());
    assert.equal(aggregation.status, 200, JSON.stringify(aggregation.body));

    const bucket = (key: string) =>
      aggregation.body.data.find((row: { key: string }) => row.key === key);

    // The KPI must never disagree with the domain aggregation.
    assert.equal(
      kpiResponse.body.data.electricity.totalConsumption,
      bucket('ELECTRICITY').totalConsumption,
    );
    assert.equal(
      kpiResponse.body.data.water.totalConsumption,
      bucket('WATER').totalConsumption,
    );
    assert.equal(
      kpiResponse.body.data.gas.totalConsumption,
      bucket('GAS').totalConsumption,
    );
  });

  it('excludes sub meters by default and includes them on request', async (t) => {
    if (!ready(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture, 'ELECTRICITY');
    const sub = await createMeter(fixture, 'ELECTRICITY');
    await api()
      .post(`/api/v1/utility/meters/${main.id}/sub-meters`)
      .set(auth())
      .send({ subMeterId: sub.id });

    await createSeries(main.id, [500]);
    await createSeries(sub.id, [120]);

    // Default: the sub meter's usage is already inside the main reading.
    const excluded = await kpi({ buildingId: fixture.building.id });
    assert.equal(excluded.status, 200, JSON.stringify(excluded.body));
    assert.equal(excluded.body.data.meterScope, 'EXCLUDE_SUB_METERS');
    assert.equal(excluded.body.data.electricity.totalConsumption, 500);

    // Opt in knowingly to the overlapping total.
    const included = await kpi({
      buildingId: fixture.building.id,
      includeSubMeters: 'true',
    });
    assert.equal(included.body.data.meterScope, 'ALL_METERS');
    assert.equal(included.body.data.electricity.totalConsumption, 620);
  });

  it('filters by date range', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Consumptions are periodised across Jan–Mar 2026; a window covering
    // only the first closing period sees one electricity consumption.
    const firstOnly = await kpi({
      buildingId: f.building.id,
      utilityType: 'ELECTRICITY',
      dateFrom: '2026-01-01',
      dateTo: '2026-02-01',
    });
    assert.equal(firstOnly.status, 200, JSON.stringify(firstOnly.body));
    assert.equal(firstOnly.body.data.electricity.totalConsumption, 100);
    assert.equal(firstOnly.body.data.electricity.consumptionCount, 1);

    // A window well before any data contains nothing.
    const empty = await kpi({
      buildingId: f.building.id,
      dateFrom: '2020-01-01',
      dateTo: '2020-12-31',
    });
    assert.equal(empty.body.data.totals.totalConsumption, 0);
    assert.equal(empty.body.data.electricity.totalConsumption, 0);
    assert.deepEqual(empty.body.data.trend, []);
  });

  it('rolls up across every accessible building when buildingId is omitted', async (t) => {
    if (!ready(t)) return;
    // Earlier tests leave their own Buildings assigned to the admin, and a
    // rollup spans every accessible Building. Clear the utility stores and
    // the admin's building access first so this assertion is deterministic.
    await pool!.query(
      `TRUNCATE reviews, utility_abnormal_consumptions,
         utility_abnormality_rules, utility_calculations,
         utility_calculation_bases, utility_meter_consumptions,
         utility_meter_readings, utility_meter_tenant_assignments,
         utility_meter_hierarchies, utility_meters,
         user_building_assignments CASCADE`,
    );
    const f = await seed();

    // A second Building under the same Client, also accessible.
    const second = await buildingService.createBuilding({
      propertyId: f.property.id,
      code: `BLDG_${suffix()}`,
      name: 'Second building',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: second.id,
    });
    const secondMeter = await createMeter(
      f,
      'ELECTRICITY',
      f.uomId,
      second.id,
    );
    await createSeries(secondMeter.id, [400]);

    const response = await kpi({});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, null);
    assert.ok(data.buildingScope.includes(f.building.id));
    assert.ok(data.buildingScope.includes(second.id));

    // Building 1's 300 + Building 2's 400.
    assert.equal(data.electricity.totalConsumption, 700);
    assert.equal(data.electricity.consumptionCount, 3);
  });

  it('denies access to a building the caller is not assigned to', async (t) => {
    if (!ready(t)) return;
    // Structure owned by another Client, with no assignment to the admin.
    const foreign = await createStructure({ assignUserId: null });

    const response = await kpi({ buildingId: foreign.building.id });
    assert.equal(response.status, 403, JSON.stringify(response.body));
  });

  it('requires authentication and the utility_kpi.read permission', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const anonymous = await api()
      .get(KPI_PATH)
      .query({ buildingId: f.building.id });
    assert.equal(anonymous.status, 401, JSON.stringify(anonymous.body));

    const plainToken = await createPlainSession();
    const forbidden = await kpi({ buildingId: f.building.id }, plainToken);
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
  });

  it('rejects malformed KPI query parameters', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const badBuilding = await kpi({ buildingId: 'not-a-uuid' });
    assert.equal(badBuilding.status, 400, JSON.stringify(badBuilding.body));

    const badType = await kpi({
      buildingId: f.building.id,
      utilityType: 'STEAM',
    });
    assert.equal(badType.status, 400, JSON.stringify(badType.body));

    const badInterval = await kpi({
      buildingId: f.building.id,
      interval: 'WEEK',
    });
    assert.equal(badInterval.status, 400, JSON.stringify(badInterval.body));

    const badRange = await kpi({
      buildingId: f.building.id,
      dateFrom: '2026-06-01',
      dateTo: '2026-01-01',
    });
    assert.equal(badRange.status, 400, JSON.stringify(badRange.body));

    const badFlag = await kpi({
      buildingId: f.building.id,
      includeSubMeters: 'maybe',
    });
    assert.equal(badFlag.status, 400, JSON.stringify(badFlag.body));

    const badDate = await kpi({
      buildingId: f.building.id,
      dateFrom: 'never',
    });
    assert.equal(badDate.status, 400, JSON.stringify(badDate.body));
  });
});
