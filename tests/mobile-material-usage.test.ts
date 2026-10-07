import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { materialRequestService } from '../src/modules/material-requests';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { workOrderProcurementBindingService } from '../src/modules/work-order-procurement-bindings';
import { workOrderService } from '../src/modules/work-orders';
import { sha256Hex } from '../src/shared/hash';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-RN11-MATERIAL-FIELD-01 PART 03 — technician material usage (canonical
 * STOCK_OUT issue) via POST /mobile/work-orders/{workOrderId}/material-usages.
 *
 * Numbering follows the CR test list (1–80).
 */

const OP_KEY = 'recordMobileWorkOrderMaterialUsage';
const FIELD_RECORD = { code: 'material_usage.field.record', name: 'Record Field Material Usage' };
const FIELD_READ = { code: 'material_request.field.read', name: 'Read Field Material Requests' };
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
  const warehouse = await inventoryWarehouseService.createWarehouse({
    buildingId: building.id, code: `WH_${suffix()}`, name: 'Field WH',
  });
  return { worker, client, building, profile, wo, uomId, item, warehouse };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function newItem(f: Fixture) {
  return inventoryItemService.createInventoryItem({
    clientId: f.client.id, code: `ITM_${suffix()}`, name: 'Nut', itemType: 'MATERIAL', uomId: f.uomId,
  });
}
async function createMr(f: Fixture, quantity: number, itemId = f.item.id) {
  const r = await api()
    .post(`/api/v1/mobile/work-orders/${f.wo.id}/material-requests`)
    .set(auth(f.worker.token))
    .set('Idempotency-Key', randomUUID())
    .send({ itemId, quantity, uomId: f.uomId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data as any;
}
async function approve(f: Fixture, mrId: string) {
  const bind = await api().post('/api/v1/procurement-approvals').set(auth(f.worker.token)).send({
    requestType: 'MATERIAL_REQUEST', requestId: mrId,
    approvalType: 'BUDGET_APPROVAL', approverUserId: f.worker.userId,
  });
  assert.equal(bind.status, 201, JSON.stringify(bind.body));
  const dec = await api()
    .post(`/api/v1/procurement-approvals/${bind.body.data.id}/approve`)
    .set(auth(f.worker.token)).send({});
  assert.equal(dec.status, 200, JSON.stringify(dec.body));
}
async function stockIn(f: Fixture, qty: number, itemId = f.item.id, warehouseId = f.warehouse.id) {
  const r = await api()
    .post(`/api/v1/warehouses/${warehouseId}/stock-movements`)
    .set(auth(f.worker.token))
    .send({ itemId, movementType: 'STOCK_IN', quantity: qty });
  assert.equal(r.status, 201, JSON.stringify(r.body));
}
async function reserve(f: Fixture, mrId: string, quantity: number, warehouseId = f.warehouse.id) {
  const r = await api()
    .post(`/api/v1/material-requests/${mrId}/reservations`)
    .set(auth(f.worker.token))
    .send({ warehouseId, quantity });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data as any;
}
/** Approved + stocked field MR with one ACTIVE reservation. */
async function issuable(f: Fixture, requested: number, stock: number, reserveQty: number | null, itemId = f.item.id) {
  const mr = await createMr(f, requested, itemId);
  await approve(f, mr.id);
  if (stock > 0) await stockIn(f, stock, itemId);
  const reservation = reserveQty === null ? null : await reserve(f, mr.id, reserveQty);
  return { mr, reservation };
}
function use(
  f: Fixture,
  body: Record<string, unknown>,
  key: string = randomUUID(),
  token = f.worker.token,
  workOrderId = f.wo.id,
) {
  return api()
    .post(`/api/v1/mobile/work-orders/${workOrderId}/material-usages`)
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send(body);
}
const detail = (id: string, token: string) =>
  api().get(`/api/v1/mobile/material-requests/${id}`).set(auth(token));
const mgmtIssue = (f: Fixture, body: Record<string, unknown>) =>
  api().post(`/api/v1/work-orders/${f.wo.id}/material-usages`).set(auth(f.worker.token))
    .send({ itemId: f.item.id, warehouseId: f.warehouse.id, ...body });

async function counts() {
  const q = async (t: string) =>
    Number((await pool!.query(`SELECT COUNT(*)::text AS n FROM ${t}`)).rows[0].n);
  return {
    movements: await q('inventory_stock_movements'),
    usages: await q('inventory_work_order_material_usages'),
    events: await q('operational_events'),
    idem: await q('request_idempotency_records'),
  };
}
async function balance(f: Fixture, itemId = f.item.id) {
  const r = await pool!.query(
    `SELECT quantity_on_hand::text AS oh, reserved_quantity::text AS rs, available_quantity::text AS av
     FROM inventory_stock_balances WHERE warehouse_id = $1 AND item_id = $2`, [f.warehouse.id, itemId]);
  const row = r.rows[0];
  return { onHand: Number(row?.oh ?? 0), reserved: Number(row?.rs ?? 0), available: Number(row?.av ?? 0) };
}
async function reservationRow(id: string) {
  const r = await pool!.query(
    `SELECT status, consumed_quantity::text AS c, remaining_quantity::text AS r FROM inventory_material_reservations WHERE id = $1`, [id]);
  return { status: r.rows[0].status, consumed: Number(r.rows[0].c), remaining: Number(r.rows[0].r) };
}
async function issuedEvents(usageId?: string) {
  const r = await pool!.query(
    `SELECT actor_user_id AS actor, metadata FROM operational_events
     WHERE event_type = 'WORK_ORDER_MATERIAL_ISSUED' AND ($1::text IS NULL OR metadata->>'usageId' = $1)`,
    [usageId ?? null]);
  return r.rows;
}
async function idemRows(key: string) {
  const r = await pool!.query(
    `SELECT * FROM request_idempotency_records WHERE operation_key = $1 AND idempotency_key_hash = $2`,
    [OP_KEY, sha256Hex(key)]);
  return r.rows;
}
async function setWoStatus(woId: string, status: string) {
  await pool!.query(`UPDATE work_orders SET status = $2 WHERE id = $1`, [woId, status]);
}

const USAGE_KEYS = [
  'id', 'itemId', 'materialRequestId', 'notes', 'quantity', 'reference', 'reservationId',
  'stockMovementId', 'uomId', 'usedAt', 'usedByUserId', 'warehouse', 'warehouseId',
];

describe('PART 03 — multi-MR mutation (1-10)', () => {
  it('1-7. three field MRs, legacy binding on A only; B and C issue independently without binding', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const itemB = await newItem(f);
    const itemC = await newItem(f);
    const A = await issuable(f, 5, 10, 5);
    const B = await issuable(f, 6, 10, 6, itemB.id);
    const C = await issuable(f, 7, 10, 7, itemC.id);
    assert.equal(A.mr.purchaseRequestId, B.mr.purchaseRequestId);
    assert.equal(B.mr.purchaseRequestId, C.mr.purchaseRequestId);
    await workOrderProcurementBindingService.createBinding(
      { workOrderId: f.wo.id, purchaseRequestId: A.mr.purchaseRequestId, materialRequestId: A.mr.id },
      f.worker.userId,
    );
    const rb = await use(f, { materialRequestId: B.mr.id, quantity: 2 });
    assert.equal(rb.status, 201, JSON.stringify(rb.body));
    const rc = await use(f, { materialRequestId: C.mr.id, quantity: 3 });
    assert.equal(rc.status, 201, JSON.stringify(rc.body));
    assert.equal(rb.body.data.usage.materialRequestId, B.mr.id);
    assert.equal(rc.body.data.usage.materialRequestId, C.mr.id);
    const dA = await detail(A.mr.id, f.worker.token);
    const dB = await detail(B.mr.id, f.worker.token);
    const dC = await detail(C.mr.id, f.worker.token);
    assert.equal(dA.body.data.fulfillment.cumulativeIssuedQuantity, 0);
    assert.equal(dA.body.data.fulfillment.remainingDemandQuantity, 5);
    assert.equal(dB.body.data.fulfillment.cumulativeIssuedQuantity, 2);
    assert.equal(dB.body.data.fulfillment.remainingDemandQuantity, 4);
    assert.equal(dC.body.data.fulfillment.cumulativeIssuedQuantity, 3);
    assert.equal(dC.body.data.fulfillment.remainingDemandQuantity, 4);
    // 9. management legacy binding flow (omits materialRequestId → binding's MR-A)
    const legacy = await mgmtIssue(f, { quantity: 1, reservationId: A.reservation.id });
    assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
    assert.equal(legacy.body.data.materialRequestId, A.mr.id);
    // 10. management explicit field MR-B (no binding) also admitted via field relation
    const mgmtB = await mgmtIssue(f, {
      quantity: 1, materialRequestId: B.mr.id, reservationId: B.reservation.id, itemId: itemB.id,
    });
    assert.equal(mgmtB.status, 201, JSON.stringify(mgmtB.body));
  });

  it('8. MR of another Work Order rejected; management MR (binding only) rejected on mobile route', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const other = await fixture();
    const foreign = await issuable(other, 3, 5, 3);
    const r = await use(f, { materialRequestId: foreign.mr.id, quantity: 1 });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'INVENTORY_WO_MATERIAL_USAGE_MATERIAL_REQUEST_INVALID');
    // management MR bound by legacy binding to THIS WO is NOT a field request
    const pr = await purchaseRequestService.createPurchaseRequest({
      clientId: f.client.id, buildingId: f.building.id, requestNumber: `PRQ_${suffix()}`,
      requestType: 'MATERIAL', title: 'Mgmt', requestedByUserId: f.worker.userId,
    });
    const mgmt = await materialRequestService.createMaterialRequest({
      purchaseRequestId: pr.id, itemId: f.item.id, quantity: 4, requestedByUserId: f.worker.userId,
    });
    await approve(f, mgmt.id);
    await workOrderProcurementBindingService.createBinding(
      { workOrderId: f.wo.id, purchaseRequestId: pr.id, materialRequestId: mgmt.id }, f.worker.userId,
    );
    await stockIn(f, 5);
    await reserve(f, mgmt.id, 2);
    const before = await counts();
    const m = await use(f, { materialRequestId: mgmt.id, quantity: 1 });
    assert.equal(m.status, 400);
    assert.equal(m.body.error.code, 'INVENTORY_WO_MATERIAL_USAGE_MATERIAL_REQUEST_INVALID');
    assert.deepEqual(await counts(), before);
    // 10. legacy management route still issues it (binding relation)
    const legacy = await mgmtIssue(f, { quantity: 1 });
    assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
    assert.equal(legacy.body.data.materialRequestId, mgmt.id);
  });
});

