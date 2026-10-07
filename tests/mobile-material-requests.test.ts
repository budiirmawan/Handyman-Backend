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
import { purchaseRequestRepository, purchaseRequestService } from '../src/modules/purchase-requests';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { workOrderService } from '../src/modules/work-orders';
import { sha256Hex } from '../src/shared/hash';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-RN11-MATERIAL-FIELD-01 PART 01 — Work-Order-bound field material
 * requests: create / list / get / cancel, idempotent create, authority, read
 * model boundaries, non-effects, OpenAPI.
 */

const OP_KEY = 'createMobileWorkOrderMaterialRequest';
const FIELD_READ = { code: 'material_request.field.read', name: 'Read Field Material Requests' };
const FIELD_REQUEST = { code: 'material_request.field.request', name: 'Request Field Materials' };
const MANAGE = { code: 'material_request.manage', name: 'Manage Material Requests' };

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

async function newItem(f: Fixture) {
  return inventoryItemService.createInventoryItem({
    clientId: f.client.id, code: `ITM_${suffix()}`, name: 'Nut', itemType: 'MATERIAL', uomId: f.uomId,
  });
}

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

async function counts() {
  const q = async (t: string) =>
    Number((await pool!.query(`SELECT COUNT(*)::text AS n FROM ${t}`)).rows[0].n);
  return {
    balances: await q('inventory_stock_balances'),
    movements: await q('inventory_stock_movements'),
    reservations: await q('inventory_material_reservations'),
    usages: await q('inventory_work_order_material_usages'),
    bindings: await q('work_order_procurement_bindings'),
  };
}
async function eventCount(type: string, materialRequestId?: string) {
  const r = await pool!.query(
    `SELECT COUNT(*)::int AS n FROM operational_events
     WHERE event_type = $1 AND ($2::text IS NULL OR metadata->>'materialRequestId' = $2)`,
    [type, materialRequestId ?? null],
  );
  return r.rows[0].n as number;
}
async function idempotencyRows(key: string) {
  const r = await pool!.query(
    `SELECT * FROM request_idempotency_records WHERE operation_key = $1 AND idempotency_key_hash = $2`,
    [OP_KEY, sha256Hex(key)],
  );
  return r.rows;
}

// PART 02 added `fulfillment` (list + create + cancel); GET adds reservations/issues.
const DTO_KEYS = [
  'approvedQuantity', 'availableActions', 'createdAt', 'fulfillment', 'id', 'item', 'notes', 'purchaseRequestId',
  'purchaseRequestNumber', 'quantity', 'requestedByUserId', 'requiredDate', 'status',
  'uom', 'uomId', 'updatedAt', 'workOrderId',
].sort();

