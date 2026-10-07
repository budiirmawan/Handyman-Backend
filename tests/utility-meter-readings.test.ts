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
 * BE-18E — Meter Reading focused validation.
 *
 * Covers only this PART: recording a reading against an existing BE-18A
 * Meter, getting a reading, listing by Meter / Tenant / Building / date,
 * getting the latest reading, plus the guard rails — invalid meter, invalid
 * UOM, invalid reading value, chronological handling, Tenant/Building context
 * validation, posted-reading history preservation, RBAC and Client / Building
 * isolation.
 *
 * Consumption is deliberately never asserted (BE-18G) and Reading Evidence is
 * not exercised (BE-18F). BE-18C Main/Sub hierarchy is untouched.
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
    `TRUNCATE utility_meter_readings, utility_meter_tenant_assignments,
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

/** Registers a BE-18A Meter — BE-18E always reads existing meters. */
async function createMeter(
  fixture: Fixture,
  options: { status?: 'ACTIVE' | 'INACTIVE'; uomId?: string } = {},
) {
  const created = await api()
    .post(`/api/v1/buildings/${fixture.building.id}/utility-meters`)
    .set(auth())
    .send({
      code: `MTR_${suffix()}`,
      name: 'Tenant meter',
      utilityType: 'ELECTRICITY',
      uomId: options.uomId ?? fixture.uomId,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  if (options.status === 'INACTIVE') {
    const patched = await api()
      .patch(`/api/v1/utility/meters/${created.body.data.id}/status`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
  }
  return created.body.data as { id: string; code: string; uomId: string };
}

async function createTenantCompany(clientId: string) {
  const created = await api()
    .post(`/api/v1/clients/${clientId}/tenant-companies`)
    .set(auth())
    .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data as { id: string };
}

/** BE-14C tenancy, then the BE-18D assignment BE-18E snapshots. */
async function assignMeterToTenant(
  meterId: string,
  tenantCompanyId: string,
  buildingId: string,
  spaceId: string,
) {
  const leased = await api()
    .post(`/api/v1/tenant-companies/${tenantCompanyId}/spaces`)
    .set(auth())
    .send({ buildingId, spaceId });
  assert.equal(leased.status, 201, JSON.stringify(leased.body));

  const assigned = await api()
    .post(`/api/v1/utility/meters/${meterId}/tenant-assignments`)
    .set(auth())
    .send({ tenantCompanyId, spaceId });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  return assigned.body.data as { id: string };
}

async function record(
  meterId: string,
  body: Record<string, unknown>,
  token = adminToken,
) {
  return api()
    .post(`/api/v1/utility/meters/${meterId}/readings`)
    .set(auth(token))
    .send(body);
}

/** A Meter in an accessible Building, ready to be read. */
async function meterScenario() {
  const fixture = await createStructure();
  const meter = await createMeter(fixture);
  return { fixture, meter };
}

describe('BE-18E meter reading — valid reading', () => {
  it('records a reading against an existing meter', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await meterScenario();

    const created = await record(meter.id, {
      readingValue: 1234.5,
      readingAt: '2026-03-01T08:00:00.000Z',
      notes: 'Monthly round',
    });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    const reading = created.body.data;
    assert.equal(reading.meterId, meter.id);
    assert.equal(reading.readingValue, 1234.5);
    assert.equal(reading.readingAt, '2026-03-01T08:00:00.000Z');
    assert.equal(reading.notes, 'Monthly round');
    // Client / Building are derived from the Meter, never from the caller.
    assert.equal(reading.clientId, fixture.client.id);
    assert.equal(reading.buildingId, fixture.building.id);
    // BE-07 UOM defaults to the meter configuration.
    assert.equal(reading.uomId, fixture.uomId);
    assert.equal(reading.uom.id, fixture.uomId);
    // Attribution and defaults.
    assert.equal(reading.recordedByUserId, adminUserId);
    assert.equal(reading.source, 'MANUAL');
    assert.equal(reading.readingType, 'ACTUAL');
    // No tenant assignment on this meter.
    assert.equal(reading.tenantCompanyId, null);
    assert.equal(reading.tenantAssignmentId, null);
    // BE-10C linkage is absent for a plain manual reading.
    assert.equal(reading.meterReadingBindingId, null);
    assert.equal(reading.formInstanceId, null);
  });

  it('accepts an explicitly restated meter UOM, a source and a reading type', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await meterScenario();

    const created = await record(meter.id, {
      readingValue: 10,
      readingAt: '2026-03-02T08:00:00.000Z',
      uomId: fixture.uomId,
      source: 'IMPORT',
      readingType: 'ESTIMATED',
    });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.source, 'IMPORT');
    assert.equal(created.body.data.readingType, 'ESTIMATED');
  });

  it('gets a recorded reading by id', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();
    const created = await record(meter.id, {
      readingValue: 42,
      readingAt: '2026-03-03T08:00:00.000Z',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const fetched = await api()
      .get(`/api/v1/utility/meter-readings/${created.body.data.id}`)
      .set(auth());

    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.id, created.body.data.id);
    assert.equal(fetched.body.data.readingValue, 42);
    assert.equal(fetched.body.data.meter.id, meter.id);
  });

  it('returns 404 for an unknown reading', async (t) => {
    if (!requireDatabase(t)) return;

    const fetched = await api()
      .get(`/api/v1/utility/meter-readings/${randomUUID()}`)
      .set(auth());

    assert.equal(fetched.status, 404, JSON.stringify(fetched.body));
    assert.equal(fetched.body.error.code, 'UTILITY_METER_READING_NOT_FOUND');
  });

  it('records a reading with an accepted BE-10C engineering linkage', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();

    // The engineering workflow keeps its own store; BE-18E only links to it.
    // With no binding supplied the reading still records its provenance.
    const created = await record(meter.id, {
      readingValue: 99,
      readingAt: '2026-03-04T08:00:00.000Z',
      source: 'ENGINEERING',
    });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.source, 'ENGINEERING');
  });
});

describe('BE-18E meter reading — invalid meter rejected', () => {
  it('rejects an unknown meter', async (t) => {
    if (!requireDatabase(t)) return;

    const created = await record(randomUUID(), {
      readingValue: 1,
      readingAt: '2026-03-01T08:00:00.000Z',
    });

    assert.equal(created.status, 404, JSON.stringify(created.body));
    assert.equal(created.body.error.code, 'UTILITY_METER_NOT_FOUND');
  });

  it('rejects a malformed meter id', async (t) => {
    if (!requireDatabase(t)) return;

    const created = await record('not-a-uuid', {
      readingValue: 1,
      readingAt: '2026-03-01T08:00:00.000Z',
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(created.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a reading against an inactive meter', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture, { status: 'INACTIVE' });

    const created = await record(meter.id, {
      readingValue: 1,
      readingAt: '2026-03-01T08:00:00.000Z',
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(created.body.error.code, 'UTILITY_METER_INACTIVE');
  });
});

describe('BE-18E meter reading — invalid UOM rejected', () => {
  it('rejects a UOM that differs from the meter configuration', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await meterScenario();
    // A perfectly valid unit of the same Client — but not this meter's unit.
    const otherUomId = await createUom(fixture.client.id, 'm3');

    const created = await record(meter.id, {
      readingValue: 5,
      readingAt: '2026-03-01T08:00:00.000Z',
      uomId: otherUomId,
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(
      created.body.error.code,
      'UTILITY_METER_READING_UOM_MISMATCH',
    );
  });

  it('rejects an unknown UOM', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();

    const created = await record(meter.id, {
      readingValue: 5,
      readingAt: '2026-03-01T08:00:00.000Z',
      uomId: randomUUID(),
    });

    assert.equal(created.status, 404, JSON.stringify(created.body));
    assert.equal(created.body.error.code, 'UTILITY_METER_UOM_NOT_FOUND');
  });

  it("rejects another client's UOM", async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();
    const other = await createStructure();

    const created = await record(meter.id, {
      readingValue: 5,
      readingAt: '2026-03-01T08:00:00.000Z',
      uomId: other.uomId,
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(created.body.error.code, 'UTILITY_METER_UOM_CLIENT_MISMATCH');
  });

  it('rejects a malformed UOM id', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();

    const created = await record(meter.id, {
      readingValue: 5,
      readingAt: '2026-03-01T08:00:00.000Z',
      uomId: 'nope',
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(created.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-18E meter reading — invalid reading value rejected', () => {
  it('rejects a negative reading', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();

    const created = await record(meter.id, {
      readingValue: -1,
      readingAt: '2026-03-01T08:00:00.000Z',
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(created.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a non-numeric reading', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();

    const created = await record(meter.id, {
      readingValue: '1234',
      readingAt: '2026-03-01T08:00:00.000Z',
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(created.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a missing reading value and a missing timestamp', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();

    const noValue = await record(meter.id, {
      readingAt: '2026-03-01T08:00:00.000Z',
    });
    assert.equal(noValue.status, 400, JSON.stringify(noValue.body));

    const noTimestamp = await record(meter.id, { readingValue: 1 });
    assert.equal(noTimestamp.status, 400, JSON.stringify(noTimestamp.body));
  });

  it('rejects an unparseable reading timestamp', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();

    const created = await record(meter.id, {
      readingValue: 1,
      readingAt: 'the day before yesterday',
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(created.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a value beyond the opt-in BE-18B decimal precision', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    // BE-18B stays opt-in: configuring it is what activates this rule.
    const configured = await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .set(auth())
      .send({
        utilityType: 'ELECTRICITY',
        name: 'Electricity',
        decimalPrecision: 2,
      });
    assert.equal(configured.status, 201, JSON.stringify(configured.body));

    const meter = await createMeter(fixture);

    const tooPrecise = await record(meter.id, {
      readingValue: 10.12345,
      readingAt: '2026-03-01T08:00:00.000Z',
    });
    assert.equal(tooPrecise.status, 400, JSON.stringify(tooPrecise.body));
    assert.equal(
      tooPrecise.body.error.code,
      'UTILITY_METER_READING_VALUE_INVALID',
    );

    const withinPrecision = await record(meter.id, {
      readingValue: 10.12,
      readingAt: '2026-03-01T09:00:00.000Z',
    });
    assert.equal(withinPrecision.status, 201, JSON.stringify(withinPrecision.body));
  });
});

describe('BE-18E meter reading — chronological handling', () => {
  it('lists a meter history newest first and returns the latest reading', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();

    // Deliberately posted out of order — chronology comes from reading_at,
    // not from the order of submission.
    for (const [value, at] of [
      [100, '2026-01-01T00:00:00.000Z'],
      [300, '2026-03-01T00:00:00.000Z'],
      [200, '2026-02-01T00:00:00.000Z'],
    ] as const) {
      const created = await record(meter.id, {
        readingValue: value,
        readingAt: at,
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    }

    const listed = await api()
      .get(`/api/v1/utility/meters/${meter.id}/readings`)
      .set(auth());
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(
      listed.body.data.map((reading: { readingValue: number }) => reading.readingValue),
      [300, 200, 100],
    );

    const latest = await api()
      .get(`/api/v1/utility/meters/${meter.id}/readings/latest`)
      .set(auth());
    assert.equal(latest.status, 200, JSON.stringify(latest.body));
    assert.equal(latest.body.data.readingValue, 300);
    assert.equal(latest.body.data.readingAt, '2026-03-01T00:00:00.000Z');
  });

  it('returns null as the latest reading for a meter never read', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();

    const latest = await api()
      .get(`/api/v1/utility/meters/${meter.id}/readings/latest`)
      .set(auth());

    // Never read is a valid state, not an error.
    assert.equal(latest.status, 200, JSON.stringify(latest.body));
    assert.equal(latest.body.data, null);
  });

  it('rejects a duplicate reading at the same instant', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();

    const first = await record(meter.id, {
      readingValue: 500,
      readingAt: '2026-04-01T00:00:00.000Z',
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const duplicate = await record(meter.id, {
      readingValue: 999,
      readingAt: '2026-04-01T00:00:00.000Z',
    });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(
      duplicate.body.error.code,
      'UTILITY_METER_READING_ALREADY_EXISTS',
    );

    // The posted value stands; the rejected submission changed nothing.
    const latest = await api()
      .get(`/api/v1/utility/meters/${meter.id}/readings/latest`)
      .set(auth());
    assert.equal(latest.body.data.readingValue, 500);
  });

  it('accepts a backdated reading without disturbing the existing history', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();

    await record(meter.id, {
      readingValue: 700,
      readingAt: '2026-06-01T00:00:00.000Z',
    });
    const backdated = await record(meter.id, {
      readingValue: 650,
      readingAt: '2026-05-01T00:00:00.000Z',
    });
    assert.equal(backdated.status, 201, JSON.stringify(backdated.body));

    const latest = await api()
      .get(`/api/v1/utility/meters/${meter.id}/readings/latest`)
      .set(auth());
    // A late arrival does not become "the latest" — chronology decides.
    assert.equal(latest.body.data.readingValue, 700);
  });

  it('filters a meter history by date range', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();

    for (const [value, at] of [
      [10, '2026-01-10T00:00:00.000Z'],
      [20, '2026-02-10T00:00:00.000Z'],
      [30, '2026-03-10T00:00:00.000Z'],
    ] as const) {
      await record(meter.id, { readingValue: value, readingAt: at });
    }

    const listed = await api()
      .get(`/api/v1/utility/meters/${meter.id}/readings`)
      .query({ from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' })
      .set(auth());

    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 1);
    assert.equal(listed.body.data[0].readingValue, 20);
  });
});

describe('BE-18E meter reading — tenant and building context', () => {
  it('snapshots the BE-18D tenant context onto the reading', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await meterScenario();
    const tenant = await createTenantCompany(fixture.client.id);
    const assignment = await assignMeterToTenant(
      meter.id,
      tenant.id,
      fixture.building.id,
      fixture.space.id,
    );

    const created = await record(meter.id, {
      readingValue: 88,
      readingAt: '2026-03-01T08:00:00.000Z',
    });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.tenantCompanyId, tenant.id);
    assert.equal(created.body.data.tenantAssignmentId, assignment.id);
  });

  it('rejects a supplied tenant that contradicts the meter assignment', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await meterScenario();
    const tenant = await createTenantCompany(fixture.client.id);
    await assignMeterToTenant(
      meter.id,
      tenant.id,
      fixture.building.id,
      fixture.space.id,
    );
    const otherTenant = await createTenantCompany(fixture.client.id);

    const created = await record(meter.id, {
      readingValue: 88,
      readingAt: '2026-03-02T08:00:00.000Z',
      tenantCompanyId: otherTenant.id,
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(
      created.body.error.code,
      'UTILITY_METER_READING_TENANT_MISMATCH',
    );
  });

  it('rejects a supplied tenant when the meter serves no tenant', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await meterScenario();
    const tenant = await createTenantCompany(fixture.client.id);

    const created = await record(meter.id, {
      readingValue: 88,
      readingAt: '2026-03-03T08:00:00.000Z',
      tenantCompanyId: tenant.id,
    });

    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(
      created.body.error.code,
      'UTILITY_METER_READING_TENANT_MISMATCH',
    );
  });

  it('lists readings by tenant company', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await meterScenario();
    const tenant = await createTenantCompany(fixture.client.id);
    await assignMeterToTenant(
      meter.id,
      tenant.id,
      fixture.building.id,
      fixture.space.id,
    );
    await record(meter.id, {
      readingValue: 12,
      readingAt: '2026-03-04T08:00:00.000Z',
    });

    const listed = await api()
      .get(`/api/v1/tenant-companies/${tenant.id}/meter-readings`)
      .set(auth());

    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 1);
    assert.equal(listed.body.data[0].readingValue, 12);
    assert.equal(listed.body.data[0].tenantCompanyId, tenant.id);
  });

  it('returns 404 for an unknown tenant company', async (t) => {
    if (!requireDatabase(t)) return;

    const listed = await api()
      .get(`/api/v1/tenant-companies/${randomUUID()}/meter-readings`)
      .set(auth());

    assert.equal(listed.status, 404, JSON.stringify(listed.body));
    assert.equal(listed.body.error.code, 'TENANT_COMPANY_NOT_FOUND');
  });

  it('lists readings by building and never leaks another building', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await meterScenario();
    await record(meter.id, {
      readingValue: 55,
      readingAt: '2026-03-05T08:00:00.000Z',
    });

    // A second building of the same client, with its own meter and reading.
    const otherFixture = await createStructure();
    const otherMeter = await createMeter(otherFixture);
    await record(otherMeter.id, {
      readingValue: 66,
      readingAt: '2026-03-05T08:00:00.000Z',
    });

    const listed = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/meter-readings`)
      .set(auth());

    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 1);
    assert.equal(listed.body.data[0].readingValue, 55);
    assert.equal(listed.body.data[0].buildingId, fixture.building.id);
  });
});