describe('PART 03 — field authority (11-18)', () => {
  it('11-16. permission + Building + field-actor gates; management permissions do not substitute', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { mr } = await issuable(f, 5, 10, 5);
    const body = { materialRequestId: mr.id, quantity: 1 };
    const before = await counts();
    // 12. read-only field permission
    const readOnly = await createSessionWithPermissions([FIELD_READ]);
    assert.equal((await use(f, body, randomUUID(), readOnly)).status, 403);
    // 15/16. management permissions alone
    assert.equal((await use(f, body, randomUUID(), await createSessionWithPermissions([STOCK_MANAGE]))).status, 403);
    assert.equal((await use(f, body, randomUUID(), await createSessionWithPermissions([MR_MANAGE]))).status, 403);
    // 13. record permission but no Building access
    const noBuilding = await createSessionWithPermissions([FIELD_RECORD]);
    const nb = await use(f, body, randomUUID(), noBuilding);
    assert.equal(nb.status, 403);
    assert.equal(nb.body.error.code, 'BUILDING_ACCESS_DENIED');
    // 14. Building access but not the WO field actor
    const outsider = await createAdminUser();
    await buildingAssignmentService.createAssignment(outsider.userId, { buildingId: f.building.id });
    const na = await use(f, body, randomUUID(), outsider.token);
    assert.equal(na.status, 403);
    assert.equal(na.body.error.code, 'WORK_ORDER_EXECUTION_UNAUTHORIZED');
    // unassigned WO (assignment removed after the request was raised)
    const g = await fixture();
    const gi = await issuable(g, 2, 5, 2);
    await pool!.query(`DELETE FROM work_order_assignments WHERE work_order_id = $1`, [g.wo.id]);
    const noAssign = await use(g, { materialRequestId: gi.mr.id, quantity: 1 });
    assert.equal(noAssign.status, 400);
    assert.equal(noAssign.body.error.code, 'WORK_ORDER_EXECUTION_NO_ASSIGNMENT');
    assert.equal((await counts()).usages, before.usages); // denied calls issued nothing
    // 11. authorized field actor
    const ok = await use(f, body);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.usage.usedByUserId, f.worker.userId);
  });

  it('17-18. field client cannot supply warehouse / item / uom / usedBy / cost / currency authority fields', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { mr } = await issuable(f, 5, 10, 5);
    const forbidden: Record<string, unknown> = {
      warehouseId: f.warehouse.id, itemId: f.item.id, uomId: f.uomId, usedByUserId: f.worker.userId,
      usedAt: new Date().toISOString(), workOrderId: f.wo.id, clientId: f.client.id,
      buildingId: f.building.id, unitCost: 1, currency: 'IDR', stockMovementId: randomUUID(),
      resultingQuantityOnHand: 1, resultingAvailableQuantity: 1, reference: 'X',
    };
    for (const [k, v] of Object.entries(forbidden)) {
      const r = await use(f, { materialRequestId: mr.id, quantity: 1, [k]: v });
      assert.equal(r.status, 400, k);
      assert.equal(r.body.error.code, 'VALIDATION_ERROR', k);
      assert.ok(r.body.error.details.some((d: any) => d.field === k), k);
    }
    // missing materialRequestId → validation (never inferred)
    const missing = await use(f, { quantity: 1 });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('PART 03 — reservation resolution (19-30)', () => {
  it('19, 29, 30. one ACTIVE reservation auto-resolves; warehouse/item/uom derive server-side', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const wh2 = await inventoryWarehouseService.createWarehouse({
      buildingId: f.building.id, code: `WH_${suffix()}`, name: 'Second WH',
    });
    const mr = await createMr(f, 5);
    await approve(f, mr.id);
    await stockIn(f, 10, f.item.id, wh2.id);
    const res = await reserve(f, mr.id, 5, wh2.id);
    const r = await use(f, { materialRequestId: mr.id, quantity: 2 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const u = r.body.data.usage;
    assert.deepEqual(Object.keys(r.body.data), ['usage']);
    assert.deepEqual(Object.keys(u).sort(), USAGE_KEYS);
    assert.equal(u.reservationId, res.id);
    assert.equal(u.warehouseId, wh2.id);
    assert.deepEqual(u.warehouse, { id: wh2.id, code: wh2.code, name: wh2.name });
    assert.equal(u.itemId, f.item.id);
    assert.equal(u.uomId, f.uomId);
    assert.equal(u.usedByUserId, f.worker.userId);
    assert.equal(u.reference, null);
    for (const k of ['unitCost', 'totalCost', 'currency', 'resultingQuantityOnHand', 'resultingBalance']) {
      assert.equal(k in u, false, k);
    }
  });

  it('20-25. supplied reservation: accepted when ACTIVE+own; rejected for other MR / WO / RELEASED / CANCELLED / CONSUMED', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { mr, reservation } = await issuable(f, 10, 20, 4);
    const other = await issuable(f, 3, 5, 3, (await newItem(f)).id); // same WO, other MR
    const foreign = await issuable(await fixture(), 3, 5, 3);        // other WO
    const before = await counts();
    const notMine = await use(f, { materialRequestId: mr.id, quantity: 1, reservationId: other.reservation.id });
    assert.equal(notMine.status, 404);
    assert.equal(notMine.body.error.code, 'INVENTORY_MATERIAL_RESERVATION_NOT_FOUND');
    const notWo = await use(f, { materialRequestId: mr.id, quantity: 1, reservationId: foreign.reservation.id });
    assert.equal(notWo.status, 404);
    // RELEASED
    const released = await reserve(f, mr.id, 1);
    const rel = await api().post(`/api/v1/material-reservations/${released.id}/release`).set(auth(f.worker.token)).send({});
    assert.equal(rel.status, 200, JSON.stringify(rel.body));
    const r1 = await use(f, { materialRequestId: mr.id, quantity: 1, reservationId: released.id });
    assert.equal(r1.status, 409);
    assert.equal(r1.body.error.code, 'INVENTORY_MATERIAL_RESERVATION_NOT_ACTIVE');
    // CANCELLED
    const cancelled = await reserve(f, mr.id, 1);
    const can = await api().post(`/api/v1/material-reservations/${cancelled.id}/cancel`).set(auth(f.worker.token)).send({});
    assert.equal(can.status, 200, JSON.stringify(can.body));
    const r2 = await use(f, { materialRequestId: mr.id, quantity: 1, reservationId: cancelled.id });
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error.code, 'INVENTORY_MATERIAL_RESERVATION_NOT_ACTIVE');
    const after = await counts();
    assert.equal(after.usages, before.usages);
    assert.equal(after.movements, before.movements);
    // 20. accepted
    const ok = await use(f, { materialRequestId: mr.id, quantity: 4, reservationId: reservation.id });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((await reservationRow(reservation.id)).status, 'CONSUMED');
    // 25. CONSUMED rejected
    const r3 = await use(f, { materialRequestId: mr.id, quantity: 1, reservationId: reservation.id });
    assert.equal(r3.status, 409);
    assert.equal(r3.body.error.code, 'INVENTORY_MATERIAL_RESERVATION_NOT_ACTIVE');
  });

  it('26-28. zero ACTIVE → ACTIVE_RESERVATION_REQUIRED; >1 ACTIVE → RESERVATION_REQUIRED; explicit id accepted', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { mr } = await issuable(f, 10, 20, null);
    const before = await counts();
    const zero = await use(f, { materialRequestId: mr.id, quantity: 1 });
    assert.equal(zero.status, 409);
    assert.equal(zero.body.error.code, 'INVENTORY_WO_MATERIAL_USAGE_ACTIVE_RESERVATION_REQUIRED');
    const a = await reserve(f, mr.id, 3);
    const b = await reserve(f, mr.id, 3);
    const many = await use(f, { materialRequestId: mr.id, quantity: 1 });
    assert.equal(many.status, 409);
    assert.equal(many.body.error.code, 'INVENTORY_WO_MATERIAL_USAGE_RESERVATION_REQUIRED');
    assert.equal((await counts()).usages, before.usages);
    const ok = await use(f, { materialRequestId: mr.id, quantity: 2, reservationId: b.id });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.usage.reservationId, b.id);
    assert.equal((await reservationRow(a.id)).consumed, 0);
    assert.equal((await reservationRow(b.id)).consumed, 2);
  });
});

