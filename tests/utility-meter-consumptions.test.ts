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
 * BE-18G — Consumption focused validation.
 *
 * Covers only this PART: deriving consumption from two authoritative BE-18E
 * readings, getting a consumption, listing by Meter / Tenant / Building /
 * period, resolving the latest consumption, plus the guard rails —
 * previous/current reading validation, negative consumption rejection, UOM
 * consistency, period validation, Tenant/Building context, RBAC and
 * Client / Building isolation.
 *
 * Tariffs, rates, cost and billing are deliberately never exercised: they are
 * out of BE-18 entirely. BE-18C Main/Sub hierarchy is untouched.
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

/** BE-18A Meter — BE-18G never creates meters. */
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

/** BE-18E Meter Reading — the authoritative operand of every calculation. */
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
  return created.body.data as { id: string; readingValue: number };
}

function calculate(
  meterId: string,
  body: Record<string, unknown>,
  token = adminToken,
) {
  return api()
    .post(`/api/v1/utility/meters/${meterId}/consumptions`)
    .set(auth(token))
    .send(body);
}

/** A Meter with two readings 100 → 350 across March. */
async function consumptionScenario() {
  const fixture = await createStructure();
  const meter = await createMeter(fixture);
  const previous = await createReading(meter.id, 100, '2026-03-01T00:00:00.000Z');
  const current = await createReading(meter.id, 350, '2026-04-01T00:00:00.000Z');
  return { fixture, meter, previous, current };
}

