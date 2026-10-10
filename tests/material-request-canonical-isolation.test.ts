import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { sessionService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { inventoryItemService } from '../src/modules/inventory-items';
import { inventoryWarehouseService } from '../src/modules/inventory-warehouses';
import { materialRequestRepository, materialRequestService } from '../src/modules/material-requests';
import type { PublicMaterialRequest } from '../src/modules/material-requests';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { roleService } from '../src/modules/roles';
import { createAdminUser, createPlainSession, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** CR-HM-SEC-03 PART 02: canonical parent/detail/list/mutation boundaries.
 * Boundary regressions must fail against 85ba9ad, without relying on
 * malformed data. Corruption fixtures separately exercise fail-closed reads.
 * Uses the existing opt-in embedded-postgres + ensureTestDatabase pattern.
 */
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55585;
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
let pool: Pool | null = null;
let postgres: EmbeddedPostgres | null = null;
let dataDir: string | undefined;
let owner: { token: string; userId: string };
let reader: { token: string; userId: string };
let multi: { token: string; userId: string };
let unassigned: { token: string; userId: string };
let plain: { token: string; userId: string };
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function readActor() {
  const token = await createSessionWithPermissions([
    { code: 'material_request.read', name: 'Read Material Requests' },
    { code: 'material_request.manage', name: 'Manage Material Requests' },
  ]);
  return { token, userId: (await sessionService.resolveSessionContext(token)).userId };
}
before(async () => {
  if (EMBEDDED) {
    dataDir = await mkdtemp(join(tmpdir(), 'asentra-hm-sec03-canonical-'));
    postgres = new EmbeddedPostgres({
      databaseDir: dataDir, port: PORT, user: 'postgres', password: '',
      persistent: true, authMethod: 'trust', onLog: () => undefined,
    });
    await postgres.initialise();
    await postgres.start();
  }
  const db = await ensureTestDatabase();
  if (!db) {
    assert.ok(!EMBEDDED, 'requested embedded database must be available, not skipped');
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE material_requests, purchase_requests, inventory_items, inventory_warehouses, users, roles, permissions, clients, properties, buildings CASCADE');
  owner = await createAdminUser();
  reader = await readActor();
  multi = await readActor();
  unassigned = await readActor();
  const plainToken = await createPlainSession();
  plain = { token: plainToken, userId: (await sessionService.resolveSessionContext(plainToken)).userId };
  const platformRole = await roleService.createRole({ code: 'PLATFORM_ADMIN', name: 'Platform Admin' });
  await roleService.assignRoleToUser(owner.userId, platformRole.id);
});
after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    pool = null;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
});
function ready(t: TestContext): boolean {
  if (!pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

async function fixture() {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Shared Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const buildings = [];
  for (const name of ['A', 'B', 'C']) {
    buildings.push(await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name }));
  }
  const [a, b, c] = buildings;
  await buildingAssignmentService.createAssignment(reader.userId, { buildingId: a.id });
  for (const building of [a, b]) {
    await buildingAssignmentService.createAssignment(multi.userId, { buildingId: building.id });
  }
  await buildingAssignmentService.createAssignment(owner.userId, { buildingId: a.id });
  const foreignClient = await clientService.createClient({ code: `F_${suffix()}`, name: 'Foreign Client' });
  const foreignProperty = await propertyService.createProperty({ clientId: foreignClient.id, code: `P_${suffix()}`, name: 'Foreign Property' });
  const d = await buildingService.createBuilding({ propertyId: foreignProperty.id, code: `B_${suffix()}`, name: 'D' });
  const item = await inventoryItemService.createInventoryItem({ clientId: client.id, code: `I_${suffix()}`, name: 'Shared Item', itemType: 'MATERIAL' });
  const emptyItem = await inventoryItemService.createInventoryItem({ clientId: client.id, code: `E_${suffix()}`, name: 'Empty Item', itemType: 'MATERIAL' });
  const foreignItem = await inventoryItemService.createInventoryItem({ clientId: foreignClient.id, code: `F_${suffix()}`, name: 'Foreign Item', itemType: 'MATERIAL' });
  const warehouses = [];
  for (const building of [a, b, d]) {
    warehouses.push(await inventoryWarehouseService.createWarehouse({ buildingId: building.id, code: `W_${suffix()}`, name: 'Warehouse' }));
  }
  const prs = [];
  const rows: PublicMaterialRequest[] = [];
  for (const [index, building] of [a, b, c].entries()) {
    const pr = await purchaseRequestService.createPurchaseRequest({
      clientId: client.id, buildingId: building.id, requestNumber: `PR_${suffix()}`,
      requestType: 'MATERIAL', title: `Demand ${index}`, requestedByUserId: owner.userId,
    });
    prs.push(pr);
    const row = await materialRequestService.createMaterialRequest({
      purchaseRequestId: pr.id, itemId: item.id, requestedByUserId: owner.userId,
      quantity: (index + 1) * 111.125, notes: `private-${index}-${suffix()}`,
      ...(index === 0 ? { warehouseId: warehouses[0].id } : {}),
    });
    const createdAt = new Date(`2031-01-0${3 - index}T01:02:03Z`).toISOString();
    const updatedAt = new Date(`2032-02-0${3 - index}T04:05:06Z`).toISOString();
    await pool!.query('UPDATE material_requests SET created_at = $2, updated_at = $3 WHERE id = $1', [row.id, createdAt, updatedAt]);
    rows.push({ ...row, createdAt, updatedAt });
  }
  const foreignPr = await purchaseRequestService.createPurchaseRequest({ clientId: foreignClient.id, buildingId: d.id, requestNumber: `PR_${suffix()}`, requestType: 'MATERIAL', title: 'Foreign demand', requestedByUserId: owner.userId });
  const foreignRow = await materialRequestService.createMaterialRequest({ purchaseRequestId: foreignPr.id, itemId: foreignItem.id, warehouseId: warehouses[2].id, quantity: 888.125, notes: `foreign-secret-${suffix()}`, requestedByUserId: owner.userId });
  return { client, foreignClient, a, b, c, d, item, emptyItem, foreignItem, foreignPr, foreignRow, warehouses, prs, rows };
}
function expectRows(response: { status: number; body: unknown }, expected: PublicMaterialRequest[], hidden: PublicMaterialRequest[] = []) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  // Exact whole-envelope equality excludes hidden counts, nested references,
  // notes, quantities, timestamps and arbitrary metadata, not just building IDs.
  assert.deepEqual(response.body, { success: true, data: expected, meta: {} });
  const serialized = JSON.stringify(response.body);
  for (const row of hidden) {
    for (const secret of [row.id, row.notes, String(row.quantity), row.updatedAt]) {
      assert.ok(secret && !serialized.includes(secret), `hidden value leaked: ${secret}`);
    }
  }
}
function withoutRequestId(body: Record<string, any>) {
  const { requestId: _requestId, ...error } = body.error;
  return { ...body, error };
}

