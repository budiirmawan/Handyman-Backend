import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Pool } from 'pg';
import { parse } from 'yaml';
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

/**
 * CR-BE-RN11-MATERIAL-FIELD-01 PART 04 — server-authoritative availableActions
 * (REQUEST_MATERIAL / CANCEL_MATERIAL_REQUEST / RECORD_MATERIAL_USAGE) and
 * final contract hardening. Numbering follows the CR list (1–48).
 */

const FIELD_READ = { code: 'material_request.field.read', name: 'Read Field Material Requests' };
const FIELD_REQUEST = { code: 'material_request.field.request', name: 'Request Field Materials' };
const FIELD_RECORD = { code: 'material_usage.field.record', name: 'Record Field Material Usage' };
const STOCK_MANAGE = { code: 'inventory_stock.manage', name: 'Manage Inventory Stock' };
const MR_MANAGE = { code: 'material_request.manage', name: 'Manage Material Requests' };

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE request_idempotency_records, operational_events,
            work_order_procurement_bindings, procurement_approval_bindings,
            inventory_material_reservations,
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

async function fixture() {
  const worker = await createAdminUser();
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Field Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  await buildingAssignmentService.createAssignment(worker.userId, { buildingId: building.id });
  const organization = await organizationService.createOrganization({ clientId: client.id, code: `ORG_${suffix()}`, name: 'Org' });
  const department = await departmentService.createDepartment({ organizationId: organization.id, code: `DEP_${suffix()}`, name: 'Dept' });
  const position = await positionService.createPosition({ organizationId: organization.id, code: `POS_${suffix()}`, name: 'Pos' });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id, departmentId: department.id, positionId: position.id,
    userId: worker.userId, employeeCode: `WF_${suffix()}`, fullName: 'Field Worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({ workforceProfileId: profile.id, buildingId: building.id });
  const wo = await workOrderService.createWorkOrder({
    clientId: client.id, buildingId: building.id, workOrderNumber: `WO_${suffix()}`,
    title: 'Field WO', workType: 'REPAIR', createdByUserId: worker.userId,
  });
  const r = await api().post(`/api/v1/work-orders/${wo.id}/assignments`).set(auth(worker.token))
    .send({ assigneeType: 'WORKFORCE', workforceProfileId: profile.id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const uomRes = await api().post(`/api/v1/clients/${client.id}/uoms`).set(auth(worker.token))
    .send({ code: `UOM_${suffix()}`, name: 'Piece', symbol: 'pc', category: 'COUNT' });
  assert.equal(uomRes.status, 201);
  const uomId = uomRes.body.data.id as string;
  const item = await inventoryItemService.createInventoryItem({
    clientId: client.id, code: `ITM_${suffix()}`, name: 'Bolt', itemType: 'MATERIAL', uomId,
  });
  const warehouse = await inventoryWarehouseService.createWarehouse({ buildingId: building.id, code: `WH_${suffix()}`, name: 'WH' });
  return { worker, client, building, organization, profile, wo, uomId, item, warehouse };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A second user with Building access + a limited permission set. When
 * `assign` is true the Work Order is reassigned to them (they become the
 * field actor); otherwise they have Building access but no WO authority.
 */
async function limitedActor(f: Fixture, perms: { code: string; name: string }[], assign: boolean) {
  const token = await createSessionWithPermissions(perms);
  const me = await api().get('/api/v1/auth/me').set(auth(token));
  const userId = (me.body.data?.user?.id ?? me.body.data?.id ?? me.body.data?.userId) as string;
  assert.ok(userId, JSON.stringify(me.body));
  await buildingAssignmentService.createAssignment(userId, { buildingId: f.building.id });
  if (assign) {
    const dep = await departmentService.createDepartment({ organizationId: f.organization.id, code: `DEP_${suffix()}`, name: 'D' });
    const pos = await positionService.createPosition({ organizationId: f.organization.id, code: `POS_${suffix()}`, name: 'P' });
    const profile = await workforceService.createWorkforceProfile({
      organizationId: f.organization.id, departmentId: dep.id, positionId: pos.id,
      userId, employeeCode: `WF_${suffix()}`, fullName: 'Limited',
    });
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({ workforceProfileId: profile.id, buildingId: f.building.id });
    const cur = await api().get(`/api/v1/work-orders/${f.wo.id}/assignments/current`).set(auth(f.worker.token));
    const re = await api().patch(`/api/v1/work-orders/${f.wo.id}/assignments/${cur.body.data.id}`)
      .set(auth(f.worker.token)).send({ assigneeType: 'WORKFORCE', workforceProfileId: profile.id });
    assert.equal(re.status, 200, JSON.stringify(re.body));
  }
  return { token, userId };
}

async function newItem(f: Fixture) {
  return inventoryItemService.createInventoryItem({
    clientId: f.client.id, code: `ITM_${suffix()}`, name: 'Nut', itemType: 'MATERIAL', uomId: f.uomId,
  });
}
async function createMr(f: Fixture, quantity: number, itemId = f.item.id, key = randomUUID()) {
  const r = await api().post(`/api/v1/mobile/work-orders/${f.wo.id}/material-requests`)
    .set(auth(f.worker.token)).set('Idempotency-Key', key).send({ itemId, quantity, uomId: f.uomId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r;
}
async function approve(f: Fixture, mrId: string) {
  const bind = await api().post('/api/v1/procurement-approvals').set(auth(f.worker.token)).send({
    requestType: 'MATERIAL_REQUEST', requestId: mrId, approvalType: 'BUDGET_APPROVAL', approverUserId: f.worker.userId,
  });
  assert.equal(bind.status, 201, JSON.stringify(bind.body));
  const dec = await api().post(`/api/v1/procurement-approvals/${bind.body.data.id}/approve`).set(auth(f.worker.token)).send({});
  assert.equal(dec.status, 200, JSON.stringify(dec.body));
}
async function stockIn(f: Fixture, qty: number, itemId = f.item.id) {
  const r = await api().post(`/api/v1/warehouses/${f.warehouse.id}/stock-movements`).set(auth(f.worker.token))
    .send({ itemId, movementType: 'STOCK_IN', quantity: qty });
  assert.equal(r.status, 201, JSON.stringify(r.body));
}
async function reserve(f: Fixture, mrId: string, quantity: number) {
  const r = await api().post(`/api/v1/material-requests/${mrId}/reservations`).set(auth(f.worker.token))
    .send({ warehouseId: f.warehouse.id, quantity });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data as any;
}
async function issuable(f: Fixture, requested: number, stock: number, reserveQty: number | null, itemId = f.item.id) {
  const mr = (await createMr(f, requested, itemId)).body.data;
  await approve(f, mr.id);
  if (stock > 0) await stockIn(f, stock, itemId);
  const reservation = reserveQty === null ? null : await reserve(f, mr.id, reserveQty);
  return { mr, reservation };
}
const list = (f: Fixture, token = f.worker.token) =>
  api().get(`/api/v1/mobile/work-orders/${f.wo.id}/material-requests`).set(auth(token));
const detail = (id: string, token: string) =>
  api().get(`/api/v1/mobile/material-requests/${id}`).set(auth(token));
const use = (f: Fixture, body: Record<string, unknown>, token = f.worker.token) =>
  api().post(`/api/v1/mobile/work-orders/${f.wo.id}/material-usages`).set(auth(token))
    .set('Idempotency-Key', randomUUID()).send(body);
const cancel = (id: string, token: string) =>
  api().post(`/api/v1/mobile/material-requests/${id}/cancel`).set(auth(token));

async function rowActions(f: Fixture, mrId: string, token = f.worker.token): Promise<string[]> {
  const l = await list(f, token);
  assert.equal(l.status, 200, JSON.stringify(l.body));
  const row = l.body.data.materialRequests.find((x: any) => x.id === mrId);
  assert.ok(row, 'row present in list');
  const d = await detail(mrId, token);
  assert.equal(d.status, 200);
  assert.deepEqual(d.body.data.availableActions, row.availableActions, 'LIST and DETAIL share the evaluator');
  return row.availableActions;
}

describe('PART 04 — Work Order action REQUEST_MATERIAL (1-6)', () => {
  it('1, 6, 32, 33. zero requests + authorized requester → REQUEST_MATERIAL; envelope shape', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const l = await list(f);
    assert.equal(l.status, 200);
    assert.deepEqual(Object.keys(l.body.data).sort(), ['availableActions', 'materialRequests', 'workOrderId']);
    assert.equal(l.body.data.workOrderId, f.wo.id);
    assert.deepEqual(l.body.data.materialRequests, []);
    assert.deepEqual(l.body.data.availableActions, ['REQUEST_MATERIAL']);
    // 6. token independent of request count
    await createMr(f, 1);
    const l2 = await list(f);
    assert.deepEqual(l2.body.data.availableActions, ['REQUEST_MATERIAL']);
    assert.equal(l2.body.data.materialRequests.length, 1);
  });

  it('2-5. read-only / management-only / unassigned / no Building actors', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    // 2. read-only, even as field actor
    const reader = await limitedActor(f, [FIELD_READ], true);
    assert.deepEqual((await list(f, reader.token)).body.data.availableActions, []);
    // 3. management mutation permissions alone (Building access, field actor) → no token
    const manager = await limitedActor(f, [FIELD_READ, MR_MANAGE, STOCK_MANAGE], true);
    assert.deepEqual((await list(f, manager.token)).body.data.availableActions, []);
    // 4. field.request but not the WO field actor
    const bystander = await limitedActor(f, [FIELD_READ, FIELD_REQUEST], false);
    assert.deepEqual((await list(f, bystander.token)).body.data.availableActions, []);
    // requester who IS the field actor → token
    const requester = await limitedActor(f, [FIELD_READ, FIELD_REQUEST], true);
    assert.deepEqual((await list(f, requester.token)).body.data.availableActions, ['REQUEST_MATERIAL']);
    // 5. Building-inaccessible actor cannot obtain context
    const stranger = await createAdminUser();
    const x = await list(f, stranger.token);
    assert.equal(x.status, 403);
    assert.equal(x.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('PART 04 — CANCEL_MATERIAL_REQUEST token (7-13)', () => {
  it('7, 10, 11, 13, 34, 35. OPEN + authority → present; APPROVED / CANCELLED → absent; authority required', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const open = (await createMr(f, 2)).body.data;
    assert.deepEqual(await rowActions(f, open.id), ['CANCEL_MATERIAL_REQUEST']);
    // 13. same OPEN status, read-only field actor → nothing
    const reader = await limitedActor(f, [FIELD_READ], false);
    assert.deepEqual(await rowActions(f, open.id, reader.token), []);
    // 10. APPROVED
    const approved = (await createMr(f, 2, (await newItem(f)).id)).body.data;
    await approve(f, approved.id);
    assert.deepEqual(await rowActions(f, approved.id), []); // no reservation → no usage either
    // 11. CANCELLED
    const c = await cancel(open.id, f.worker.token);
    assert.equal(c.status, 200);
    assert.deepEqual(await rowActions(f, open.id), []);
  });

  it('8, 9, 12. no field.request permission / not field actor / ACTIVE reservation blocker → absent', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const open = (await createMr(f, 2)).body.data;
    // 8. usage permission only, field actor
    const usageOnly = await limitedActor(f, [FIELD_READ, FIELD_RECORD], true);
    assert.deepEqual(await rowActions(f, open.id, usageOnly.token), []);
    // 9. field.request but not field actor
    const bystander = await limitedActor(f, [FIELD_READ, FIELD_REQUEST], false);
    assert.deepEqual(await rowActions(f, open.id, bystander.token), []);
    // 12. ACTIVE reservation on an OPEN request (forced — canonical cancel blocker)
    const g = await fixture();
    const blockedOpen = (await createMr(g, 2)).body.data;
    assert.deepEqual(await rowActions(g, blockedOpen.id), ['CANCEL_MATERIAL_REQUEST']);
    await pool!.query(
      `INSERT INTO inventory_material_reservations
         (id, client_id, building_id, material_request_id, warehouse_id, item_id, uom_id, reserved_quantity, status, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'ACTIVE', $8)`,
      [randomUUID(), g.client.id, g.building.id, blockedOpen.id, g.warehouse.id, g.item.id, g.uomId, g.worker.userId],
    );
    assert.deepEqual(await rowActions(g, blockedOpen.id), []);
    const blocked = await cancel(blockedOpen.id, g.worker.token);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'MATERIAL_REQUEST_ACTIVE_RESERVATION');
  });
});

describe('PART 04 — RECORD_MATERIAL_USAGE token (14-27)', () => {
  it('14, 15, 16, 22, 23, 27. present with full authority; absent without permission / field authority; one or many reservations', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { mr } = await issuable(f, 10, 20, 3);
    assert.deepEqual(await rowActions(f, mr.id), ['RECORD_MATERIAL_USAGE']);
    // 15. request permission only
    const reqOnly = await limitedActor(f, [FIELD_READ, FIELD_REQUEST], true);
    assert.deepEqual(await rowActions(f, mr.id, reqOnly.token), []);
    // 27. inventory_stock.manage alone
    const stock = await limitedActor(f, [FIELD_READ, STOCK_MANAGE], true);
    assert.deepEqual(await rowActions(f, mr.id, stock.token), []);
    // 16. usage permission, not field actor
    const bystander = await limitedActor(f, [FIELD_READ, FIELD_RECORD], false);
    assert.deepEqual(await rowActions(f, mr.id, bystander.token), []);
    // usage permission + field actor → present
    const recorder = await limitedActor(f, [FIELD_READ, FIELD_RECORD], true);
    assert.deepEqual(await rowActions(f, mr.id, recorder.token), ['RECORD_MATERIAL_USAGE']);
    // 23. multiple ACTIVE reservations → still present
    await reserve(f, mr.id, 2);
    assert.deepEqual(await rowActions(f, mr.id, recorder.token), ['RECORD_MATERIAL_USAGE']);
  });

  it('17-21. OPEN / CANCELLED / zero remaining demand / zero ACTIVE / remaining 0 → absent', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    // 17. OPEN with (forced) ACTIVE reservation
    const open = (await createMr(f, 2)).body.data;
    await pool!.query(
      `INSERT INTO inventory_material_reservations
         (id, client_id, building_id, material_request_id, warehouse_id, item_id, uom_id, reserved_quantity, status, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'ACTIVE', $8)`,
      [randomUUID(), f.client.id, f.building.id, open.id, f.warehouse.id, f.item.id, f.uomId, f.worker.userId],
    );
    assert.equal((await rowActions(f, open.id)).includes('RECORD_MATERIAL_USAGE'), false);
    // 18. CANCELLED
    const cancelled = (await createMr(f, 2, (await newItem(f)).id)).body.data;
    assert.equal((await cancel(cancelled.id, f.worker.token)).status, 200);
    assert.deepEqual(await rowActions(f, cancelled.id), []);
    // 20. APPROVED, zero ACTIVE reservations
    const noRes = await issuable(f, 5, 10, null, (await newItem(f)).id);
    assert.deepEqual(await rowActions(f, noRes.mr.id), []);
    // 21. an ACTIVE reservation with remainingQuantity 0 is not representable: the
    // canonical lifecycle check forbids it (a fully consumed allocation is CONSUMED),
    // and the evaluator keys on SUM(ACTIVE remaining) > 0 — proven by the constraint.
    await assert.rejects(
      pool!.query(
        `INSERT INTO inventory_material_reservations
           (id, client_id, building_id, material_request_id, warehouse_id, item_id, uom_id, reserved_quantity, consumed_quantity, status, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 2, 2, 'ACTIVE', $8)`,
        [randomUUID(), f.client.id, f.building.id, noRes.mr.id, f.warehouse.id, noRes.mr.item.id, f.uomId, f.worker.userId],
      ),
      /lifecycle_check/,
    );
    assert.deepEqual(await rowActions(f, noRes.mr.id), []);
    // 19. zero remaining demand: approved 2, reserve 2, issue 2 → demand 0 (reservation CONSUMED too)
    const full = await issuable(f, 2, 10, 2, (await newItem(f)).id);
    assert.deepEqual(await rowActions(f, full.mr.id), ['RECORD_MATERIAL_USAGE']);
    const u = await use(f, { materialRequestId: full.mr.id, quantity: 2 });
    assert.equal(u.status, 201, JSON.stringify(u.body));
    assert.deepEqual(await rowActions(f, full.mr.id), []);
    // 19 strictly: remaining demand 0 but a fresh ACTIVE reservation exists → still absent
    await pool!.query(
      `INSERT INTO inventory_material_reservations
         (id, client_id, building_id, material_request_id, warehouse_id, item_id, uom_id, reserved_quantity, status, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'ACTIVE', $8)`,
      [randomUUID(), f.client.id, f.building.id, full.mr.id, f.warehouse.id, full.mr.item.id, f.uomId, f.worker.userId],
    );
    const d = await detail(full.mr.id, f.worker.token);
    assert.equal(d.body.data.fulfillment.remainingDemandQuantity, 0);
    assert.deepEqual(d.body.data.availableActions, []);
  });

  it('24-26. COMPLETED / CANCELLED / CLOSED Work Order → absent (REQUEST_MATERIAL unaffected by stock)', async (t) => {
    if (!ready(t)) return;
    for (const status of ['COMPLETED', 'CANCELLED', 'CLOSED']) {
      const f = await fixture();
      const { mr } = await issuable(f, 5, 10, 5);
      assert.deepEqual(await rowActions(f, mr.id), ['RECORD_MATERIAL_USAGE']);
      await pool!.query(`UPDATE work_orders SET status = $2 WHERE id = $1`, [f.wo.id, status]);
      assert.deepEqual(await rowActions(f, mr.id), [], status);
      const r = await use(f, { materialRequestId: mr.id, quantity: 1 });
      assert.equal(r.status, 409, status);
      assert.equal(r.body.error.code, 'WO_MATERIAL_USAGE_WORK_ORDER_STATE_INVALID');
    }
  });
});

describe('PART 04 — snapshot / revalidation (28-31)', () => {
  it('28-31. stale token never bypasses command guards; reload removes it', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { mr, reservation } = await issuable(f, 4, 10, 4);
    assert.deepEqual(await rowActions(f, mr.id), ['RECORD_MATERIAL_USAGE']);
    // 29. reservation consumed by another transaction (management route) after the snapshot
    const other = await api().post(`/api/v1/work-orders/${f.wo.id}/material-usages`).set(auth(f.worker.token))
      .send({ itemId: f.item.id, warehouseId: f.warehouse.id, materialRequestId: mr.id, reservationId: reservation.id, quantity: 4 });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    // 30. demand exhausted → command rejects canonically (stale client still "sees" the token)
    const r = await use(f, { materialRequestId: mr.id, quantity: 1, reservationId: reservation.id });
    assert.equal(r.status, 409);
    assert.ok(['INVENTORY_MATERIAL_RESERVATION_NOT_ACTIVE', 'INVENTORY_WO_MATERIAL_USAGE_DEMAND_EXCEEDED'].includes(r.body.error.code), r.body.error.code);
    const r2 = await use(f, { materialRequestId: mr.id, quantity: 1 });
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error.code, 'INVENTORY_WO_MATERIAL_USAGE_ACTIVE_RESERVATION_REQUIRED');
    // 31. reload removes stale token
    assert.deepEqual(await rowActions(f, mr.id), []);
    // 28. cancel token then state change (approval) → cancel rejected
    const open = (await createMr(f, 1, (await newItem(f)).id)).body.data;
    assert.deepEqual(await rowActions(f, open.id), ['CANCEL_MATERIAL_REQUEST']);
    await approve(f, open.id);
    const c = await cancel(open.id, f.worker.token);
    assert.equal(c.status, 400);
    assert.equal(c.body.error.code, 'MATERIAL_REQUEST_NOT_OPEN');
    assert.deepEqual(await rowActions(f, open.id), []);
  });
});

describe('PART 04 — response shapes (32-40)', () => {
  it('36-39. CREATE / replay / CANCEL responses carry evaluator snapshots', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const key = randomUUID();
    const created = await createMr(f, 2, f.item.id, key);
    assert.deepEqual(created.body.data.availableActions, ['CANCEL_MATERIAL_REQUEST']);
    // 37. replay returns the stored response verbatim, even after state changed
    await approve(f, created.body.data.id);
    const replay = await api().post(`/api/v1/mobile/work-orders/${f.wo.id}/material-requests`)
      .set(auth(f.worker.token)).set('Idempotency-Key', key).send({ itemId: f.item.id, quantity: 2, uomId: f.uomId });
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body.data, created.body.data);
    // 38-39. cancel response recomputed, no mutation tokens
    const open = (await createMr(f, 1, (await newItem(f)).id)).body.data;
    const c = await cancel(open.id, f.worker.token);
    assert.equal(c.status, 200);
    assert.equal(c.body.data.status, 'CANCELLED');
    assert.deepEqual(c.body.data.availableActions, []);
    assert.ok('availableActions' in c.body.data);
  });

  it('40, 45. full-demand usage removes RECORD_MATERIAL_USAGE on detail; item discovery has no actions', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { mr } = await issuable(f, 3, 10, 3);
    assert.equal((await use(f, { materialRequestId: mr.id, quantity: 1 })).status, 201);
    let d = await detail(mr.id, f.worker.token);
    assert.deepEqual(d.body.data.availableActions, ['RECORD_MATERIAL_USAGE']);
    assert.equal(d.body.data.fulfillment.remainingDemandQuantity, 2);
    assert.equal((await use(f, { materialRequestId: mr.id, quantity: 2 })).status, 201);
    d = await detail(mr.id, f.worker.token);
    assert.equal(d.body.data.fulfillment.remainingDemandQuantity, 0);
    assert.deepEqual(d.body.data.availableActions, []);
    assert.equal(d.body.data.issues.length, 2);
    // usage response itself is not enlarged
    const items = await api().get(`/api/v1/mobile/work-orders/${f.wo.id}/material-items`).set(auth(f.worker.token));
    assert.equal(items.status, 200);
    assert.equal(JSON.stringify(items.body.data).includes('availableActions'), false);
  });
});