describe('BE-18E meter reading — posted history preserved', () => {
  it('exposes no update or delete route for a posted reading', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();
    const created = await record(meter.id, {
      readingValue: 321,
      readingAt: '2026-07-01T00:00:00.000Z',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const readingId = created.body.data.id;

    // Readings are append-only: nothing may overwrite or remove them.
    const patched = await api()
      .patch(`/api/v1/utility/meter-readings/${readingId}`)
      .set(auth())
      .send({ readingValue: 1 });
    assert.equal(patched.status, 404, JSON.stringify(patched.body));

    const deleted = await api()
      .delete(`/api/v1/utility/meter-readings/${readingId}`)
      .set(auth());
    assert.equal(deleted.status, 404, JSON.stringify(deleted.body));

    const fetched = await api()
      .get(`/api/v1/utility/meter-readings/${readingId}`)
      .set(auth());
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.readingValue, 321);
  });

  it('keeps the original when a correcting reading is recorded', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();

    const original = await record(meter.id, {
      readingValue: 1000,
      readingAt: '2026-08-01T00:00:00.000Z',
      notes: 'Misread',
    });
    assert.equal(original.status, 201, JSON.stringify(original.body));

    const correction = await record(meter.id, {
      readingValue: 1010,
      readingAt: '2026-08-01T00:05:00.000Z',
      notes: 'Correction of the 08:00 reading',
    });
    assert.equal(correction.status, 201, JSON.stringify(correction.body));

    const listed = await api()
      .get(`/api/v1/utility/meters/${meter.id}/readings`)
      .set(auth());
    assert.equal(listed.body.data.length, 2);
    assert.deepEqual(
      listed.body.data.map((reading: { readingValue: number }) => reading.readingValue),
      [1010, 1000],
    );

    // The superseded reading is still individually retrievable.
    const stillThere = await api()
      .get(`/api/v1/utility/meter-readings/${original.body.data.id}`)
      .set(auth());
    assert.equal(stillThere.status, 200);
    assert.equal(stillThere.body.data.readingValue, 1000);
  });

  it('keeps readings after the tenant assignment ends', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await meterScenario();
    const tenant = await createTenantCompany(fixture.client.id);
    const assignment = await assignMeterToTenant(
      meter.id,
      tenant.id,
      fixture.building.id,
      fixture.space.id,
    );
    const created = await record(meter.id, {
      readingValue: 77,
      readingAt: '2026-09-01T00:00:00.000Z',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const ended = await api()
      .patch(`/api/v1/utility/meter-tenant-assignments/${assignment.id}/end`)
      .set(auth())
      .send({});
    assert.equal(ended.status, 200, JSON.stringify(ended.body));

    // The historical reading stays attributed to the tenant that incurred it.
    const fetched = await api()
      .get(`/api/v1/utility/meter-readings/${created.body.data.id}`)
      .set(auth());
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.tenantCompanyId, tenant.id);
    assert.equal(fetched.body.data.tenantAssignmentId, assignment.id);
  });
});

