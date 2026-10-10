import { roleService } from '../src/modules/roles';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { inventoryItemService } from '../src/modules/inventory-items';
import { inventoryWarehouseService } from '../src/modules/inventory-warehouses';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** CR-HM-SEC-03 PART 03: scoped mobile MR boundaries using the existing field fixture. */
const FIELD_READ = { code: 'material_request.field.read', name: 'Read Field Material Requests' };
const FIELD_REQUEST = { code: 'material_request.field.request', name: 'Request Field Materials' };

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE request_idempotency_records, operational_events,
            work_order_procurement_bindings, inventory_material_reservations,
            inventory_work_order_material_usages, inventory_stock_movements,
            inventory_stock_balances, material_requests, purchase_requests,
            work_order_assignments, work_orders, inventory_items,
            inventory_warehouses, units_of_measure, workforce_building_assignments,
            workforce_profiles, positions, departments, organizations, users,
            roles, clients, properties, buildings CASCADE`,
  );
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

const suffix = (): string => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * A full-permission "worker" (admin) with a Workforce Profile, a Building,
 * a Work Order actively assigned (WORKFORCE) to that worker, a UOM and an
 * item carrying that UOM.
 */
async function fixture(options: { assign?: boolean } = {}) {
  const worker = await createAdminUser();
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Field Client' });
  const property = await propertyService.createProperty({
    clientId: client.id, code: `P_${suffix()}`, name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id, code: `B_${suffix()}`, name: 'Building',
  });
  await buildingAssignmentService.createAssignment(worker.userId, { buildingId: building.id });
  const organization = await organizationService.createOrganization({
    clientId: client.id, code: `ORG_${suffix()}`, name: 'Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id, code: `DEP_${suffix()}`, name: 'Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id, code: `POS_${suffix()}`, name: 'Pos',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: worker.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Field Worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id, buildingId: building.id,
  });
  const wo = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Field WO',
    workType: 'REPAIR',
    createdByUserId: worker.userId,
  });
  if (options.assign !== false) {
    const r = await api()
      .post(`/api/v1/work-orders/${wo.id}/assignments`)
      .set(auth(worker.token))
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: profile.id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const uomRes = await api()
    .post(`/api/v1/clients/${client.id}/uoms`)
    .set(auth(worker.token))
    .send({ code: `UOM_${suffix()}`, name: 'Piece', symbol: 'pc', category: 'COUNT' });
  assert.equal(uomRes.status, 201);
  const uomId = uomRes.body.data.id as string;
  const item = await inventoryItemService.createInventoryItem({
    clientId: client.id, code: `ITM_${suffix()}`, name: 'Bolt', itemType: 'MATERIAL', uomId,
  });
  return { worker, client, building, profile, wo, uomId, item };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function create(
  f: Fixture,
  body: Record<string, unknown>,
  key: string = randomUUID(),
  token = f.worker.token,
  workOrderId = f.wo.id,
) {
  return api()
    .post(`/api/v1/mobile/work-orders/${workOrderId}/material-requests`)
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send(body);
}
const body = (f: Fixture, extra: Record<string, unknown> = {}) => ({
  itemId: f.item.id, quantity: 2, uomId: f.uomId, ...extra,
});
const list = (f: Fixture, token = f.worker.token, workOrderId = f.wo.id) =>
  api().get(`/api/v1/mobile/work-orders/${workOrderId}/material-requests`).set(auth(token));
const get = (id: string, token: string) =>
  api().get(`/api/v1/mobile/material-requests/${id}`).set(auth(token));
const cancel = (id: string, token: string) =>
  api().post(`/api/v1/mobile/material-requests/${id}/cancel`).set(auth(token));

function normalized(body: any) { const { requestId, ...error } = body.error; return { ...body, error }; }
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ['material_requests', 'purchase_requests', 'request_idempotency_records', 'operational_events', 'inventory_material_reservations', 'inventory_stock_balances', 'inventory_stock_movements']) result[table] = (await pool!.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
  return result;
}
describe('SEC-03 mobile parity', () => {
  it('all four boundaries hide sibling, foreign, permission-only and platform-admin IDs without mutation', async t => {
    if (!ready(t)) return;
    const f = await fixture(); const made = await create(f, body(f)); assert.equal(made.status, 201);
    const foreign = await fixture();
    const sibling = await buildingService.createBuilding({ propertyId: f.building.propertyId, code: `B_${suffix()}`, name: 'Sibling' });
    const siblingActor = await createAdminUser();
    await buildingAssignmentService.createAssignment(siblingActor.userId, { buildingId: sibling.id });
    const platform = await createAdminUser();
    const role = await roleService.createRole({ code: 'PLATFORM_ADMIN', name: 'Platform Admin' });
    await roleService.assignRoleToUser(platform.userId, role.id);
    const permissionOnly = await createSessionWithPermissions([FIELD_READ, FIELD_REQUEST]);
    for (const token of [foreign.worker.token, siblingActor.token, permissionOnly, platform.token]) {
      const before = await snapshot();
      for (const op of ['get', 'cancel', 'list', 'create']) {
        const call = (id: string) => op === 'get' ? get(id, token) : op === 'cancel' ? cancel(id, token) : op === 'list' ? list(f, token, id) : create(f, body(f), randomUUID(), token, id);
        const hidden = await call(op === 'get' || op === 'cancel' ? made.body.data.id : f.wo.id);
        const missing = await call(randomUUID());
        assert.equal(hidden.status, 404, JSON.stringify(hidden.body)); assert.equal(missing.status, 404);
        assert.deepEqual(normalized(hidden.body), normalized(missing.body));
      }
      assert.deepEqual(await snapshot(), before);
    }
  });
  for (const kind of ['mrClient', 'parentClient', 'itemClient', 'warehouseBuilding', 'workOrderClient']) {
    it(`rejects ${kind} corruption before projection and cancellation`, async t => {
      if (!ready(t)) return;
      const f = await fixture(); const other = await fixture();
      const made = await create(f, body(f)); assert.equal(made.status, 201);
      const id = made.body.data.id;
      if (kind === 'mrClient') await pool!.query('UPDATE material_requests SET client_id=$2 WHERE id=$1', [id, other.client.id]);
      if (kind === 'parentClient') await pool!.query('UPDATE purchase_requests SET client_id=$2 WHERE id=$1', [made.body.data.purchaseRequestId, other.client.id]);
      if (kind === 'itemClient') await pool!.query('UPDATE inventory_items SET client_id=$2 WHERE id=$1', [f.item.id, other.client.id]);
      if (kind === 'warehouseBuilding') {
        const wh = await inventoryWarehouseService.createWarehouse({ buildingId: other.building.id, code: `W_${suffix()}`, name: 'Hidden' });
        await pool!.query('UPDATE material_requests SET warehouse_id=$2 WHERE id=$1', [id, wh.id]);
      }
      if (kind === 'workOrderClient') await pool!.query('UPDATE work_orders SET client_id=$2 WHERE id=$1', [f.wo.id, other.client.id]);
      const before = await snapshot();
      for (const op of [get, cancel]) {
        const res = await op(id, f.worker.token); const missing = await op(randomUUID(), f.worker.token);
        assert.equal(res.status, 404, JSON.stringify(res.body)); assert.deepEqual(normalized(res.body), normalized(missing.body));
      }
      const listed = await list(f);
      if (kind === 'workOrderClient') assert.equal(listed.status, 404);
      else { assert.equal(listed.status, 200); assert.deepEqual(listed.body.data.materialRequests, []); }
      assert.deepEqual(await snapshot(), before);
    });
  }
});
describe('SEC-03 mobile projection guards', () => {
  it('does not call trusted enrichment/fulfillment for inaccessible requests', async t => {
    if (!ready(t)) return;
    const f = await fixture(); const made = await create(f, body(f));
    const outsider = await createAdminUser();
    const { mobileMaterialRequestRepository: repo } = await import('../src/modules/mobile-material-requests/mobile-material-request.repository');
    const { inventoryMaterialReservationRepository: reservations } = await import('../src/modules/inventory-material-reservations/inventory-material-reservation.repository');
    const original = repo.findFieldById; const demand = reservations.getDemandSummaries;
    repo.findFieldById = async () => { throw new Error('global enriched fetch forbidden'); };
    reservations.getDemandSummaries = async () => { throw new Error('unauthorized demand projection'); };
    try { assert.equal((await get(made.body.data.id, outsider.token)).status, 404); assert.equal((await cancel(made.body.data.id, outsider.token)).status, 404); }
    finally { repo.findFieldById = original; reservations.getDemandSummaries = demand; }
  });
  it('hides a request with corrupt reservation ownership before fulfillment/list/cancel', async t => {
    if (!ready(t)) return;
    const f = await fixture(); const other = await fixture(); const made = await create(f, body(f));
    const warehouse = await inventoryWarehouseService.createWarehouse({buildingId: other.building.id, code:`W_${suffix()}`, name:'Foreign'});
    // Deliberate independent-FK corruption, not a valid stock allocation.
    await pool!.query(`INSERT INTO inventory_material_reservations
      (id, client_id, building_id, material_request_id, warehouse_id, item_id, reserved_quantity, status, created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,1,'ACTIVE',$7)`,
      [randomUUID(), other.client.id, other.building.id, made.body.data.id, warehouse.id, other.item.id, f.worker.userId]);
    const before = await snapshot();
    assert.equal((await get(made.body.data.id, f.worker.token)).status, 404);
    assert.equal((await cancel(made.body.data.id, f.worker.token)).status, 404);
    const rows = await list(f); assert.equal(rows.status, 200); assert.deepEqual(rows.body.data.materialRequests, []);
    assert.deepEqual(await snapshot(), before);
  });
  it('corrupt existing field parent rolls back creation, claim and audit', async t => {
    if (!ready(t)) return;
    const f = await fixture(); const other = await fixture(); const made = await create(f, body(f));
    await pool!.query('UPDATE purchase_requests SET client_id=$2 WHERE id=$1', [made.body.data.purchaseRequestId, other.client.id]);
    const before = await snapshot();
    const res = await create(f, body(f)); assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.deepEqual(await snapshot(), before);
  });
});

it('SEC-03 replay cannot project an ownership-corrupted request or mutate its stored response', async t => {
  if (!ready(t)) return;
  const f = await fixture(); const other = await fixture(); const key = randomUUID();
  const made = await create(f, body(f), key); assert.equal(made.status, 201);
  await pool!.query('UPDATE material_requests SET client_id=$2 WHERE id=$1', [made.body.data.id, other.client.id]);
  const before = await snapshot();
  assert.equal((await create(f, body(f), key)).status, 404);
  assert.deepEqual(await snapshot(), before);
});
