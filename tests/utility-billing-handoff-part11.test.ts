import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
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
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55481;
const DIR = '/tmp/asentra-part11-pg';
if (EMBEDDED) {
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_PORT: String(PORT), DB_USER: 'postgres',
    DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false',
  });
}
let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  if (EMBEDDED) {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({ databaseDir: DIR, port: PORT,
      user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
    await postgres.initialise();
    await postgres.start();
    const admin = postgres.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }
  const config = await ensureTestDatabase();
  if (!config) return;
  database = config;
  pool = await initDatabase(config);
  await migrateUp(pool);
  await pool.query(`TRUNCATE utility_bill_history, utility_bills,
    tenant_approval_bindings, utility_calculations, utility_calculation_bases,
    utility_meter_consumptions, utility_meter_readings,
    utility_meter_tenant_assignments, utility_meter_hierarchies,
    utility_type_uoms, utility_type_configurations, utility_meters,
    units_of_measure, tenant_space_relationships, tenant_companies,
    functional_locations, spaces, rooms, areas, floors,
    user_building_assignments, buildings, properties, users, roles,
    permissions, role_permission_assignments, user_role_assignments,
    clients CASCADE`);
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally { await rm(DIR, { recursive: true, force: true }); }
  pool = null; postgres = null; database = null;
});

function ready(t: TestContext) {
  if (!database || !pool) {
    t.skip('PART 11 PostgreSQL database unavailable');
    return false;
  }
  return true;
}