describe('PART 01 — multi-request create', () => {
  it('1-7. three requests on one Work Order share one field parent, no binding needed', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const before = await counts();
    const items = [f.item, await newItem(f), await newItem(f)];
    const created: any[] = [];
    for (const [i, item] of items.entries()) {
      const r = await create(f, { itemId: item.id, quantity: i + 1, uomId: f.uomId });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      created.push(r.body.data);
    }
    assert.equal(new Set(created.map((c) => c.id)).size, 3);
    assert.equal(new Set(created.map((c) => c.purchaseRequestId)).size, 1);
    const parent = await purchaseRequestRepository.findByWorkOrderId(f.wo.id);
    assert.equal(parent?.id, created[0].purchaseRequestId);
    assert.equal(parent?.requestType, 'MATERIAL');
    assert.match(created[0].purchaseRequestNumber, /^WOF_[A-F0-9]{8}$/);
    // first / second still intact
    const first = await get(created[0].id, f.worker.token);
    assert.equal(first.body.data.itemId, undefined);
    assert.equal(first.body.data.item.id, items[0].id);
    assert.equal(first.body.data.quantity, 1);
    const second = await get(created[1].id, f.worker.token);
    assert.equal(second.body.data.quantity, 2);
    // canonical rows
    const canon = await materialRequestService.getMaterialRequestById(created[2].id);
    assert.equal(canon.status, 'OPEN');
    assert.equal(canon.purchaseRequestId, parent!.id);
    // legacy binding untouched / not required
    const after = await counts();
    assert.equal(after.bindings, before.bindings);
  });

  it('7b. an existing legacy binding row is not overwritten by field requests', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const legacyPr = await purchaseRequestService.createPurchaseRequest({
      clientId: f.client.id, buildingId: f.building.id, requestNumber: `PRQ_${suffix()}`,
      requestType: 'MATERIAL', title: 'Legacy', requestedByUserId: f.worker.userId,
    });
    const legacyMr = await materialRequestService.createMaterialRequest({
      purchaseRequestId: legacyPr.id, itemId: f.item.id, quantity: 9, requestedByUserId: f.worker.userId,
    });
    const bind = await api()
      .post('/api/v1/work-order-procurement-bindings')
      .set(auth(f.worker.token))
      .send({ workOrderId: f.wo.id, purchaseRequestId: legacyPr.id, materialRequestId: legacyMr.id });
    assert.equal(bind.status, 201, JSON.stringify(bind.body));
    const r = await create(f, body(f));
    assert.equal(r.status, 201);
    const rows = await pool!.query(
      `SELECT purchase_request_id, material_request_id FROM work_order_procurement_bindings WHERE work_order_id = $1`,
      [f.wo.id],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].purchase_request_id, legacyPr.id);
    assert.equal(rows.rows[0].material_request_id, legacyMr.id);
    // list shows only the field request (legacy parent has no work_order_id)
    const l = await list(f);
    assert.deepEqual(l.body.data.materialRequests.map((x: any) => x.id), [r.body.data.id]);
  });
});

describe('PART 01 — create authority', () => {
  it('8, 14, 15. authorized field actor creates; requester/context server-derived', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const r = await create(f, body(f, { notes: '  urgent  ' }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body.data).sort(), DTO_KEYS);
    assert.equal(r.body.data.workOrderId, f.wo.id);
    assert.equal(r.body.data.requestedByUserId, f.worker.userId);
    assert.equal(r.body.data.status, 'OPEN');
    assert.equal(r.body.data.notes, 'urgent');
    assert.equal(r.body.data.uom.id, f.uomId);
    assert.equal(r.body.data.approvedQuantity, null);
    const canon = await materialRequestService.getMaterialRequestById(r.body.data.id);
    assert.equal(canon.clientId, f.client.id);
    assert.equal(canon.buildingId, f.building.id);
    assert.equal(canon.requestedByUserId, f.worker.userId);
  });

  it('9, 12. no field permission → 403; material_request.manage does not substitute', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const readOnly = await createSessionWithPermissions([FIELD_READ]);
    const r1 = await create(f, body(f), randomUUID(), readOnly);
    assert.equal(r1.status, 403);
    const manager = await createSessionWithPermissions([MANAGE, { code: 'inventory_stock.manage', name: 'x' }]);
    const r2 = await create(f, body(f), randomUUID(), manager);
    assert.equal(r2.status, 403);
    const r3 = await list(f, manager);
    assert.equal(r3.status, 403);
  });

  it('10. Building access failure → 403 BUILDING_ACCESS_DENIED (no key poisoning)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const outsider = await createAdminUser(); // full permissions, no Building assignment
    const key = randomUUID();
    const r = await create(f, body(f), key, outsider.token);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal((await idempotencyRows(key)).length, 0);
  });

  it('11. actor not field-authorized for the Work Order → denied', async (t) => {
    if (!ready(t)) return;
    const unassigned = await fixture({ assign: false });
    const r1 = await create(unassigned, body(unassigned));
    assert.equal(r1.status, 400);
    assert.equal(r1.body.error.code, 'WORK_ORDER_EXECUTION_NO_ASSIGNMENT');
    // assigned to someone else: other admin with building access but not the assignee
    const f = await fixture();
    const other = await createAdminUser();
    await buildingAssignmentService.createAssignment(other.userId, { buildingId: f.building.id });
    const r2 = await create(f, body(f), randomUUID(), other.token);
    assert.equal(r2.status, 403);
    assert.equal(r2.body.error.code, 'WORK_ORDER_EXECUTION_UNAUTHORIZED');
    // but the same user may READ (list) with building access
    const l = await list(f, other.token);
    assert.equal(l.status, 200);
  });

  it('13. authority fields in the body are rejected', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    for (const field of [
      'purchaseRequestId', 'workOrderId', 'clientId', 'buildingId', 'requestedByUserId',
      'status', 'approvedQuantity', 'approvedByUserId', 'approvedAt', 'warehouseId',
      'reservedQuantity', 'issuedQuantity', 'unitCost', 'currency', 'requiredDate',
    ]) {
      const key = randomUUID();
      const r = await create(f, body(f, { [field]: 'x' }), key);
      assert.equal(r.status, 400, field);
      assert.ok(r.body.error.details.some((d: any) => d.field === field), field);
      assert.equal((await idempotencyRows(key)).length, 0);
    }
  });
});

