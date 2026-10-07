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
import { inventoryMaterialReservationRepository } from '../src/modules/inventory-material-reservations/inventory-material-reservation.repository';
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
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-RN11-MATERIAL-FIELD-01 PART 02 — material issue awareness (read-only)
 * + mobile-safe item discovery.
 *
 * Numbering follows the CR test list (1–48).
 */

const FIELD_READ = { code: 'material_request.field.read', name: 'Read Field Material Requests' };
const ITEM_READ = { code: 'inventory_item.read', name: 'Read Inventory Items' };

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
  const r = await api()
    .post(`/api/v1/work-orders/${wo.id}/assignments`)
    .set(auth(worker.token))
    .send({ assigneeType: 'WORKFORCE', workforceProfileId: profile.id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
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

async function newItem(f: Fixture, extra: Record<string, unknown> = {}) {
  return inventoryItemService.createInventoryItem({
    clientId: f.client.id, code: `ITM_${suffix()}`, name: 'Nut', itemType: 'MATERIAL', uomId: f.uomId,
    ...extra,
  } as any);
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
const list = (f: Fixture, token = f.worker.token, workOrderId = f.wo.id) =>
  api().get(`/api/v1/mobile/work-orders/${workOrderId}/material-requests`).set(auth(token));
const get = (id: string, token: string) =>
  api().get(`/api/v1/mobile/material-requests/${id}`).set(auth(token));
const items = (f: Fixture, token = f.worker.token, workOrderId = f.wo.id) =>
  api().get(`/api/v1/mobile/work-orders/${workOrderId}/material-items`).set(auth(token));

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
async function setApproved(mrId: string, qty: number) {
  await pool!.query(`UPDATE material_requests SET approved_quantity = $2 WHERE id = $1`, [mrId, qty]);
}
async function stockIn(f: Fixture, qty: number, itemId = f.item.id) {
  const r = await api()
    .post(`/api/v1/warehouses/${f.warehouse.id}/stock-movements`)
    .set(auth(f.worker.token))
    .send({ itemId, movementType: 'STOCK_IN', quantity: qty });
  assert.equal(r.status, 201, JSON.stringify(r.body));
}
/** Legacy usage engine (Part 03 rewires it) still needs a binding to issue. */
async function bindLegacy(f: Fixture, mr: any) {
  await workOrderProcurementBindingService.createBinding(
    { workOrderId: f.wo.id, purchaseRequestId: mr.purchaseRequestId, materialRequestId: mr.id },
    f.worker.userId,
  );
}
async function issue(f: Fixture, body: Record<string, unknown>) {
  return api()
    .post(`/api/v1/work-orders/${f.wo.id}/material-usages`)
    .set(auth(f.worker.token))
    .send({ itemId: f.item.id, warehouseId: f.warehouse.id, ...body });
}
async function reserve(f: Fixture, mrId: string, quantity: number) {
  return api()
    .post(`/api/v1/material-requests/${mrId}/reservations`)
    .set(auth(f.worker.token))
    .send({ warehouseId: f.warehouse.id, quantity });
}
/** An approved + bound + stocked request ready to be reserved/issued. */
async function issuable(f: Fixture, requested: number, approvedQty: number | null, stock: number) {
  const mr = await createMr(f, requested);
  await approve(f, mr.id);
  if (approvedQty !== null && approvedQty !== requested) await setApproved(mr.id, approvedQty);
  await bindLegacy(f, mr);
  if (stock > 0) await stockIn(f, stock);
  return mr;
}
async function counts() {
  const q = async (t: string) =>
    Number((await pool!.query(`SELECT COUNT(*)::text AS n FROM ${t}`)).rows[0].n);
  return {
    balances: await q('inventory_stock_balances'),
    movements: await q('inventory_stock_movements'),
    reservations: await q('inventory_material_reservations'),
    usages: await q('inventory_work_order_material_usages'),
    bindings: await q('work_order_procurement_bindings'),
    events: await q('operational_events'),
  };
}
async function balance(f: Fixture) {
  const r = await pool!.query(
    `SELECT quantity_on_hand, reserved_quantity, available_quantity FROM inventory_stock_balances
     WHERE warehouse_id = $1 AND item_id = $2`, [f.warehouse.id, f.item.id]);
  return r.rows[0];
}

const FULFILLMENT_KEYS = [
  'activeReservedQuantity', 'approvedQuantity', 'cumulativeIssuedQuantity',
  'remainingDemandQuantity', 'requestedQuantity',
];
const LIST_KEYS = [
  'approvedQuantity', 'availableActions', 'createdAt', 'fulfillment', 'id', 'item', 'notes', 'purchaseRequestId',
  'purchaseRequestNumber', 'quantity', 'requestedByUserId', 'requiredDate', 'status',
  'uom', 'uomId', 'updatedAt', 'workOrderId',
].sort();
const DETAIL_KEYS = [...LIST_KEYS, 'issues', 'reservations'].sort();
const RESERVATION_KEYS = [
  'consumedQuantity', 'createdAt', 'id', 'materialRequestId', 'remainingQuantity',
  'reservedQuantity', 'status', 'updatedAt', 'warehouse', 'warehouseId',
];
const ISSUE_KEYS = [
  'id', 'itemId', 'materialRequestId', 'notes', 'quantity', 'reference', 'reservationId',
  'stockMovementId', 'uomId', 'usedAt', 'usedByUserId', 'warehouse', 'warehouseId',
];
const FORBIDDEN = [
  'remainingQuantity', 'usedQuantity', 'onHand', 'quantityOnHand', 'availableQuantity',
  'reservedQuantity', 'acknowledged', 'acknowledgedAt', 'issuedQuantity',
];

describe('PART 02 — multi-MR awareness (1-5)', () => {
  it('1-3, 5. list carries fulfillment per request; three requests isolated; canonical parent chain', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const before = await counts();
    const a = await createMr(f, 1);
    const b = await createMr(f, 2, (await newItem(f)).id);
    const c = await createMr(f, 3, (await newItem(f)).id);
    const l = await list(f);
    assert.equal(l.status, 200);
    assert.deepEqual(l.body.data.materialRequests.map((x: any) => x.id), [a.id, b.id, c.id]);
    for (const [i, row] of l.body.data.materialRequests.entries()) {
      assert.deepEqual(Object.keys(row).sort(), LIST_KEYS);
      assert.deepEqual(Object.keys(row.fulfillment).sort(), FULFILLMENT_KEYS);
      assert.deepEqual(row.fulfillment, {
        requestedQuantity: i + 1, approvedQuantity: null, activeReservedQuantity: 0,
        cumulativeIssuedQuantity: 0, remainingDemandQuantity: i + 1,
      });
      assert.equal('reservations' in row, false);
      assert.equal('issues' in row, false);
    }
    // 5. work_order_id chain, not legacy binding: no binding rows exist at all
    const after = await counts();
    assert.equal(after.bindings, before.bindings);
    // 2. create/cancel responses also carry fulfillment
    assert.deepEqual(Object.keys(a).sort(), LIST_KEYS);
  });

  it('4. issue against ONE request does not bleed into siblings on the same Work Order', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const target = await issuable(f, 5, 5, 10);
    const sibling = await createMr(f, 4, (await newItem(f)).id);
    const done = await issue(f, { quantity: 2 });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    const l = await list(f);
    const byId = Object.fromEntries(l.body.data.materialRequests.map((x: any) => [x.id, x]));
    assert.equal(byId[target.id].fulfillment.cumulativeIssuedQuantity, 2);
    assert.equal(byId[target.id].fulfillment.remainingDemandQuantity, 3);
    assert.equal(byId[sibling.id].fulfillment.cumulativeIssuedQuantity, 0);
    assert.equal(byId[sibling.id].fulfillment.remainingDemandQuantity, 4);
    const d = await get(sibling.id, f.worker.token);
    assert.deepEqual(d.body.data.issues, []);
  });
});

describe('PART 02 — quantity facts (6-19)', () => {
  it('6-9, 12. OPEN request: requested only; approved null; remaining = requested; approval sets cap', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const mr = await createMr(f, 7);
    let d = await get(mr.id, f.worker.token);
    assert.equal(d.body.data.status, 'OPEN');
    assert.deepEqual(d.body.data.fulfillment, {
      requestedQuantity: 7, approvedQuantity: null, activeReservedQuantity: 0,
      cumulativeIssuedQuantity: 0, remainingDemandQuantity: 7,
    });
    await approve(f, mr.id);
    await setApproved(mr.id, 5);
    d = await get(mr.id, f.worker.token);
    assert.equal(d.body.data.status, 'APPROVED');
    assert.equal(d.body.data.fulfillment.requestedQuantity, 7);
    assert.equal(d.body.data.fulfillment.approvedQuantity, 5);
    assert.equal(d.body.data.fulfillment.remainingDemandQuantity, 5);
    assert.equal(d.body.data.approvedQuantity, d.body.data.fulfillment.approvedQuantity);
    assert.equal(d.body.data.quantity, d.body.data.fulfillment.requestedQuantity);
  });

  it('10-11, 13-15. cumulative issued sums usages; remaining = cap − issued; reservations NOT subtracted', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const mr = await issuable(f, 10, 8, 20);
    const res = await reserve(f, mr.id, 3);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    let d = await get(mr.id, f.worker.token);
    assert.equal(d.body.data.fulfillment.activeReservedQuantity, 3);
    assert.equal(d.body.data.fulfillment.cumulativeIssuedQuantity, 0);
    // issue cap semantics = cap − issued (reservation is an earmark, not an issue)
    assert.equal(d.body.data.fulfillment.remainingDemandQuantity, 8);
    assert.equal((await issue(f, { quantity: 2 })).status, 201);
    assert.equal((await issue(f, { quantity: 3 })).status, 201);
    d = await get(mr.id, f.worker.token);
    assert.equal(d.body.data.fulfillment.cumulativeIssuedQuantity, 5);
    assert.equal(d.body.data.fulfillment.remainingDemandQuantity, 3);
    assert.equal(d.body.data.fulfillment.activeReservedQuantity, 3);
    // 15. identical to the canonical demand snapshot used by issue control
    const client = await pool!.connect();
    try {
      const snap = await inventoryMaterialReservationRepository.getDemandSnapshot(client, mr.id, 1);
      assert.equal(d.body.data.fulfillment.cumulativeIssuedQuantity, snap.cumulativeIssued);
      assert.equal(d.body.data.fulfillment.activeReservedQuantity, snap.activeReserved);
      assert.equal(d.body.data.fulfillment.remainingDemandQuantity, snap.remainingDemand);
    } finally {
      client.release();
    }
  });

  it('16-17. fully issued → remaining 0; engine refuses beyond cap and awareness agrees', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const mr = await issuable(f, 4, 4, 10);
    assert.equal((await issue(f, { quantity: 4 })).status, 201);
    const over = await issue(f, { quantity: 1 });
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, 'INVENTORY_WO_MATERIAL_USAGE_DEMAND_EXCEEDED');
    const d = await get(mr.id, f.worker.token);
    assert.equal(d.body.data.fulfillment.cumulativeIssuedQuantity, 4);
    assert.equal(d.body.data.fulfillment.remainingDemandQuantity, 0);
    assert.equal(d.body.data.issues.length, 1);
    assert.equal(d.body.data.status, 'APPROVED'); // request status is untouched by issue
  });

  it('18. decimal quantities survive NUMERIC arithmetic (no float drift)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const mr = await issuable(f, 1, 1, 5);
    assert.equal((await issue(f, { quantity: 0.1 })).status, 201);
    assert.equal((await issue(f, { quantity: 0.2 })).status, 201);
    const d = await get(mr.id, f.worker.token);
    assert.equal(d.body.data.fulfillment.cumulativeIssuedQuantity, 0.3);
    assert.equal(d.body.data.fulfillment.remainingDemandQuantity, 0.7);
  });

  it('19. CANCELLED request keeps its facts; request status separate from history', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const mr = await createMr(f, 3);
    const c = await api().post(`/api/v1/mobile/material-requests/${mr.id}/cancel`).set(auth(f.worker.token));
    assert.equal(c.status, 200);
    assert.deepEqual(Object.keys(c.body.data).sort(), LIST_KEYS);
    const d = await get(mr.id, f.worker.token);
    assert.equal(d.body.data.status, 'CANCELLED');
    assert.deepEqual(d.body.data.fulfillment, {
      requestedQuantity: 3, approvedQuantity: null, activeReservedQuantity: 0,
      cumulativeIssuedQuantity: 0, remainingDemandQuantity: 3,
    });
  });
});

