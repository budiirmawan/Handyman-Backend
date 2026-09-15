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
 * BE-18I — Utility Calculation focused validation.
 *
 * Covers only this PART: deriving a value from an authoritative BE-18G
 * consumption using a data-driven rate basis — valid calculation, invalid
 * consumption, period validation, basis/rate validation, Tenant/Building
 * context, finalized-result protection, RBAC, and Client / Building
 * isolation.
 *
 * Invoicing, tax, payment, accounting and Abnormal Consumption (BE-18J) are
 * deliberately never exercised.
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
    `TRUNCATE utility_calculations, utility_calculation_bases,
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

/** A single 150-unit consumption over Jan → Feb 2026. */
async function createConsumption(
  meterId: string,
  from = 100,
  to = 250,
  start = '2026-01-01T00:00:00.000Z',
  end = '2026-02-01T00:00:00.000Z',
) {
  await createReading(meterId, from, start);
  const closing = await createReading(meterId, to, end);
  const created = await api()
    .post(`/api/v1/utility/meters/${meterId}/consumptions`)
    .set(auth())
    .send({ currentReadingId: closing.id });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data as {
    id: string;
    consumptionValue: number;
    uomId: string;
  };
}

async function createBasis(
  clientId: string,
  overrides: Record<string, unknown> = {},
) {
  const created = await api()
    .post(`/api/v1/clients/${clientId}/utility-calculation-bases`)
    .set(auth())
    .send({
      utilityType: 'ELECTRICITY',
      name: 'Standard electricity rate',
      rateValue: 2,
      rateLabel: 'per kWh',
      effectiveFrom: '2025-01-01T00:00:00.000Z',
      ...overrides,
    });
  return created;
}

/** Fixture + meter + one consumption + an applicable ACTIVE basis. */
async function calculationScenario(rateValue = 2) {
  const fixture = await createStructure();
  const meter = await createMeter(fixture);
  const consumption = await createConsumption(meter.id);
  const basis = await createBasis(fixture.client.id, { rateValue });
  assert.equal(basis.status, 201, JSON.stringify(basis.body));
  return {
    fixture,
    meter,
    consumption,
    basis: basis.body.data as { id: string; rateValue: number },
  };
}

async function calculate(consumptionId: string, body: unknown = {}) {
  return api()
    .post(`/api/v1/utility/consumptions/${consumptionId}/calculations`)
    .set(auth())
    .send(body as object);
}

describe('BE-18I utility calculation — valid calculation', () => {
  it('derives amount = consumption x rate from the authoritative consumption', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, consumption, basis } = await calculationScenario(2);

    const response = await calculate(consumption.id);

    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;
    // 150 consumed x rate 2.
    assert.equal(consumption.consumptionValue, 150);
    assert.equal(data.calculatedAmount, 300);
    assert.equal(data.appliedRateValue, 2);
    assert.equal(data.status, 'DRAFT');
    assert.equal(data.consumptionId, consumption.id);
    assert.equal(data.calculationBasisId, basis.id);
    assert.equal(data.meterId, meter.id);
    assert.equal(data.buildingId, fixture.building.id);
    assert.equal(data.clientId, fixture.client.id);
    assert.equal(data.utilityType, 'ELECTRICITY');
    assert.equal(data.uomId, consumption.uomId);
    assert.ok(data.calculatedAt);
    assert.equal(data.finalizedAt, null);
    assert.equal(data.supersedesCalculationId, null);
  });

  it('mirrors the consumption period rather than accepting one', async (t) => {
    if (!requireDatabase(t)) return;
    const { consumption } = await calculationScenario();

    const response = await calculate(consumption.id);

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(
      response.body.data.periodStart,
      '2026-01-01T00:00:00.000Z',
    );
    assert.equal(response.body.data.periodEnd, '2026-02-01T00:00:00.000Z');
  });

  it('resolves the applicable basis when none is supplied', async (t) => {
    if (!requireDatabase(t)) return;
    const { consumption, basis } = await calculationScenario(3);

    const response = await calculate(consumption.id);

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.calculationBasisId, basis.id);
    assert.equal(response.body.data.calculatedAmount, 450);
  });

  it('does not duplicate the consumption value onto the calculation row', async (t) => {
    if (!requireDatabase(t)) return;
    const { consumption } = await calculationScenario();
    const created = await calculate(consumption.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'utility_calculations'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    // The value is referenced, never copied.
    assert.ok(names.includes('consumption_id'));
    assert.ok(!names.includes('consumption_value'));
    // Nor are the BE-18E readings behind it.
    assert.ok(!names.includes('current_reading_id'));
    assert.ok(!names.includes('previous_reading_id'));

    // But it is resolved read-through on the response.
    const fetched = await api()
      .get(`/api/v1/utility/calculations/${created.body.data.id}`)
      .set(auth());
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.consumption.consumptionValue, 150);
    assert.equal(fetched.body.data.consumption.id, consumption.id);
  });

  it('rejects a caller-supplied amount, rate, period or status', async (t) => {
    if (!requireDatabase(t)) return;
    const { consumption } = await calculationScenario();

    for (const body of [
      { calculatedAmount: 999 },
      { appliedRateValue: 999 },
      { periodStart: '2020-01-01T00:00:00.000Z' },
      { status: 'FINALIZED' },
    ]) {
      const response = await calculate(consumption.id, body);
      assert.equal(
        response.status,
        400,
        `${JSON.stringify(body)} → ${JSON.stringify(response.body)}`,
      );
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('lists calculations by meter, building and consumption', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, consumption } = await calculationScenario();
    const created = await calculate(consumption.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const byMeter = await api()
      .get(`/api/v1/utility/meters/${meter.id}/calculations`)
      .set(auth());
    assert.equal(byMeter.status, 200, JSON.stringify(byMeter.body));
    assert.equal(byMeter.body.data.length, 1);

    const byBuilding = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/utility-calculations`)
      .set(auth());
    assert.equal(byBuilding.status, 200, JSON.stringify(byBuilding.body));
    assert.equal(byBuilding.body.data.length, 1);

    const byConsumption = await api()
      .get(`/api/v1/utility/consumptions/${consumption.id}/calculations`)
      .set(auth());
    assert.equal(byConsumption.status, 200, JSON.stringify(byConsumption.body));
    assert.equal(byConsumption.body.data.length, 1);
  });

  it('filters a list by status and utility type', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, consumption } = await calculationScenario();
    await calculate(consumption.id);

    const drafts = await api()
      .get(`/api/v1/utility/meters/${meter.id}/calculations`)
      .query({ status: 'DRAFT' })
      .set(auth());
    assert.equal(drafts.status, 200, JSON.stringify(drafts.body));
    assert.equal(drafts.body.data.length, 1);

    const finalized = await api()
      .get(`/api/v1/utility/meters/${meter.id}/calculations`)
      .query({ status: 'FINALIZED' })
      .set(auth());
    assert.equal(finalized.body.data.length, 0);

    const gas = await api()
      .get(`/api/v1/utility/meters/${meter.id}/calculations`)
      .query({ utilityType: 'GAS' })
      .set(auth());
    assert.equal(gas.body.data.length, 0);

    const bad = await api()
      .get(`/api/v1/utility/meters/${meter.id}/calculations`)
      .query({ status: 'PAID' })
      .set(auth());
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
  });
});