describe('PART 01 — validation & non-effects', () => {
  it('16-19. quantity, item scope, unknown/inactive item, UOM', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    for (const q of [0, -1, 'x', null]) {
      const r = await create(f, body(f, { quantity: q }));
      assert.equal(r.status, 400, String(q));
    }
    const otherClient = await clientService.createClient({ code: `C_${suffix()}`, name: 'Other' });
    const foreign = await inventoryItemService.createInventoryItem({
      clientId: otherClient.id, code: `ITM_${suffix()}`, name: 'Foreign', itemType: 'MATERIAL',
    });
    const r1 = await create(f, body(f, { itemId: foreign.id, uomId: null }));
    assert.equal(r1.status, 400);
    assert.equal(r1.body.error.code, 'MATERIAL_REQUEST_ITEM_CLIENT_MISMATCH');
    const r2 = await create(f, body(f, { itemId: randomUUID() }));
    assert.equal(r2.status, 404);
    assert.equal(r2.body.error.code, 'INVENTORY_ITEM_NOT_FOUND');
    // canonical BE-17B rule: an INACTIVE item is still accepted for demand
    // (no status gate exists in createMaterialRequest) — pinned, not invented.
    const inactive = await newItem(f);
    await pool!.query(`UPDATE inventory_items SET status = 'INACTIVE' WHERE id = $1`, [inactive.id]);
    const r3 = await create(f, body(f, { itemId: inactive.id }));
    assert.equal(r3.status, 201);
    // UOM mismatch / missing
    const r4 = await create(f, body(f, { uomId: randomUUID() }));
    assert.equal(r4.status, 400);
    assert.equal(r4.body.error.code, 'MATERIAL_REQUEST_ITEM_UOM_MISMATCH');
    const r5 = await create(f, body(f, { uomId: null }));
    assert.equal(r5.status, 400);
    assert.equal(r5.body.error.code, 'MATERIAL_REQUEST_ITEM_UOM_MISMATCH');
    const r6 = await create(f, { itemId: f.item.id, quantity: 1 });
    assert.equal(r6.status, 400);
  });

  it('20-22. create mutates no stock / reservation / usage; insufficient stock does not block', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await inventoryWarehouseService.createWarehouse({
      buildingId: f.building.id, code: `WH_${suffix()}`, name: 'WH',
    });
    const before = await counts();
    const r = await create(f, body(f, { quantity: 1000 })); // no stock at all
    assert.equal(r.status, 201);
    assert.deepEqual(await counts(), before);
  });
});