describe('PART 02 — reservation awareness (20-24)', () => {
  it('20-23. detail lists canonical reservations verbatim with warehouse metadata and status', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const mr = await issuable(f, 10, 10, 20);
    const r1 = await reserve(f, mr.id, 4);
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    const r2 = await reserve(f, mr.id, 2);
    assert.equal(r2.status, 201);
    const rel = await api()
      .post(`/api/v1/material-reservations/${r1.body.data.id}/release`)
      .set(auth(f.worker.token)).send({});
    assert.equal(rel.status, 200, JSON.stringify(rel.body));
    const d = await get(mr.id, f.worker.token);
    assert.deepEqual(Object.keys(d.body.data).sort(), DETAIL_KEYS);
    assert.equal(d.body.data.reservations.length, 2);
    for (const row of d.body.data.reservations) {
      assert.deepEqual(Object.keys(row).sort(), RESERVATION_KEYS);
      assert.equal(row.materialRequestId, mr.id);
      assert.equal(row.warehouseId, f.warehouse.id);
      assert.deepEqual(row.warehouse, { id: f.warehouse.id, code: f.warehouse.code, name: f.warehouse.name });
    }
    const byId = Object.fromEntries(d.body.data.reservations.map((x: any) => [x.id, x]));
    assert.equal(byId[r1.body.data.id].status, 'RELEASED');
    assert.equal(byId[r1.body.data.id].reservedQuantity, 4);
    assert.equal(byId[r2.body.data.id].status, 'ACTIVE');
    assert.equal(byId[r2.body.data.id].reservedQuantity, 2);
    assert.equal(byId[r2.body.data.id].consumedQuantity, 0);
    assert.equal(byId[r2.body.data.id].remainingQuantity, 2);
    // 22. only ACTIVE counts
    assert.equal(d.body.data.fulfillment.activeReservedQuantity, 2);
    // 23. newest first (canonical order)
    assert.deepEqual(d.body.data.reservations.map((x: any) => x.id), [r2.body.data.id, r1.body.data.id]);
  });

  it('24. consumed reservation: CONSUMED status, consumedQuantity, and issue linked via reservationId', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const mr = await issuable(f, 6, 6, 20);
    const r = await reserve(f, mr.id, 3);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const done = await issue(f, { quantity: 3, reservationId: r.body.data.id });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    const d = await get(mr.id, f.worker.token);
    const res = d.body.data.reservations[0];
    assert.equal(res.status, 'CONSUMED');
    assert.equal(res.consumedQuantity, 3);
    assert.equal(res.remainingQuantity, 0);
    assert.equal(d.body.data.fulfillment.activeReservedQuantity, 0);
    assert.equal(d.body.data.fulfillment.cumulativeIssuedQuantity, 3);
    assert.equal(d.body.data.fulfillment.remainingDemandQuantity, 3);
    assert.equal(d.body.data.issues[0].reservationId, r.body.data.id);
  });
});

