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
 * BE-18H — Usage History focused validation.
 *
 * Covers only this PART: reading the chronological usage projection over
 * authoritative BE-18G consumptions — history by Meter, filtering by Tenant /
 * Building / period, resolving chronological order, the latest entry, UOM
 * consistency, source Consumption linkage, RBAC and Client / Building
 * isolation.
 *
 * BE-18H owns no table and writes nothing: the suite asserts that too.
 * Tariffs, rates, cost and billing are deliberately never exercised.
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
    `TRUNCATE utility_meter_consumptions, evidence_submissions,
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

async function createMeter(fixture: Fixture, options: { uomId?: string } = {}) {
  const created = await api()
    .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
    .set(auth())
    .send({
      code: `MTR_${suffix()}`,
      name: 'Utility meter',
      utilityType: 'ELECTRICITY',
      uomId: options.uomId ?? fixture.uomId,
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

async function calculate(meterId: string, currentReadingId: string) {
  const created = await api()
    .post(`/api/v1/utility/meters/${meterId}/consumptions`)
    .set(auth())
    .send({ currentReadingId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data as { id: string; consumptionValue: number };
}

/**
 * A meter with three monthly consumptions: 100, 150, 200 across Jan–Apr.
 * Readings 100 → 200 → 350 → 550.
 */
async function historyScenario() {
  const fixture = await createStructure();
  const meter = await createMeter(fixture);
  const r1 = await createReading(meter.id, 100, '2026-01-01T00:00:00.000Z');
  const r2 = await createReading(meter.id, 200, '2026-02-01T00:00:00.000Z');
  const r3 = await createReading(meter.id, 350, '2026-03-01T00:00:00.000Z');
  const r4 = await createReading(meter.id, 550, '2026-04-01T00:00:00.000Z');
  const c1 = await calculate(meter.id, r2.id); // 100
  const c2 = await calculate(meter.id, r3.id); // 150
  const c3 = await calculate(meter.id, r4.id); // 200
  return { fixture, meter, readings: [r1, r2, r3, r4], consumptions: [c1, c2, c3] };
}

const values = (body: { data: { entries: { consumptionValue: number }[] } }) =>
  body.data.entries.map((entry) => entry.consumptionValue);

describe('BE-18H usage history — chronological history', () => {
  it('returns meter usage history oldest-first by default', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await historyScenario();

    const response = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    // History reads forward in time.
    assert.deepEqual(values(response.body), [100, 150, 200]);
    assert.equal(response.body.data.entryCount, 3);
    assert.equal(response.body.data.periodStart, '2026-01-01T00:00:00.000Z');
    assert.equal(response.body.data.periodEnd, '2026-04-01T00:00:00.000Z');
  });

  it('supports reverse chronological order', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await historyScenario();

    const response = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .query({ order: 'DESC' })
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(values(response.body), [200, 150, 100]);
  });

  it('rejects an invalid order', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await historyScenario();

    const response = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .query({ order: 'SIDEWAYS' })
      .set(auth());

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns an empty history for a meter with no consumption', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);

    const response = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.entries, []);
    assert.equal(response.body.data.entryCount, 0);
    assert.equal(response.body.data.totalConsumption, 0);
    assert.equal(response.body.data.periodStart, null);
  });

  it('resolves the latest usage entry, and null when none exists', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);

    const empty = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history/latest`)
      .set(auth());
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(empty.body.data, null);

    const r1 = await createReading(meter.id, 100, '2026-01-01T00:00:00.000Z');
    const r2 = await createReading(meter.id, 200, '2026-02-01T00:00:00.000Z');
    const r3 = await createReading(meter.id, 350, '2026-03-01T00:00:00.000Z');
    await calculate(meter.id, r2.id);
    const newest = await calculate(meter.id, r3.id);
    void r1;

    const latest = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history/latest`)
      .set(auth());
    assert.equal(latest.status, 200, JSON.stringify(latest.body));
    assert.equal(latest.body.data.consumptionValue, 150);
    assert.equal(latest.body.data.consumptionId, newest.id);
    assert.equal(latest.body.data.periodEnd, '2026-03-01T00:00:00.000Z');
  });

  it('exposes no write route — history cannot be created or amended', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await historyScenario();

    const posted = await api()
      .post(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .set(auth())
      .send({ consumptionValue: 1 });
    assert.equal(posted.status, 404, JSON.stringify(posted.body));

    const deleted = await api()
      .delete(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .set(auth());
    assert.equal(deleted.status, 404, JSON.stringify(deleted.body));

    // BE-18H owns no table: the projection reads BE-18G only.
    const tables = await pool!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE '%usage_history%'`,
    );
    assert.equal(tables.rowCount, 0);
  });
});