describe('PART 01 — idempotency', () => {
  it('23. missing Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const r = await api()
      .post(`/api/v1/mobile/work-orders/${f.wo.id}/material-requests`)
      .set(auth(f.worker.token))
      .send(body(f));
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  it('24-27, 33. replay returns same id, no duplicate row/event, raw key not stored', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const key = `field-${randomUUID()}`;
    const r1 = await create(f, body(f, { notes: 'a' }), key);
    assert.equal(r1.status, 201);
    const r2 = await create(f, body(f, { notes: 'a' }), key);
    assert.equal(r2.status, 201);
    assert.deepEqual(r2.body.data, r1.body.data);
    const rows = await pool!.query(
      `SELECT COUNT(*)::int AS n FROM material_requests mr JOIN purchase_requests pr ON pr.id = mr.purchase_request_id WHERE pr.work_order_id = $1`,
      [f.wo.id],
    );
    assert.equal(rows.rows[0].n, 1);
    assert.equal(await eventCount('WORK_ORDER_MATERIAL_REQUESTED', r1.body.data.id), 1);
    const idem = await idempotencyRows(key);
    assert.equal(idem.length, 1);
    assert.equal(idem[0].status, 'COMPLETED');
    assert.ok(!JSON.stringify(idem[0]).includes(key));
    const ev = await pool!.query(`SELECT metadata::text AS m FROM operational_events WHERE metadata->>'materialRequestId' = $1`, [r1.body.data.id]);
    assert.ok(!ev.rows[0].m.includes(key));
    assert.ok(!JSON.stringify(r2.body).includes(key));
  });

  it('28-31. changed item / quantity / notes / Work Order with same key → 409', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const key = randomUUID();
    const r1 = await create(f, body(f, { notes: 'n' }), key);
    assert.equal(r1.status, 201);
    const other = await newItem(f);
    for (const variant of [
      body(f, { notes: 'n', itemId: other.id }),
      body(f, { notes: 'n', quantity: 3 }),
      body(f, { notes: 'changed' }),
      body(f),
    ]) {
      const r = await create(f, variant, key);
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'IDEMPOTENCY_CONFLICT');
    }
    // same actor, same key, different Work Order (same building) → conflict
    const wo2 = await workOrderService.createWorkOrder({
      clientId: f.client.id, buildingId: f.building.id, workOrderNumber: `WO_${suffix()}`,
      title: 'WO2', workType: 'REPAIR', createdByUserId: f.worker.userId,
    });
    const a = await api().post(`/api/v1/work-orders/${wo2.id}/assignments`).set(auth(f.worker.token))
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: f.profile.id });
    assert.equal(a.status, 201);
    const r = await create(f, body(f, { notes: 'n' }), key, f.worker.token, wo2.id);
    assert.equal(r.status, 409);
    // still exactly one row
    const rows = await pool!.query(`SELECT COUNT(*)::int AS n FROM material_requests WHERE item_id = $1`, [f.item.id]);
    assert.equal(rows.rows[0].n, 1);
  });

  it('32. different actor, same key → independent namespace', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const key = randomUUID();
    const r1 = await create(f, body(f), key);
    assert.equal(r1.status, 201);
    // second actor: team assignment path — give WO a TEAM? simpler: reassign to a second worker.
    const w2 = await createAdminUser();
    await buildingAssignmentService.createAssignment(w2.userId, { buildingId: f.building.id });
    const org = (await pool!.query(`SELECT organization_id, department_id, position_id FROM workforce_profiles WHERE id = $1`, [f.profile.id])).rows[0];
    const p2 = await workforceService.createWorkforceProfile({
      organizationId: org.organization_id, departmentId: org.department_id, positionId: org.position_id,
      userId: w2.userId, employeeCode: `WF_${suffix()}`, fullName: 'Second',
    });
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({ workforceProfileId: p2.id, buildingId: f.building.id });
    const current = await api().get(`/api/v1/work-orders/${f.wo.id}/assignments/current`).set(auth(f.worker.token));
    assert.equal(current.status, 200);
    const re = await api().patch(`/api/v1/work-orders/${f.wo.id}/assignments/${current.body.data.id}`).set(auth(f.worker.token))
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: p2.id });
    assert.ok([200, 201].includes(re.status), JSON.stringify(re.body));
    const r2 = await create(f, body(f), key, w2.token);
    assert.equal(r2.status, 201, JSON.stringify(r2.body));
    assert.notEqual(r2.body.data.id, r1.body.data.id);
    assert.equal(r2.body.data.requestedByUserId, w2.userId);
  });

  it('34-35. validation failure does not poison key; business failure rolls back request + claim', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const key = randomUUID();
    const bad = await create(f, body(f, { quantity: -1 }), key);
    assert.equal(bad.status, 400);
    assert.equal((await idempotencyRows(key)).length, 0);
    const good = await create(f, body(f), key);
    assert.equal(good.status, 201);
    // business failure inside the transaction: item client mismatch is raised
    // AFTER the claim (inside work) → no request, no claim, no event.
    const otherClient = await clientService.createClient({ code: `C_${suffix()}`, name: 'Other' });
    const foreign = await inventoryItemService.createInventoryItem({
      clientId: otherClient.id, code: `ITM_${suffix()}`, name: 'Foreign', itemType: 'MATERIAL',
    });
    const key2 = randomUUID();
    const evBefore = await eventCount('WORK_ORDER_MATERIAL_REQUESTED');
    const r = await create(f, body(f, { itemId: foreign.id, uomId: null }), key2);
    assert.equal(r.status, 400);
    assert.equal((await idempotencyRows(key2)).length, 0);
    assert.equal(await eventCount('WORK_ORDER_MATERIAL_REQUESTED'), evBefore);
    const rows = await pool!.query(`SELECT COUNT(*)::int AS n FROM material_requests WHERE item_id = $1`, [foreign.id]);
    assert.equal(rows.rows[0].n, 0);
    // the key is reusable afterwards
    const ok = await create(f, body(f, { quantity: 5 }), key2);
    assert.equal(ok.status, 201);
  });
});

