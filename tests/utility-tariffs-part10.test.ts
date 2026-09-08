import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** CR-BE-UTL-01 PART 10 focused tariff and monetary charge validation only. */
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const EMBEDDED_PORT = 55480;
const EMBEDDED_DIR = '/tmp/asentra-part10-pg';
if (EMBEDDED) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(EMBEDDED_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_NAME = 'asentra_test';
  process.env.DB_SSL = 'false';
}
let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  if (EMBEDDED) {
    await rm(EMBEDDED_DIR, { recursive: true, force: true });
    await mkdir(EMBEDDED_DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: EMBEDDED_DIR,
      port: EMBEDDED_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const admin = postgres.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }
  const config = await ensureTestDatabase();
  if (!config) return;
  pool = await initDatabase(config);
  await migrateUp(pool);
  await pool.query(`TRUNCATE utility_bill_history, utility_bills,
    tenant_approval_bindings, utility_calculations, utility_calculation_bases,
    utility_meter_consumptions, utility_meter_readings,
    utility_meter_tenant_assignments, utility_meter_hierarchies,
    utility_type_uoms, utility_type_configurations, utility_meters,
    units_of_measure, user_building_assignments, buildings, properties,
    users, roles, permissions, role_permission_assignments,
    user_role_assignments, clients CASCADE`);
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = config;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(EMBEDDED_DIR, { recursive: true, force: true });
  }
  pool = null;
  postgres = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

type UtilityKind = 'ELECTRICITY' | 'WATER';

