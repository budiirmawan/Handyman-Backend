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
import {
  parseCreateServiceChargeReadinessBody,
  parseServiceChargeReadinessFilters,
} from '../src/modules/service-charge-readiness';
import { spaceService } from '../src/modules/spaces';
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
  await pool.query(`TRUNCATE service_charge_readiness_history,
    service_charge_readiness, utility_bill_history, utility_bills,
    tenant_charge_history, tenant_charges, tenant_building_contexts,
    tenant_space_relationships, tenant_companies, spaces, rooms, areas, floors,
    buildings, properties, users, roles, permissions, clients CASCADE`);
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
  assert.equal((await api().post(`/api/v1/tenant-companies/${tenant.id}/spaces`).set(auth(withToken)).send({
    buildingId: building.id, spaceId: space.id,
  })).status, 201);
  assert.equal((await api().post(`/api/v1/tenant-companies/${tenant.id}/building-contexts`).set(auth(withToken)).send({
    buildingId: building.id,
  })).status, 201);
  return { client, building, space, tenant };
}
async function createCharge(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await api().post(`/api/v1/tenant-companies/${f.tenant.id}/charges`).set(auth()).send({
    buildingId: f.building.id, spaceId: f.space.id,
    chargeType: 'COMMON_AREA_SERVICE', description: 'Monthly common area service',
    amount: 500000, currencyCode: 'IDR',
    chargeDate: '2026-08-01', dueDate: '2026-08-20',
    reference: `SC-${suffix()}`,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}
function readinessPayload(
  f: Awaited<ReturnType<typeof fixture>>,
  tenantChargeId: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    buildingId: f.building.id,
    spaceId: f.space.id,
    serviceChargeType: 'COMMON_AREA_SERVICE',
    chargeBasis: 'LEASED_AREA_MONTHLY_BASIS',
    tenantChargeId,
    effectiveFrom: '2026-08-01',
    effectiveTo: '2026-08-31',
    readinessStatus: tenantChargeId ? 'READY' : 'NOT_READY',
    notes: 'Preparation only.',
    ...overrides,
  };
}
async function createReadiness(
  f: Awaited<ReturnType<typeof fixture>>,
  tenantChargeId: string | null,
  overrides: Record<string, unknown> = {},
) {
  return api().post(`/api/v1/tenant-companies/${f.tenant.id}/service-charge-readiness`)
    .set(auth()).send(readinessPayload(f, tenantChargeId, overrides));
}

describe('BE-19C Service Charge Readiness', () => {
  it('validates status and period payloads without database access', () => {
    const parsed = parseCreateServiceChargeReadinessBody({
      buildingId: randomUUID(), spaceId: randomUUID(),
      serviceChargeType: ' common_area_service ', chargeBasis: null,
      effectiveFrom: '2026-08-01', effectiveTo: '2026-08-31',
      readinessStatus: 'INCOMPLETE',
    });
    assert.equal(parsed.serviceChargeType, 'COMMON_AREA_SERVICE');
    assert.throws(() => parseCreateServiceChargeReadinessBody({
      ...parsed, readinessStatus: 'PENDING',
    }));
    assert.throws(() => parseCreateServiceChargeReadinessBody({
      ...parsed, effectiveFrom: '2026-09-01', effectiveTo: '2026-08-31',
    }));
    assert.throws(() => parseServiceChargeReadinessFilters({ status: 'PENDING' }));
  });

  it('creates, gets, and filters valid READY readiness using a BE-19A charge', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const charge = await createCharge(f);
    const created = await createReadiness(f, charge.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.readinessStatus, 'READY');
    assert.equal(created.body.data.tenantChargeId, charge.id);
    const read = await api().get(`/api/v1/service-charge-readiness/${created.body.data.id}`).set(auth());
    assert.equal(read.status, 200);
    const list = await api().get('/api/v1/service-charge-readiness').query({
      tenantCompanyId: f.tenant.id, buildingId: f.building.id, status: 'READY',
      periodFrom: '2026-08-01', periodTo: '2026-08-31',
    }).set(auth());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.some((item: { id: string }) => item.id === created.body.data.id), true);
  });

  it('rejects an invalid Tenant', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const response = await api().post(`/api/v1/tenant-companies/${randomUUID()}/service-charge-readiness`)
      .set(auth()).send(readinessPayload(f, null));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'TENANT_COMPANY_NOT_FOUND');
  });

  it('rejects a Space and Building context mismatch', async (t) => {
    if (!ready(t)) return;
    const first = await fixture();
    const second = await fixture();
    const response = await createReadiness(first, null, { spaceId: second.space.id });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'SERVICE_CHARGE_READINESS_SPACE_MISMATCH');
  });

  it('rejects an invalid readiness status', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const response = await createReadiness(f, null, { readinessStatus: 'PENDING' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('validates effective periods on create and update', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const invalid = await createReadiness(f, null, {
      effectiveFrom: '2026-09-01', effectiveTo: '2026-08-31',
    });
    assert.equal(invalid.status, 400);
    const created = await createReadiness(f, null);
    const update = await api().patch(`/api/v1/service-charge-readiness/${created.body.data.id}`)
      .set(auth()).send({ effectiveFrom: '2026-09-01' });
    assert.equal(update.status, 400);
    assert.equal(update.body.error.code, 'VALIDATION_ERROR');
  });

  it('updates and resolves INCOMPLETE, NOT_READY, and READY while preserving history', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const charge = await createCharge(f);
    const created = await createReadiness(f, null, {
      chargeBasis: null, readinessStatus: 'INCOMPLETE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.readinessStatus, 'INCOMPLETE');
    const id = created.body.data.id;
    const notReady = await api().patch(`/api/v1/service-charge-readiness/${id}`).set(auth()).send({
      chargeBasis: 'LEASED_AREA_MONTHLY_BASIS', readinessStatus: 'NOT_READY',
    });
    assert.equal(notReady.status, 200, JSON.stringify(notReady.body));
    assert.equal(notReady.body.data.readinessStatus, 'NOT_READY');
    const readyResult = await api().patch(`/api/v1/service-charge-readiness/${id}`).set(auth()).send({
      tenantChargeId: charge.id, readinessStatus: 'READY', notes: 'Charge prepared.',
    });
    assert.equal(readyResult.status, 200, JSON.stringify(readyResult.body));
    assert.equal(readyResult.body.data.readinessStatus, 'READY');
    const history = await pool!.query(
      'SELECT readiness_status FROM service_charge_readiness_history WHERE service_charge_readiness_id = $1 ORDER BY changed_at', [id],
    );
    assert.deepEqual(history.rows.map((row) => row.readiness_status), ['INCOMPLETE', 'NOT_READY', 'READY']);
  });

  it('enforces RBAC', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const plain = await createPlainSession();
    const response = await api().post(`/api/v1/tenant-companies/${f.tenant.id}/service-charge-readiness`)
      .set(auth(plain)).send(readinessPayload(f, null));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Client and Building isolation for get and list', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await createReadiness(f, null);
    const other = await createAdminUser();
    await fixture(other.userId, other.token);
    const denied = await api().get(`/api/v1/service-charge-readiness/${created.body.data.id}`).set(auth(other.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
    const list = await api().get('/api/v1/service-charge-readiness').set(auth(other.token));
    assert.equal(list.status, 200);
    assert.equal(list.body.data.some((item: { id: string }) => item.id === created.body.data.id), false);
  });
});