describe('PART 01 — read / list', () => {
  it('36-38, 43-44. list returns all rows of one WO only; no fabricated quantities', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const items = [f.item, await newItem(f), await newItem(f)];
    const ids: string[] = [];
    for (const item of items) {
      const r = await create(f, body(f, { itemId: item.id }));
      assert.equal(r.status, 201);
      ids.push(r.body.data.id);
    }
    const other = await fixture(); // different WO / building
    const ro = await create(other, body(other));
    assert.equal(ro.status, 201);
    const l = await list(f);
    assert.equal(l.status, 200);
    assert.deepEqual(l.body.data.materialRequests.map((x: any) => x.id), ids);
    for (const row of l.body.data.materialRequests) {
      assert.deepEqual(Object.keys(row).sort(), DTO_KEYS);
      for (const k of ['remainingQuantity', 'receivedQuantity', 'reservedQuantity', 'issuedQuantity', 'usedQuantity', 'returnedQuantity', 'availableQuantity', 'quantityOnHand']) {
        assert.equal(k in row, false, k);
      }
    }
    const lo = await list(other);
    assert.deepEqual(lo.body.data.materialRequests.map((x: any) => x.id), [ro.body.data.id]);
  });

  it('39-42. get by id: canonical DTO; management MR hidden; cross-Building & no-permission denied', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const r = await create(f, body(f, { notes: 'x' }));
    const g = await get(r.body.data.id, f.worker.token);
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.data, { ...r.body.data, reservations: [], issues: [] });
    assert.equal('remainingQuantity' in g.body.data, false);
    // management-created MR (parent without work_order_id) is not a field request
    const pr = await purchaseRequestService.createPurchaseRequest({
      clientId: f.client.id, buildingId: f.building.id, requestNumber: `PRQ_${suffix()}`,
      requestType: 'MATERIAL', title: 'Mgmt', requestedByUserId: f.worker.userId,
    });
    const mgmt = await materialRequestService.createMaterialRequest({
      purchaseRequestId: pr.id, itemId: f.item.id, quantity: 1, requestedByUserId: f.worker.userId,
    });
    const hidden = await get(mgmt.id, f.worker.token);
    assert.equal(hidden.status, 404);
    assert.equal(hidden.body.error.code, 'MATERIAL_REQUEST_NOT_FOUND');
    const c = await cancel(mgmt.id, f.worker.token);
    assert.equal(c.status, 404);
    // cross-building
    const stranger = await createAdminUser();
    const x = await get(r.body.data.id, stranger.token);
    assert.equal(x.status, 403);
    assert.equal(x.body.error.code, 'BUILDING_ACCESS_DENIED');
    const xl = await list(f, stranger.token);
    assert.equal(xl.status, 403);
    // no field read permission
    const none = await createSessionWithPermissions([MANAGE]);
    const n = await get(r.body.data.id, none);
    assert.equal(n.status, 403);
    // unknown id
    const u = await get(randomUUID(), f.worker.token);
    assert.equal(u.status, 404);
  });
});