describe('BE-18H usage history — source consumption linkage', () => {
  it('links every entry back to its authoritative consumption and readings', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, readings, consumptions } = await historyScenario();

    const response = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const first = response.body.data.entries[0];
    // The entry's identity IS the source consumption's identity.
    assert.equal(first.consumptionId, consumptions[0].id);
    assert.equal(first.usageId, first.consumptionId);
    // And it carries the two BE-18E readings behind the figure.
    assert.equal(first.previousReadingId, readings[0].id);
    assert.equal(first.currentReadingId, readings[1].id);
    assert.equal(first.meterId, meter.id);
    assert.ok(first.calculatedAt);
  });

  it('matches the authoritative consumption record exactly', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, consumptions } = await historyScenario();

    const history = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .set(auth());
    const entry = history.body.data.entries[1];

    const source = await api()
      .get(`/api/v1/utility/meter-consumptions/${consumptions[1].id}`)
      .set(auth());
    assert.equal(source.status, 200, JSON.stringify(source.body));

    // The projection never restates a different figure than its source.
    assert.equal(entry.consumptionValue, source.body.data.consumptionValue);
    assert.equal(entry.periodStart, source.body.data.periodStart);
    assert.equal(entry.periodEnd, source.body.data.periodEnd);
    assert.equal(entry.uomId, source.body.data.uomId);
  });

  it('reflects a newly calculated consumption immediately', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await historyScenario();

    const before = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .set(auth());
    assert.equal(before.body.data.entryCount, 3);

    const r5 = await createReading(meter.id, 700, '2026-05-01T00:00:00.000Z');
    await calculate(meter.id, r5.id);

    const after = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .set(auth());
    // A projection has no cache to invalidate.
    assert.equal(after.body.data.entryCount, 4);
    assert.deepEqual(values(after.body), [100, 150, 200, 150]);
  });
});