describe('BE-18G consumption — valid calculation', () => {
  it('derives consumption as current minus previous', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, previous, current } = await consumptionScenario();

    const created = await calculate(meter.id, {
      currentReadingId: current.id,
      previousReadingId: previous.id,
    });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    const consumption = created.body.data;
    // 350 - 100 = 250
    assert.equal(consumption.consumptionValue, 250);
    assert.equal(consumption.meterId, meter.id);
    assert.equal(consumption.previousReadingId, previous.id);
    assert.equal(consumption.currentReadingId, current.id);
    // The period mirrors the two reading instants.
    assert.equal(consumption.periodStart, '2026-03-01T00:00:00.000Z');
    assert.equal(consumption.periodEnd, '2026-04-01T00:00:00.000Z');
    assert.ok(consumption.calculatedAt);
    assert.equal(consumption.calculatedByUserId, adminUserId);
    // Client / Building / UOM derive from authoritative records.
    assert.equal(consumption.clientId, fixture.client.id);
    assert.equal(consumption.buildingId, fixture.building.id);
    assert.equal(consumption.uomId, fixture.uomId);
  });

  it('resolves the previous reading automatically when omitted', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, previous, current } = await consumptionScenario();

    const created = await calculate(meter.id, {
      currentReadingId: current.id,
    });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.previousReadingId, previous.id);
    assert.equal(created.body.data.consumptionValue, 250);
  });

  it('reads through to the endpoint readings without copying values', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, previous, current } = await consumptionScenario();
    const created = await calculate(meter.id, { currentReadingId: current.id });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // The response exposes reading context...
    assert.equal(created.body.data.previousReading.readingValue, 100);
    assert.equal(created.body.data.currentReading.readingValue, 350);
    assert.equal(created.body.data.previousReading.id, previous.id);

    // ...but the stored row holds only references, never the values.
    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'utility_meter_consumptions'
         AND column_name LIKE '%reading%'
       ORDER BY column_name`,
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      ['current_reading_id', 'previous_reading_id'],
    );
  });

  it('accepts a zero delta when the meter did not advance', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    await createReading(meter.id, 500, '2026-03-01T00:00:00.000Z');
    const current = await createReading(
      meter.id,
      500,
      '2026-04-01T00:00:00.000Z',
    );

    const created = await calculate(meter.id, { currentReadingId: current.id });

    // Zero is a legitimate measurement (an empty unit), unlike a negative.
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.consumptionValue, 0);
  });

  it('gets a consumption by id', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, current } = await consumptionScenario();
    const created = await calculate(meter.id, { currentReadingId: current.id });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const fetched = await api()
      .get(`/api/v1/utility/meter-consumptions/${created.body.data.id}`)
      .set(auth());

    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.id, created.body.data.id);
    assert.equal(fetched.body.data.consumptionValue, 250);
    assert.equal(fetched.body.data.meter.id, meter.id);
  });

  it('returns 404 for an unknown consumption', async (t) => {
    if (!requireDatabase(t)) return;

    const fetched = await api()
      .get(`/api/v1/utility/meter-consumptions/${randomUUID()}`)
      .set(auth());

    assert.equal(fetched.status, 404, JSON.stringify(fetched.body));
    assert.equal(fetched.body.error.code, 'UTILITY_METER_CONSUMPTION_NOT_FOUND');
  });

  it('rejects a caller-supplied consumption value', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, current } = await consumptionScenario();

    const created = await calculate(meter.id, {
      currentReadingId: current.id,
      consumptionValue: 9999,
    });

    // Consumption is derived; accepting a figure would be a second source.
    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(created.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-18G consumption — previous/current reading validation', () => {
  it('rejects an unknown current reading', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await consumptionScenario();

    const created = await calculate(meter.id, {
      currentReadingId: randomUUID(),
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(
      created.body.error.code,
      'UTILITY_METER_CONSUMPTION_READING_INVALID',
    );
  });

  it('rejects an unknown previous reading', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, current } = await consumptionScenario();

    const created = await calculate(meter.id, {
      currentReadingId: current.id,
      previousReadingId: randomUUID(),
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(
      created.body.error.code,
      'UTILITY_METER_CONSUMPTION_READING_INVALID',
    );
  });

  it("rejects a reading belonging to another meter", async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, current } = await consumptionScenario();
    const otherMeter = await createMeter(fixture);
    const foreignReading = await createReading(
      otherMeter.id,
      10,
      '2026-02-01T00:00:00.000Z',
    );

    const created = await calculate(meter.id, {
      currentReadingId: current.id,
      previousReadingId: foreignReading.id,
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(
      created.body.error.code,
      'UTILITY_METER_CONSUMPTION_READING_INVALID',
    );
  });

  it('rejects the same reading as both endpoints', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, current } = await consumptionScenario();

    const created = await calculate(meter.id, {
      currentReadingId: current.id,
      previousReadingId: current.id,
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(
      created.body.error.code,
      'UTILITY_METER_CONSUMPTION_READING_INVALID',
    );
  });

  it('rejects a calculation when no earlier reading exists', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const only = await createReading(meter.id, 100, '2026-03-01T00:00:00.000Z');

    const created = await calculate(meter.id, { currentReadingId: only.id });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(
      created.body.error.code,
      'UTILITY_METER_CONSUMPTION_READING_INVALID',
    );
  });

  it('rejects an unknown meter and a missing current reading', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, current } = await consumptionScenario();

    const unknownMeter = await calculate(randomUUID(), {
      currentReadingId: current.id,
    });
    assert.equal(unknownMeter.status, 404, JSON.stringify(unknownMeter.body));
    assert.equal(unknownMeter.body.error.code, 'UTILITY_METER_NOT_FOUND');

    const missing = await calculate(meter.id, {});
    assert.equal(missing.status, 400, JSON.stringify(missing.body));
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects recalculating the same closing reading', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, current } = await consumptionScenario();

    const first = await calculate(meter.id, { currentReadingId: current.id });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const again = await calculate(meter.id, { currentReadingId: current.id });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(
      again.body.error.code,
      'UTILITY_METER_CONSUMPTION_ALREADY_EXISTS',
    );
  });
});

describe('BE-18G consumption — negative consumption rejected', () => {
  it('rejects a delta where the meter went backwards', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    await createReading(meter.id, 900, '2026-03-01T00:00:00.000Z');
    const current = await createReading(
      meter.id,
      400,
      '2026-04-01T00:00:00.000Z',
    );

    const created = await calculate(meter.id, { currentReadingId: current.id });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(created.body.error.code, 'UTILITY_METER_CONSUMPTION_NEGATIVE');

    // Nothing was persisted — the rollover needs an explicit decision.
    const stored = await pool!.query(
      'SELECT count(*)::int AS n FROM utility_meter_consumptions WHERE meter_id = $1',
      [meter.id],
    );
    assert.equal(stored.rows[0].n, 0);
  });

  it('rejects a reversed pair supplied explicitly', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, previous, current } = await consumptionScenario();

    // Swapping the endpoints: 100 - 350 would be negative, and the period is
    // reversed too. Either way it must not be stored.
    const created = await calculate(meter.id, {
      currentReadingId: previous.id,
      previousReadingId: current.id,
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(
      created.body.error.code,
      'UTILITY_METER_CONSUMPTION_PERIOD_INVALID',
    );
  });
});

describe('BE-18G consumption — UOM consistency', () => {
  it('rejects readings that disagree on unit', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const previous = await createReading(
      meter.id,
      100,
      '2026-03-01T00:00:00.000Z',
    );
    const current = await createReading(
      meter.id,
      350,
      '2026-04-01T00:00:00.000Z',
    );

    // Force a divergence directly in the store: the meter's unit changed
    // under the readings, so the two operands are no longer comparable.
    const otherUomId = await createUom(fixture.client.id, 'm3');
    await pool!.query(
      'UPDATE utility_meter_readings SET uom_id = $1 WHERE id = $2',
      [otherUomId, previous.id],
    );

    const created = await calculate(meter.id, {
      currentReadingId: current.id,
      previousReadingId: previous.id,
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(
      created.body.error.code,
      'UTILITY_METER_CONSUMPTION_UOM_MISMATCH',
    );
  });

  it('rejects readings that no longer match the meter configuration', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const previous = await createReading(
      meter.id,
      100,
      '2026-03-01T00:00:00.000Z',
    );
    const current = await createReading(
      meter.id,
      350,
      '2026-04-01T00:00:00.000Z',
    );

    // Both readings agree with each other but not with the meter.
    const otherUomId = await createUom(fixture.client.id, 'm3');
    await pool!.query(
      'UPDATE utility_meter_readings SET uom_id = $1 WHERE id = ANY($2::uuid[])',
      [otherUomId, [previous.id, current.id]],
    );

    const created = await calculate(meter.id, {
      currentReadingId: current.id,
      previousReadingId: previous.id,
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(
      created.body.error.code,
      'UTILITY_METER_CONSUMPTION_UOM_MISMATCH',
    );
  });

  it('carries the reading unit onto the consumption', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, current } = await consumptionScenario();

    const created = await calculate(meter.id, { currentReadingId: current.id });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.uomId, fixture.uomId);
    assert.equal(created.body.data.uom.id, fixture.uomId);
  });
});

describe('BE-18G consumption — period validation and history', () => {
  it('lists a meter history newest period first', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const r1 = await createReading(meter.id, 100, '2026-01-01T00:00:00.000Z');
    const r2 = await createReading(meter.id, 200, '2026-02-01T00:00:00.000Z');
    const r3 = await createReading(meter.id, 450, '2026-03-01T00:00:00.000Z');

    await calculate(meter.id, {
      currentReadingId: r2.id,
      previousReadingId: r1.id,
    });
    await calculate(meter.id, {
      currentReadingId: r3.id,
      previousReadingId: r2.id,
    });

    const listed = await api()
      .get(`/api/v1/utility/meters/${meter.id}/consumptions`)
      .set(auth());

    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(
      listed.body.data.map((c: { consumptionValue: number }) => c.consumptionValue),
      [250, 100],
    );
  });

  it('resolves the latest consumption, and null when none exists', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);

    const empty = await api()
      .get(`/api/v1/utility/meters/${meter.id}/consumptions/latest`)
      .set(auth());
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(empty.body.data, null);

    const r1 = await createReading(meter.id, 100, '2026-01-01T00:00:00.000Z');
    const r2 = await createReading(meter.id, 200, '2026-02-01T00:00:00.000Z');
    const r3 = await createReading(meter.id, 450, '2026-03-01T00:00:00.000Z');
    await calculate(meter.id, {
      currentReadingId: r2.id,
      previousReadingId: r1.id,
    });
    await calculate(meter.id, {
      currentReadingId: r3.id,
      previousReadingId: r2.id,
    });

    const latest = await api()
      .get(`/api/v1/utility/meters/${meter.id}/consumptions/latest`)
      .set(auth());
    assert.equal(latest.status, 200, JSON.stringify(latest.body));
    assert.equal(latest.body.data.consumptionValue, 250);
    assert.equal(latest.body.data.periodEnd, '2026-03-01T00:00:00.000Z');
  });

  it('filters a meter history by period', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const r1 = await createReading(meter.id, 100, '2026-01-01T00:00:00.000Z');
    const r2 = await createReading(meter.id, 200, '2026-02-01T00:00:00.000Z');
    const r3 = await createReading(meter.id, 450, '2026-03-01T00:00:00.000Z');
    await calculate(meter.id, {
      currentReadingId: r2.id,
      previousReadingId: r1.id,
    });
    await calculate(meter.id, {
      currentReadingId: r3.id,
      previousReadingId: r2.id,
    });

    const listed = await api()
      .get(`/api/v1/utility/meters/${meter.id}/consumptions`)
      .query({ from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' })
      .set(auth());

    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 1);
    assert.equal(listed.body.data[0].consumptionValue, 250);
  });

  it('rejects a malformed period filter', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await consumptionScenario();

    const listed = await api()
      .get(`/api/v1/utility/meters/${meter.id}/consumptions`)
      .query({ from: 'last-tuesday' })
      .set(auth());

    assert.equal(listed.status, 400, JSON.stringify(listed.body));
    assert.equal(listed.body.error.code, 'VALIDATION_ERROR');
  });

  it('preserves calculation history — no update or delete route', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, current } = await consumptionScenario();
    const created = await calculate(meter.id, { currentReadingId: current.id });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;

    const patched = await api()
      .patch(`/api/v1/utility/meter-consumptions/${id}`)
      .set(auth())
      .send({ consumptionValue: 1 });
    assert.equal(patched.status, 404, JSON.stringify(patched.body));

    const deleted = await api()
      .delete(`/api/v1/utility/meter-consumptions/${id}`)
      .set(auth());
    assert.equal(deleted.status, 404, JSON.stringify(deleted.body));

    const fetched = await api()
      .get(`/api/v1/utility/meter-consumptions/${id}`)
      .set(auth());
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.data.consumptionValue, 250);
  });
});

describe('BE-18G consumption — tenant and building context', () => {
  it('snapshots the tenant context carried by the readings', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);

    const tenant = await api()
      .post(`/api/v1/clients/${fixture.client.id}/tenant-companies`)
      .set(auth())
      .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company' });
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

    // Both readings are taken while the tenant is in place.
    await createReading(meter.id, 100, '2026-03-01T00:00:00.000Z');
    const current = await createReading(
      meter.id,
      350,
      '2026-04-01T00:00:00.000Z',
    );

    const created = await calculate(meter.id, { currentReadingId: current.id });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.tenantCompanyId, tenant.body.data.id);
    assert.equal(
      created.body.data.tenantAssignmentId,
      assigned.body.data.id,
    );

    const byTenant = await api()
      .get(`/api/v1/tenant-companies/${tenant.body.data.id}/meter-consumptions`)
      .set(auth());
    assert.equal(byTenant.status, 200, JSON.stringify(byTenant.body));
    assert.equal(byTenant.body.data.length, 1);
    assert.equal(byTenant.body.data[0].consumptionValue, 250);
  });

  it('rejects a period spanning a change of tenant', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);

    // First reading with no tenant on the meter.
    const previous = await createReading(
      meter.id,
      100,
      '2026-03-01T00:00:00.000Z',
    );

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

    // Second reading now carries the tenant — the period straddles turnover.
    const current = await createReading(
      meter.id,
      350,
      '2026-04-01T00:00:00.000Z',
    );

    const created = await calculate(meter.id, {
      currentReadingId: current.id,
      previousReadingId: previous.id,
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(
      created.body.error.code,
      'UTILITY_METER_CONSUMPTION_TENANT_MISMATCH',
    );
  });

  it('returns 404 for an unknown tenant company', async (t) => {
    if (!requireDatabase(t)) return;

    const listed = await api()
      .get(`/api/v1/tenant-companies/${randomUUID()}/meter-consumptions`)
      .set(auth());

    assert.equal(listed.status, 404, JSON.stringify(listed.body));
    assert.equal(listed.body.error.code, 'TENANT_COMPANY_NOT_FOUND');
  });

  it('lists by building and never leaks another building', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, current } = await consumptionScenario();
    await calculate(meter.id, { currentReadingId: current.id });

    // A second building with its own meter and consumption.
    const otherFixture = await createStructure();
    const otherMeter = await createMeter(otherFixture);
    await createReading(otherMeter.id, 10, '2026-03-01T00:00:00.000Z');
    const otherCurrent = await createReading(
      otherMeter.id,
      99,
      '2026-04-01T00:00:00.000Z',
    );
    await calculate(otherMeter.id, { currentReadingId: otherCurrent.id });

    const listed = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/meter-consumptions`)
      .set(auth());

    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 1);
    assert.equal(listed.body.data[0].consumptionValue, 250);
    assert.equal(listed.body.data[0].buildingId, fixture.building.id);
  });
});