describe('PART 01 — cancel', () => {
  it('45-46, 48, 50-53. OPEN → CANCELLED; repeat rejected; GET reconciles; no stock effect', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const r = await create(f, body(f));
    const before = await counts();
    const c = await cancel(r.body.data.id, f.worker.token);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.data.status, 'CANCELLED');
    assert.deepEqual(Object.keys(c.body.data).sort(), DTO_KEYS);
    assert.equal(await eventCount('WORK_ORDER_MATERIAL_REQUEST_CANCELLED', r.body.data.id), 1);
    const again = await cancel(r.body.data.id, f.worker.token);
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'MATERIAL_REQUEST_NOT_OPEN');
    const g = await get(r.body.data.id, f.worker.token);
    assert.equal(g.body.data.status, 'CANCELLED');
    assert.deepEqual(await counts(), before);
    const canon = await materialRequestService.getMaterialRequestById(r.body.data.id);
    assert.equal(canon.status, 'CANCELLED');
  });

  it('47. APPROVED field request cannot be field-cancelled (management may)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const r = await create(f, body(f));
    const bind = await api().post('/api/v1/procurement-approvals').set(auth(f.worker.token)).send({
      requestType: 'MATERIAL_REQUEST', requestId: r.body.data.id,
      approvalType: 'BUDGET_APPROVAL', approverUserId: f.worker.userId,
    });
    assert.equal(bind.status, 201, JSON.stringify(bind.body));
    const dec = await api().post(`/api/v1/procurement-approvals/${bind.body.data.id}/approve`).set(auth(f.worker.token)).send({});
    assert.equal(dec.status, 200);
    const g = await get(r.body.data.id, f.worker.token);
    assert.equal(g.body.data.status, 'APPROVED');
    assert.equal(g.body.data.approvedQuantity, 2);
    const c = await cancel(r.body.data.id, f.worker.token);
    assert.equal(c.status, 400);
    assert.equal(c.body.error.code, 'MATERIAL_REQUEST_NOT_OPEN');
  });

  it('49, 52. an ACTIVE reservation blocks field cancel and is never released', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const r = await create(f, body(f));
    const wh = await inventoryWarehouseService.createWarehouse({
      buildingId: f.building.id, code: `WH_${suffix()}`, name: 'WH',
    });
    // Force the guard condition directly (a reservation normally requires
    // APPROVED, which is already refused by 47): prove the reservation guard
    // is not bypassed by the field route.
    await pool!.query(
      `INSERT INTO inventory_material_reservations
         (id, client_id, building_id, material_request_id, warehouse_id, item_id, uom_id,
          reserved_quantity, status, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'ACTIVE', $8)`,
      [randomUUID(), f.client.id, f.building.id, r.body.data.id, wh.id, f.item.id, f.uomId, f.worker.userId],
    );
    const c = await cancel(r.body.data.id, f.worker.token);
    assert.equal(c.status, 409);
    assert.equal(c.body.error.code, 'MATERIAL_REQUEST_ACTIVE_RESERVATION');
    const res = await pool!.query(`SELECT status FROM inventory_material_reservations WHERE material_request_id = $1`, [r.body.data.id]);
    assert.equal(res.rows[0].status, 'ACTIVE');
    const g = await get(r.body.data.id, f.worker.token);
    assert.equal(g.body.data.status, 'OPEN');
  });

  it('cancel authority: not the field actor → denied; read-only permission → 403', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const r = await create(f, body(f));
    const other = await createAdminUser();
    await buildingAssignmentService.createAssignment(other.userId, { buildingId: f.building.id });
    const c = await cancel(r.body.data.id, other.token);
    assert.equal(c.status, 403);
    assert.equal(c.body.error.code, 'WORK_ORDER_EXECUTION_UNAUTHORIZED');
    const ro = await createSessionWithPermissions([FIELD_READ]);
    const c2 = await cancel(r.body.data.id, ro);
    assert.equal(c2.status, 403);
  });
});