describe('PART 03 — issue / usage effects (31-41)', () => {
  it('31-41. exact canonical effects: reservation, balance, one movement, one usage, one event, Part 02 read', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { mr, reservation } = await issuable(f, 10, 20, 6);
    const b0 = await balance(f);
    assert.deepEqual(b0, { onHand: 20, reserved: 6, available: 14 });
    const c0 = await counts();
    // 31
    const zero = await use(f, { materialRequestId: mr.id, quantity: 0 });
    assert.equal(zero.status, 400);
    const neg = await use(f, { materialRequestId: mr.id, quantity: -1 });
    assert.equal(neg.status, 400);
    const r = await use(f, { materialRequestId: mr.id, quantity: 4, notes: 'used on pump' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const u = r.body.data.usage;
    // 32
    assert.deepEqual(await reservationRow(reservation.id), { status: 'ACTIVE', consumed: 4, remaining: 2 });
    // 33-34
    assert.deepEqual(await balance(f), { onHand: 16, reserved: 2, available: 14 });
    // 35-37
    const c1 = await counts();
    assert.equal(c1.movements - c0.movements, 1);
    assert.equal(c1.usages - c0.usages, 1);
    const mv = await pool!.query(`SELECT movement_type, quantity::text AS q FROM inventory_stock_movements WHERE id = $1`, [u.stockMovementId]);
    assert.equal(mv.rows[0].movement_type, 'STOCK_OUT');
    assert.equal(Number(mv.rows[0].q), 4);
    const ev = await issuedEvents(u.id);
    assert.equal(ev.length, 1);
    // 38
    assert.equal(ev[0].actor, f.worker.userId);
    assert.equal(u.usedByUserId, f.worker.userId);
    assert.equal(ev[0].metadata.reservationId, reservation.id);
    assert.equal(ev[0].metadata.materialRequestId, mr.id);
    // 39-41
    const d = await detail(mr.id, f.worker.token);
    assert.equal(d.body.data.fulfillment.cumulativeIssuedQuantity, 4);
    assert.equal(d.body.data.fulfillment.remainingDemandQuantity, 6);
    assert.equal(d.body.data.fulfillment.activeReservedQuantity, 2);
    assert.equal(d.body.data.issues.length, 1);
    assert.deepEqual(d.body.data.issues[0], u);
    assert.equal(d.body.data.issues[0].notes, 'used on pump');
    // multiple partial usages allowed
    const r2 = await use(f, { materialRequestId: mr.id, quantity: 2 });
    assert.equal(r2.status, 201);
    assert.equal((await reservationRow(reservation.id)).status, 'CONSUMED');
  });
});

describe('PART 03 — domain guards (42-51)', () => {
  it('42-44. OPEN / CANCELLED cannot issue; APPROVED may', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await stockIn(f, 20);
    const open = await createMr(f, 2);
    const before = await counts();
    // reservation normally requires APPROVED; force one to isolate the status guard
    await pool!.query(
      `INSERT INTO inventory_material_reservations
         (id, client_id, building_id, material_request_id, warehouse_id, item_id, uom_id, reserved_quantity, status, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'ACTIVE', $8)`,
      [randomUUID(), f.client.id, f.building.id, open.id, f.warehouse.id, f.item.id, f.uomId, f.worker.userId],
    );
    const r1 = await use(f, { materialRequestId: open.id, quantity: 1 });
    assert.equal(r1.status, 409);
    assert.equal(r1.body.error.code, 'INVENTORY_WO_MATERIAL_USAGE_MATERIAL_REQUEST_NOT_APPROVED');
    const cancelled = await createMr(f, 2, (await newItem(f)).id);
    const c = await api().post(`/api/v1/mobile/material-requests/${cancelled.id}/cancel`).set(auth(f.worker.token));
    assert.equal(c.status, 200);
    const r2 = await use(f, { materialRequestId: cancelled.id, quantity: 1 });
    assert.equal(r2.status, 409);
    assert.ok(['INVENTORY_WO_MATERIAL_USAGE_MATERIAL_REQUEST_NOT_APPROVED', 'INVENTORY_WO_MATERIAL_USAGE_ACTIVE_RESERVATION_REQUIRED'].includes(r2.body.error.code));
    assert.equal((await counts()).usages, before.usages);
    // 44. APPROVED may issue
    const approved = await issuable(f, 3, 5, 3, (await newItem(f)).id);
    const ok = await use(f, { materialRequestId: approved.mr.id, quantity: 1 });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });

  it('45-47, 51. allocation / demand cap / insufficient stock rejected atomically', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    // 45. quantity > reservation remaining
    const a = await issuable(f, 10, 20, 3);
    const s0 = await balance(f);
    const c0 = await counts();
    const over = await use(f, { materialRequestId: a.mr.id, quantity: 4 });
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, 'INVENTORY_MATERIAL_RESERVATION_ALLOCATION_EXCEEDED');
    // 46. demand cap (approved 2 < reservation 3)
    await pool!.query(`UPDATE material_requests SET approved_quantity = 2 WHERE id = $1`, [a.mr.id]);
    const cap = await use(f, { materialRequestId: a.mr.id, quantity: 3 });
    assert.equal(cap.status, 409);
    assert.equal(cap.body.error.code, 'INVENTORY_WO_MATERIAL_USAGE_DEMAND_EXCEEDED');
    // 51. nothing changed
    assert.deepEqual(await balance(f), s0);
    assert.deepEqual(await counts(), c0);
    assert.deepEqual(await reservationRow(a.reservation.id), { status: 'ACTIVE', consumed: 0, remaining: 3 });
    // 47. insufficient stock: drain on-hand behind the reservation, then issue
    await pool!.query(
      `UPDATE inventory_stock_balances SET quantity_on_hand = 1, reserved_quantity = 1 WHERE warehouse_id = $1 AND item_id = $2`,
      [f.warehouse.id, f.item.id],
    );
    const low = await use(f, { materialRequestId: a.mr.id, quantity: 2 });
    assert.equal(low.status, 409);
    assert.equal(low.body.error.code, 'INVENTORY_WO_MATERIAL_USAGE_INSUFFICIENT_STOCK');
    assert.deepEqual(await reservationRow(a.reservation.id), { status: 'ACTIVE', consumed: 0, remaining: 3 });
    assert.deepEqual(await counts(), c0);
  });

  it('48-50. COMPLETED / CANCELLED / CLOSED Work Order rejected', async (t) => {
    if (!ready(t)) return;
    for (const status of ['COMPLETED', 'CANCELLED', 'CLOSED']) {
      const f = await fixture();
      const { mr } = await issuable(f, 3, 5, 3);
      await setWoStatus(f.wo.id, status);
      const before = await counts();
      const r = await use(f, { materialRequestId: mr.id, quantity: 1 });
      assert.equal(r.status, 409, status);
      assert.equal(r.body.error.code, 'WO_MATERIAL_USAGE_WORK_ORDER_STATE_INVALID', status);
      assert.deepEqual(await counts(), before);
    }
  });
});