describe('PART 02 — issue history (25-34)', () => {
  it('25-31. issues are canonical usage rows: fields verbatim, stockMovementId set, newest first', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const mr = await issuable(f, 10, 10, 20);
    const i1 = await issue(f, { quantity: 2, reference: 'REF-1', notes: 'first' });
    assert.equal(i1.status, 201, JSON.stringify(i1.body));
    const i2 = await issue(f, { quantity: 3 });
    assert.equal(i2.status, 201);
    const d = await get(mr.id, f.worker.token);
    assert.equal(d.body.data.issues.length, 2);
    assert.deepEqual(d.body.data.issues.map((x: any) => x.id), [i2.body.data.id, i1.body.data.id]);
    const first = d.body.data.issues[1];
    assert.deepEqual(Object.keys(first).sort(), ISSUE_KEYS);
    assert.equal(first.materialRequestId, mr.id);
    assert.equal(first.reservationId, null);
    assert.equal(first.warehouseId, f.warehouse.id);
    assert.deepEqual(first.warehouse, { id: f.warehouse.id, code: f.warehouse.code, name: f.warehouse.name });
    assert.equal(first.itemId, f.item.id);
    assert.equal(first.quantity, 2);
    assert.equal(first.uomId, f.uomId);
    assert.equal(first.usedByUserId, f.worker.userId);
    assert.equal(first.reference, 'REF-1');
    assert.equal(first.notes, 'first');
    assert.equal(typeof first.usedAt, 'string');
    // canonical usage row equality
    const canon = await pool!.query(
      `SELECT quantity::text AS q, stock_movement_id AS sm, used_at FROM inventory_work_order_material_usages WHERE id = $1`,
      [first.id],
    );
    assert.equal(Number(canon.rows[0].q), first.quantity);
    assert.equal(canon.rows[0].sm, first.stockMovementId);
    assert.ok(first.stockMovementId);
    assert.equal(new Date(canon.rows[0].used_at).toISOString(), first.usedAt);
    assert.equal(d.body.data.fulfillment.cumulativeIssuedQuantity, 5);
  });

  it('32. issue cost / resulting balances are not exposed to the field surface', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const mr = await issuable(f, 5, 5, 10);
    assert.equal((await issue(f, { quantity: 1 })).status, 201);
    const d = await get(mr.id, f.worker.token);
    const json = JSON.stringify(d.body.data);
    for (const k of ['unitCost', 'totalCost', 'currency', 'costSource', 'resultingQuantityOnHand', 'resultingAvailableQuantity']) {
      assert.equal(json.includes(`"${k}"`), false, k);
    }
  });

  it('33-34. reads mutate nothing: no stock, reservation, usage, movement, event side effects', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const mr = await issuable(f, 5, 5, 10);
    assert.equal((await reserve(f, mr.id, 1)).status, 201);
    assert.equal((await issue(f, { quantity: 1 })).status, 201);
    const before = await counts();
    const bal = await balance(f);
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await get(mr.id, f.worker.token)).status, 200);
      assert.equal((await list(f)).status, 200);
      assert.equal((await items(f)).status, 200);
    }
    assert.deepEqual(await counts(), before);
    assert.deepEqual(await balance(f), bal);
  });
});