describe('PART 01 — contract', () => {
  it('OpenAPI documents the four mobile routes with field permissions and idempotency', () => {
    const spec = parse(readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8')) as any;
    const listOp = spec.paths['/mobile/work-orders/{workOrderId}/material-requests'].get;
    const createOp = spec.paths['/mobile/work-orders/{workOrderId}/material-requests'].post;
    const getOp = spec.paths['/mobile/material-requests/{materialRequestId}'].get;
    const cancelOp = spec.paths['/mobile/material-requests/{materialRequestId}/cancel'].post;
    assert.equal(listOp.operationId, 'listMobileWorkOrderMaterialRequests');
    assert.equal(createOp.operationId, 'createMobileWorkOrderMaterialRequest');
    assert.equal(getOp.operationId, 'getMobileMaterialRequest');
    assert.equal(cancelOp.operationId, 'cancelMobileMaterialRequest');
    assert.equal(listOp['x-required-permission'], 'material_request.field.read');
    assert.equal(getOp['x-required-permission'], 'material_request.field.read');
    assert.equal(createOp['x-required-permission'], 'material_request.field.request');
    assert.equal(cancelOp['x-required-permission'], 'material_request.field.request');
    assert.ok(createOp.parameters.some((p: any) => p.$ref === '#/components/parameters/RequestIdempotencyKeyHeader'));
    assert.ok(createOp.responses['409']);
    assert.match(createOp.description, /IDEMPOTENCY_CONFLICT/);
    assert.match(cancelOp.description, /GET \/mobile\/material-requests\/\{materialRequestId\}/);
    const schema = spec.components.schemas.MobileMaterialRequest;
    assert.deepEqual([...schema.required].sort(), DTO_KEYS);
    for (const k of ['remainingQuantity', 'reservedQuantity', 'issuedQuantity']) {
      assert.equal(k in schema.properties, false, k);
    }
    const createSchema = spec.components.schemas.MobileMaterialRequestCreate;
    assert.equal(createSchema.additionalProperties, false);
    assert.deepEqual(createSchema.required, ['itemId', 'quantity', 'uomId']);
    for (const op of [listOp, createOp, getOp, cancelOp]) {
      assert.deepEqual(op.security, [{ bearerAuth: [] }]);
    }
  });

  it('seed declares the two field permissions; no management route re-exposed under /mobile', () => {
    const seed = readFileSync(resolve(__dirname, '../src/database/seeds/foundation-access.seed.ts'), 'utf8');
    assert.ok(seed.includes("'material_request.field.read'"));
    assert.ok(seed.includes("'material_request.field.request'"));
    const routes = readFileSync(resolve(__dirname, '../src/modules/mobile-material-requests/mobile-material-request.routes.ts'), 'utf8');
    assert.equal(/material_request\.manage|inventory_stock\.manage|purchase_request\.manage|wo_procurement\.manage/.test(routes), false);
    // PART 03 added the canonical field usage command (material-usages) with its
    // own field permission; reservation / stock-movement management stays absent.
    assert.equal(/reservations|stock-movements/.test(routes), false);
    assert.ok(routes.includes("'material_usage.field.record'"));
  });
});
