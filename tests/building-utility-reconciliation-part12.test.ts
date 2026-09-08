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
const PORT = 55482;
const DIR = '/tmp/asentra-part12-pg';
if (EMBEDDED) Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: String(PORT),
  DB_USER: 'postgres', DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false' });
let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const period = { periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z' };

before(async () => {
  if (EMBEDDED) {
    await rm(DIR, { recursive: true, force: true }); await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({ databaseDir: DIR, port: PORT, user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
    await postgres.initialise(); await postgres.start();
    const admin = postgres.getPgClient('postgres', '127.0.0.1'); await admin.connect();
    await admin.query('CREATE DATABASE asentra_test'); await admin.end();
  }
  const config = await ensureTestDatabase(); if (!config) return;
  database = config; pool = await initDatabase(config); await migrateUp(pool);
  await pool.query(`TRUNCATE building_utility_reconciliations,
    utility_bill_history, utility_bills, tenant_approval_bindings,
    utility_calculations, utility_calculation_bases, utility_meter_consumptions,
    utility_meter_readings, utility_meter_tenant_assignments,
    utility_meter_hierarchies, utility_type_uoms, utility_type_configurations,
    utility_meters, units_of_measure, tenant_space_relationships,
    tenant_companies, functional_locations, spaces, rooms, areas, floors,
    user_building_assignments, buildings, properties, users, roles,
    permissions, role_permission_assignments, user_role_assignments,
    clients CASCADE`);
  const admin = await createAdminUser(); token = admin.token; userId = admin.userId;
});
after(async () => {
  try { if (pool) await closePool(pool); if (postgres) await postgres.stop(); }
  finally { await rm(DIR, { recursive: true, force: true }); }
  pool = null; postgres = null; database = null;
});
function ready(t: TestContext) { if (!database || !pool) { t.skip('PART 12 PostgreSQL unavailable'); return false; } return true; }

type Kind = 'ELECTRICITY' | 'WATER';
type Purpose = 'BUILDING' | 'ENERGY_SOURCE' | 'COMMON_AREA' | 'TENANT';
async function structure(kind: Kind, areaSqm = 100) {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Analytics Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  await buildingAssignmentService.createAssignment(userId, { buildingId: building.id });
  await clientMonetaryContextService.setClientMonetaryContext({
    clientId: client.id, baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR',
    allowedCurrencyCodes: ['IDR', 'USD'],
  }, userId);
  const floor = await floorService.createFloor({ buildingId: building.id, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
  const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
  const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
  const space = await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Measured Space', areaSqm });
  const uom = await api().post(`/api/v1/clients/${client.id}/uoms`).set(auth()).send({
    code: `U_${suffix()}`, name: kind === 'ELECTRICITY' ? 'Kilowatt hour' : 'Cubic metre',
    symbol: kind === 'ELECTRICITY' ? 'kWh' : 'm3', category: kind === 'ELECTRICITY' ? 'ENERGY' : 'VOLUME',
  });
  assert.equal(uom.status, 201, JSON.stringify(uom.body));
  return { client, building, space, uomId: uom.body.data.id as string, kind };
}
async function consumption(s: Awaited<ReturnType<typeof structure>>, purpose: Purpose, amount: number) {
  const meter = await api().post(`/api/v1/buildings/${s.building.id}/utility-meters`).set(auth()).send({
    code: `M_${suffix()}`, name: `${purpose} meter`, utilityType: s.kind, purpose, uomId: s.uomId,
  });
  assert.equal(meter.status, 201, JSON.stringify(meter.body));
  const first = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/readings`).set(auth()).send({ readingValue: 100, readingAt: period.periodStart });
  const second = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/readings`).set(auth()).send({ readingValue: 100 + amount, readingAt: period.periodEnd });
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  const result = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/consumptions`).set(auth()).send({ previousReadingId: first.body.data.id, currentReadingId: second.body.data.id });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return { meterId: meter.body.data.id as string, consumptionId: result.body.data.id as string };
}
async function scenario(kind: Kind, values = { source: 100, tenant: 60, common: 30 }, areaSqm = 100) {
  const s = await structure(kind, areaSqm);
  const source = await consumption(s, 'ENERGY_SOURCE', values.source);
  const tenant = await consumption(s, 'TENANT', values.tenant);
  const common = await consumption(s, 'COMMON_AREA', values.common);
  return { ...s, source, tenant, common };
}
async function reconcile(s: Awaited<ReturnType<typeof scenario>>, tokenValue = token) {
  return api().post(`/api/v1/buildings/${s.building.id}/utility-reconciliations`).set(auth(tokenValue)).send({ utilityType: s.kind, ...period });
}

describe('CR-BE-UTL-01 PART 12 — Building reconciliation and IKE/IKA', () => {
  it('reconciles Electricity source, Tenant, and common-area consumption', async (t) => {
    if (!ready(t)) return; const s = await scenario('ELECTRICITY');
    const response = await reconcile(s); assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.sourceConsumption, 100);
    assert.equal(response.body.data.tenantConsumption, 60);
    assert.equal(response.body.data.commonAreaConsumption, 30);
    assert.equal(response.body.data.reconciliationPercentage, 90);
    assert.equal((await pool!.query('SELECT COUNT(*)::int count FROM tenant_approval_bindings')).rows[0].count, 0);
    assert.equal((await pool!.query('SELECT COUNT(*)::int count FROM utility_bills')).rows[0].count, 0);
  });

  it('uses the same reconciliation foundation for Water m3', async (t) => {
    if (!ready(t)) return; const s = await scenario('WATER', { source: 50, tenant: 20, common: 10 });
    const response = await reconcile(s); assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.sourceConsumption, 50);
    assert.equal(response.body.data.tenantConsumption, 20);
    assert.equal(response.body.data.commonAreaConsumption, 10);
    assert.equal(response.body.data.unallocatedConsumption, 20);
  });

  it('persists unallocated consumption without forcing balance', async (t) => {
    if (!ready(t)) return; const s = await scenario('ELECTRICITY', { source: 100, tenant: 80, common: 40 });
    const response = await reconcile(s); assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.unallocatedConsumption, -20);
    assert.equal(response.body.data.reconciliationPercentage, 120);
  });

  it('calculates IKE as source kWh divided by applicable m2', async (t) => {
    if (!ready(t)) return; const s = await scenario('ELECTRICITY', undefined, 200);
    const response = await reconcile(s); assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.performanceMetric, 'IKE');
    assert.equal(response.body.data.performanceUom, 'kWh/m²');
    assert.equal(response.body.data.applicableAreaSqm, 200);
    assert.equal(response.body.data.performanceValue, 0.5);
  });

  it('calculates IKA as source m3 divided by applicable m2', async (t) => {
    if (!ready(t)) return; const s = await scenario('WATER', { source: 40, tenant: 10, common: 5 }, 80);
    const response = await reconcile(s); assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.performanceMetric, 'IKA');
    assert.equal(response.body.data.performanceUom, 'm³/m²');
    assert.equal(response.body.data.performanceValue, 0.5);
  });

  it('preserves consumption and area snapshots after source data changes', async (t) => {
    if (!ready(t)) return; const s = await scenario('ELECTRICITY');
    const created = await reconcile(s); assert.equal(created.status, 201, JSON.stringify(created.body));
    await pool!.query('UPDATE utility_meter_consumptions SET consumption_value=999 WHERE id=$1', [s.source.consumptionId]);
    await pool!.query('UPDATE spaces SET area_sqm=999 WHERE id=$1', [s.space.id]);
    await pool!.query("UPDATE utility_meters SET purpose='COMMON_AREA' WHERE id=$1", [s.source.meterId]);
    const read = await api().get(`/api/v1/utility/reconciliations/${created.body.data.id}`).set(auth());
    assert.equal(read.body.data.sourceConsumption, 100);
    assert.equal(read.body.data.applicableAreaSqm, 100);
    assert.equal(read.body.data.performanceValue, 1);
  });

  it('enforces Building isolation without cross-Building aggregation', async (t) => {
    if (!ready(t)) return; const s = await scenario('ELECTRICITY');
    const outsider = await createAdminUser();
    const denied = await reconcile(s, outsider.token);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const created = await reconcile(s); assert.equal(created.status, 201);
    const deniedRead = await api().get(`/api/v1/utility/reconciliations/${created.body.data.id}`).set(auth(outsider.token));
    assert.equal(deniedRead.status, 403, JSON.stringify(deniedRead.body));
  });

  it('leaves the approved Tenant billing chain unaffected', async (t) => {
    if (!ready(t)) return;
    const s = await structure('ELECTRICITY', 100);
    const tenant = await api().post(`/api/v1/clients/${s.client.id}/tenant-companies`).set(auth()).send({ tenantCode: `T_${suffix()}`, tenantName: 'Tenant' });
    await api().post(`/api/v1/tenant-companies/${tenant.body.data.id}/spaces`).set(auth()).send({ buildingId: s.building.id, spaceId: s.space.id });
    const meter = await api().post(`/api/v1/buildings/${s.building.id}/utility-meters`).set(auth()).send({ code: `M_${suffix()}`, name: 'Tenant meter', utilityType: 'ELECTRICITY', purpose: 'TENANT', uomId: s.uomId });
    const assignment = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/tenant-assignments`).set(auth()).send({ tenantCompanyId: tenant.body.data.id, spaceId: s.space.id });
    assert.equal(assignment.status, 201, JSON.stringify(assignment.body));
    const first = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/readings`).set(auth()).send({ readingValue: 0, readingAt: period.periodStart });
    const second = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/readings`).set(auth()).send({ readingValue: 10, readingAt: period.periodEnd });
    const usage = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/consumptions`).set(auth()).send({ previousReadingId: first.body.data.id, currentReadingId: second.body.data.id });
    await api().post(`/api/v1/buildings/${s.building.id}/utility-tariffs`).set(auth()).send({ utilityType: 'ELECTRICITY', currency: 'IDR', uomId: s.uomId, ratePerUom: '1000', effectiveFrom: '2025-01-01T00:00:00.000Z' });
    const calculation = await api().post(`/api/v1/utility/consumptions/${usage.body.data.id}/calculations`).set(auth()).send({});
    const finalized = await api().post(`/api/v1/utility/calculations/${calculation.body.data.id}/finalize`).set(auth()).send({});
    const pending = await api().post('/api/v1/tenant-approvals').set(auth()).send({ requestType: 'UTILITY_CALCULATION', requestId: finalized.body.data.id, approvalType: 'TENANT_UTILITY_CHARGE', approverUserId: userId });
    assert.equal((await api().post(`/api/v1/tenant-approvals/${pending.body.data.id}/approve`).set(auth()).send({})).status, 200);
    const bill = await api().post(`/api/v1/tenant-companies/${tenant.body.data.id}/utility-bills`).set(auth()).send({ calculationId: finalized.body.data.id, dueDate: '2026-02-15' });
    assert.equal(bill.status, 201, JSON.stringify(bill.body));
    assert.equal(bill.body.data.billAmount, 10000);
  });
});
