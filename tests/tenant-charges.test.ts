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
  parseCreateTenantChargeBody,
  parseTenantChargeFilters,
  parseUpdateTenantChargeBody,
} from '../src/modules/tenant-charges';
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
  await pool.query(`TRUNCATE tenant_charge_history, tenant_charges,
    tenant_documents, tenant_contractor_relationships, tenant_approval_bindings,
    tenant_utility_requests, tenant_complaints, tenant_service_requests,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const manager = await createAdminUser();
  token = manager.token;
  userId = manager.userId;
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
  await clientMonetaryContextService.setClientMonetaryContext({ clientId: client.id, baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR', 'USD', 'JPY', 'EUR'] }, assignedUserId);
  const floor = await floorService.createFloor({ buildingId: building.id, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
  const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
  const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
  const space = await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Tenant Space' });
  const companyResponse = await api()
    .post(`/api/v1/clients/${client.id}/tenant-companies`).set(auth(withToken))
    .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company' });
  assert.equal(companyResponse.status, 201, JSON.stringify(companyResponse.body));
  const company = companyResponse.body.data;
  assert.equal((await api().post(`/api/v1/tenant-companies/${company.id}/spaces`).set(auth(withToken))
    .send({ buildingId: building.id, spaceId: space.id })).status, 201);
  assert.equal((await api().post(`/api/v1/tenant-companies/${company.id}/building-contexts`).set(auth(withToken))
    .send({ buildingId: building.id })).status, 201);
  return { client, building, space, company };
}
function chargePayload(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return {
    buildingId: f.building.id,
    spaceId: f.space.id,
    chargeType: 'PARKING_SERVICE',
    description: 'Reserved parking service charge',
    amount: 250000,
    currencyCode: 'IDR',
    chargeDate: '2026-08-01',
    dueDate: '2026-08-15',
    reference: `REF-${suffix()}`,
    notes: 'Operational tenant charge only.',
    ...overrides,
  };
}
async function createCharge(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return api().post(`/api/v1/tenant-companies/${f.company.id}/charges`)
    .set(auth()).send(chargePayload(f, overrides));
}

describe('BE-19A Tenant Charges', () => {
  it('validates amount, dates, data-driven type codes, updates, and filters without database access', () => {
    const parsed = parseCreateTenantChargeBody({
      buildingId: randomUUID(), spaceId: randomUUID(), chargeType: ' service_charge ',
      description: 'Service charge', amount: 1250.5, currencyCode: 'IDR',
      chargeDate: '2026-08-01', dueDate: '2026-08-15',
    });
    assert.equal(parsed.chargeType, 'SERVICE_CHARGE');
    assert.equal(parsed.amount, 1250.5);
    assert.throws(() => parseCreateTenantChargeBody({
      ...parsed, amount: -1,
    }));
    assert.throws(() => parseCreateTenantChargeBody({
      ...parsed, amount: 1.234,
    }));
    assert.throws(() => parseCreateTenantChargeBody({
      ...parsed, chargeDate: '2026-02-30',
    }));
    assert.throws(() => parseUpdateTenantChargeBody({ status: 'CANCELLED' }));
    assert.throws(() => parseTenantChargeFilters({
      chargeDateFrom: '2026-08-31', chargeDateTo: '2026-08-01',
    }));
  });

  it('creates, gets, and filters a valid charge in its Tenant/Building/Space context', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await createCharge(f, { chargeType: ' parking_service ' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.chargeType, 'PARKING_SERVICE');
    assert.equal(created.body.data.amount, 250000);
    assert.equal(created.body.data.status, 'ACTIVE');
    const id = created.body.data.id;
    const read = await api().get(`/api/v1/tenant-charges/${id}`).set(auth());
    assert.equal(read.status, 200);
    const list = await api().get('/api/v1/tenant-charges')
      .query({ tenantCompanyId: f.company.id, buildingId: f.building.id,
        chargeType: 'PARKING_SERVICE', status: 'ACTIVE',
        chargeDateFrom: '2026-08-01', chargeDateTo: '2026-08-31' }).set(auth());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.some((charge: { id: string }) => charge.id === id), true);
  });

  it('rejects an invalid Tenant', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const response = await api().post(`/api/v1/tenant-companies/${randomUUID()}/charges`)
      .set(auth()).send(chargePayload(f));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'TENANT_COMPANY_NOT_FOUND');
  });

  it('rejects a Space and Building context mismatch', async (t) => {
    if (!ready(t)) return;
    const first = await fixture();
    const second = await fixture();
    const response = await createCharge(first, { spaceId: second.space.id });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'TENANT_CHARGE_SPACE_MISMATCH');
  });

  it('rejects negative, non-finite-compatible, and over-precision amounts', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    for (const amount of [-1, 1.234]) {
      const response = await createCharge(f, { amount });
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('validates charge and due dates on create, update, and filters', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const invalid = await createCharge(f, { chargeDate: '2026-02-30' });
    assert.equal(invalid.status, 400);
    const reversed = await createCharge(f, { chargeDate: '2026-08-20', dueDate: '2026-08-19' });
    assert.equal(reversed.status, 400);
    const created = await createCharge(f);
    const update = await api().patch(`/api/v1/tenant-charges/${created.body.data.id}`)
      .set(auth()).send({ chargeDate: '2026-08-20' });
    assert.equal(update.status, 400);
    const filter = await api().get('/api/v1/tenant-charges')
      .query({ chargeDateFrom: '2026-08-31', chargeDateTo: '2026-08-01' }).set(auth());
    assert.equal(filter.status, 400);
  });

  it('updates an active charge, cancels it terminally, and preserves snapshots', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await createCharge(f);
    const id = created.body.data.id;
    const updated = await api().patch(`/api/v1/tenant-charges/${id}`).set(auth())
      .send({ description: 'Updated service charge', amount: 275000, dueDate: null });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.amount, 275000);
    const cancelled = await api().post(`/api/v1/tenant-charges/${id}/cancel`).set(auth())
      .send({ notes: 'Cancelled by property manager.' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    const retry = await api().patch(`/api/v1/tenant-charges/${id}`).set(auth()).send({ amount: 1 });
    assert.equal(retry.status, 400);
    assert.equal(retry.body.error.code, 'TENANT_CHARGE_NOT_ACTIVE');
    const history = await pool!.query(
      'SELECT action FROM tenant_charge_history WHERE tenant_charge_id = $1 ORDER BY changed_at', [id],
    );
    assert.deepEqual(history.rows.map((row) => row.action), ['CREATED', 'UPDATED', 'CANCELLED']);
  });

  it('enforces RBAC', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const plain = await createPlainSession();
    const response = await api().post(`/api/v1/tenant-companies/${f.company.id}/charges`)
      .set(auth(plain)).send(chargePayload(f));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Client and Building isolation for get and list', async (t) => {
    if (!ready(t)) return;
    const first = await fixture();
    const created = await createCharge(first);
    const other = await createAdminUser();
    await fixture(other.userId, other.token);
    const denied = await api().get(`/api/v1/tenant-charges/${created.body.data.id}`).set(auth(other.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
    const list = await api().get('/api/v1/tenant-charges').set(auth(other.token));
    assert.equal(list.status, 200);
    assert.equal(list.body.data.some((charge: { id: string }) => charge.id === created.body.data.id), false);
  });
});