describe('PART 02 — item discovery (35-42)', () => {
  it('35-38. lists client-scoped items with uom, no stock; other clients invisible; ordered by code', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const other = await fixture();
    const noUom = await inventoryItemService.createInventoryItem({
      clientId: f.client.id, code: `AAA_${suffix()}`, name: 'Loose', itemType: 'CONSUMABLE', uomId: null,
    } as any);
    await stockIn(f, 5);
    const r = await items(f);
    assert.equal(r.status, 200);
    const ids = r.body.data.map((x: any) => x.itemId);
    assert.ok(ids.includes(f.item.id));
    assert.ok(ids.includes(noUom.id));
    assert.equal(ids.includes(other.item.id), false);
    const codes = r.body.data.map((x: any) => x.code);
    assert.deepEqual(codes, [...codes].sort());
    const mine = r.body.data.find((x: any) => x.itemId === f.item.id);
    assert.deepEqual(Object.keys(mine).sort(), ['code', 'itemId', 'itemType', 'name', 'uom']);
    assert.equal(mine.code, f.item.code);
    assert.equal(mine.name, 'Bolt');
    assert.equal(mine.itemType, 'MATERIAL');
    assert.deepEqual(Object.keys(mine.uom).sort(), ['code', 'id', 'name', 'symbol']);
    assert.equal(mine.uom.id, f.uomId);
    const loose = r.body.data.find((x: any) => x.itemId === noUom.id);
    assert.equal(loose.uom, null);
    const json = JSON.stringify(r.body.data);
    for (const k of ['quantityOnHand', 'onHand', 'availableQuantity', 'reservedQuantity', 'warehouse', 'unitCost']) {
      assert.equal(json.includes(k), false, k);
    }
  });

  it('39. discovery filter == create validity rule (every listed item creates; unlisted item is rejected)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const other = await fixture();
    const inactive = await newItem(f);
    await inventoryItemService.updateInventoryItem(inactive.id, { status: 'INACTIVE' } as any);
    const r = await items(f);
    const listed = r.body.data as any[];
    assert.ok(listed.some((x) => x.itemId === inactive.id), 'BE-17B applies no status gate; discovery must not either');
    for (const it of listed) {
      const c = await api()
        .post(`/api/v1/mobile/work-orders/${f.wo.id}/material-requests`)
        .set(auth(f.worker.token)).set('Idempotency-Key', randomUUID())
        .send({ itemId: it.itemId, quantity: 1, uomId: it.uom?.id ?? null });
      assert.equal(c.status, 201, JSON.stringify(c.body));
    }
    const foreign = await api()
      .post(`/api/v1/mobile/work-orders/${f.wo.id}/material-requests`)
      .set(auth(f.worker.token)).set('Idempotency-Key', randomUUID())
      .send({ itemId: other.item.id, quantity: 1, uomId: other.uomId });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.body.error.code, 'MATERIAL_REQUEST_ITEM_CLIENT_MISMATCH');
  });

  it('40-42. authority: field.read suffices (no inventory_item.read); building isolation; unknown WO; no auth', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const fieldOnly = await createSessionWithPermissions([FIELD_READ]);
    // field.read but no Building access → 403 BUILDING_ACCESS_DENIED
    const noBuilding = await items(f, fieldOnly);
    assert.equal(noBuilding.status, 403);
    assert.equal(noBuilding.body.error.code, 'BUILDING_ACCESS_DENIED');
    // inventory_item.read alone is NOT enough
    const itemReadOnly = await createSessionWithPermissions([ITEM_READ]);
    assert.equal((await items(f, itemReadOnly)).status, 403);
    // cross-building admin (all perms, no building assignment)
    const stranger = await createAdminUser();
    const x = await items(f, stranger.token);
    assert.equal(x.status, 403);
    assert.equal(x.body.error.code, 'BUILDING_ACCESS_DENIED');
    const unknown = await items(f, f.worker.token, randomUUID());
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'WORK_ORDER_NOT_FOUND');
    const anon = await api().get(`/api/v1/mobile/work-orders/${f.wo.id}/material-items`);
    assert.equal(anon.status, 401);
    // the technician itself (building-assigned) succeeds
    assert.equal((await items(f)).status, 200);
  });
});