async function scenario(type: UtilityKind, from = 100, to = 112.5) {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Tariff Client' });
  const property = await propertyService.createProperty({
    clientId: client.id, code: `P_${suffix()}`, name: 'Tariff Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id, code: `B_${suffix()}`, name: 'Tariff Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, { buildingId: building.id });
  await clientMonetaryContextService.setClientMonetaryContext({
    clientId: client.id, baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR',
    allowedCurrencyCodes: ['IDR', 'USD', 'EUR'],
  }, adminUserId);

  const uom = await api().post(`/api/v1/clients/${client.id}/uoms`).set(auth()).send({
    code: `U_${suffix()}`, name: type === 'WATER' ? 'Cubic metre' : 'Kilowatt hour',
    symbol: type === 'WATER' ? 'm3' : 'kWh', category: type === 'WATER' ? 'VOLUME' : 'ENERGY',
  });
  assert.equal(uom.status, 201, JSON.stringify(uom.body));
  const uomId = uom.body.data.id as string;

  const meter = await api().post(`/api/v1/buildings/${building.id}/utility-meters`).set(auth()).send({
    code: `M_${suffix()}`, name: `${type} meter`, utilityType: type, uomId,
  });
  assert.equal(meter.status, 201, JSON.stringify(meter.body));
  const meterId = meter.body.data.id as string;

  const first = await api().post(`/api/v1/utility/meters/${meterId}/readings`).set(auth()).send({
    readingValue: from, readingAt: '2026-01-01T00:00:00.000Z',
  });
  const second = await api().post(`/api/v1/utility/meters/${meterId}/readings`).set(auth()).send({
    readingValue: to, readingAt: '2026-02-01T00:00:00.000Z',
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const consumption = await api().post(`/api/v1/utility/meters/${meterId}/consumptions`).set(auth()).send({
    previousReadingId: first.body.data.id, currentReadingId: second.body.data.id,
  });
  assert.equal(consumption.status, 201, JSON.stringify(consumption.body));
  return { client, building, uomId, meterId, utilityType: type, consumption: consumption.body.data };
}

async function tariff(
  s: Awaited<ReturnType<typeof scenario>>,
  overrides: Record<string, unknown> = {},
) {
  return api().post(`/api/v1/buildings/${s.building.id}/utility-tariffs`).set(auth()).send({
    utilityType: s.utilityType,
    currency: 'IDR', uomId: s.uomId, ratePerUom: '1.23456789',
    effectiveFrom: '2025-01-01T00:00:00.000Z', effectiveUntil: null,
    ...overrides,
  });
}

async function calculate(consumptionId: string) {
  return api().post(`/api/v1/utility/consumptions/${consumptionId}/calculations`).set(auth()).send({});
}

describe('CR-BE-UTL-01 PART 10 — tariff resolution and charge snapshots', () => {
  it('resolves the active tariff covering the authoritative period', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('ELECTRICITY');
    const created = await tariff(s);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const charge = await calculate(s.consumption.id);
    assert.equal(charge.status, 201, JSON.stringify(charge.body));
    assert.equal(charge.body.data.tariffId, created.body.data.id);
    assert.equal(charge.body.data.currency, 'IDR');
    assert.equal(charge.body.data.uomId, s.uomId);
  });

  it('rejects overlapping ACTIVE tariff periods for one Building scope', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('ELECTRICITY');
    assert.equal((await tariff(s, { effectiveUntil: '2026-12-31T00:00:00.000Z' })).status, 201);
    const overlap = await tariff(s, { effectiveFrom: '2026-01-15T00:00:00.000Z' });
    assert.equal(overlap.status, 409, JSON.stringify(overlap.body));
    assert.equal(overlap.body.error.code, 'UTILITY_TARIFF_PERIOD_OVERLAP');
  });

  it('calculates an Electricity charge with exact PostgreSQL NUMERIC arithmetic', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('ELECTRICITY');
    await tariff(s);
    const charge = await calculate(s.consumption.id);
    assert.equal(charge.status, 201, JSON.stringify(charge.body));
    const stored = await pool!.query<{ quantity: string; rate: string; amount: string }>(
      `SELECT consumption_quantity::text quantity, tariff_rate::text rate,
              calculated_amount::text amount FROM utility_calculations WHERE id = $1`,
      [charge.body.data.id],
    );
    assert.equal(stored.rows[0].quantity, '12.5');
    assert.equal(stored.rows[0].rate, '1.23456789');
    assert.equal(stored.rows[0].amount, '15.432098625');
  });

  it('uses the same tariff engine for finalized Water m3 consumption', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('WATER', 10, 13.5);
    const configured = await tariff(s, { ratePerUom: '2500' });
    assert.equal(configured.status, 201, JSON.stringify(configured.body));
    const charge = await calculate(s.consumption.id);
    assert.equal(charge.status, 201, JSON.stringify(charge.body));
    assert.equal(charge.body.data.utilityType, 'WATER');
    assert.equal(charge.body.data.consumptionQuantity, 3.5);
    assert.equal(charge.body.data.calculatedAmount, 8750);
  });

  it('keeps the quantity, tariff rate, currency and amount snapshot immutable', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('ELECTRICITY');
    const configured = await tariff(s, { ratePerUom: '2.5', currency: 'USD' });
    const charge = await calculate(s.consumption.id);
    assert.equal(charge.status, 201, JSON.stringify(charge.body));
    await pool!.query('UPDATE utility_calculation_bases SET rate_value = 9, currency = $2 WHERE id = $1',
      [configured.body.data.id, 'EUR']);
    const historical = await api().get(`/api/v1/utility/calculations/${charge.body.data.id}`).set(auth());
    assert.equal(historical.body.data.tariffRate, 2.5);
    assert.equal(historical.body.data.currency, 'USD');
    assert.equal(historical.body.data.calculatedAmount, 31.25);
  });

  it('fails explicitly when no valid Building tariff exists', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('ELECTRICITY');
    await tariff(s, { effectiveFrom: '2026-03-01T00:00:00.000Z' });
    const missing = await calculate(s.consumption.id);
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.equal(missing.body.error.code, 'UTILITY_TARIFF_NOT_FOUND');
  });

  it('enforces Building isolation on tariff configuration and charge calculation', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('ELECTRICITY');
    await tariff(s);
    const outsider = await createAdminUser();
    const deniedTariff = await api().get(`/api/v1/buildings/${s.building.id}/utility-tariffs`).set(auth(outsider.token));
    assert.equal(deniedTariff.status, 403, JSON.stringify(deniedTariff.body));
    const deniedCharge = await api().post(`/api/v1/utility/consumptions/${s.consumption.id}/calculations`)
      .set(auth(outsider.token)).send({});
    assert.equal(deniedCharge.status, 403, JSON.stringify(deniedCharge.body));
  });
});
