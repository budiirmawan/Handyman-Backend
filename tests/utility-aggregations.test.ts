import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-18M — Utility Aggregation focused validation.
 *
 * Covers only this PART: read-only summaries over authoritative BE-18 data —
 * utility-type, Building and Tenant aggregation, period filtering, Main/Sub
 * Meter double-count protection, the abnormal summary, the verification /
 * approval summary, RBAC, and Client / Building isolation.
 *
 * Billing, tariffs and any persisted roll-up are deliberately never
 * exercised: this module stores nothing.
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
  await clientMonetaryContextService.setClientMonetaryContext({
    clientId: client.id, baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR',
    allowedCurrencyCodes: ['IDR', 'USD'],
  }, adminUserId);
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

async function createMeter(
  fixture: Fixture,
  utilityType: 'ELECTRICITY' | 'WATER' | 'GAS' = 'ELECTRICITY',
  uomId = fixture.uomId,
  purpose?: 'TENANT' | 'BUILDING' | 'COMMON_AREA' | 'ENERGY_SOURCE',
) {
  const created = await api()
    .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
    .set(auth())
    .send({
      code: `MTR_${suffix()}`,
      name: 'Utility meter',
      utilityType,
      uomId,
      ...(purpose === undefined ? {} : { purpose }),
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data as { id: string; code: string };
}

const iso = (month: number) => new Date(Date.UTC(2026, month, 1)).toISOString();

/**
 * Produces consumptions on `meterId` from a series of deltas, one month
 * apart starting Jan 2026.
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

const AGG = '/api/v1/utility/aggregations';

async function summary(query: string, token = adminToken) {
  return api().get(`${AGG}/summary?${query}`).set(auth(token));
}

async function consumption(query: string, token = adminToken) {
  return api().get(`${AGG}/consumption?${query}`).set(auth(token));
}

const bucketFor = (body: { data: { key: string | null }[] }, key: string) =>
  body.data.find((row) => row.key === key);

describe('BE-18M utility aggregation — utility type aggregation', () => {
  it('totals consumption per utility type from authoritative records', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const waterUom = await createUom(fixture.client.id);

    const electricity = await createMeter(fixture, 'ELECTRICITY');
    const water = await createMeter(fixture, 'WATER', waterUom);
    await createSeries(electricity.id, [100, 200]);
    await createSeries(water.id, [50]);

    const response = await consumption(
      `buildingId=${fixture.building.id}&groupBy=UTILITY_TYPE`,
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.meta.groupBy, 'UTILITY_TYPE');

    const power = bucketFor(response.body, 'ELECTRICITY')!;
    assert.equal(power.totalConsumption, 300);
    assert.equal(power.consumptionCount, 2);
    assert.equal(power.meterCount, 1);
    assert.ok(power.periodStart);
    assert.ok(power.periodEnd);

    const flow = bucketFor(response.body, 'WATER')!;
    assert.equal(flow.totalConsumption, 50);
    assert.equal(flow.consumptionCount, 1);
  });

  it('filters the aggregate to a single utility type', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const waterUom = await createUom(fixture.client.id);
    const electricity = await createMeter(fixture, 'ELECTRICITY');
    const water = await createMeter(fixture, 'WATER', waterUom);
    await createSeries(electricity.id, [100]);
    await createSeries(water.id, [50]);

    const response = await summary(
      `buildingId=${fixture.building.id}&utilityType=WATER`,
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.totals.totalConsumption, 50);
    assert.equal(response.body.data.filters.utilityType, 'WATER');
    assert.equal(response.body.data.byUtilityType.length, 1);
    assert.equal(response.body.data.byUtilityType[0].key, 'WATER');
  });

  it('groups by meter and reports the meter code', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const first = await createMeter(fixture);
    const second = await createMeter(fixture);
    await createSeries(first.id, [100]);
    await createSeries(second.id, [40]);

    const response = await consumption(
      `buildingId=${fixture.building.id}&groupBy=METER`,
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.length, 2);
    const bucket = bucketFor(response.body, first.id)!;
    assert.equal(bucket.totalConsumption, 100);
    assert.equal((bucket as { meterCode: string }).meterCode, first.code);
  });

  it('rejects an unknown utility type and an unknown grouping', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const badType = await summary(
      `buildingId=${fixture.building.id}&utilityType=STEAM`,
    );
    assert.equal(badType.status, 400, JSON.stringify(badType.body));
    assert.equal(badType.body.error.code, 'VALIDATION_ERROR');

    const badGroup = await consumption(
      `buildingId=${fixture.building.id}&groupBy=REGION`,
    );
    assert.equal(badGroup.status, 400, JSON.stringify(badGroup.body));
    assert.equal(badGroup.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-18M utility aggregation — building aggregation', () => {
  it('aggregates a building and never reaches another building', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    await createSeries(meter.id, [100, 250]);

    // A second Building under the same Client must not leak in.
    const otherProperty = await propertyService.createProperty({
      clientId: fixture.client.id,
      code: `PROP_${suffix()}`,
      name: 'Second Property',
    });
    const otherBuilding = await buildingService.createBuilding({
      propertyId: otherProperty.id,
      code: `BLDG_${suffix()}`,
      name: 'Second Building',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: otherBuilding.id,
    });
    const otherMeterResponse = await api()
      .post(`/api/v1/buildings/${otherBuilding.id}/utility-meters`)
      .set(auth())
      .send({
        code: `MTR_${suffix()}`,
        name: 'Other meter',
        utilityType: 'ELECTRICITY',
        uomId: fixture.uomId,
      });
    assert.equal(otherMeterResponse.status, 201);
    await createSeries(otherMeterResponse.body.data.id, [7]);

    const scoped = await summary(`buildingId=${fixture.building.id}`);
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
    assert.equal(scoped.body.data.totals.totalConsumption, 350);

    // Grouping the whole Client shows both Buildings, separately.
    const byBuilding = await consumption(
      `clientId=${fixture.client.id}&groupBy=BUILDING`,
    );
    assert.equal(byBuilding.status, 200, JSON.stringify(byBuilding.body));
    assert.equal(byBuilding.body.data.length, 2);
    assert.equal(
      bucketFor(byBuilding.body, fixture.building.id)!.totalConsumption,
      350,
    );
    assert.equal(bucketFor(byBuilding.body, otherBuilding.id)!.totalConsumption, 7);
  });

  it('requires exactly one scope anchor', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const none = await api().get(`${AGG}/summary`).set(auth());
    assert.equal(none.status, 400, JSON.stringify(none.body));
    assert.equal(none.body.error.code, 'UTILITY_AGGREGATION_SCOPE_REQUIRED');

    const two = await summary(
      `clientId=${fixture.client.id}&buildingId=${fixture.building.id}`,
    );
    assert.equal(two.status, 400, JSON.stringify(two.body));
    assert.equal(two.body.error.code, 'UTILITY_AGGREGATION_SCOPE_REQUIRED');
  });

  it('returns an empty aggregate rather than failing when nothing matches', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const response = await summary(`buildingId=${fixture.building.id}`);

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.totals.totalConsumption, 0);
    assert.equal(response.body.data.totals.consumptionCount, 0);
    assert.equal(response.body.data.totals.meterCount, 0);
    assert.deepEqual(response.body.data.byUtilityType, []);
  });
});

describe('BE-18M utility aggregation — tenant aggregation', () => {
  it('aggregates by Tenant while preserving Tenant Meter context', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);

    const tenant = await api()
      .post(`/api/v1/clients/${fixture.client.id}/tenant-companies`)
      .set(auth())
      .send({ tenantCode: `TEN_${suffix()}`, tenantName: 'Tenant Co' });
    assert.equal(tenant.status, 201, JSON.stringify(tenant.body));

    const leased = await api()
      .post(`/api/v1/tenant-companies/${tenant.body.data.id}/spaces`)
      .set(auth())
      .send({ buildingId: fixture.building.id, spaceId: fixture.space.id });
    assert.equal(leased.status, 201, JSON.stringify(leased.body));

    const assigned = await api()
      .post(`/api/v1/utility/meters/${meter.id}/tenant-assignments`)
      .set(auth())
      .send({
        tenantCompanyId: tenant.body.data.id,
        spaceId: fixture.space.id,
      });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

    await createSeries(meter.id, [120, 80]);

    const byTenant = await consumption(
      `buildingId=${fixture.building.id}&groupBy=TENANT`,
    );
    assert.equal(byTenant.status, 200, JSON.stringify(byTenant.body));
    const bucket = bucketFor(byTenant.body, tenant.body.data.id)!;
    assert.equal(bucket.totalConsumption, 200);
    assert.equal(
      (bucket as { tenantCompanyId: string }).tenantCompanyId,
      tenant.body.data.id,
    );

    // The Tenant scope itself resolves through BE-14A and totals the same.
    const scoped = await summary(`tenantCompanyId=${tenant.body.data.id}`);
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
    assert.equal(scoped.body.data.totals.totalConsumption, 200);
    assert.equal(scoped.body.data.scope.resolvedClientId, fixture.client.id);
  });

  it('keeps untenanted consumption out of any Tenant bucket', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    await createSeries(meter.id, [90]);

    const byTenant = await consumption(
      `buildingId=${fixture.building.id}&groupBy=TENANT`,
    );

    assert.equal(byTenant.status, 200, JSON.stringify(byTenant.body));
    // Landlord-side usage groups under a null Tenant, not an arbitrary one.
    assert.equal(byTenant.body.data.length, 1);
    assert.equal(byTenant.body.data[0].key, null);
    assert.equal(byTenant.body.data[0].totalConsumption, 90);
  });

  it('returns 404 for an unknown tenant company', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await summary(`tenantCompanyId=${randomUUID()}`);

    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'TENANT_COMPANY_NOT_FOUND');
  });
});

describe('BE-18M utility aggregation — period filtering', () => {
  it('restricts totals to the requested window', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    // Periods close on 1 Feb, 1 Mar and 1 Apr 2026.
    await createSeries(meter.id, [10, 20, 40]);

    const all = await summary(`meterId=${meter.id}`);
    assert.equal(all.body.data.totals.totalConsumption, 70);

    const windowed = await summary(
      `meterId=${meter.id}&from=${iso(1)}&to=${iso(2)}`,
    );
    assert.equal(windowed.status, 200, JSON.stringify(windowed.body));
    // Only the periods closing 1 Feb (10) and 1 Mar (20).
    assert.equal(windowed.body.data.totals.totalConsumption, 30);
    assert.equal(windowed.body.data.totals.consumptionCount, 2);
    assert.equal(windowed.body.data.filters.from, iso(1));
    assert.equal(windowed.body.data.filters.to, iso(2));
  });

  it('groups by calendar period', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    await createSeries(meter.id, [10, 20]);

    const monthly = await consumption(
      `meterId=${meter.id}&groupBy=PERIOD&interval=MONTH`,
    );

    assert.equal(monthly.status, 200, JSON.stringify(monthly.body));
    assert.equal(monthly.body.data.length, 2);
    assert.equal(monthly.body.data[0].totalConsumption, 10);
    assert.equal(monthly.body.data[1].totalConsumption, 20);
    assert.ok(monthly.body.data[0].intervalStart);

    const yearly = await consumption(
      `meterId=${meter.id}&groupBy=PERIOD&interval=YEAR`,
    );
    assert.equal(yearly.body.data.length, 1);
    assert.equal(yearly.body.data[0].totalConsumption, 30);
  });

  it('rejects an inverted or malformed period', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const inverted = await summary(
      `buildingId=${fixture.building.id}&from=${iso(3)}&to=${iso(1)}`,
    );
    assert.equal(inverted.status, 400, JSON.stringify(inverted.body));
    assert.equal(
      inverted.body.error.code,
      'UTILITY_AGGREGATION_PERIOD_INVALID',
    );

    const malformed = await summary(
      `buildingId=${fixture.building.id}&from=not-a-date`,
    );
    assert.equal(malformed.status, 400, JSON.stringify(malformed.body));
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-18M utility aggregation — main/sub meter double counting', () => {
  it('excludes an ACTIVE Sub Meter so its usage is not counted twice', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture);
    const sub = await createMeter(fixture);

    // The Sub Meter's 40 already flowed through the Main Meter's 100.
    await createSeries(main.id, [100]);
    await createSeries(sub.id, [40]);

    const bound = await api()
      .post(`/api/v1/utility/meters/${main.id}/sub-meters`)
      .set(auth())
      .send({ subMeterId: sub.id });
    assert.equal(bound.status, 201, JSON.stringify(bound.body));

    const guarded = await summary(`buildingId=${fixture.building.id}`);
    assert.equal(guarded.status, 200, JSON.stringify(guarded.body));
    // 100, not 140 — the Sub Meter is not added on top of its Main.
    assert.equal(guarded.body.data.totals.totalConsumption, 100);
    assert.equal(guarded.body.data.totals.meterCount, 1);
    assert.equal(guarded.body.data.excludedSubMeterCount, 1);
    assert.equal(guarded.body.data.filters.meterScope, 'EXCLUDE_SUB_METERS');

    // The inclusive view is available, and knowingly overlaps.
    const inclusive = await summary(
      `buildingId=${fixture.building.id}&meterScope=ALL_METERS`,
    );
    assert.equal(inclusive.body.data.totals.totalConsumption, 140);
    assert.equal(inclusive.body.data.totals.meterCount, 2);
    assert.equal(inclusive.body.data.excludedSubMeterCount, 0);
  });

  it('counts a released Sub Meter again once the binding is inactive', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture);
    const sub = await createMeter(fixture);
    await createSeries(main.id, [100]);
    await createSeries(sub.id, [40]);

    const bound = await api()
      .post(`/api/v1/utility/meters/${main.id}/sub-meters`)
      .set(auth())
      .send({ subMeterId: sub.id });
    assert.equal(bound.status, 201, JSON.stringify(bound.body));

    const before = await summary(`buildingId=${fixture.building.id}`);
    assert.equal(before.body.data.totals.totalConsumption, 100);

    // BE-18C owns the relationship; ending it restores independent metering.
    const released = await api()
      .patch(`/api/v1/utility/meter-hierarchies/${bound.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(released.status, 200, JSON.stringify(released.body));

    const after = await summary(`buildingId=${fixture.building.id}`);
    assert.equal(after.body.data.totals.totalConsumption, 140);
    assert.equal(after.body.data.excludedSubMeterCount, 0);
  });

  it('applies the exclusion to grouped aggregates too', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const main = await createMeter(fixture);
    const sub = await createMeter(fixture);
    await createSeries(main.id, [100]);
    await createSeries(sub.id, [40]);
    await api()
      .post(`/api/v1/utility/meters/${main.id}/sub-meters`)
      .set(auth())
      .send({ subMeterId: sub.id });

    const byMeter = await consumption(
      `buildingId=${fixture.building.id}&groupBy=METER`,
    );
    assert.equal(byMeter.status, 200, JSON.stringify(byMeter.body));
    assert.equal(byMeter.body.data.length, 1);
    assert.equal(byMeter.body.data[0].meterId, main.id);

    const byType = await consumption(
      `buildingId=${fixture.building.id}&groupBy=UTILITY_TYPE`,
    );
    assert.equal(bucketFor(byType.body, 'ELECTRICITY')!.totalConsumption, 100);
  });
});

describe('BE-18M utility aggregation — abnormal summary', () => {
  it('counts BE-18J abnormalities by status and type', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const series = await createSeries(meter.id, [900, 800]);

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

    for (const item of series) {
      const detected = await api()
        .post(`/api/v1/utility/consumptions/${item.id}/abnormality-evaluations`)
        .set(auth())
        .send({});
      assert.equal(detected.status, 201, JSON.stringify(detected.body));
    }

    const open = await api()
      .get(`${AGG}/abnormal?buildingId=${fixture.building.id}`)
      .set(auth());
    assert.equal(open.status, 200, JSON.stringify(open.body));
    assert.equal(open.body.data.total, 2);
    assert.equal(open.body.data.open, 2);
    assert.equal(open.body.data.resolved, 0);
    assert.equal(open.body.data.byType.HIGH_USAGE, 2);

    // Closing one moves it between buckets without changing the total.
    const listed = await api()
      .get(`/api/v1/utility/meters/${meter.id}/abnormal-consumptions`)
      .set(auth());
    await api()
      .post(
        `/api/v1/utility/abnormal-consumptions/${listed.body.data[0].id}/resolve`,
      )
      .set(auth())
      .send({ status: 'RESOLVED', resolutionNotes: 'Faulty meter replaced.' });

    const after = await api()
      .get(`${AGG}/abnormal?buildingId=${fixture.building.id}`)
      .set(auth());
    assert.equal(after.body.data.total, 2);
    assert.equal(after.body.data.open, 1);
    assert.equal(after.body.data.resolved, 1);

    // The headline summary carries the same counts.
    const headline = await summary(`buildingId=${fixture.building.id}`);
    assert.equal(headline.body.data.abnormal.total, 2);
    assert.equal(headline.body.data.abnormal.open, 1);
  });
});

describe('BE-18M utility aggregation — verification and approval summary', () => {
  it('summarises BE-18K verification and BE-18L approval status', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    // CR-BE-TEST-02: the BE-18L binding path requires a TENANT-purpose
    // meter — only those carry Tenant charges into Tenant approval.
    const meter = await createMeter(fixture, 'ELECTRICITY', undefined, 'TENANT');

    const tenant = await api()
      .post(`/api/v1/clients/${fixture.client.id}/tenant-companies`)
      .set(auth())
      .send({ tenantCode: `TEN_${suffix()}`, tenantName: 'Tenant Co' });
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

    const series = await createSeries(meter.id, [900]);

    await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-abnormality-rules`)
      .set(auth())
      .send({
        utilityType: 'ELECTRICITY',
        abnormalityType: 'HIGH_USAGE',
        name: 'High usage rule',
        thresholdValue: 500,
        comparisonMode: 'ABSOLUTE',
      });
    const detected = await api()
      .post(`/api/v1/utility/consumptions/${series[0].id}/abnormality-evaluations`)
      .set(auth())
      .send({});
    const abnormalityId = detected.body.data.detections[0].id;

    // Before any review, the abnormality counts as unverified.
    const initial = await api()
      .get(`${AGG}/verification-approval?buildingId=${fixture.building.id}`)
      .set(auth());
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    assert.equal(initial.body.data.verification.unverified, 1);
    assert.equal(initial.body.data.verification.approved, 0);

    // Open a review → PENDING.
    await api()
      .post(
        `/api/v1/utility/abnormal-consumptions/${abnormalityId}/verification/open`,
      )
      .set(auth())
      .send({});
    const pending = await api()
      .get(`${AGG}/verification-approval?buildingId=${fixture.building.id}`)
      .set(auth());
    assert.equal(pending.body.data.verification.pending, 1);
    assert.equal(pending.body.data.verification.unverified, 0);

    // Decide it → APPROVED.
    await api()
      .post(`/api/v1/utility/abnormal-consumptions/${abnormalityId}/verification`)
      .set(auth())
      .send({ decision: 'APPROVED' });
    const verified = await api()
      .get(`${AGG}/verification-approval?buildingId=${fixture.building.id}`)
      .set(auth());
    assert.equal(verified.body.data.verification.approved, 1);
    assert.equal(verified.body.data.verification.pending, 0);

    // A Tenant charge with no binding yet counts as unbound.
    // CR-BE-TEST-02: use the UTL-01 PART 10 Building tariff so the resulting
    // calculation carries a complete tariff snapshot (tariffId, tariffRate,
    // currency) — the BE-18L binding path requires it.
    await api()
      .post(`/api/v1/buildings/${fixture.building.id}/utility-tariffs`)
      .set(auth())
      .send({
        utilityType: 'ELECTRICITY',
        currency: 'IDR',
        uomId: fixture.uomId,
        ratePerUom: '2',
        effectiveFrom: '2025-01-01T00:00:00.000Z',
      });
    const calculation = await api()
      .post(`/api/v1/utility/consumptions/${series[0].id}/calculations`)
      .set(auth())
      .send({});
    assert.equal(calculation.status, 201, JSON.stringify(calculation.body));

    const unbound = await api()
      .get(`${AGG}/verification-approval?buildingId=${fixture.building.id}`)
      .set(auth());
    assert.equal(unbound.body.data.approval.unbound, 1);

    await api()
      .post(`/api/v1/utility/calculations/${calculation.body.data.id}/finalize`)
      .set(auth())
      .send({});
    const binding = await api()
      .post('/api/v1/tenant-approvals')
      .set(auth())
      .send({
        requestType: 'UTILITY_CALCULATION',
        requestId: calculation.body.data.id,
        approvalType: 'TENANT_UTILITY_CHARGE',
        approverUserId: adminUserId,
      });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    const bound = await api()
      .get(`${AGG}/verification-approval?buildingId=${fixture.building.id}`)
      .set(auth());
    assert.equal(bound.body.data.approval.pending, 1);
    assert.equal(bound.body.data.approval.unbound, 0);

    await api()
      .post(`/api/v1/tenant-approvals/${binding.body.data.id}/approve`)
      .set(auth())
      .send({});
    const approved = await api()
      .get(`${AGG}/verification-approval?buildingId=${fixture.building.id}`)
      .set(auth());
    assert.equal(approved.body.data.approval.approved, 1);
    assert.equal(approved.body.data.approval.pending, 0);

    // The headline summary reports the same state.
    const headline = await summary(`buildingId=${fixture.building.id}`);
    assert.equal(
      headline.body.data.verificationApproval.verification.approved,
      1,
    );
    assert.equal(headline.body.data.verificationApproval.approval.approved, 1);
  });
});

describe('BE-18M utility aggregation — RBAC', () => {
  it('requires authentication on every aggregation endpoint', async (t) => {
    if (!requireDatabase(t)) return;

    for (const response of [
      await api().get(`${AGG}/summary`),
      await api().get(`${AGG}/consumption`),
      await api().get(`${AGG}/abnormal`),
      await api().get(`${AGG}/verification-approval`),
    ]) {
      assert.equal(response.status, 401, JSON.stringify(response.body));
    }
  });

  it('denies a session without the utility read permission', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const plainToken = await createPlainSession();

    const denied = await summary(
      `buildingId=${fixture.building.id}`,
      plainToken,
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));

    const grouped = await consumption(
      `buildingId=${fixture.building.id}`,
      plainToken,
    );
    assert.equal(grouped.status, 403, JSON.stringify(grouped.body));
  });
});

describe('BE-18M utility aggregation — client and building isolation', () => {
  it('denies aggregating a building the actor is not assigned to', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    await createSeries(meter.id, [100]);

    // A second administrator with full RBAC but no assignment to this Building.
    const outsider = await createAdminUser();

    const building = await summary(
      `buildingId=${fixture.building.id}`,
      outsider.token,
    );
    assert.equal(building.status, 403, JSON.stringify(building.body));
    assert.equal(building.body.error.code, 'BUILDING_ACCESS_DENIED');

    const byMeter = await summary(`meterId=${meter.id}`, outsider.token);
    assert.equal(byMeter.status, 403, JSON.stringify(byMeter.body));

    const client = await summary(
      `clientId=${fixture.client.id}`,
      outsider.token,
    );
    assert.equal(client.status, 403, JSON.stringify(client.body));
  });

  it('never sums across clients', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    await createSeries(meter.id, [100]);

    const otherFixture = await createStructure();
    const otherMeter = await createMeter(otherFixture);
    await createSeries(otherMeter.id, [500]);

    const mine = await summary(`clientId=${fixture.client.id}`);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body.data.totals.totalConsumption, 100);
    assert.equal(mine.body.data.scope.resolvedClientId, fixture.client.id);

    const theirs = await summary(`clientId=${otherFixture.client.id}`);
    assert.equal(theirs.body.data.totals.totalConsumption, 500);

    // Each Client's building breakdown contains only its own Buildings.
    const buildings = await consumption(
      `clientId=${fixture.client.id}&groupBy=BUILDING`,
    );
    assert.equal(buildings.body.data.length, 1);
    assert.equal(buildings.body.data[0].key, fixture.building.id);
  });
});