describe('BE-18I utility calculation — invalid consumption rejected', () => {
  it('rejects an unknown consumption', async (t) => {
    if (!requireDatabase(t)) return;
    await calculationScenario();

    const response = await calculate(randomUUID());

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_CALCULATION_CONSUMPTION_INVALID',
    );
  });

  it('rejects a malformed consumption id', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .post('/api/v1/utility/consumptions/not-a-uuid/calculations')
      .set(auth())
      .send({});

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('refuses a second live calculation for the same consumption', async (t) => {
    if (!requireDatabase(t)) return;
    const { consumption } = await calculationScenario();

    const first = await calculate(consumption.id);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await calculate(consumption.id);
    // Two competing figures for one period is exactly what must not happen.
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(
      second.body.error.code,
      'UTILITY_CALCULATION_ALREADY_EXISTS',
    );
  });

  it('returns 404 for an unknown calculation', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/utility/calculations/${randomUUID()}`)
      .set(auth());

    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_CALCULATION_NOT_FOUND');
  });
});

describe('BE-18I utility calculation — period validation', () => {
  it('rejects a basis that starts after the consumption period', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const consumption = await createConsumption(meter.id);
    // Effective only from March; the consumption ran Jan → Feb.
    const late = await createBasis(fixture.client.id, {
      effectiveFrom: '2026-03-01T00:00:00.000Z',
    });
    assert.equal(late.status, 201, JSON.stringify(late.body));

    const response = await calculate(consumption.id, {
      calculationBasisId: late.body.data.id,
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_CALCULATION_BASIS_INVALID');
  });

  it('rejects a basis that expires mid-period', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const consumption = await createConsumption(meter.id);
    // Expires 15 Jan, but the period runs to 1 Feb — it cannot describe it all.
    const expiring = await createBasis(fixture.client.id, {
      effectiveFrom: '2025-01-01T00:00:00.000Z',
      effectiveTo: '2026-01-15T00:00:00.000Z',
    });
    assert.equal(expiring.status, 201, JSON.stringify(expiring.body));

    const response = await calculate(consumption.id, {
      calculationBasisId: expiring.body.data.id,
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_CALCULATION_BASIS_INVALID');
  });

  it('reports no applicable tariff when none covers the period', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const meter = await createMeter(fixture);
    const consumption = await createConsumption(meter.id);
    await createBasis(fixture.client.id, {
      effectiveFrom: '2030-01-01T00:00:00.000Z',
    });

    const response = await calculate(consumption.id);

    // PART 10: ELECTRICITY/WATER charges resolve the governed Building tariff
    // first. With no active Building tariff and no legacy basis covering the
    // consumption period, the value is never invented at an implicit zero
    // rate — the tariff-first engine reports UTILITY_TARIFF_NOT_FOUND (404).
    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_TARIFF_NOT_FOUND',
    );
  });

  it('filters calculations by period window', async (t) => {
    if (!requireDatabase(t)) return;
    const { meter, consumption } = await calculationScenario();
    await calculate(consumption.id);

    const inside = await api()
      .get(`/api/v1/utility/meters/${meter.id}/calculations`)
      .query({ from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' })
      .set(auth());
    assert.equal(inside.status, 200, JSON.stringify(inside.body));
    assert.equal(inside.body.data.length, 1);

    const outside = await api()
      .get(`/api/v1/utility/meters/${meter.id}/calculations`)
      .query({ from: '2027-01-01T00:00:00.000Z' })
      .set(auth());
    assert.equal(outside.body.data.length, 0);

    const malformed = await api()
      .get(`/api/v1/utility/meters/${meter.id}/calculations`)
      .query({ from: 'whenever' })
      .set(auth());
    assert.equal(malformed.status, 400, JSON.stringify(malformed.body));
  });

  it('rejects a basis window that does not move forward in time', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const response = await createBasis(fixture.client.id, {
      effectiveFrom: '2026-06-01T00:00:00.000Z',
      effectiveTo: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-18I utility calculation — basis and rate validation', () => {
  it('creates and lists a data-driven basis', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const created = await createBasis(fixture.client.id, { rateValue: 1.5 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.rateValue, 1.5);
    assert.equal(created.body.data.status, 'ACTIVE');
    assert.equal(created.body.data.utilityType, 'ELECTRICITY');

    const listed = await api()
      .get(`/api/v1/clients/${fixture.client.id}/utility-calculation-bases`)
      .set(auth());
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 1);
  });

  it('rejects a negative, non-numeric or missing rate', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    for (const rateValue of [-1, 'free', undefined]) {
      const response = await createBasis(fixture.client.id, { rateValue });
      assert.equal(
        response.status,
        400,
        `${String(rateValue)} → ${JSON.stringify(response.body)}`,
      );
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('rejects an unknown utility type on a basis', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();

    const response = await createBasis(fixture.client.id, {
      utilityType: 'STEAM',
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an unknown basis reference', async (t) => {
    if (!requireDatabase(t)) return;
    const { consumption } = await calculationScenario();

    const response = await calculate(consumption.id, {
      calculationBasisId: randomUUID(),
    });

    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_CALCULATION_BASIS_NOT_FOUND',
    );
  });

  it('rejects a basis for a different utility type', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, consumption } = await calculationScenario();
    const waterBasis = await createBasis(fixture.client.id, {
      utilityType: 'WATER',
      name: 'Water rate',
    });
    assert.equal(waterBasis.status, 201, JSON.stringify(waterBasis.body));

    const response = await calculate(consumption.id, {
      calculationBasisId: waterBasis.body.data.id,
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_CALCULATION_BASIS_INVALID');
  });

  it('rejects an inactive basis', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, consumption } = await calculationScenario();
    const inactive = await createBasis(fixture.client.id, {
      name: 'Retired rate',
      status: 'INACTIVE',
    });
    assert.equal(inactive.status, 201, JSON.stringify(inactive.body));

    const response = await calculate(consumption.id, {
      calculationBasisId: inactive.body.data.id,
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_CALCULATION_BASIS_INVALID');
  });

  it("rejects another client's basis", async (t) => {
    if (!requireDatabase(t)) return;
    const { consumption } = await calculationScenario();
    const otherFixture = await createStructure();
    const foreign = await createBasis(otherFixture.client.id);
    assert.equal(foreign.status, 201, JSON.stringify(foreign.body));

    const response = await calculate(consumption.id, {
      calculationBasisId: foreign.body.data.id,
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_CALCULATION_BASIS_INVALID');
  });

  it('rejects a basis bound to a different unit of measure', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, consumption } = await calculationScenario();
    const otherUomId = await createUom(fixture.client.id, 'm3');
    const mismatched = await createBasis(fixture.client.id, {
      name: 'Cubic-metre rate',
      uomId: otherUomId,
    });
    assert.equal(mismatched.status, 201, JSON.stringify(mismatched.body));

    const response = await calculate(consumption.id, {
      calculationBasisId: mismatched.body.data.id,
    });

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UTILITY_CALCULATION_BASIS_INVALID');
  });

  it('freezes the applied rate so a later basis change cannot rewrite history', async (t) => {
    if (!requireDatabase(t)) return;
    const { consumption, basis } = await calculationScenario(2);
    const created = await calculate(consumption.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.appliedRateValue, 2);

    // The reference data moves on...
    await pool!.query(
      'UPDATE utility_calculation_bases SET rate_value = 99 WHERE id = $1',
      [basis.id],
    );

    const fetched = await api()
      .get(`/api/v1/utility/calculations/${created.body.data.id}`)
      .set(auth());
    // ...but the result stays explainable at the rate actually applied.
    assert.equal(fetched.body.data.appliedRateValue, 2);
    assert.equal(fetched.body.data.calculatedAmount, 300);
  });
});

describe('BE-18I utility calculation — tenant and building context', () => {
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

    const consumption = await createConsumption(meter.id);
    await createBasis(fixture.client.id);

    const created = await calculate(consumption.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // Snapshotted from the consumption, not from who occupies the space now.
    assert.equal(created.body.data.tenantCompanyId, tenant.body.data.id);
    assert.equal(
      created.body.data.tenantAssignmentId,
      assigned.body.data.id,
    );

    const byTenant = await api()
      .get(`/api/v1/tenant-companies/${tenant.body.data.id}/utility-calculations`)
      .set(auth());
    assert.equal(byTenant.status, 200, JSON.stringify(byTenant.body));
    assert.equal(byTenant.body.data.length, 1);
    assert.equal(byTenant.body.data[0].calculatedAmount, 300);
  });

  it('leaves tenant context null for a common-area meter', async (t) => {
    if (!requireDatabase(t)) return;
    const { consumption } = await calculationScenario();

    const created = await calculate(consumption.id);

    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.tenantCompanyId, null);
    assert.equal(created.body.data.tenantAssignmentId, null);
  });

  it('returns 404 for an unknown tenant company', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/tenant-companies/${randomUUID()}/utility-calculations`)
      .set(auth());

    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'TENANT_COMPANY_NOT_FOUND');
  });

  it('anchors building context to the consumption, not the caller', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, consumption } = await calculationScenario();
    const otherFixture = await createStructure();

    const created = await calculate(consumption.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.buildingId, fixture.building.id);

    // The result never appears under an unrelated Building.
    const elsewhere = await api()
      .get(`/api/v1/buildings/${otherFixture.building.id}/utility-calculations`)
      .set(auth());
    assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.body));
    assert.equal(elsewhere.body.data.length, 0);
  });
});