async function structure() {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Billing Client' });
  const property = await propertyService.createProperty({ clientId: client.id,
    code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id,
    code: `B_${suffix()}`, name: 'Building' });
  await buildingAssignmentService.createAssignment(userId, { buildingId: building.id });
  await clientMonetaryContextService.setClientMonetaryContext({
    clientId: client.id, baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR',
    allowedCurrencyCodes: ['IDR'],
  }, userId);
  const floor = await floorService.createFloor({ buildingId: building.id,
    code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
  const area = await areaService.createArea({ floorId: floor.id,
    code: `A_${suffix()}`, name: 'Area' });
  const room = await roomService.createRoom({ areaId: area.id,
    code: `R_${suffix()}`, name: 'Room' });
  const space = await spaceService.createSpace({ roomId: room.id,
    code: `S_${suffix()}`, name: 'Tenant Space' });
  const uom = await api().post(`/api/v1/clients/${client.id}/uoms`).set(auth()).send({
    code: `U_${suffix()}`, name: 'Kilowatt hour', symbol: 'kWh', category: 'ENERGY',
  });
  assert.equal(uom.status, 201, JSON.stringify(uom.body));
  return { client, building, space, uomId: uom.body.data.id as string };
}

async function tenantCharge(options: { purpose?: string; tenant?: boolean } = {}) {
  const s = await structure();
  const meter = await api().post(`/api/v1/buildings/${s.building.id}/utility-meters`).set(auth()).send({
    code: `M_${suffix()}`, name: 'Electricity meter', utilityType: 'ELECTRICITY',
    purpose: options.purpose ?? 'TENANT', uomId: s.uomId,
  });
  assert.equal(meter.status, 201, JSON.stringify(meter.body));

  let tenantId: string | null = null;
  let assignmentId: string | null = null;
  if (options.tenant !== false) {
    const tenant = await api().post(`/api/v1/clients/${s.client.id}/tenant-companies`).set(auth()).send({
      tenantCode: `T_${suffix()}`, tenantName: 'Original Tenant',
    });
    assert.equal(tenant.status, 201, JSON.stringify(tenant.body));
    tenantId = tenant.body.data.id;
    const lease = await api().post(`/api/v1/tenant-companies/${tenantId}/spaces`).set(auth()).send({
      buildingId: s.building.id, spaceId: s.space.id,
    });
    assert.equal(lease.status, 201, JSON.stringify(lease.body));
    const assignment = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/tenant-assignments`).set(auth()).send({
      tenantCompanyId: tenantId, spaceId: s.space.id,
    });
    assert.equal(assignment.status, 201, JSON.stringify(assignment.body));
    assignmentId = assignment.body.data.id;
  }

  const first = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/readings`).set(auth()).send({
    readingValue: 100, readingAt: '2026-01-01T00:00:00.000Z',
  });
  const second = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/readings`).set(auth()).send({
    readingValue: 125, readingAt: '2026-02-01T00:00:00.000Z',
  });
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  const consumption = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/consumptions`).set(auth()).send({
    previousReadingId: first.body.data.id, currentReadingId: second.body.data.id,
  });
  assert.equal(consumption.status, 201, JSON.stringify(consumption.body));
  const tariff = await api().post(`/api/v1/buildings/${s.building.id}/utility-tariffs`).set(auth()).send({
    utilityType: 'ELECTRICITY', currency: 'IDR', uomId: s.uomId,
    ratePerUom: '1500', effectiveFrom: '2025-01-01T00:00:00.000Z',
  });
  assert.equal(tariff.status, 201, JSON.stringify(tariff.body));
  const calculation = await api().post(`/api/v1/utility/consumptions/${consumption.body.data.id}/calculations`).set(auth()).send({});
  assert.equal(calculation.status, 201, JSON.stringify(calculation.body));
  const finalized = await api().post(`/api/v1/utility/calculations/${calculation.body.data.id}/finalize`).set(auth()).send({});
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
  return { ...s, meterId: meter.body.data.id as string, tenantId, assignmentId,
    tariffId: tariff.body.data.id as string, calculation: finalized.body.data };
}

async function approval(
  c: Awaited<ReturnType<typeof tenantCharge>>,
  approvalType = 'TENANT_UTILITY_CHARGE',
) {
  return api().post('/api/v1/tenant-approvals').set(auth()).send({
    requestType: 'UTILITY_CALCULATION', requestId: c.calculation.id,
    approvalType, approverUserId: userId,
  });
}
async function decide(id: string, value: 'approve' | 'reject') {
  return api().post(`/api/v1/tenant-approvals/${id}/${value}`).set(auth()).send(
    value === 'reject' ? { decisionNotes: 'Tenant disputed the reading.' } : {},
  );
}
async function bill(c: Awaited<ReturnType<typeof tenantCharge>>) {
  return api().post(`/api/v1/tenant-companies/${c.tenantId}/utility-bills`).set(auth()).send({
    calculationId: c.calculation.id, dueDate: '2026-02-15',
  });
}

describe('CR-BE-UTL-01 PART 11 — Tenant approval and billing handoff', () => {
  it('creates a Utility Bill and invoice-ready projection from an approved calculation', async (t) => {
    if (!ready(t)) return;
    const c = await tenantCharge();
    const pending = await approval(c);
    assert.equal(pending.status, 201, JSON.stringify(pending.body));
    assert.equal(pending.body.data.utilitySpaceId, c.space.id);
    assert.equal(pending.body.data.utilityMeterId, c.meterId);
    assert.equal(pending.body.data.utilityConsumptionQuantity, 25);
    assert.equal(pending.body.data.utilityTariffRate, 1500);
    assert.equal(pending.body.data.utilityCalculatedAmount, 37500);
    assert.equal(pending.body.data.utilityCurrency, 'IDR');
    const approved = await decide(pending.body.data.id, 'approve');
    assert.equal(approved.status, 200);
    assert.ok(approved.body.data.decidedAt);
    const created = await bill(c);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.approvalId, pending.body.data.id);
    assert.equal(created.body.data.spaceId, c.space.id);
    assert.equal(created.body.data.consumptionQuantity, 25);
    assert.equal(created.body.data.tariffRate, 1500);
    assert.equal(created.body.data.billAmount, 37500);
    assert.equal(created.body.data.currency, 'IDR');
    const handoff = await api().get(`/api/v1/utility-bills/${created.body.data.id}/invoice-ready`).set(auth());
    assert.equal(handoff.status, 200, JSON.stringify(handoff.body));
    assert.deepEqual(handoff.body.data, {
      tenantCompanyId: c.tenantId,
      billingPeriod: { start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' },
      chargeDescription: 'ELECTRICITY utility charge', utilityType: 'ELECTRICITY',
      quantity: 25, uomId: c.uomId, unitRate: 1500, amount: 37500,
      currency: 'IDR', utilityBillId: created.body.data.id,
      sourceCalculationId: c.calculation.id,
    });
  });

  it('blocks a PENDING calculation from billing handoff', async (t) => {
    if (!ready(t)) return;
    const c = await tenantCharge();
    assert.equal((await approval(c)).status, 201);
    const blocked = await bill(c);
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, 'UTILITY_BILL_APPROVAL_REQUIRED');
  });

  it('blocks a REJECTED calculation and preserves rejection facts', async (t) => {
    if (!ready(t)) return;
    const c = await tenantCharge();
    const pending = await approval(c);
    const rejected = await decide(pending.body.data.id, 'reject');
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.data.decisionNotes, 'Tenant disputed the reading.');
    assert.equal(rejected.body.data.approverUserId, userId);
    assert.ok(rejected.body.data.decidedAt);
    const blocked = await bill(c);
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, 'UTILITY_BILL_APPROVAL_REJECTED');
  });

  it('blocks billing while any approval remains pending', async (t) => {
    if (!ready(t)) return;
    const c = await tenantCharge();
    const first = await approval(c, 'TENANT_UTILITY_CHARGE');
    const second = await approval(c, 'FINANCE_UTILITY_CHECK');
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal((await decide(first.body.data.id, 'approve')).status, 200);
    const blocked = await bill(c);
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, 'UTILITY_BILL_APPROVAL_REQUIRED');
  });

  it('prevents duplicate bills for one approved calculation', async (t) => {
    if (!ready(t)) return;
    const c = await tenantCharge();
    const pending = await approval(c); await decide(pending.body.data.id, 'approve');
    assert.equal((await bill(c)).status, 201);
    const duplicate = await bill(c);
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.error.code, 'UTILITY_BILL_ALREADY_EXISTS');
  });

  it('keeps the billing snapshot immutable after tariff and meter changes', async (t) => {
    if (!ready(t)) return;
    const c = await tenantCharge();
    const pending = await approval(c); await decide(pending.body.data.id, 'approve');
    const created = await bill(c);
    await pool!.query('UPDATE utility_calculation_bases SET rate_value = 9999, currency = $2 WHERE id = $1', [c.tariffId, 'USD']);
    await pool!.query("UPDATE utility_meters SET utility_type = 'WATER', purpose = 'COMMON_AREA' WHERE id = $1", [c.meterId]);
    const read = await api().get(`/api/v1/utility-bills/${created.body.data.id}`).set(auth());
    assert.equal(read.body.data.utilityType, 'ELECTRICITY');
    assert.equal(read.body.data.tariffRate, 1500);
    assert.equal(read.body.data.billAmount, 37500);
    assert.equal(read.body.data.currency, 'IDR');
  });

  it('uses the Tenant and Space attribution captured by approval history', async (t) => {
    if (!ready(t)) return;
    const c = await tenantCharge();
    const pending = await approval(c); await decide(pending.body.data.id, 'approve');
    const other = await api().post(`/api/v1/clients/${c.client.id}/tenant-companies`).set(auth()).send({
      tenantCode: `T_${suffix()}`, tenantName: 'Later Tenant',
    });
    await pool!.query('UPDATE utility_meter_tenant_assignments SET tenant_company_id = $2 WHERE id = $1',
      [c.assignmentId, other.body.data.id]);
    const created = await bill(c);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.tenantCompanyId, c.tenantId);
    assert.equal(created.body.data.spaceId, c.space.id);
  });

  it('excludes BUILDING-purpose meters from Tenant approval and billing', async (t) => {
    if (!ready(t)) return;
    const c = await tenantCharge({ purpose: 'BUILDING', tenant: false });
    const bind = await approval(c);
    assert.equal(bind.status, 400, JSON.stringify(bind.body));
    assert.equal(bind.body.error.code, 'TENANT_APPROVAL_CONTEXT_MISMATCH');
    const tenant = await api().post(`/api/v1/clients/${c.client.id}/tenant-companies`).set(auth()).send({
      tenantCode: `T_${suffix()}`, tenantName: 'Unrelated Tenant',
    });
    const billing = await api().post(`/api/v1/tenant-companies/${tenant.body.data.id}/utility-bills`).set(auth()).send({
      calculationId: c.calculation.id, dueDate: '2026-02-15',
    });
    assert.equal(billing.status, 400, JSON.stringify(billing.body));
    assert.equal(billing.body.error.code, 'UTILITY_BILL_CALCULATION_INVALID');
  });

  it('enforces Building isolation on billing and invoice-ready reads', async (t) => {
    if (!ready(t)) return;
    const c = await tenantCharge();
    const pending = await approval(c); await decide(pending.body.data.id, 'approve');
    const created = await bill(c);
    const outsider = await createAdminUser();
    const deniedBill = await api().get(`/api/v1/utility-bills/${created.body.data.id}`).set(auth(outsider.token));
    const deniedHandoff = await api().get(`/api/v1/utility-bills/${created.body.data.id}/invoice-ready`).set(auth(outsider.token));
    assert.equal(deniedBill.status, 403, JSON.stringify(deniedBill.body));
    assert.equal(deniedHandoff.status, 403, JSON.stringify(deniedHandoff.body));
  });
});
