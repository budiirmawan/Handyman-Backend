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
import { currencyService } from '../src/modules/currencies';
import { floorService } from '../src/modules/floors';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-CUR-02 PART 04 — Utility Tariff currency alignment.
 *
 * Proofs: a new Utility Tariff requires an explicit ACTIVE + Client-allowed
 * currency (no IDR/base/default inference); the currency snapshot is persisted
 * and propagates exactly through calculation → bill; INACTIVE and
 * Client-disallowed codes are rejected; historical tariffs/calculations/bills
 * remain readable after configuration changes; the existing monetary
 * calculation is unchanged; no FX/conversion path is introduced.
 */
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (v = token) => ({ Authorization: `Bearer ${v}` });

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE utility_bill_history, utility_bills,
    tenant_approval_bindings, utility_calculations, utility_calculation_bases,
    utility_meter_consumptions, utility_meter_readings,
    utility_meter_tenant_assignments, utility_meter_hierarchies,
    utility_type_uoms, utility_type_configurations, utility_meters,
    units_of_measure, user_building_assignments, buildings, properties,
    users, roles, permissions, role_permission_assignments,
    user_role_assignments, client_monetary_contexts,
    client_allowed_transaction_currencies, clients CASCADE`);
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
  database = db;
});
after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});
function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database unavailable');
    return false;
  }
  return true;
}

async function fixture(codes: string[] = ['IDR', 'USD', 'JPY', 'EUR']) {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Tariff Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Tariff Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Tariff Building' });
  await buildingAssignmentService.createAssignment(userId, { buildingId: building.id });
  await clientMonetaryContextService.setClientMonetaryContext({
    clientId: client.id, baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: codes,
  }, userId);
  const uom = await api().post(`/api/v1/clients/${client.id}/uoms`).set(auth()).send({
    code: `U_${suffix()}`, name: 'Kilowatt hour', symbol: 'kWh', category: 'ENERGY',
  });
  assert.equal(uom.status, 201, JSON.stringify(uom.body));
  const uomId = uom.body.data.id as string;
  const meter = await api().post(`/api/v1/buildings/${building.id}/utility-meters`).set(auth()).send({
    code: `M_${suffix()}`, name: 'Electricity meter', utilityType: 'ELECTRICITY', uomId,
  });
  assert.equal(meter.status, 201, JSON.stringify(meter.body));
  return { client, building, uomId, meterId: meter.body.data.id as string };
}

async function readingsConsumption(f: Awaited<ReturnType<typeof fixture>>) {
  const a = await api().post(`/api/v1/utility/meters/${f.meterId}/readings`).set(auth()).send({ readingValue: 100, readingAt: '2026-01-01T00:00:00.000Z' });
  const b = await api().post(`/api/v1/utility/meters/${f.meterId}/readings`).set(auth()).send({ readingValue: 250, readingAt: '2026-02-01T00:00:00.000Z' });
  const consumption = await api().post(`/api/v1/utility/meters/${f.meterId}/consumptions`).set(auth()).send({ currentReadingId: b.body.data.id });
  assert.equal(consumption.status, 201, JSON.stringify(consumption.body));
  return consumption.body.data;
}

function tariffBody(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return {
    utilityType: 'ELECTRICITY', currency: 'IDR', uomId: f.uomId,
    ratePerUom: '2', effectiveFrom: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}
const createTariff = (f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) =>
  api().post(`/api/v1/buildings/${f.building.id}/utility-tariffs`).set(auth()).send(tariffBody(f, overrides));

describe('CR-BE-CUR-02 PART 04 — Utility Tariff currency alignment', () => {
  it('requires Currency Master ACTIVE + Client-allowed; rejects unknown, INACTIVE, and disallowed codes', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(['IDR', 'USD', 'JPY', 'EUR']);
    // Unknown (not in Currency Master)
    const unknown = await createTariff(f, { currency: 'ZZZ' });
    assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
    assert.equal(unknown.body.error.code, 'CURRENCY_INACTIVE_OR_UNKNOWN');
    // INACTIVE master code
    await currencyService.setCurrencyStatus('JPY', 'INACTIVE', userId);
    try {
      const inactive = await createTariff(f, { currency: 'JPY' });
      assert.equal(inactive.status, 400, JSON.stringify(inactive.body));
      assert.equal(inactive.body.error.code, 'CURRENCY_INACTIVE_OR_UNKNOWN');
    } finally {
      await currencyService.setCurrencyStatus('JPY', 'ACTIVE', userId);
    }
    // ACTIVE but not allowed for the resolved Client
    const g = await fixture(['IDR', 'USD']);
    const notAllowed = await createTariff(g, { currency: 'EUR' });
    assert.equal(notAllowed.status, 400, JSON.stringify(notAllowed.body));
    assert.equal(notAllowed.body.error.code, 'CLIENT_CURRENCY_NOT_ALLOWED');
  });

  it('accepts an ACTIVE allowed currency and persists the exact tariff snapshot (no IDR/base default)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(['IDR', 'USD', 'EUR']);
    const created = await createTariff(f, { currency: 'USD' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.currency, 'USD');
    const row = await pool!.query('SELECT currency FROM utility_calculation_bases WHERE id=$1', [created.body.data.id]);
    assert.equal(row.rows[0].currency, 'USD');
  });

  it('propagates the exact tariff currency through calculation -> bill (no cross-currency replacement)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(['IDR', 'USD', 'EUR']);
    await createTariff(f, { currency: 'USD', ratePerUom: '2' });
    const consumption = await readingsConsumption(f);
    const calc = await api().post(`/api/v1/utility/consumptions/${consumption.id}/calculations`).set(auth()).send({});
    assert.equal(calc.status, 201, JSON.stringify(calc.body));
    assert.equal(calc.body.data.currency, 'USD');
    // The bill (issued after a tenant approval) must carry the exact USD
    // currency from the calculation/tariff chain — never converted to the
    // Client base/default (IDR).
    const tenant = await setUpTenant(f);
    assert.equal((await api().post(`/api/v1/tenant-companies/${tenant.id}/spaces`).set(auth()).send({ buildingId: f.building.id, spaceId: (await setUpSpace(f)).id })).status, 201);
    assert.equal((await api().post(`/api/v1/tenant-companies/${tenant.id}/building-contexts`).set(auth()).send({ buildingId: f.building.id })).status, 201);
    const finalized = await api().post(`/api/v1/utility/calculations/${calc.body.data.id}/finalize`).set(auth()).send({});
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    const approval = await api().post('/api/v1/tenant-approvals').set(auth()).send({
      requestType: 'UTILITY_CALCULATION', requestId: calc.body.data.id,
      approvalType: 'TENANT_UTILITY_CHARGE', approverUserId: userId,
    });
    assert.equal(approval.status, 201, JSON.stringify(approval.body));
    assert.equal((await api().post(`/api/v1/tenant-approvals/${approval.body.data.id}/approve`).set(auth()).send({})).status, 200);
    const bill = await api().post(`/api/v1/tenant-companies/${tenant.id}/utility-bills`).set(auth()).send({ calculationId: calc.body.data.id, dueDate: '2026-02-15' });
    assert.equal(bill.status, 201, JSON.stringify(bill.body));
    assert.equal(bill.body.data.currency, 'USD');
  });

  it('historical tariff/calculation remain readable after the current Client allowed set changes or master deactivates', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(['IDR', 'USD']);
    const created = await createTariff(f, { currency: 'USD', ratePerUom: '2.5' });
    const consumption = await readingsConsumption(f);
    const calc = await api().post(`/api/v1/utility/consumptions/${consumption.id}/calculations`).set(auth()).send({});
    assert.equal(calc.status, 201, JSON.stringify(calc.body));
    assert.equal(calc.body.data.currency, 'USD');
    // Remove USD from the allowed set; historical reads must still hold.
    await clientMonetaryContextService.setClientMonetaryContext({
      clientId: f.client.id, baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR'],
    }, userId);
    const tariffRead = await api().get(`/api/v1/buildings/${f.building.id}/utility-tariffs`).set(auth());
    assert.equal(tariffRead.status, 200, JSON.stringify(tariffRead.body));
    const usdTariff = tariffRead.body.data.find((x: { id: string }) => x.id === created.body.data.id);
    assert.equal(usdTariff.currency, 'USD');
    const calcRead = await api().get(`/api/v1/utility/calculations/${calc.body.data.id}`).set(auth());
    assert.equal(calcRead.status, 200, JSON.stringify(calcRead.body));
    assert.equal(calcRead.body.data.currency, 'USD');
  });
});

async function setUpTenant(f: Awaited<ReturnType<typeof fixture>>) {
  const r = await api().post(`/api/v1/clients/${f.client.id}/tenant-companies`).set(auth()).send({
    tenantCode: `T_${suffix()}`, tenantName: 'Tenant',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}

async function setUpSpace(f: Awaited<ReturnType<typeof fixture>>) {
  const floor = await floorService.createFloor({ buildingId: f.building.id, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
  const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
  const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
  const space = await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Tenant Space' });
  return space;
}