describe('BE-18H usage history — meter filtering', () => {
  it('filters a building history down to one meter', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await historyScenario();

    // A second meter in the same building with its own usage.
    const otherMeter = await createMeter(fixture);
    await createReading(otherMeter.id, 10, '2026-01-01T00:00:00.000Z');
    const o2 = await createReading(otherMeter.id, 60, '2026-02-01T00:00:00.000Z');
    await calculate(otherMeter.id, o2.id); // 50

    const all = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/usage-history`)
      .set(auth());
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(all.body.data.entryCount, 4);

    const filtered = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/usage-history`)
      .query({ meterId: meter.id })
      .set(auth());
    assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
    assert.deepEqual(values(filtered.body), [100, 150, 200]);
  });

  it('resolves history by meter through the collection endpoint', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await historyScenario();

    const response = await api()
      .get('/api/v1/utility/usage-history')
      .query({ meterId: meter.id })
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(values(response.body), [100, 150, 200]);
  });

  it('rejects an unknown meter and a malformed meter id', async (t) => {
    if (!requireDatabase(t)) return;

    const unknown = await api()
      .get(`/api/v1/utility/meters/${randomUUID()}/usage-history`)
      .set(auth());
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(unknown.body.error.code, 'UTILITY_METER_NOT_FOUND');

    const malformed = await api()
      .get('/api/v1/utility/meters/not-a-uuid/usage-history')
      .set(auth());
    assert.equal(malformed.status, 400, JSON.stringify(malformed.body));
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-18H usage history — tenant filtering', () => {
  it('returns usage history for a tenant company', async (t) => {
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

    await createReading(meter.id, 100, '2026-01-01T00:00:00.000Z');
    const r2 = await createReading(meter.id, 250, '2026-02-01T00:00:00.000Z');
    await calculate(meter.id, r2.id); // 150

    const response = await api()
      .get(`/api/v1/tenant-companies/${tenant.body.data.id}/usage-history`)
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(values(response.body), [150]);
    assert.equal(
      response.body.data.entries[0].tenantCompanyId,
      tenant.body.data.id,
    );
    assert.equal(
      response.body.data.entries[0].tenantAssignmentId,
      assigned.body.data.id,
    );
  });

  it('excludes usage that belongs to no tenant', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const tenantMeter = await createMeter(fixture);
    const houseMeter = await createMeter(fixture);

    const tenant = await api()
      .post(`/api/v1/clients/${fixture.client.id}/tenant-companies`)
      .set(auth())
      .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company' });
    await api()
      .post(`/api/v1/tenant-companies/${tenant.body.data.id}/spaces`)
      .set(auth())
      .send({ buildingId: fixture.building.id, spaceId: fixture.space.id });
    await api()
      .post(`/api/v1/utility/meters/${tenantMeter.id}/tenant-assignments`)
      .set(auth())
      .send({
        tenantCompanyId: tenant.body.data.id,
        spaceId: fixture.space.id,
      });

    await createReading(tenantMeter.id, 0, '2026-01-01T00:00:00.000Z');
    const t2 = await createReading(tenantMeter.id, 90, '2026-02-01T00:00:00.000Z');
    await calculate(tenantMeter.id, t2.id); // 90, tenant

    await createReading(houseMeter.id, 0, '2026-01-01T00:00:00.000Z');
    const h2 = await createReading(houseMeter.id, 40, '2026-02-01T00:00:00.000Z');
    await calculate(houseMeter.id, h2.id); // 40, common area

    const response = await api()
      .get(`/api/v1/tenant-companies/${tenant.body.data.id}/usage-history`)
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    // Only the tenant's own meter — common-area usage is not attributed.
    assert.deepEqual(values(response.body), [90]);
  });

  it('returns 404 for an unknown tenant company', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/tenant-companies/${randomUUID()}/usage-history`)
      .set(auth());

    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'TENANT_COMPANY_NOT_FOUND');
  });
});

describe('BE-18H usage history — building filtering', () => {
  it('aggregates every meter in a building and leaks no other building', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture } = await historyScenario();

    // A second building of the same client with its own usage.
    const otherFixture = await createStructure();
    const otherMeter = await createMeter(otherFixture);
    await createReading(otherMeter.id, 0, '2026-01-01T00:00:00.000Z');
    const o2 = await createReading(otherMeter.id, 999, '2026-02-01T00:00:00.000Z');
    await calculate(otherMeter.id, o2.id);

    const response = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/usage-history`)
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(values(response.body), [100, 150, 200]);
    assert.equal(response.body.data.totalConsumption, 450);
    for (const entry of response.body.data.entries) {
      assert.equal(entry.buildingId, fixture.building.id);
    }
  });

  it('resolves history by building through the collection endpoint', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture } = await historyScenario();

    const response = await api()
      .get('/api/v1/utility/usage-history')
      .query({ buildingId: fixture.building.id })
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(values(response.body), [100, 150, 200]);
  });
});

describe('BE-18H usage history — period filtering', () => {
  it('filters to consumptions fully inside the window', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await historyScenario();

    const response = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .query({ from: '2026-02-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' })
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    // Feb→Mar (150) and Mar→Apr (200); Jan→Feb starts before the window.
    assert.deepEqual(values(response.body), [150, 200]);
    assert.equal(response.body.data.totalConsumption, 350);
  });

  it('returns an empty window when nothing falls inside', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await historyScenario();

    const response = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .query({ from: '2027-01-01T00:00:00.000Z' })
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.entryCount, 0);
  });

  it('rejects a malformed period and an invalid limit', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await historyScenario();

    const badDate = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .query({ from: 'whenever' })
      .set(auth());
    assert.equal(badDate.status, 400, JSON.stringify(badDate.body));
    assert.equal(badDate.body.error.code, 'VALIDATION_ERROR');

    const badLimit = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .query({ limit: '0' })
      .set(auth());
    assert.equal(badLimit.status, 400, JSON.stringify(badLimit.body));
  });

  it('honours an explicit limit', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await historyScenario();

    const response = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .query({ limit: '2' })
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.entryCount, 2);
  });
});