describe('BE-18E meter reading — client and building isolation', () => {
  it('denies readings of a building the user is not assigned to', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await meterScenario();
    const created = await record(meter.id, {
      readingValue: 5,
      readingAt: '2026-10-01T00:00:00.000Z',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // A second administrator with full RBAC but no assignment to this Building.
    const outsider = await createAdminUser();

    const recorded = await record(
      meter.id,
      { readingValue: 6, readingAt: '2026-10-02T00:00:00.000Z' },
      outsider.token,
    );
    assert.equal(recorded.status, 403, JSON.stringify(recorded.body));
    assert.equal(recorded.body.error.code, 'BUILDING_ACCESS_DENIED');

    const fetched = await api()
      .get(`/api/v1/utility/meter-readings/${created.body.data.id}`)
      .set(auth(outsider.token));
    assert.equal(fetched.status, 403, JSON.stringify(fetched.body));

    const listed = await api()
      .get(`/api/v1/utility/meters/${meter.id}/readings`)
      .set(auth(outsider.token));
    assert.equal(listed.status, 403, JSON.stringify(listed.body));

    const latest = await api()
      .get(`/api/v1/utility/meters/${meter.id}/readings/latest`)
      .set(auth(outsider.token));
    assert.equal(latest.status, 403, JSON.stringify(latest.body));

    const byBuilding = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/meter-readings`)
      .set(auth(outsider.token));
    assert.equal(byBuilding.status, 403, JSON.stringify(byBuilding.body));
  });

  it("hides a tenant's readings from a user outside that client", async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await meterScenario();
    const tenant = await createTenantCompany(fixture.client.id);
    await assignMeterToTenant(
      meter.id,
      tenant.id,
      fixture.building.id,
      fixture.space.id,
    );
    await record(meter.id, {
      readingValue: 5,
      readingAt: '2026-10-03T00:00:00.000Z',
    });

    const outsider = await createAdminUser();

    const listed = await api()
      .get(`/api/v1/tenant-companies/${tenant.id}/meter-readings`)
      .set(auth(outsider.token));

    assert.equal(listed.status, 403, JSON.stringify(listed.body));
    assert.equal(listed.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('BE-18E meter reading — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter } = await meterScenario();

    const created = await api()
      .post(`/api/v1/utility/meters/${meter.id}/readings`)
      .send({ readingValue: 1, readingAt: '2026-11-01T00:00:00.000Z' });
    assert.equal(created.status, 401, JSON.stringify(created.body));

    const listed = await api().get(
      `/api/v1/utility/meters/${meter.id}/readings`,
    );
    assert.equal(listed.status, 401, JSON.stringify(listed.body));
  });

  it('denies a user without utility_meter permissions (default-deny)', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await meterScenario();
    const plainToken = await createPlainSession();

    const created = await record(
      meter.id,
      { readingValue: 1, readingAt: '2026-11-02T00:00:00.000Z' },
      plainToken,
    );
    assert.equal(created.status, 403, JSON.stringify(created.body));

    const listed = await api()
      .get(`/api/v1/utility/meters/${meter.id}/readings`)
      .set(auth(plainToken));
    assert.equal(listed.status, 403);

    const latest = await api()
      .get(`/api/v1/utility/meters/${meter.id}/readings/latest`)
      .set(auth(plainToken));
    assert.equal(latest.status, 403);

    const byBuilding = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/meter-readings`)
      .set(auth(plainToken));
    assert.equal(byBuilding.status, 403);

    const fetched = await api()
      .get(`/api/v1/utility/meter-readings/${randomUUID()}`)
      .set(auth(plainToken));
    assert.equal(fetched.status, 403);
  });
});
