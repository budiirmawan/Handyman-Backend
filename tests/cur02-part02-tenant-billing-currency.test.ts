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
 * CR-BE-CUR-02 PART 02 — Tenant billing currency.
 *
 * Proofs: tenant charges require a governed currency (ACTIVE + Client-allowed),
 * persist and snapshot it, keep legacy NULL readable and fail closed on a
 * monetary amount change; tenant invoices demand one exact header currency and
 * exact-equality line/source currencies; the finalize guard rejects unknown or
 * mixed currencies; no default, Client-default injection, inference, or FX.
 */
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = () => ({ Authorization: `Bearer ${token}` });

before(async () => {
  const db = await ensureTestDatabase(); if (!db) return;
  pool = await initDatabase(db); await migrateUp(pool);
  await pool.query(`TRUNCATE tenant_invoice_history, tenant_invoice_lines,
    tenant_invoices, service_charge_readiness_history, service_charge_readiness,
    utility_bill_history, utility_bills, tenant_charge_history, tenant_charges,
    utility_calculations, utility_calculation_bases, utility_meter_consumptions,
    utility_meter_readings, utility_meter_tenant_assignments, utility_meters,
    units_of_measure, tenant_building_contexts, tenant_space_relationships,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser(); token = admin.token; userId = admin.userId; database = db;
});
after(async () => { if (pool) await closePool(pool); pool = null; database = null; });
function ready(t: TestContext): boolean { if (!database || !pool) { t.skip('test database unavailable'); return false; } return true; }

async function fixture(codes: string[] = ['IDR', 'USD', 'JPY', 'EUR']) {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Billing Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  await buildingAssignmentService.createAssignment(userId, { buildingId: building.id });
  await clientMonetaryContextService.setClientMonetaryContext({ clientId: client.id, baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: codes }, userId);
  const floor = await floorService.createFloor({ buildingId: building.id, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
  const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
  const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
  const space = await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Tenant Space' });
  const tenantRes = await api().post(`/api/v1/clients/${client.id}/tenant-companies`).set(auth()).send({ tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company' });
  assert.equal(tenantRes.status, 201, JSON.stringify(tenantRes.body));
  const tenant = tenantRes.body.data;
  assert.equal((await api().post(`/api/v1/tenant-companies/${tenant.id}/spaces`).set(auth()).send({ buildingId: building.id, spaceId: space.id })).status, 201);
  assert.equal((await api().post(`/api/v1/tenant-companies/${tenant.id}/building-contexts`).set(auth()).send({ buildingId: building.id })).status, 201);
  return { client, building, space, tenant };
}

function chargePayload(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return {
    buildingId: f.building.id, spaceId: f.space.id, chargeType: 'SERVICE',
    description: 'Tenant charge', amount: 100000, currencyCode: 'IDR',
    chargeDate: '2026-08-01', dueDate: '2026-08-20', ...overrides,
  };
}
const createCharge = (f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) =>
  api().post(`/api/v1/tenant-companies/${f.tenant.id}/charges`).set(auth()).send(chargePayload(f, overrides));

function invoicePayload(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return {
    buildingId: f.building.id, spaceId: f.space.id,
    invoiceNumber: `INV-${suffix()}`, invoiceDate: '2026-08-15', dueDate: '2099-01-01',
    currencyCode: 'IDR', ...overrides,
  };
}
const createInvoice = (f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) =>
  api().post(`/api/v1/tenant-companies/${f.tenant.id}/invoices`).set(auth()).send(invoicePayload(f, overrides));
const link = (id: string, sourceType: 'TENANT_CHARGE' | 'UTILITY_BILL', sourceId: string) =>
  api().post(`/api/v1/tenant-invoices/${id}/lines`).set(auth()).send({ sourceType, sourceId });

async function legacyCharge(f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID();
  await pool!.query(`INSERT INTO tenant_charges
    (id, client_id, tenant_company_id, building_id, space_id, charge_type,
     description, amount, charge_date, status, created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,'SERVICE','Legacy charge',50000,'2026-08-01','ACTIVE',$6)`,
    [id, f.client.id, f.tenant.id, f.building.id, f.space.id, userId]);
  return id;
}

async function createIssuedUtilityBill(f: Awaited<ReturnType<typeof fixture>>, currency = 'IDR') {
  const uom = await api().post(`/api/v1/clients/${f.client.id}/uoms`).set(auth()).send({ code: `UOM_${suffix()}`, name: 'Kilowatt hour', symbol: 'kWh', category: 'ENERGY' });
  assert.equal(uom.status, 201, JSON.stringify(uom.body));
  const meter = await api().post(`/api/v1/buildings/${f.building.id}/utility-meters`).set(auth()).send({ code: `MTR_${suffix()}`, name: 'Tenant meter', utilityType: 'ELECTRICITY', uomId: uom.body.data.id });
  assert.equal(meter.status, 201, JSON.stringify(meter.body));
  assert.equal((await api().post(`/api/v1/utility/meters/${meter.body.data.id}/tenant-assignments`).set(auth()).send({ tenantCompanyId: f.tenant.id, spaceId: f.space.id })).status, 201);
  await api().post(`/api/v1/utility/meters/${meter.body.data.id}/readings`).set(auth()).send({ readingValue: 100, readingAt: '2026-01-01T00:00:00.000Z' });
  const closing = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/readings`).set(auth()).send({ readingValue: 250, readingAt: '2026-02-01T00:00:00.000Z' });
  const consumption = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/consumptions`).set(auth()).send({ currentReadingId: closing.body.data.id });
  assert.equal(consumption.status, 201, JSON.stringify(consumption.body));
  const tariff = await api().post(`/api/v1/buildings/${f.building.id}/utility-tariffs`).set(auth()).send({
    utilityType: 'ELECTRICITY', currency, uomId: uom.body.data.id, ratePerUom: '2', effectiveFrom: '2025-01-01T00:00:00.000Z',
  });
  assert.equal(tariff.status, 201, JSON.stringify(tariff.body));
  const calc = await api().post(`/api/v1/utility/consumptions/${consumption.body.data.id}/calculations`).set(auth()).send({});
  assert.equal((await api().post(`/api/v1/utility/calculations/${calc.body.data.id}/finalize`).set(auth()).send({})).status, 200);
  const approval = await api().post('/api/v1/tenant-approvals').set(auth()).send({
    requestType: 'UTILITY_CALCULATION', requestId: calc.body.data.id,
    approvalType: 'TENANT_UTILITY_CHARGE', approverUserId: userId,
  });
  assert.equal(approval.status, 201, JSON.stringify(approval.body));
  assert.equal((await api().post(`/api/v1/tenant-approvals/${approval.body.data.id}/approve`).set(auth()).send({})).status, 200);
  const bill = await api().post(`/api/v1/tenant-companies/${f.tenant.id}/utility-bills`).set(auth()).send({ calculationId: calc.body.data.id, dueDate: '2026-02-15' });
  assert.equal(bill.status, 201, JSON.stringify(bill.body));
  const issued = await api().patch(`/api/v1/utility-bills/${bill.body.data.id}`).set(auth()).send({ status: 'ISSUED' });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return issued.body.data;
}

describe('CR-BE-CUR-02 PART 02 — Tenant billing currency', () => {
  it('rejects a new Tenant charge without an explicit currency (no default/inference)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const missing = await createCharge(f, { currencyCode: undefined });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');
    const unknown = await createCharge(f, { currencyCode: 'ZZZ' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, 'CURRENCY_INACTIVE_OR_UNKNOWN');
  });

  it('rejects an INACTIVE master code even when Client-allowed', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await currencyService.setCurrencyStatus('JPY', 'INACTIVE', userId);
    try {
      const r = await createCharge(f, { currencyCode: 'JPY' });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'CURRENCY_INACTIVE_OR_UNKNOWN');
    } finally {
      await currencyService.setCurrencyStatus('JPY', 'ACTIVE', userId);
    }
  });

  it('rejects an ACTIVE currency that is not allowed for the resolved Client', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(['IDR', 'USD']);
    const r = await createCharge(f, { currencyCode: 'EUR' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'CLIENT_CURRENCY_NOT_ALLOWED');
  });

  it('persists and snapshots the exact governed currency on a created charge', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await createCharge(f, { currencyCode: 'USD' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.currencyCode, 'USD');
    const row = await pool!.query('SELECT currency_code FROM tenant_charges WHERE id=$1', [created.body.data.id]);
    assert.equal(row.rows[0].currency_code, 'USD');
    const h = await pool!.query('SELECT action,currency_code FROM tenant_charge_history WHERE tenant_charge_id=$1 ORDER BY changed_at', [created.body.data.id]);
    assert.deepEqual(h.rows.map((x) => [x.action, x.currency_code]), [['CREATED', 'USD']]);
  });

  it('keeps a legacy NULL-currency charge readable and lets non-monetary updates keep NULL', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const id = await legacyCharge(f);
    const read = await api().get(`/api/v1/tenant-charges/${id}`).set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.currencyCode, null);
    const preserved = await api().patch(`/api/v1/tenant-charges/${id}`).set(auth()).send({ notes: 'Clarification.' });
    assert.equal(preserved.status, 200, JSON.stringify(preserved.body));
    assert.equal(preserved.body.data.currencyCode, null);
  });

  it('requires an explicit currency only when a legacy NULL-currency amount changes, and is immutable after governance', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const id = await legacyCharge(f);
    const denied = await api().patch(`/api/v1/tenant-charges/${id}`).set(auth()).send({ amount: 75000 });
    assert.equal(denied.status, 400);
    assert.equal(denied.body.error.code, 'TENANT_CHARGE_CURRENCY_REQUIRED');
    const governed = await api().patch(`/api/v1/tenant-charges/${id}`).set(auth()).send({ amount: 75000, currencyCode: 'IDR' });
    assert.equal(governed.status, 200, JSON.stringify(governed.body));
    assert.equal(governed.body.data.currencyCode, 'IDR');
    const h = await pool!.query('SELECT action,currency_code FROM tenant_charge_history WHERE tenant_charge_id=$1 ORDER BY changed_at', [id]);
    assert.deepEqual(h.rows.map((x) => [x.action, x.currency_code]), [['UPDATED', 'IDR']]);
    const immut = await api().patch(`/api/v1/tenant-charges/${id}`).set(auth()).send({ currencyCode: 'USD' });
    assert.equal(immut.status, 400);
    assert.equal(immut.body.error.code, 'TENANT_CHARGE_CURRENCY_IMMUTABLE');
  });

  it('requires an Invoice header currency and validates it (no default/inference)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const missing = await createInvoice(f, { currencyCode: undefined });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');
    const unknown = await createInvoice(f, { currencyCode: 'ZZZ' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, 'CURRENCY_INACTIVE_OR_UNKNOWN');
    const notAllowed = await createInvoice(f, { currencyCode: 'EUR' });
    assert.equal(notAllowed.status, 400);
    assert.equal(notAllowed.body.error.code, 'CLIENT_CURRENCY_NOT_ALLOWED');
  });

  it('links a same-currency charge to an Invoice and persists the line currency', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const charge = await createCharge(f, { currencyCode: 'IDR' });
    const invoice = await createInvoice(f, { currencyCode: 'IDR' });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
    const linked = await link(invoice.body.data.id, 'TENANT_CHARGE', charge.body.data.id);
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    assert.equal(linked.body.data.lines[0].currencyCode, 'IDR');
  });

  it('rejects a same-tenant source charge whose currency is cross or UNKNOWN when linking', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(['IDR', 'USD']);
    const usdCharge = await createCharge(f, { currencyCode: 'USD' });
    const idrInvoice = await createInvoice(f, { currencyCode: 'IDR' });
    const mixed = await link(idrInvoice.body.data.id, 'TENANT_CHARGE', usdCharge.body.data.id);
    assert.equal(mixed.status, 400);
    assert.equal(mixed.body.error.code, 'TENANT_INVOICE_CURRENCY_MISMATCH');
    const legacyId = await legacyCharge(f);
    const unknown = await link(idrInvoice.body.data.id, 'TENANT_CHARGE', legacyId);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, 'TENANT_INVOICE_SOURCE_CURRENCY_UNKNOWN');
  });

  it('links an exact-currency issued Utility Bill to an Invoice', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const bill = await createIssuedUtilityBill(f, 'IDR');
    const invoice = await createInvoice(f, { currencyCode: 'IDR' });
    const linked = await link(invoice.body.data.id, 'UTILITY_BILL', bill.id);
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    assert.equal(linked.body.data.lines[0].currencyCode, 'IDR');
  });

  it('rejects a Utility Bill whose currency differs from the Invoice header', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(['IDR', 'USD']);
    const bill = await createIssuedUtilityBill(f, 'USD');
    const invoice = await createInvoice(f, { currencyCode: 'IDR' });
    const mixed = await link(invoice.body.data.id, 'UTILITY_BILL', bill.id);
    assert.equal(mixed.status, 400);
    assert.equal(mixed.body.error.code, 'TENANT_INVOICE_CURRENCY_MISMATCH');
  });

  it('finalize rejects an unknown header, an unknown/mixed line, and accepts a single known currency', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(['IDR', 'USD']);
    // unknown header: a legacy NULL-currency draft cannot be finalized
    const legacyId = randomUUID();
    await pool!.query(`INSERT INTO tenant_invoices
      (id, client_id, tenant_company_id, building_id, space_id, invoice_number,
       invoice_date, due_date, status, subtotal, total_amount, created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,'2026-08-15','2099-01-01','DRAFT',0,0,$7)`,
      [legacyId, f.client.id, f.tenant.id, f.building.id, f.space.id, `INV-${suffix()}`, userId]);
    const noHeader = await api().post(`/api/v1/tenant-invoices/${legacyId}/finalize`).set(auth()).send({});
    assert.equal(noHeader.status, 400);
    assert.equal(noHeader.body.error.code, 'TENANT_INVOICE_CURRENCY_REQUIRED');
    // a line whose stored currency differs from the header fails closed at finalize
    const lineCharge = await createCharge(f, { currencyCode: 'IDR', amount: 1500 });
    const mixedInv = await createInvoice(f, { currencyCode: 'IDR' });
    await pool!.query(`INSERT INTO tenant_invoice_lines
      (id, invoice_id, source_type, tenant_charge_id, amount_snapshot, currency_code)
      VALUES ($1,$2,'TENANT_CHARGE',$3,1500,'USD')`,
      [randomUUID(), mixedInv.body.data.id, lineCharge.body.data.id]);
    const mixedFinalize = await api().post(`/api/v1/tenant-invoices/${mixedInv.body.data.id}/finalize`).set(auth()).send({});
    assert.equal(mixedFinalize.status, 400);
    assert.equal(mixedFinalize.body.error.code, 'TENANT_INVOICE_CURRENCY_MISMATCH');
    // valid single-currency finalize succeeds and totals are single-currency
    const idrCharge = await createCharge(f, { currencyCode: 'IDR', amount: 1500 });
    const valid = await createInvoice(f, { currencyCode: 'IDR' });
    await link(valid.body.data.id, 'TENANT_CHARGE', idrCharge.body.data.id);
    const finalized = await api().post(`/api/v1/tenant-invoices/${valid.body.data.id}/finalize`).set(auth()).send({});
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    assert.equal(finalized.body.data.status, 'FINALIZED');
    assert.equal(finalized.body.data.currencyCode, 'IDR');
    assert.equal(finalized.body.data.totalAmount, 1500);
  });
});