const mrPath = (id: string) => `/api/v1/material-requests/${id}`;
const prPath = (id: string) => `/api/v1/purchase-requests/${id}/material-requests`;
const buildingPath = (id: string) => `/api/v1/buildings/${id}/material-requests`;
async function deniedEquivalent(hidden: string, missing: string, token: string, kind: 'get' | 'patch' | 'cancel' | 'create') {
  const request = (path: string) => kind === 'patch' ? api().patch(path).set(auth(token)).send({ quantity: 9, notes: 'unauthorized' }) : kind === 'cancel' ? api().post(`${path}/cancel`).set(auth(token)).send({}) : kind === 'create' ? api().post(path).set(auth(token)).send({ itemId: randomUUID(), quantity: 1 }) : api().get(path).set(auth(token));
  const [a, b] = await Promise.all([request(hidden), request(missing)]);
  assert.equal(a.status, 404, JSON.stringify(a.body));
  assert.equal(b.status, 404, JSON.stringify(b.body));
  assert.deepEqual(withoutRequestId(a.body), withoutRequestId(b.body));
}
describe('Canonical MR scoped boundaries', { concurrency: false }, () => {
  it('hides sibling/cross-client resources uniformly before enrichment and performs zero writes', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const before = (await pool!.query('SELECT * FROM material_requests ORDER BY id')).rows;
    for (const token of [reader.token, unassigned.token, owner.token]) {
      for (const row of [f.rows[1], f.foreignRow]) {
        for (const kind of ['get', 'patch', 'cancel'] as const) await deniedEquivalent(mrPath(row.id), mrPath(randomUUID()), token, kind);
      }
      for (const pr of [f.prs[1], f.foreignPr]) {
        for (const kind of ['get', 'create'] as const) await deniedEquivalent(prPath(pr.id), prPath(randomUUID()), token, kind);
      }
    }
    assert.deepEqual((await pool!.query('SELECT * FROM material_requests ORDER BY id')).rows, before);
  });
  it('scopes before global enriched lookups and preserves explicit building access semantics', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const detail = materialRequestRepository.findByIdWithDetails;
    const quantity = materialRequestRepository.sumReceivedQuantity;
    const parent = purchaseRequestService.getPurchaseRequestById;
    materialRequestRepository.findByIdWithDetails = async () => { throw new Error('global enrichment must not run'); };
    materialRequestRepository.sumReceivedQuantity = async () => { throw new Error('unauthorized fulfilment lookup'); };
    purchaseRequestService.getPurchaseRequestById = async () => { throw new Error('global parent enrichment'); };
    try {
      await deniedEquivalent(mrPath(f.rows[1].id), mrPath(randomUUID()), reader.token, 'get');
      await deniedEquivalent(prPath(f.prs[1].id), prPath(randomUUID()), reader.token, 'get');
    } finally {
      materialRequestRepository.findByIdWithDetails = detail;
      materialRequestRepository.sumReceivedQuantity = quantity;
      purchaseRequestService.getPurchaseRequestById = parent;
    }
    for (const id of [f.b.id, f.d.id, randomUUID()]) {
      const res = await api().get(buildingPath(id)).set(auth(reader.token));
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'BUILDING_ACCESS_DENIED');
    }
    expectRows(await api().get(buildingPath(f.a.id)).set(auth(reader.token)), [f.rows[0]], [f.rows[1], f.foreignRow]);
    expectRows(await api().get(prPath(f.prs[1].id)).set(auth(multi.token)), [f.rows[1]], [f.rows[0], f.foreignRow]);
  });
  it('hides inaccessible item and warehouse input references like missing references', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    for (const field of ['itemId', 'warehouseId'] as const) {
      const ids = field === 'itemId' ? [f.foreignItem.id, randomUUID()] : [f.warehouses[1].id, f.warehouses[2].id, randomUUID()];
      const results = [];
      for (const id of ids) results.push(await api().post(prPath(f.prs[0].id)).set(auth(reader.token)).send({ itemId: f.item.id, quantity: 1, [field]: id }));
      for (const res of results) { assert.equal(res.status, 404, JSON.stringify(res.body)); assert.deepEqual(withoutRequestId(res.body), withoutRequestId(results.at(-1)!.body)); }
    }
    const before = await materialRequestRepository.findById(f.rows[0].id);
    const hidden = await api().patch(mrPath(f.rows[0].id)).set(auth(reader.token)).send({ warehouseId: f.warehouses[1].id });
    const missing = await api().patch(mrPath(f.rows[0].id)).set(auth(reader.token)).send({ warehouseId: randomUUID() });
    assert.equal(hidden.status, 404); assert.deepEqual(withoutRequestId(hidden.body), withoutRequestId(missing.body));
    assert.deepEqual(await materialRequestRepository.findById(f.rows[0].id), before);
  });
  for (const corruption of ['parentSibling', 'parentClient', 'mrClient', 'itemClient', 'warehouseSibling', 'warehouseClient'] as const) {
    it(`fails closed on ${corruption} without mutation across detail and lists`, async (t) => {
      if (!ready(t)) return;
      const f = await fixture(); const row = f.rows[0];
      if (corruption === 'parentSibling') await pool!.query('UPDATE material_requests SET purchase_request_id=$2 WHERE id=$1', [row.id, f.prs[1].id]);
      if (corruption === 'parentClient') await pool!.query('UPDATE purchase_requests SET client_id=$2 WHERE id=$1', [f.prs[0].id, f.foreignClient.id]);
      if (corruption === 'mrClient') await pool!.query('UPDATE material_requests SET client_id=$2 WHERE id=$1', [row.id, f.foreignClient.id]);
      if (corruption === 'itemClient') await pool!.query('UPDATE inventory_items SET client_id=$2 WHERE id=$1', [f.item.id, f.foreignClient.id]);
      if (corruption === 'warehouseSibling') await pool!.query('UPDATE material_requests SET warehouse_id=$2 WHERE id=$1', [row.id, f.warehouses[1].id]);
      if (corruption === 'warehouseClient') await pool!.query('UPDATE inventory_warehouses SET client_id=$2 WHERE id=$1', [f.warehouses[0].id, f.foreignClient.id]);
      const before = (await pool!.query('SELECT * FROM material_requests WHERE id=$1', [row.id])).rows;
      for (const kind of ['get', 'patch', 'cancel'] as const) await deniedEquivalent(mrPath(row.id), mrPath(randomUUID()), reader.token, kind);
      expectRows(await api().get(buildingPath(f.a.id)).set(auth(reader.token)), []);
      const parentList = await api().get(prPath(f.prs[0].id)).set(auth(reader.token));
      if (corruption === 'parentClient') { assert.equal(parentList.status, 404); await deniedEquivalent(prPath(f.prs[0].id), prPath(randomUUID()), reader.token, 'create'); }
      else expectRows(parentList, []);
      assert.deepEqual((await pool!.query('SELECT * FROM material_requests WHERE id=$1', [row.id])).rows, before);
    });
  }
  it('retains authorized lifecycle, nullable warehouse and permission gates without inventory permission', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    assert.equal((await api().get(mrPath(f.rows[0].id))).status, 401);
    assert.equal((await api().get(mrPath(f.rows[0].id)).set(auth(plain.token))).status, 403);
    const made = await api().post(prPath(f.prs[0].id)).set(auth(reader.token)).send({ itemId: f.item.id, quantity: 3, notes: 'allowed' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const path = mrPath(made.body.data.id);
    const changed = await api().patch(path).set(auth(reader.token)).send({ quantity: 4, warehouseId: f.warehouses[0].id });
    assert.equal(changed.status, 200, JSON.stringify(changed.body)); assert.equal(changed.body.data.quantity, 4);
    const detail = await api().get(path).set(auth(reader.token));
    assert.equal(detail.status, 200); assert.equal(detail.body.data.remainingQuantity, 4); assert.equal(detail.body.data.receivedQuantity, 0); assert.equal(detail.body.data.item.id, f.item.id);
    assert.equal((await api().patch(path).set(auth(reader.token)).send({ warehouseId: null })).status, 200);
    assert.equal((await api().post(`${path}/cancel`).set(auth(reader.token)).send({})).body.data.status, 'CANCELLED');
    assert.equal((await api().patch(path).set(auth(reader.token)).send({ quantity: 5 })).status, 400);
  });
});