describe('PART 04 — no scope leak / static proofs (41-48)', () => {
  it('41-44, 46-48. closed vocabulary; no return / reservation / stock / approval tokens; no BE-25H resource; no return or consume endpoint', () => {
    const spec = parse(readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'));
    const s = spec.components.schemas;
    assert.deepEqual(s.MobileWorkOrderMaterialAvailableAction.enum, ['REQUEST_MATERIAL']);
    assert.deepEqual(s.MobileMaterialRequestAvailableAction.enum, ['CANCEL_MATERIAL_REQUEST', 'RECORD_MATERIAL_USAGE']);
    assert.equal(s.MobileMaterialRequest.properties.availableActions.items.$ref, '#/components/schemas/MobileMaterialRequestAvailableAction');
    assert.deepEqual(s.MobileWorkOrderMaterialContext.required, ['workOrderId', 'availableActions', 'materialRequests']);
    assert.equal(JSON.stringify(s.MobileMaterialItem).includes('availableActions'), false);
    assert.equal(JSON.stringify(s.MobileMaterialUsageResult).includes('availableActions'), false);
    // source vocabulary
    const types = readFileSync(resolve(__dirname, '../src/modules/mobile-material-requests/mobile-material-request.types.ts'), 'utf8');
    const evaluator = readFileSync(resolve(__dirname, '../src/modules/mobile-material-requests/mobile-material-action.evaluator.ts'), 'utf8');
    const src = types + evaluator;
    for (const bad of ['RETURN_MATERIAL', 'RESERVE_MATERIAL', 'RELEASE_RESERVATION', 'ADJUST_STOCK', 'APPROVE_MATERIAL_REQUEST', 'ISSUE_MATERIAL', 'ACKNOWLEDGE_ISSUE', 'CONSUME_MATERIAL']) {
      assert.equal(src.includes(bad), false, bad);
    }
    // evaluator: no role names, no JWT parsing, uses the canonical resolver + field seam
    assert.equal(/PLATFORM_ADMIN|roleName|roles\.includes|jwt|decode\(/i.test(evaluator), false);
    assert.ok(evaluator.includes('permissionService.resolvePermissionsForUser'));
    assert.ok(evaluator.includes('assertWorkOrderFieldActor'));
    // routes: no return / consume / acknowledge / stock endpoints; no management permission required
    const routes = readFileSync(resolve(__dirname, '../src/modules/mobile-material-requests/mobile-material-request.routes.ts'), 'utf8');
    const routePaths = [...routes.matchAll(/'(\/mobile\/[^']+)'/g)].map((m) => m[1]).join('\n');
    assert.equal(/return|revers|consume|acknowledge|adjust|stock-in|reservations|stock-movements/i.test(routePaths), false);
    assert.equal(/material_request\.manage|inventory_stock\.manage|wo_procurement\.manage/.test(routes), false);
    // 46. no BE-25H (offline sync) material resource
    const syncDirs = readdirSync(resolve(__dirname, '../src/modules')).filter((d) => /sync|offline/i.test(d));
    for (const dir of syncDirs) {
      for (const file of readdirSync(join(resolve(__dirname, '../src/modules'), dir))) {
        if (!file.endsWith('.ts')) continue;
        const content = readFileSync(join(resolve(__dirname, '../src/modules'), dir, file), 'utf8');
        assert.equal(/material[-_ ]?(request|usage)/i.test(content), false, `${dir}/${file}`);
      }
    }
    // no mobile material path beyond the RN-11 set
    const mobileMaterial = Object.keys(spec.paths).filter((p: string) => /^\/mobile\/.*material/.test(p)).sort();
    assert.deepEqual(mobileMaterial, [
      '/mobile/material-requests/{materialRequestId}',
      '/mobile/material-requests/{materialRequestId}/cancel',
      '/mobile/work-orders/{workOrderId}/material-items',
      '/mobile/work-orders/{workOrderId}/material-requests',
      '/mobile/work-orders/{workOrderId}/material-usages',
    ]);
  });
});
