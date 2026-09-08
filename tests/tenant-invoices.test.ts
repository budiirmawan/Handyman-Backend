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
import { parseCreateTenantInvoiceBody } from '../src/modules/tenant-invoices';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });

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

async function fixture(assignedUserId = userId, withToken = token) {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Owner Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  await buildingAssignmentService.createAssignment(assignedUserId, { buildingId: building.id });
  await clientMonetaryContextService.setClientMonetaryContext({ clientId: client.id, baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR', 'USD'] }, assignedUserId);
  const floor = await floorService.createFloor({ buildingId: building.id, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
  const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
  const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
  const space = await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Tenant Space' });
  const tenantResponse = await api().post(`/api/v1/clients/${client.id}/tenant-companies`).set(auth(withToken)).send({
    tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company',
  });
  assert.equal(tenantResponse.status, 201, JSON.stringify(tenantResponse.body));
  const tenant = tenantResponse.body.data;
  assert.equal((await api().post(`/api/v1/tenant-companies/${tenant.id}/spaces`).set(auth(withToken)).send({ buildingId: building.id, spaceId: space.id })).status, 201);
  assert.equal((await api().post(`/api/v1/tenant-companies/${tenant.id}/building-contexts`).set(auth(withToken)).send({ buildingId: building.id })).status, 201);
  return { client, building, space, tenant };
}
async function createCharge(f: Awaited<ReturnType<typeof fixture>>, amount = 500000, currencyCode = 'IDR') {
  const response = await api().post(`/api/v1/tenant-companies/${f.tenant.id}/charges`).set(auth()).send({
    buildingId: f.building.id, spaceId: f.space.id, chargeType: 'RENTAL_SERVICE',
    description: 'Tenant operational charge', amount, currencyCode,
    chargeDate: '2026-08-01', dueDate: '2026-08-20',
  });
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.data;
}
async function createIssuedUtilityBill(f: Awaited<ReturnType<typeof fixture>>) {
  const uom = await api().post(`/api/v1/clients/${f.client.id}/uoms`).set(auth()).send({ code: `UOM_${suffix()}`, name: 'Kilowatt hour', symbol: 'kWh', category: 'ENERGY' });
  const meter = await api().post(`/api/v1/buildings/${f.building.id}/utility-meters`).set(auth()).send({ code: `MTR_${suffix()}`, name: 'Tenant meter', utilityType: 'ELECTRICITY', uomId: uom.body.data.id });
  assert.equal(meter.status, 201, JSON.stringify(meter.body));
  assert.equal((await api().post(`/api/v1/utility/meters/${meter.body.data.id}/tenant-assignments`).set(auth()).send({ tenantCompanyId: f.tenant.id, spaceId: f.space.id })).status, 201);
  await api().post(`/api/v1/utility/meters/${meter.body.data.id}/readings`).set(auth()).send({ readingValue: 100, readingAt: '2026-01-01T00:00:00.000Z' });
  const closing = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/readings`).set(auth()).send({ readingValue: 250, readingAt: '2026-02-01T00:00:00.000Z' });
  const consumption = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/consumptions`).set(auth()).send({ currentReadingId: closing.body.data.id });
  assert.equal(consumption.status, 201, JSON.stringify(consumption.body));
  assert.equal((await api().post(`/api/v1/clients/${f.client.id}/utility-calculation-bases`).set(auth()).send({ utilityType: 'ELECTRICITY', name: 'Rate', rateValue: 2, effectiveFrom: '2025-01-01T00:00:00.000Z' })).status, 201);
  const tariff = await api().post(`/api/v1/buildings/${f.building.id}/utility-tariffs`).set(auth()).send({
    utilityType: 'ELECTRICITY', currency: 'IDR', uomId: uom.body.data.id,
    ratePerUom: '2', effectiveFrom: '2025-01-01T00:00:00.000Z',
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
  assert.equal(issued.status, 200, JSON.stringify(issued.body)); return issued.body.data;
}
function invoicePayload(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return { buildingId: f.building.id, spaceId: f.space.id, invoiceNumber: `INV-${suffix()}`,
    invoiceDate: '2026-08-15', dueDate: '2026-08-31', currencyCode: 'IDR',
    notes: 'Operational invoice.', ...overrides };
}
async function createInvoice(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return api().post(`/api/v1/tenant-companies/${f.tenant.id}/invoices`).set(auth()).send(invoicePayload(f, overrides));
}
async function link(id: string, sourceType: 'TENANT_CHARGE' | 'UTILITY_BILL', sourceId: string, withToken = token) {
  return api().post(`/api/v1/tenant-invoices/${id}/lines`).set(auth(withToken)).send({ sourceType, sourceId });
}

describe('BE-19D Tenant Invoice', () => {
  it('validates Invoice and due dates without database access', () => {
    const parsed = parseCreateTenantInvoiceBody({ buildingId: randomUUID(), spaceId: randomUUID(), invoiceNumber: ' inv-001 ', invoiceDate: '2026-08-01', dueDate: '2026-08-31', currencyCode: 'IDR' });
    assert.equal(parsed.invoiceNumber, 'INV-001');
    assert.throws(() => parseCreateTenantInvoiceBody({ ...parsed, dueDate: '2026-07-31' }));
  });
  it('creates, gets, and filters a draft Invoice', async (t) => {
    if (!ready(t)) return; const f = await fixture(); const created = await createInvoice(f);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'DRAFT'); assert.equal(created.body.data.totalAmount, 0);
    assert.equal((await api().get(`/api/v1/tenant-invoices/${created.body.data.id}`).set(auth())).status, 200);
    const list = await api().get('/api/v1/tenant-invoices').query({ tenantCompanyId: f.tenant.id, buildingId: f.building.id, status: 'DRAFT', invoiceDateFrom: '2026-08-01', invoiceDateTo: '2026-08-31' }).set(auth());
    assert.equal(list.status, 200); assert.equal(list.body.data.length, 1);
  });
  it('links a valid Tenant Charge and maintains totals', async (t) => {
    if (!ready(t)) return; const f = await fixture(); const charge = await createCharge(f); const invoice = await createInvoice(f);
    const linked = await link(invoice.body.data.id, 'TENANT_CHARGE', charge.id);
    assert.equal(linked.status, 201, JSON.stringify(linked.body)); assert.equal(linked.body.data.subtotal, 500000); assert.equal(linked.body.data.totalAmount, 500000);
    assert.equal(linked.body.data.lines[0].tenantChargeId, charge.id);
  });
  it('links a valid issued Utility Bill', async (t) => {
    if (!ready(t)) return; const f = await fixture(); const bill = await createIssuedUtilityBill(f); const invoice = await createInvoice(f);
    const linked = await link(invoice.body.data.id, 'UTILITY_BILL', bill.id);
    assert.equal(linked.status, 201, JSON.stringify(linked.body)); assert.equal(linked.body.data.totalAmount, 300); assert.equal(linked.body.data.lines[0].utilityBillId, bill.id);
  });
  it('rejects invalid charge references', async (t) => {
    if (!ready(t)) return; const f = await fixture(); const invoice = await createInvoice(f);
    const response = await link(invoice.body.data.id, 'TENANT_CHARGE', randomUUID());
    assert.equal(response.status, 400); assert.equal(response.body.error.code, 'TENANT_INVOICE_SOURCE_INVALID');
  });
  it('rejects duplicate invoicing of a source charge', async (t) => {
    if (!ready(t)) return; const f = await fixture(); const charge = await createCharge(f); const one = await createInvoice(f); const two = await createInvoice(f);
    assert.equal((await link(one.body.data.id, 'TENANT_CHARGE', charge.id)).status, 201);
    const duplicate = await link(two.body.data.id, 'TENANT_CHARGE', charge.id);
    assert.equal(duplicate.status, 409); assert.equal(duplicate.body.error.code, 'TENANT_INVOICE_SOURCE_ALREADY_INVOICED');
  });
  it('keeps subtotal and total consistent across Tenant Charge and Utility Bill lines', async (t) => {
    if (!ready(t)) return; const f = await fixture(); const charge = await createCharge(f, 1000); const bill = await createIssuedUtilityBill(f); const invoice = await createInvoice(f);
    await link(invoice.body.data.id, 'TENANT_CHARGE', charge.id); const both = await link(invoice.body.data.id, 'UTILITY_BILL', bill.id);
    assert.equal(both.body.data.subtotal, 1300); assert.equal(both.body.data.totalAmount, 1300);
  });
  it('validates due dates on draft update', async (t) => {
    if (!ready(t)) return; const f = await fixture(); const invoice = await createInvoice(f);
    const response = await api().patch(`/api/v1/tenant-invoices/${invoice.body.data.id}`).set(auth()).send({ dueDate: '2026-08-14' });
    assert.equal(response.status, 400); assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
  it('refreshes totals on finalization and protects the finalized Invoice', async (t) => {
    if (!ready(t)) return; const f = await fixture(); const charge = await createCharge(f, 1000); const invoice = await createInvoice(f); const id = invoice.body.data.id;
    await link(id, 'TENANT_CHARGE', charge.id);
    await api().patch(`/api/v1/tenant-charges/${charge.id}`).set(auth()).send({ amount: 1250 });
    const finalized = await api().post(`/api/v1/tenant-invoices/${id}/finalize`).set(auth()).send({});
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body)); assert.equal(finalized.body.data.status, 'FINALIZED'); assert.equal(finalized.body.data.totalAmount, 1250);
    const update = await api().patch(`/api/v1/tenant-invoices/${id}`).set(auth()).send({ notes: 'overwrite' });
    assert.equal(update.status, 400); assert.equal(update.body.error.code, 'TENANT_INVOICE_FINALIZED_PROTECTED');
    const add = await link(id, 'TENANT_CHARGE', (await createCharge(f, 50)).id);
    assert.equal(add.status, 400); assert.equal(add.body.error.code, 'TENANT_INVOICE_FINALIZED_PROTECTED');
    const retry = await api().post(`/api/v1/tenant-invoices/${id}/finalize`).set(auth()).send({});
    assert.equal(retry.status, 400);
  });
  it('enforces RBAC', async (t) => {
    if (!ready(t)) return; const f = await fixture(); const plain = await createPlainSession();
    const response = await api().post(`/api/v1/tenant-companies/${f.tenant.id}/invoices`).set(auth(plain)).send(invoicePayload(f));
    assert.equal(response.status, 403); assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });
  it('enforces Client and Building isolation', async (t) => {
    if (!ready(t)) return; const f = await fixture(); const invoice = await createInvoice(f); const other = await createAdminUser(); await fixture(other.userId, other.token);
    const denied = await api().get(`/api/v1/tenant-invoices/${invoice.body.data.id}`).set(auth(other.token));
    assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
    const list = await api().get('/api/v1/tenant-invoices').set(auth(other.token)); assert.equal(list.status, 200); assert.equal(list.body.data.some((x: {id:string}) => x.id === invoice.body.data.id), false);
  });
});