describe('BE-18I utility calculation — recalculation and finalized protection', () => {
  it('supersedes a draft instead of overwriting it', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, consumption } = await calculationScenario(2);
    const first = await calculate(consumption.id);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.calculatedAmount, 300);

    const newRate = await createBasis(fixture.client.id, {
      name: 'Revised rate',
      rateValue: 4,
      effectiveFrom: '2025-06-01T00:00:00.000Z',
    });
    assert.equal(newRate.status, 201, JSON.stringify(newRate.body));

    const recalculated = await api()
      .post(`/api/v1/utility/calculations/${first.body.data.id}/recalculate`)
      .set(auth())
      .send({ calculationBasisId: newRate.body.data.id });

    assert.equal(recalculated.status, 201, JSON.stringify(recalculated.body));
    // A NEW row, linked back to its predecessor.
    assert.notEqual(recalculated.body.data.id, first.body.data.id);
    assert.equal(
      recalculated.body.data.supersedesCalculationId,
      first.body.data.id,
    );
    assert.equal(recalculated.body.data.calculatedAmount, 600);
    assert.equal(recalculated.body.data.status, 'DRAFT');

    // The prior result survives, marked SUPERSEDED — history is preserved.
    const prior = await api()
      .get(`/api/v1/utility/calculations/${first.body.data.id}`)
      .set(auth());
    assert.equal(prior.status, 200, JSON.stringify(prior.body));
    assert.equal(prior.body.data.status, 'SUPERSEDED');
    assert.equal(prior.body.data.calculatedAmount, 300);

    const history = await api()
      .get(`/api/v1/utility/consumptions/${consumption.id}/calculations`)
      .set(auth());
    assert.equal(history.body.data.length, 2);
  });

  it('finalizes a draft and stamps who and when', async (t) => {
    if (!requireDatabase(t)) return;
    const { consumption } = await calculationScenario();
    const created = await calculate(consumption.id);

    const finalized = await api()
      .post(`/api/v1/utility/calculations/${created.body.data.id}/finalize`)
      .set(auth())
      .send({});

    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    assert.equal(finalized.body.data.status, 'FINALIZED');
    assert.ok(finalized.body.data.finalizedAt);
    assert.equal(finalized.body.data.finalizedByUserId, adminUserId);
    assert.equal(finalized.body.data.calculatedAmount, 300);
  });

  it('refuses to recalculate a finalized result', async (t) => {
    if (!requireDatabase(t)) return;
    const { consumption } = await calculationScenario();
    const created = await calculate(consumption.id);
    const finalized = await api()
      .post(`/api/v1/utility/calculations/${created.body.data.id}/finalize`)
      .set(auth())
      .send({});
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));

    const response = await api()
      .post(`/api/v1/utility/calculations/${created.body.data.id}/recalculate`)
      .set(auth())
      .send({});

    // A finalized figure must never silently change.
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_CALCULATION_ALREADY_FINALIZED',
    );

    const unchanged = await api()
      .get(`/api/v1/utility/calculations/${created.body.data.id}`)
      .set(auth());
    assert.equal(unchanged.body.data.status, 'FINALIZED');
    assert.equal(unchanged.body.data.calculatedAmount, 300);
  });

  it('refuses to re-finalize, and refuses a fresh calculation over a finalized one', async (t) => {
    if (!requireDatabase(t)) return;
    const { consumption } = await calculationScenario();
    const created = await calculate(consumption.id);
    await api()
      .post(`/api/v1/utility/calculations/${created.body.data.id}/finalize`)
      .set(auth())
      .send({});

    const again = await api()
      .post(`/api/v1/utility/calculations/${created.body.data.id}/finalize`)
      .set(auth())
      .send({});
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(
      again.body.error.code,
      'UTILITY_CALCULATION_ALREADY_FINALIZED',
    );

    // Nor can a finalized result be sidestepped by calculating afresh.
    const fresh = await calculate(consumption.id);
    assert.equal(fresh.status, 409, JSON.stringify(fresh.body));
    assert.equal(fresh.body.error.code, 'UTILITY_CALCULATION_ALREADY_EXISTS');
  });

  it('refuses to act on a superseded result', async (t) => {
    if (!requireDatabase(t)) return;
    const { consumption } = await calculationScenario();
    const first = await calculate(consumption.id);
    const second = await api()
      .post(`/api/v1/utility/calculations/${first.body.data.id}/recalculate`)
      .set(auth())
      .send({});
    assert.equal(second.status, 201, JSON.stringify(second.body));

    const recalcOld = await api()
      .post(`/api/v1/utility/calculations/${first.body.data.id}/recalculate`)
      .set(auth())
      .send({});
    assert.equal(recalcOld.status, 409, JSON.stringify(recalcOld.body));
    assert.equal(
      recalcOld.body.error.code,
      'UTILITY_CALCULATION_NOT_RECALCULABLE',
    );

    const finalizeOld = await api()
      .post(`/api/v1/utility/calculations/${first.body.data.id}/finalize`)
      .set(auth())
      .send({});
    assert.equal(finalizeOld.status, 409, JSON.stringify(finalizeOld.body));
  });

  it('exposes no update or delete route', async (t) => {
    if (!requireDatabase(t)) return;
    const { consumption } = await calculationScenario();
    const created = await calculate(consumption.id);

    const patched = await api()
      .patch(`/api/v1/utility/calculations/${created.body.data.id}`)
      .set(auth())
      .send({ calculatedAmount: 1 });
    assert.equal(patched.status, 404, JSON.stringify(patched.body));

    const deleted = await api()
      .delete(`/api/v1/utility/calculations/${created.body.data.id}`)
      .set(auth());
    assert.equal(deleted.status, 404, JSON.stringify(deleted.body));
  });
});

