import { roleService } from '../src/modules/roles';
import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { inventoryItemService } from '../src/modules/inventory-items';
import { inventoryWarehouseService } from '../src/modules/inventory-warehouses';
import { materialRequestService } from '../src/modules/material-requests';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import {
  createAdminUser,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** CR-HM-SEC-03 PART 03: reservation boundaries; existing isolated PostgreSQL fixture pattern. */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let ownerToken = '';
let ownerUserId = '';
let postgres: EmbeddedPostgres | null = null;

const PORT = 55587;
let dataDir: string | undefined;
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

before(async () => {
  if (EMBEDDED) {
    dataDir = await mkdtemp(join(tmpdir(), 'asentra-hm-sec03-reservation-'));
    postgres = new EmbeddedPostgres({
      databaseDir: dataDir,
      port: PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const setup = postgres.getPgClient('postgres', '127.0.0.1');
    await setup.connect();
    await setup.query('CREATE DATABASE asentra_test');
    await setup.end();
  }

  const db = await ensureTestDatabase();
  if (!db) return;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE inventory_material_reservations,
            inventory_work_order_material_usages,
            inventory_stock_adjustments,
            inventory_stock_movements,
            inventory_stock_balances,
            material_requests,
            purchase_requests,
            operational_events,
            units_of_measure,
            inventory_items,
            inventory_warehouses,
            functional_locations,
            users, roles, permissions, clients, properties, buildings CASCADE`,
  );

  const owner = await createAdminUser();
  ownerToken = owner.token;
  ownerUserId = owner.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
  if (postgres) {
    await postgres.stop().catch(() => undefined);
    postgres = null;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function fixture(options: {
  requestedQuantity?: number;
  approvedQuantity?: number;
  stockQuantity?: number;
  targetWarehouse?: boolean;
} = {}) {
  const requestedQuantity = options.requestedQuantity ?? 10;
  const approvedQuantity = options.approvedQuantity ?? requestedQuantity;
  const stockQuantity = options.stockQuantity ?? 20;

  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Reservation Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Reservation Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Reservation Building',
  });
  await buildingAssignmentService.createAssignment(ownerUserId, {
    buildingId: building.id,
  });

  const purchaseRequest = await purchaseRequestService.createPurchaseRequest({
    clientId: client.id,
    buildingId: building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: 'MATERIAL',
    title: 'Reservation Purchase Request',
    requestedByUserId: ownerUserId,
  });
  const item = await inventoryItemService.createInventoryItem({
    clientId: client.id,
    code: `ITM_${suffix()}`,
    name: 'Reservation Item',
    itemType: 'MATERIAL',
  });
  const warehouse = await inventoryWarehouseService.createWarehouse({
    buildingId: building.id,
    code: `WH_${suffix()}`,
    name: 'Reservation Warehouse',
  });
  const materialRequest = await materialRequestService.createMaterialRequest({
    purchaseRequestId: purchaseRequest.id,
    itemId: item.id,
    quantity: requestedQuantity,
    ...(options.targetWarehouse ? { warehouseId: warehouse.id } : {}),
    requestedByUserId: ownerUserId,
  });

  if (stockQuantity > 0) {
    const stockIn = await api()
      .post(`/api/v1/warehouses/${warehouse.id}/stock-movements`)
      .set(auth(ownerToken))
      .send({
        itemId: item.id,
        movementType: 'STOCK_IN',
        quantity: stockQuantity,
      });
    assert.equal(stockIn.status, 201, JSON.stringify(stockIn.body));
  }

  return {
    client,
    property,
    building,
    purchaseRequest,
    item,
    warehouse,
    materialRequest,
    requestedQuantity,
    approvedQuantity,
    stockQuantity,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function approveMaterialRequest(
  materialRequestId: string,
  approvedQuantity?: number,
): Promise<void> {
  const binding = await api()
    .post('/api/v1/procurement-approvals')
    .set(auth(ownerToken))
    .send({
      requestType: 'MATERIAL_REQUEST',
      requestId: materialRequestId,
      approvalType: 'BUDGET_APPROVAL',
      approverUserId: ownerUserId,
    });
  assert.equal(binding.status, 201, JSON.stringify(binding.body));

  const decision = await api()
    .post(`/api/v1/procurement-approvals/${binding.body.data.id}/approve`)
    .set(auth(ownerToken))
    .send(approvedQuantity === undefined ? {} : { approvedQuantity });
  assert.equal(decision.status, 200, JSON.stringify(decision.body));
}

async function reserve(
  f: Fixture,
  quantity: number,
  token = ownerToken,
  overrides: Record<string, unknown> = {},
) {
  return api()
    .post(`/api/v1/material-requests/${f.materialRequest.id}/reservations`)
    .set(auth(token))
    .send({
      warehouseId: f.warehouse.id,
      quantity,
      ...overrides,
    });
}

function normalized(body: any) { const { requestId, ...error } = body.error; return { ...body, error }; }
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ['material_requests', 'inventory_material_reservations', 'inventory_stock_balances', 'inventory_stock_movements', 'operational_events']) result[table] = (await pool!.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
  return result;
}
const detail = (id: string, token: string, op: string) => op === 'get' ? api().get(`/api/v1/material-reservations/${id}`).set(auth(token)) : api().post(`/api/v1/material-reservations/${id}/${op}`).set(auth(token)).send({});
const nested = (id: string, token: string, op: string, warehouseId: string) => op === 'get' ? api().get(`/api/v1/material-requests/${id}/reservations`).set(auth(token)) : api().post(`/api/v1/material-requests/${id}/reservations`).set(auth(token)).send({warehouseId, quantity: 1});
describe('SEC-03 reservation parity', () => {
  it('all five boundaries hide sibling, foreign, permission-only and platform-admin IDs without mutation', async t => {
    if (!ready(t)) return;
    const f = await fixture(); await approveMaterialRequest(f.materialRequest.id);
    const made = await reserve(f, 2); assert.equal(made.status, 201);
    const foreign = await fixture();
    const sibling = await buildingService.createBuilding({ propertyId: f.property.id, code: `B_${suffix()}`, name: 'Sibling' });
    const siblingActor = await createAdminUser(); await buildingAssignmentService.createAssignment(siblingActor.userId, { buildingId: sibling.id });
    const foreignActor = await createAdminUser(); await buildingAssignmentService.createAssignment(foreignActor.userId, { buildingId: foreign.building.id });
    const platform = await createAdminUser(); const role = await roleService.createRole({code: 'PLATFORM_ADMIN', name: 'Platform Admin'}); await roleService.assignRoleToUser(platform.userId, role.id);
    const permissionOnly = await createSessionWithPermissions([{code:'inventory_stock.read',name:'Read'}, {code:'inventory_stock.manage',name:'Manage'}]);
    for (const token of [siblingActor.token, foreignActor.token, platform.token, permissionOnly]) {
      const before = await snapshot();
      for (const op of ['get', 'release', 'cancel']) {
        const hidden = await detail(made.body.data.id, token, op); const missing = await detail(randomUUID(), token, op);
        assert.equal(hidden.status, 404, JSON.stringify(hidden.body)); assert.equal(missing.status, 404); assert.deepEqual(normalized(hidden.body), normalized(missing.body));
      }
      for (const op of ['get', 'post']) {
        const hidden = await nested(f.materialRequest.id, token, op, f.warehouse.id); const missing = await nested(randomUUID(), token, op, f.warehouse.id);
        assert.equal(hidden.status, 404, JSON.stringify(hidden.body)); assert.equal(missing.status, 404); assert.deepEqual(normalized(hidden.body), normalized(missing.body));
      }
      assert.deepEqual(await snapshot(), before);
    }
  });
  for (const kind of ['reservationClient', 'reservationBuilding', 'reservationItem', 'reservationWarehouse', 'parentClient', 'mrItem', 'mrWarehouse']) {
    it(`fails closed on ${kind} corruption with zero stock/audit mutation`, async t => {
      if (!ready(t)) return;
      const f = await fixture(); const other = await fixture(); await approveMaterialRequest(f.materialRequest.id);
      const made = await reserve(f, 2); assert.equal(made.status, 201);
      const id = made.body.data.id;
      const changes: Record<string, [string, string, string, string]> = {
        reservationClient: ['inventory_material_reservations', 'client_id', id, other.client.id],
        reservationBuilding: ['inventory_material_reservations', 'building_id', id, other.building.id],
        reservationItem: ['inventory_material_reservations', 'item_id', id, other.item.id],
        reservationWarehouse: ['inventory_material_reservations', 'warehouse_id', id, other.warehouse.id],
        parentClient: ['purchase_requests', 'client_id', f.purchaseRequest.id, other.client.id],
        mrItem: ['material_requests', 'item_id', f.materialRequest.id, other.item.id],
        mrWarehouse: ['material_requests', 'warehouse_id', f.materialRequest.id, other.warehouse.id],
      };
      const [table, column, target, value] = changes[kind]; await pool!.query(`UPDATE ${table} SET ${column}=$2 WHERE id=$1`, [target, value]);
      const before = await snapshot();
      for (const op of ['get', 'release', 'cancel']) {
        const hidden = await detail(id, ownerToken, op); const missing = await detail(randomUUID(), ownerToken, op);
        assert.equal(hidden.status, 404, JSON.stringify(hidden.body)); assert.deepEqual(normalized(hidden.body), normalized(missing.body));
      }
      const listed = await nested(f.materialRequest.id, ownerToken, 'get', f.warehouse.id);
      if (kind.startsWith('reservation')) { assert.equal(listed.status, 200); assert.deepEqual(listed.body.data, []); }
      else { assert.equal(listed.status, 404); assert.equal((await reserve(f, 1)).status, 404); }
      assert.deepEqual(await snapshot(), before);
    });
  }
});
describe('SEC-03 reservation projection/input guards', () => {
  it('does not call global enriched details for hidden resources', async t => {
    if (!ready(t)) return;
    const f = await fixture(); await approveMaterialRequest(f.materialRequest.id); const made = await reserve(f, 2);
    const outsider = await createAdminUser();
    const { inventoryMaterialReservationRepository: repo } = await import('../src/modules/inventory-material-reservations/inventory-material-reservation.repository');
    const original = repo.findByIdWithDetails;
    repo.findByIdWithDetails = async () => { throw new Error('global enriched lookup forbidden'); };
    try { for (const op of ['get','release','cancel']) assert.equal((await detail(made.body.data.id, outsider.token, op)).status, 404); }
    finally { repo.findByIdWithDetails = original; }
  });
  it('hidden warehouse/input IDs match missing IDs and cannot allocate stock', async t => {
    if (!ready(t)) return;
    const f = await fixture(); const other = await fixture(); await approveMaterialRequest(f.materialRequest.id);
    const actor = await createAdminUser(); await buildingAssignmentService.createAssignment(actor.userId, {buildingId:f.building.id});
    const before = await snapshot();
    for (const [field, id] of [['warehouseId',other.warehouse.id], ['itemId',other.item.id]]) {
      const hidden = await reserve(f, 1, actor.token, {[field]:id}); const missing = await reserve(f, 1, actor.token, {[field]:randomUUID()});
      assert.equal(hidden.status, 404); assert.equal(missing.status, 404); assert.deepEqual(normalized(hidden.body), normalized(missing.body));
    }
    assert.deepEqual(await snapshot(), before);
  });
});
it('SEC-03 release keeps MR → reservation → stock lock ordering', async t => {
  if (!ready(t)) return;
  const f = await fixture(); await approveMaterialRequest(f.materialRequest.id); const made = await reserve(f, 2);
  const { materialRequestRepository: mr } = await import('../src/modules/material-requests');
  const { inventoryMaterialReservationRepository: reservations } = await import('../src/modules/inventory-material-reservations/inventory-material-reservation.repository');
  const source = mr.findByIdInScope; const allocation = reservations.findByIdInScope; const balanceLock = reservations.findBalanceForUpdate;
  const calls: string[] = [];
  mr.findByIdInScope = async (...args) => { if (args[2]) calls.push('MR'); return source(...args); };
  reservations.findByIdInScope = async (...args) => { if (args[2]) calls.push('reservation'); return allocation(...args); };
  reservations.findBalanceForUpdate = async (...args) => { calls.push('stock'); return balanceLock(...args); };
  try { assert.equal((await detail(made.body.data.id, ownerToken, 'release')).status, 200); assert.deepEqual(calls, ['MR','reservation','stock']); }
  finally { mr.findByIdInScope = source; reservations.findByIdInScope = allocation; reservations.findBalanceForUpdate = balanceLock; }
});

it('SEC-03 empty scopes cannot fall back to global reservation queries', async t => {
  if (!ready(t)) return;
  const { inventoryMaterialReservationRepository: repo } = await import('../src/modules/inventory-material-reservations/inventory-material-reservation.repository');
  const original = pool!.query;
  pool!.query = (() => { throw new Error('no database query allowed for empty scope'); }) as typeof original;
  try {
    assert.equal(await repo.findByIdInScope(randomUUID(), []), null);
    assert.equal(await repo.findByIdWithDetailsInScope(randomUUID(), []), null);
    assert.deepEqual(await repo.listByMaterialRequestInScope({materialRequestId:randomUUID()}, []), []);
  } finally { pool!.query = original; }
});