describe('PART 03 — idempotency (52-67)', () => {
  it('52-59, 64. key required; replay returns same usage with zero additional effects', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { mr, reservation } = await issuable(f, 10, 20, 6);
    const missing = await api()
      .post(`/api/v1/mobile/work-orders/${f.wo.id}/material-usages`)
      .set(auth(f.worker.token)).send({ materialRequestId: mr.id, quantity: 1 });
    assert.equal(missing.status, 400);
    const key = randomUUID();
    const body = { materialRequestId: mr.id, quantity: 2, notes: 'x' };
    const c0 = await counts();
    const first = await use(f, body, key);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const c1 = await counts();
    assert.equal(c1.usages - c0.usages, 1);
    assert.equal(c1.movements - c0.movements, 1);
    assert.equal(c1.idem - c0.idem, 1);
    const b1 = await balance(f);
    const r1 = await reservationRow(reservation.id);
    const ev1 = (await issuedEvents()).length;
    const replay = await use(f, body, key);
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body.data, first.body.data);
    assert.deepEqual(await counts(), c1);
    assert.deepEqual(await balance(f), b1);
    assert.deepEqual(await reservationRow(reservation.id), r1);
    assert.equal((await issuedEvents()).length, ev1);
    const d = await detail(mr.id, f.worker.token);
    assert.equal(d.body.data.fulfillment.cumulativeIssuedQuantity, 2);
    assert.equal(d.body.data.issues.length, 1);
  });

  it('60-63, 65. changed intent → IDEMPOTENCY_CONFLICT; different actor = independent namespace', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { mr, reservation } = await issuable(f, 10, 20, 6);
    const other = await issuable(f, 5, 0, null, (await newItem(f)).id);
    const key = randomUUID();
    const body = { materialRequestId: mr.id, reservationId: reservation.id, quantity: 1, notes: 'a' };
    assert.equal((await use(f, body, key)).status, 201);
    const c = await counts();
    for (const variant of [
      { ...body, materialRequestId: other.mr.id },
      { ...body, reservationId: undefined },
      { ...body, quantity: 2 },
      { ...body, notes: 'b' },
    ]) {
      const clean = JSON.parse(JSON.stringify(variant));
      const r = await use(f, clean, key);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.error.code, 'IDEMPOTENCY_CONFLICT');
    }
    assert.deepEqual(await counts(), c);
    // 65. another authorized field actor with the same key → own namespace → new usage
    const second = await createAdminUser();
    await buildingAssignmentService.createAssignment(second.userId, { buildingId: f.building.id });
    const org = (await organizationService.listOrganizationsByClient(f.client.id))[0]!;
    const dep2 = await departmentService.createDepartment({ organizationId: org.id, code: `DEP_${suffix()}`, name: 'D2' });
    const pos2 = await positionService.createPosition({ organizationId: org.id, code: `POS_${suffix()}`, name: 'P2' });
    const profile2 = await workforceService.createWorkforceProfile({
      organizationId: org.id, departmentId: dep2.id, positionId: pos2.id,
      userId: second.userId, employeeCode: `WF_${suffix()}`, fullName: 'Second',
    });
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: profile2.id, buildingId: f.building.id,
    });
    const cur = await api().get(`/api/v1/work-orders/${f.wo.id}/assignments/current`).set(auth(f.worker.token));
    const re = await api().patch(`/api/v1/work-orders/${f.wo.id}/assignments/${cur.body.data.id}`)
      .set(auth(f.worker.token)).send({ assigneeType: 'WORKFORCE', workforceProfileId: profile2.id });
    assert.equal(re.status, 200, JSON.stringify(re.body));
    const r2 = await use(f, body, key, second.token);
    assert.equal(r2.status, 201, JSON.stringify(r2.body));
    assert.notEqual(r2.body.data.usage.id, undefined);
    assert.equal(r2.body.data.usage.usedByUserId, second.userId);
    assert.equal((await counts()).usages, c.usages + 1);
  });

  it('66. authority / validation / domain failure does not poison the key', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { mr } = await issuable(f, 10, 20, 6);
    const key = randomUUID();
    // validation failure
    assert.equal((await use(f, { materialRequestId: mr.id, quantity: 0 }, key)).status, 400);
    // authority failure
    const readOnly = await createSessionWithPermissions([FIELD_READ]);
    assert.equal((await use(f, { materialRequestId: mr.id, quantity: 1 }, key, readOnly)).status, 403);
    // foreign MR
    assert.equal((await use(f, { materialRequestId: randomUUID(), quantity: 1 }, key)).status, 400);
    // domain conflict inside the transaction (allocation exceeded)
    const dom = await use(f, { materialRequestId: mr.id, quantity: 7 }, key);
    assert.equal(dom.status, 409);
    assert.equal((await idemRows(key)).length, 0);
    const ok = await use(f, { materialRequestId: mr.id, quantity: 1 }, key);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((await idemRows(key)).length, 1);
  });

  it('67. forced failure after the stock decrement rolls back idempotency + all stock effects', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { mr, reservation } = await issuable(f, 10, 20, 6);
    const key = randomUUID();
    const b0 = await balance(f);
    const c0 = await counts();
    // Force the event insert to fail after movement + usage + reservation consumption.
    await pool!.query(`
      CREATE OR REPLACE FUNCTION asentra_test_fail_issue_event() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'WORK_ORDER_MATERIAL_ISSUED' THEN RAISE EXCEPTION 'forced event failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER asentra_test_fail_issue_event BEFORE INSERT ON operational_events
        FOR EACH ROW EXECUTE FUNCTION asentra_test_fail_issue_event();`);
    try {
      const r = await use(f, { materialRequestId: mr.id, quantity: 2 }, key);
      assert.equal(r.status, 500);
    } finally {
      await pool!.query(`DROP TRIGGER IF EXISTS asentra_test_fail_issue_event ON operational_events;
                         DROP FUNCTION IF EXISTS asentra_test_fail_issue_event();`);
    }
    assert.deepEqual(await balance(f), b0);
    assert.deepEqual(await counts(), c0);
    assert.deepEqual(await reservationRow(reservation.id), { status: 'ACTIVE', consumed: 0, remaining: 6 });
    assert.equal((await idemRows(key)).length, 0);
    // key still usable
    const ok = await use(f, { materialRequestId: mr.id, quantity: 2 }, key);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });
});