describe('BE-18I utility calculation — client and building isolation', () => {
  it('denies calculating for a building the user is not assigned to', async (t) => {
    if (!requireDatabase(t)) return;
    const { consumption } = await calculationScenario();

    // A second administrator with full RBAC but no assignment to this Building.
    const outsider = await createAdminUser();

    const response = await api()
      .post(`/api/v1/utility/consumptions/${consumption.id}/calculations`)
      .set(auth(outsider.token))
      .send({});

    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies reading, recalculating and finalizing across buildings', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, consumption } = await calculationScenario();
    const created = await calculate(consumption.id);
    const calculationId = created.body.data.id;

    const outsider = await createAdminUser();

    const fetched = await api()
      .get(`/api/v1/utility/calculations/${calculationId}`)
      .set(auth(outsider.token));
    assert.equal(fetched.status, 403, JSON.stringify(fetched.body));

    const recalculated = await api()
      .post(`/api/v1/utility/calculations/${calculationId}/recalculate`)
      .set(auth(outsider.token))
      .send({});
    assert.equal(recalculated.status, 403, JSON.stringify(recalculated.body));

    const finalized = await api()
      .post(`/api/v1/utility/calculations/${calculationId}/finalize`)
      .set(auth(outsider.token))
      .send({});
    assert.equal(finalized.status, 403, JSON.stringify(finalized.body));

    const byMeter = await api()
      .get(`/api/v1/utility/meters/${meter.id}/calculations`)
      .set(auth(outsider.token));
    assert.equal(byMeter.status, 403, JSON.stringify(byMeter.body));

    const byBuilding = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/utility-calculations`)
      .set(auth(outsider.token));
    assert.equal(byBuilding.status, 403, JSON.stringify(byBuilding.body));
  });

  it("hides a tenant's calculations from a user outside that client", async (t) => {
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
    const consumption = await createConsumption(meter.id);
    await createBasis(fixture.client.id);
    await calculate(consumption.id);

    const outsider = await createAdminUser();

    const response = await api()
      .get(`/api/v1/tenant-companies/${tenant.body.data.id}/utility-calculations`)
      .set(auth(outsider.token));

    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it("denies managing another client's calculation bases", async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const outsider = await createAdminUser();

    const created = await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-calculation-bases`)
      .set(auth(outsider.token))
      .send({
        utilityType: 'ELECTRICITY',
        name: 'Foreign rate',
        rateValue: 5,
        effectiveFrom: '2025-01-01T00:00:00.000Z',
      });
    assert.equal(created.status, 403, JSON.stringify(created.body));

    const listed = await api()
      .get(`/api/v1/clients/${fixture.client.id}/utility-calculation-bases`)
      .set(auth(outsider.token));
    assert.equal(listed.status, 403, JSON.stringify(listed.body));
  });
});