describe('PART 02 — DTO safety (43-48)', () => {
  it('43-46. no receiving remainingQuantity / usedQuantity / stock / ack in list or detail top level', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const mr = await issuable(f, 5, 5, 10);
    assert.equal((await reserve(f, mr.id, 1)).status, 201);
    assert.equal((await issue(f, { quantity: 1 })).status, 201);
    const l = await list(f);
    const d = await get(mr.id, f.worker.token);
    for (const dto of [l.body.data.materialRequests[0], d.body.data]) {
      for (const k of FORBIDDEN) assert.equal(k in dto, false, k);
      for (const k of FORBIDDEN) assert.equal(k in dto.fulfillment, false, `fulfillment.${k}`);
    }
    // canonical management read still owns the receiving-based remainingQuantity — untouched
    const mgmt = await materialRequestService.getMaterialRequestById(mr.id);
    assert.equal(mgmt.status, 'APPROVED');
  });

  it('47. field surface is not a management facade: no reservation/stock/return routes under /mobile material paths', async (t) => {
    if (!ready(t)) return;
    const { createMobileMaterialRequestRouter } = await import('../src/modules/mobile-material-requests');
    const stack = (createMobileMaterialRequestRouter() as any).stack as any[];
    const routes = stack.map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).sort();
    assert.deepEqual(routes, [
      'GET /mobile/material-requests/:materialRequestId',
      'GET /mobile/work-orders/:workOrderId/material-items',
      'GET /mobile/work-orders/:workOrderId/material-requests',
      'POST /mobile/material-requests/:materialRequestId/cancel',
      'POST /mobile/work-orders/:workOrderId/material-requests',
      // PART 03: canonical STOCK_OUT usage — the only stock-affecting field command
      'POST /mobile/work-orders/:workOrderId/material-usages',
    ]);
  });

  it('48. OpenAPI documents the PART 02 contract', () => {
    const spec = parse(readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'));
    const p = spec.paths['/mobile/work-orders/{workOrderId}/material-items'].get;
    assert.equal(p.operationId, 'listMobileWorkOrderMaterialItems');
    assert.equal(p['x-required-permission'], 'material_request.field.read');
    assert.equal(p['x-building-scoped'], true);
    const s = spec.components.schemas;
    assert.deepEqual(Object.keys(s.MobileMaterialItem.properties).sort(), ['code', 'itemId', 'itemType', 'name', 'uom']);
    assert.deepEqual(Object.keys(s.MobileMaterialRequestFulfillment.properties).sort(), FULFILLMENT_KEYS);
    assert.ok(s.MobileMaterialRequest.required.includes('fulfillment'));
    assert.deepEqual(Object.keys(s.MobileMaterialReservation.properties).sort(), RESERVATION_KEYS);
    assert.deepEqual(Object.keys(s.MobileMaterialIssue.properties).sort(), ISSUE_KEYS);
    assert.deepEqual(s.MobileMaterialRequestDetail.allOf[1].required, ['reservations', 'issues']);
    const detail = spec.paths['/mobile/material-requests/{materialRequestId}'].get;
    assert.equal(
      detail.responses['200'].content['application/json'].schema.allOf[1].properties.data.$ref,
      '#/components/schemas/MobileMaterialRequestDetail',
    );
    assert.match(String(s.MobileMaterialRequestFulfillment.description), /NOT subtracted/);
    // PART 04 added the closed availableActions vocabulary to the request DTO
    assert.deepEqual(s.MobileMaterialRequestAvailableAction.enum, ['CANCEL_MATERIAL_REQUEST', 'RECORD_MATERIAL_USAGE']);
  });
});