describe('BE-18G consumption — client and building isolation', () => {
  it('denies consumption in a building the user is not assigned to', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, current } = await consumptionScenario();
    const created = await calculate(meter.id, { currentReadingId: current.id });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // A second administrator with full RBAC but no assignment to this Building.
    const outsider = await createAdminUser();

    const calculated = await calculate(
      meter.id,
      { currentReadingId: current.id },
      outsider.token,
    );
    assert.equal(calculated.status, 403, JSON.stringify(calculated.body));
    assert.equal(calculated.body.error.code, 'BUILDING_ACCESS_DENIED');

    const fetched = await api()
      .get(`/api/v1/utility/meter-consumptions/${created.body.data.id}`)
      .set(auth(outsider.token));
    assert.equal(fetched.status, 403, JSON.stringify(fetched.body));

    const listed = await api()
      .get(`/api/v1/utility/meters/${meter.id}/consumptions`)
      .set(auth(outsider.token));
    assert.equal(listed.status, 403, JSON.stringify(listed.body));

    const latest = await api()
      .get(`/api/v1/utility/meters/${meter.id}/consumptions/latest`)
      .set(auth(outsider.token));
    assert.equal(latest.status, 403, JSON.stringify(latest.body));

    const byBuilding = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/meter-consumptions`)
      .set(auth(outsider.token));
    assert.equal(byBuilding.status, 403, JSON.stringify(byBuilding.body));
  });

  it("hides a tenant's consumption from a user outside that client", async (t) => {
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
    await createReading(meter.id, 100, '2026-03-01T00:00:00.000Z');
    const current = await createReading(
      meter.id,
      350,
      '2026-04-01T00:00:00.000Z',
    );
    await calculate(meter.id, { currentReadingId: current.id });

    const outsider = await createAdminUser();

    const listed = await api()
      .get(`/api/v1/tenant-companies/${tenant.body.data.id}/meter-consumptions`)
      .set(auth(outsider.token));

    assert.equal(listed.status, 403, JSON.stringify(listed.body));
    assert.equal(listed.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('BE-18G consumption — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, current } = await consumptionScenario();

    const calculated = await api()
      .post(`/api/v1/utility/meters/${meter.id}/consumptions`)
      .send({ currentReadingId: current.id });
    assert.equal(calculated.status, 401, JSON.stringify(calculated.body));

    const listed = await api().get(
      `/api/v1/utility/meters/${meter.id}/consumptions`,
    );
    assert.equal(listed.status, 401, JSON.stringify(listed.body));
  });

  it('denies a user without utility_meter permissions (default-deny)', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, current } = await consumptionScenario();
    const plainToken = await createPlainSession();

    const calculated = await calculate(
      meter.id,
      { currentReadingId: current.id },
      plainToken,
    );
    assert.equal(calculated.status, 403, JSON.stringify(calculated.body));

    const listed = await api()
      .get(`/api/v1/utility/meters/${meter.id}/consumptions`)
      .set(auth(plainToken));
    assert.equal(listed.status, 403);

    const latest = await api()
      .get(`/api/v1/utility/meters/${meter.id}/consumptions/latest`)
      .set(auth(plainToken));
    assert.equal(latest.status, 403);

    const byBuilding = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/meter-consumptions`)
      .set(auth(plainToken));
    assert.equal(byBuilding.status, 403);

    const fetched = await api()
      .get(`/api/v1/utility/meter-consumptions/${randomUUID()}`)
      .set(auth(plainToken));
    assert.equal(fetched.status, 403);
  });
});