describe('PART 03 — concurrency (68-73)', () => {
  it('68-73. concurrent usages: demand cap, allocation and stock never exceeded; losers get deterministic conflicts', async (t) => {
    if (!ready(t)) return;
    // demand cap 5 with reservation 5 and stock 5: three concurrent 3-unit issues → exactly one wins
    const f = await fixture();
    const { mr, reservation } = await issuable(f, 5, 5, 5);
    const c0 = await counts();
    const results = await Promise.all([
      use(f, { materialRequestId: mr.id, quantity: 3 }),
      use(f, { materialRequestId: mr.id, quantity: 3 }),
      use(f, { materialRequestId: mr.id, quantity: 3 }),
    ]);
    const winners = results.filter((r) => r.status === 201);
    const losers = results.filter((r) => r.status !== 201);
    assert.equal(winners.length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.equal(losers.length, 2);
    for (const l of losers) {
      assert.equal(l.status, 409);
      assert.ok([
        'INVENTORY_WO_MATERIAL_USAGE_DEMAND_EXCEEDED',
        'INVENTORY_MATERIAL_RESERVATION_ALLOCATION_EXCEEDED',
        'INVENTORY_WO_MATERIAL_USAGE_INSUFFICIENT_STOCK',
      ].includes(l.body.error.code), l.body.error.code);
    }
    const c1 = await counts();
    assert.equal(c1.usages - c0.usages, 1);
    assert.equal(c1.movements - c0.movements, 1);
    assert.deepEqual(await balance(f), { onHand: 2, reserved: 2, available: 0 });
    assert.deepEqual(await reservationRow(reservation.id), { status: 'ACTIVE', consumed: 3, remaining: 2 });
    const d = await detail(mr.id, f.worker.token);
    assert.equal(d.body.data.fulfillment.cumulativeIssuedQuantity, 3);
    assert.equal(d.body.data.fulfillment.remainingDemandQuantity, 2);
    // two more concurrent 2-unit issues against remaining 2 → exactly one wins, stock never below zero
    const again = await Promise.all([
      use(f, { materialRequestId: mr.id, quantity: 2 }),
      use(f, { materialRequestId: mr.id, quantity: 2 }),
    ]);
    assert.equal(again.filter((r) => r.status === 201).length, 1);
    assert.deepEqual(await balance(f), { onHand: 0, reserved: 0, available: 0 });
    assert.equal((await reservationRow(reservation.id)).status, 'CONSUMED');
  });
});

describe('PART 03 — boundaries (74-80)', () => {
  it('74-78. no return / reversal / consume / acknowledge surface; usage response carries no availableActions', async (t) => {
    if (!ready(t)) return;
    const { createMobileMaterialRequestRouter } = await import('../src/modules/mobile-material-requests');
    const stack = (createMobileMaterialRequestRouter() as any).stack as any[];
    const routes = stack.map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).join('\n');
    assert.equal(/return|revers|consume|acknowledge|mark-used|adjust|stock-in/i.test(routes), false);
    const spec = parse(readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'));
    const mobile = Object.keys(spec.paths).filter((p: string) => p.startsWith('/mobile/') && /material/.test(p));
    assert.equal(mobile.some((p: string) => /return|revers|consume|acknowledge/.test(p)), false);
    assert.equal(JSON.stringify(spec.components.schemas.MobileMaterialUsageResult).includes('availableActions'), false);
    // PART 04: request-level vocabulary is closed — no return / reservation / approval token
    assert.deepEqual(spec.components.schemas.MobileMaterialRequestAvailableAction.enum, ['CANCEL_MATERIAL_REQUEST', 'RECORD_MATERIAL_USAGE']);
    // 76. negative usage
    const f = await fixture();
    const { mr } = await issuable(f, 3, 5, 3);
    assert.equal((await use(f, { materialRequestId: mr.id, quantity: -1 })).status, 400);
    // OpenAPI contract of the new command
    const op = spec.paths['/mobile/work-orders/{workOrderId}/material-usages'].post;
    assert.equal(op.operationId, 'recordMobileWorkOrderMaterialUsage');
    assert.equal(op['x-required-permission'], 'material_usage.field.record');
    assert.ok(op.parameters.some((p: any) => p.$ref === '#/components/parameters/RequestIdempotencyKeyHeader'));
    const create = spec.components.schemas.MobileMaterialUsageCreate;
    assert.deepEqual(Object.keys(create.properties).sort(), ['materialRequestId', 'notes', 'quantity', 'reservationId']);
    assert.equal(create.additionalProperties, false);
    assert.match(op.description, /STOCK_OUT/);
    assert.match(op.description, /GET \/mobile\/material-requests\/\{materialRequestId\}/);
  });

  it('79-80. Part 02 read model canonical after usage; Part 01 create/cancel preserved', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { mr } = await issuable(f, 5, 10, 5);
    assert.equal((await use(f, { materialRequestId: mr.id, quantity: 2 })).status, 201);
    const d = await detail(mr.id, f.worker.token);
    assert.equal(d.body.data.status, 'APPROVED');
    assert.deepEqual(d.body.data.fulfillment, {
      requestedQuantity: 5, approvedQuantity: 5, activeReservedQuantity: 3,
      cumulativeIssuedQuantity: 2, remainingDemandQuantity: 3,
    });
    assert.equal(d.body.data.reservations.length, 1);
    assert.equal(d.body.data.issues.length, 1);
    // Part 01
    const fresh = await createMr(f, 1, (await newItem(f)).id);
    assert.equal(fresh.status, 'OPEN');
    const c = await api().post(`/api/v1/mobile/material-requests/${fresh.id}/cancel`).set(auth(f.worker.token));
    assert.equal(c.status, 200);
    assert.equal(c.body.data.status, 'CANCELLED');
    const list = await api().get(`/api/v1/mobile/work-orders/${f.wo.id}/material-requests`).set(auth(f.worker.token));
    assert.equal(list.body.data.materialRequests.length, 2);
  });
});
