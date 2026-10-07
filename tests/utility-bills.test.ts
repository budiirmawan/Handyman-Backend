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
import {
  parseGenerateUtilityBillBody,
  parseUtilityBillFilters,
  parseUpdateUtilityBillBody,
} from '../src/modules/utility-bills';
import type { UtilityBillType } from '../src/modules/utility-bills';
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
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE utility_bill_history, utility_bills,
    tenant_charge_history, tenant_charges, tenant_approval_bindings,
    utility_calculations, utility_calculation_bases, utility_meter_consumptions,
    utility_abnormal_consumptions, reviews, utility_meter_readings,
    utility_meter_tenant_assignments, utility_meter_hierarchies,
    utility_type_uoms, utility_type_configurations, utility_meters,
    units_of_measure, tenant_building_contexts, tenant_space_relationships,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
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
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function createStructure(assignedUserId = userId) {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Utility Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  await buildingAssignmentService.createAssignment(assignedUserId, { buildingId: building.id });
  await clientMonetaryContextService.setClientMonetaryContext({
    clientId: client.id, baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR',
    allowedCurrencyCodes: ['IDR', 'USD'],
  }, assignedUserId);
  const floor = await floorService.createFloor({ buildingId: building.id, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
  const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
  const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
  const space = await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Tenant Space' });
  return { client, building, space };
}

async function scenario(utilityType: UtilityBillType, finalize = true) {
  const structure = await createStructure();
  const uom = await api().post(`/api/v1/clients/${structure.client.id}/uoms`).set(auth()).send({
    code: `UOM_${suffix()}`, name: utilityType === 'WATER' ? 'Cubic metre' : 'Kilowatt hour',
    symbol: utilityType === 'WATER' ? 'm3' : 'kWh', category: utilityType === 'WATER' ? 'VOLUME' : 'ENERGY',
  });
  assert.equal(uom.status, 201, JSON.stringify(uom.body));
  // PART 11: only TENANT-purpose meters may enter Tenant approval and billing.
  const meter = await api().post(`/api/v1/buildings/${structure.building.id}/utility-meters`).set(auth()).send({
    code: `MTR_${suffix()}`, name: `${utilityType} tenant meter`, utilityType,
    purpose: 'TENANT', uomId: uom.body.data.id,
  });
  assert.equal(meter.status, 201, JSON.stringify(meter.body));
  const tenant = await api().post(`/api/v1/clients/${structure.client.id}/tenant-companies`).set(auth()).send({
    tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company',
  });
  assert.equal(tenant.status, 201, JSON.stringify(tenant.body));
  assert.equal((await api().post(`/api/v1/tenant-companies/${tenant.body.data.id}/spaces`).set(auth()).send({
    buildingId: structure.building.id, spaceId: structure.space.id,
  })).status, 201);
  const assignment = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/tenant-assignments`).set(auth()).send({
    tenantCompanyId: tenant.body.data.id, spaceId: structure.space.id,
  });
  assert.equal(assignment.status, 201, JSON.stringify(assignment.body));
  const first = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/readings`).set(auth()).send({
    readingValue: 100, readingAt: '2026-01-01T00:00:00.000Z',
  });
  const second = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/readings`).set(auth()).send({
    readingValue: 250, readingAt: '2026-02-01T00:00:00.000Z',
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const consumption = await api().post(`/api/v1/utility/meters/${meter.body.data.id}/consumptions`).set(auth()).send({
    currentReadingId: second.body.data.id,
  });
  assert.equal(consumption.status, 201, JSON.stringify(consumption.body));
  // PART 10: governed Building tariff (rate 2 → 150 consumed × 2 = 300).
  const tariff = await api().post(`/api/v1/buildings/${structure.building.id}/utility-tariffs`).set(auth()).send({
    utilityType, currency: 'IDR', uomId: uom.body.data.id, ratePerUom: '2',
    effectiveFrom: '2025-01-01T00:00:00.000Z',
  });
  assert.equal(tariff.status, 201, JSON.stringify(tariff.body));
  const calculation = await api().post(`/api/v1/utility/consumptions/${consumption.body.data.id}/calculations`).set(auth()).send({});
  assert.equal(calculation.status, 201, JSON.stringify(calculation.body));
  if (finalize) {
    const finalized = await api().post(`/api/v1/utility/calculations/${calculation.body.data.id}/finalize`).set(auth()).send({});
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    // PART 11: the latest Tenant approval must be APPROVED before billing.
    const approval = await api().post('/api/v1/tenant-approvals').set(auth()).send({
      requestType: 'UTILITY_CALCULATION', requestId: calculation.body.data.id,
      approvalType: 'TENANT_UTILITY_CHARGE', approverUserId: userId,
    });
    assert.equal(approval.status, 201, JSON.stringify(approval.body));
    const approved = await api().post(`/api/v1/tenant-approvals/${approval.body.data.id}/approve`).set(auth()).send({});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
  }
  return {
    ...structure, tenant: tenant.body.data, meter: meter.body.data,
    assignment: assignment.body.data, consumption: consumption.body.data,
    calculation: calculation.body.data,
  };
}
async function generate(s: Awaited<ReturnType<typeof scenario>>, tenantId = s.tenant.id) {
  return api().post(`/api/v1/tenant-companies/${tenantId}/utility-bills`).set(auth()).send({
    calculationId: s.calculation.id, dueDate: '2026-02-15',
  });
}

describe('BE-19B Electricity / Water Bill', () => {
  it('validates generate, update, and period filter payloads without database access', () => {
    const generated = parseGenerateUtilityBillBody({ calculationId: randomUUID(), dueDate: '2026-02-15' });
    assert.equal(generated.dueDate, '2026-02-15');
    assert.throws(() => parseGenerateUtilityBillBody({ calculationId: randomUUID(), dueDate: '2026-02-30' }));
    assert.throws(() => parseUpdateUtilityBillBody({ billAmount: 1 }));
    assert.throws(() => parseUtilityBillFilters({
      periodFrom: '2026-03-01T00:00:00.000Z', periodTo: '2026-02-01T00:00:00.000Z',
    }));
  });

  it('generates an Electricity bill from a finalized authoritative BE-18 calculation', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('ELECTRICITY');
    const response = await generate(s);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const bill = response.body.data;
    assert.equal(bill.utilityType, 'ELECTRICITY');
    assert.equal(bill.tenantCompanyId, s.tenant.id);
    assert.equal(bill.meterId, s.meter.id);
    assert.equal(bill.calculationId, s.calculation.id);
    assert.equal(bill.consumptionId, s.consumption.id);
    assert.equal(bill.calculatedUtilityValue, 300);
    assert.equal(bill.billAmount, 300);
    assert.equal(bill.status, 'DRAFT');
    const read = await api().get(`/api/v1/utility-bills/${bill.id}`).set(auth());
    assert.equal(read.status, 200);
    const list = await api().get('/api/v1/utility-bills').query({
      tenantCompanyId: s.tenant.id, buildingId: s.building.id,
      utilityType: 'ELECTRICITY', status: 'DRAFT',
      periodFrom: '2026-01-01T00:00:00.000Z', periodTo: '2026-02-01T00:00:00.000Z',
    }).set(auth());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.some((item: { id: string }) => item.id === bill.id), true);
  });

  it('generates a Water bill from a finalized authoritative BE-18 calculation', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('WATER');
    const response = await generate(s);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.utilityType, 'WATER');
    assert.equal(response.body.data.calculatedUtilityValue, 300);
    assert.equal(response.body.data.billAmount, 300);
  });

  it('rejects invalid Tenant and Meter context', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('ELECTRICITY');
    const wrongTenant = await generate(s, randomUUID());
    assert.equal(wrongTenant.status, 400);
    assert.equal(wrongTenant.body.error.code, 'UTILITY_BILL_CONTEXT_INVALID');
    const other = await scenario('ELECTRICITY');
    await pool!.query('UPDATE utility_calculations SET meter_id = $1 WHERE id = $2', [other.meter.id, s.calculation.id]);
    const wrongMeter = await generate(s);
    assert.equal(wrongMeter.status, 400);
    assert.equal(wrongMeter.body.error.code, 'UTILITY_BILL_CONTEXT_INVALID');
  });

  it('rejects unknown and non-finalized calculation references', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('ELECTRICITY', false);
    const unknown = await api().post(`/api/v1/tenant-companies/${s.tenant.id}/utility-bills`).set(auth()).send({
      calculationId: randomUUID(), dueDate: '2026-02-15',
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'UTILITY_CALCULATION_NOT_FOUND');
    const draft = await generate(s);
    assert.equal(draft.status, 400);
    assert.equal(draft.body.error.code, 'UTILITY_BILL_CALCULATION_INVALID');
  });

  it('validates due date against the authoritative billing period', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('WATER');
    const response = await api().post(`/api/v1/tenant-companies/${s.tenant.id}/utility-bills`).set(auth()).send({
      calculationId: s.calculation.id, dueDate: '2026-01-31',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('protects against duplicate bills for the same Tenant, Meter, and period', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('ELECTRICITY');
    assert.equal((await generate(s)).status, 201);
    const duplicate = await generate(s);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'UTILITY_BILL_ALREADY_EXISTS');
  });

  it('updates due date/status only while allowed and preserves bill history', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('WATER');
    const created = await generate(s);
    const id = created.body.data.id;
    const issued = await api().patch(`/api/v1/utility-bills/${id}`).set(auth()).send({
      dueDate: '2026-02-20', status: 'ISSUED',
    });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.equal(issued.body.data.status, 'ISSUED');
    const dateChange = await api().patch(`/api/v1/utility-bills/${id}`).set(auth()).send({ dueDate: '2026-02-25' });
    assert.equal(dateChange.status, 400);
    const cancelled = await api().patch(`/api/v1/utility-bills/${id}`).set(auth()).send({ status: 'CANCELLED' });
    assert.equal(cancelled.status, 200);
    const history = await pool!.query('SELECT action, status FROM utility_bill_history WHERE utility_bill_id = $1 ORDER BY changed_at', [id]);
    assert.deepEqual(history.rows.map((row) => row.status), ['DRAFT', 'ISSUED', 'CANCELLED']);
  });

  it('enforces RBAC', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('ELECTRICITY');
    const plain = await createPlainSession();
    const response = await api().post(`/api/v1/tenant-companies/${s.tenant.id}/utility-bills`).set(auth(plain)).send({
      calculationId: s.calculation.id, dueDate: '2026-02-15',
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Client and Building isolation for get and list', async (t) => {
    if (!ready(t)) return;
    const s = await scenario('WATER');
    const created = await generate(s);
    const other = await createAdminUser();
    await createStructure(other.userId);
    const denied = await api().get(`/api/v1/utility-bills/${created.body.data.id}`).set(auth(other.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
    const list = await api().get('/api/v1/utility-bills').set(auth(other.token));
    assert.equal(list.status, 200);
    assert.equal(list.body.data.some((item: { id: string }) => item.id === created.body.data.id), false);
  });
});