describe('BE-18H usage history — UOM consistency', () => {
  it('reports a single unit and a total when all entries agree', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await historyScenario();

    const response = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.uomConsistent, true);
    assert.equal(response.body.data.uomId, fixture.uomId);
    assert.equal(response.body.data.totalConsumption, 450);
    for (const entry of response.body.data.entries) {
      assert.equal(entry.uomId, fixture.uomId);
      assert.equal(entry.uom.id, fixture.uomId);
    }
  });

  it('refuses to total a window that mixes units', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await historyScenario();

    // Simulate a unit change part-way through the meter's life.
    const otherUomId = await createUom(fixture.client.id, 'm3');
    const rows = await pool!.query<{ id: string }>(
      `SELECT id FROM utility_meter_consumptions
       WHERE meter_id = $1 ORDER BY period_end ASC LIMIT 1`,
      [meter.id],
    );
    await pool!.query(
      'UPDATE utility_meter_consumptions SET uom_id = $1 WHERE id = $2',
      [otherUomId, rows.rows[0].id],
    );

    const response = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    // Entries are still returned, but adding kWh to m³ is refused.
    assert.equal(response.body.data.entryCount, 3);
    assert.equal(response.body.data.uomConsistent, false);
    assert.equal(response.body.data.uomId, null);
    assert.equal(response.body.data.totalConsumption, 0);
  });
});

describe('BE-18H usage history — client and building isolation', () => {
  it('denies history for a building the user is not assigned to', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await historyScenario();

    // A second administrator with full RBAC but no assignment to this Building.
    const outsider = await createAdminUser();

    const byMeter = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .set(auth(outsider.token));
    assert.equal(byMeter.status, 403, JSON.stringify(byMeter.body));
    assert.equal(byMeter.body.error.code, 'BUILDING_ACCESS_DENIED');

    const latest = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history/latest`)
      .set(auth(outsider.token));
    assert.equal(latest.status, 403, JSON.stringify(latest.body));

    const byBuilding = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/usage-history`)
      .set(auth(outsider.token));
    assert.equal(byBuilding.status, 403, JSON.stringify(byBuilding.body));

    const collection = await api()
      .get('/api/v1/utility/usage-history')
      .query({ meterId: meter.id })
      .set(auth(outsider.token));
    assert.equal(collection.status, 403, JSON.stringify(collection.body));
  });

  it('returns nothing on an unscoped query for an unassigned user', async (t) => {
    if (!requireDatabase(t)) return;
    await historyScenario();

    const outsider = await createAdminUser();

    const response = await api()
      .get('/api/v1/utility/usage-history')
      .set(auth(outsider.token));

    // Bounded by the accessible Building set, which is empty.
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.entryCount, 0);
  });

  it("hides a tenant's history from a user outside that client", async (t) => {
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
    await createReading(meter.id, 0, '2026-01-01T00:00:00.000Z');
    const r2 = await createReading(meter.id, 75, '2026-02-01T00:00:00.000Z');
    await calculate(meter.id, r2.id);

    const outsider = await createAdminUser();

    const response = await api()
      .get(`/api/v1/tenant-companies/${tenant.body.data.id}/usage-history`)
      .set(auth(outsider.token));

    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('BE-18H usage history — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await historyScenario();

    const byMeter = await api().get(
      `/api/v1/utility/meters/${meter.id}/usage-history`,
    );
    assert.equal(byMeter.status, 401, JSON.stringify(byMeter.body));

    const collection = await api().get('/api/v1/utility/usage-history');
    assert.equal(collection.status, 401, JSON.stringify(collection.body));
  });

  it('denies a user without utility_meter permissions (default-deny)', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await historyScenario();
    const plainToken = await createPlainSession();

    const byMeter = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history`)
      .set(auth(plainToken));
    assert.equal(byMeter.status, 403, JSON.stringify(byMeter.body));

    const latest = await api()
      .get(`/api/v1/utility/meters/${meter.id}/usage-history/latest`)
      .set(auth(plainToken));
    assert.equal(latest.status, 403);

    const byBuilding = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/usage-history`)
      .set(auth(plainToken));
    assert.equal(byBuilding.status, 403);

    const byTenant = await api()
      .get(`/api/v1/tenant-companies/${randomUUID()}/usage-history`)
      .set(auth(plainToken));
    assert.equal(byTenant.status, 403);

    const collection = await api()
      .get('/api/v1/utility/usage-history')
      .set(auth(plainToken));
    assert.equal(collection.status, 403);
  });
});