describe('BE-18I utility calculation — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, consumption } = await calculationScenario();

    const posted = await api()
      .post(`/api/v1/utility/consumptions/${consumption.id}/calculations`)
      .send({});
    assert.equal(posted.status, 401, JSON.stringify(posted.body));

    const listed = await api().get(
      `/api/v1/buildings/${fixture.building.id}/utility-calculations`,
    );
    assert.equal(listed.status, 401, JSON.stringify(listed.body));
  });

  it('denies a user without utility_meter permissions (default-deny)', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, consumption } = await calculationScenario();
    const created = await calculate(consumption.id);
    const calculationId = created.body.data.id;
    const plainToken = await createPlainSession();

    const posted = await api()
      .post(`/api/v1/utility/consumptions/${consumption.id}/calculations`)
      .set(auth(plainToken))
      .send({});
    assert.equal(posted.status, 403, JSON.stringify(posted.body));

    const recalculated = await api()
      .post(`/api/v1/utility/calculations/${calculationId}/recalculate`)
      .set(auth(plainToken))
      .send({});
    assert.equal(recalculated.status, 403);

    const finalized = await api()
      .post(`/api/v1/utility/calculations/${calculationId}/finalize`)
      .set(auth(plainToken))
      .send({});
    assert.equal(finalized.status, 403);

    const fetched = await api()
      .get(`/api/v1/utility/calculations/${calculationId}`)
      .set(auth(plainToken));
    assert.equal(fetched.status, 403);

    const byMeter = await api()
      .get(`/api/v1/utility/meters/${meter.id}/calculations`)
      .set(auth(plainToken));
    assert.equal(byMeter.status, 403);

    const bases = await api()
      .post(`/api/v1/clients/${fixture.client.id}/utility-calculation-bases`)
      .set(auth(plainToken))
      .send({
        utilityType: 'ELECTRICITY',
        name: 'Rate',
        rateValue: 1,
        effectiveFrom: '2025-01-01T00:00:00.000Z',
      });
    assert.equal(bases.status, 403);
  });
});
