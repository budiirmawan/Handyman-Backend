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
import { inventoryItemService, inventoryItemRepository } from '../src/modules/inventory-items';
import { inventoryWarehouseService } from '../src/modules/inventory-warehouses';
import { materialRequestRepository, materialRequestService } from '../src/modules/material-requests';
import type { PublicMaterialRequest } from '../src/modules/material-requests';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { roleService } from '../src/modules/roles';
import { createAdminUser, createPlainSession, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** CR-HM-SEC-03 PART 01: only the item-nested MR read boundary.
 * Mixed-building regressions must fail against 5d04fac, without relying on
 * malformed data. Corruption fixtures separately exercise fail-closed reads.
 * Uses the existing opt-in embedded-postgres + ensureTestDatabase pattern.
 */
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55583;
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
  ]);
  return { token, userId: (await sessionService.resolveSessionContext(token)).userId };
}
before(async () => {
  if (EMBEDDED) {
    dataDir = await mkdtemp(join(tmpdir(), 'asentra-hm-sec03-item-'));
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
  return { client, foreignClient, a, b, c, d, item, emptyItem, foreignItem, warehouses, prs, rows };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function list(itemId: string, token = reader.token, query = '') {
  return api().get(`/api/v1/items/${itemId}/material-requests${query}`).set(auth(token));
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

describe('Material Request item-list exact-building containment', () => {
  it('mixed-building baseline regression: hidden B sorted after authorized A never leaks', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const response = await list(f.item.id);
    t.diagnostic(`returned status=${response.status}, buildings=${JSON.stringify(response.body.data?.map((r: any) => r.buildingId))}`);
    expectRows(response, [f.rows[0]], f.rows.slice(1));
  });

  it('mixed-building regression: hidden B sorted first neither denies nor leaks', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await pool!.query('UPDATE material_requests SET created_at = $2 WHERE id = $1', [f.rows[1].id, '2033-01-01T00:00:00Z']);
    expectRows(await list(f.item.id), [f.rows[0]], f.rows.slice(1));
  });

  it('unauthorized-only filters and genuinely empty items return the same empty envelope', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    expectRows(await list(f.item.id, reader.token, `?purchaseRequestId=${f.prs[1].id}`), [], f.rows);
    expectRows(await list(f.item.id, reader.token, `?purchaseRequestId=${randomUUID()}`), []);
    expectRows(await list(f.emptyItem.id), []);
    // Nonempty item-wide history, but no authorized rows even without filters.
    await pool!.query('DELETE FROM material_requests WHERE id = $1', [f.rows[0].id]);
    expectRows(await list(f.item.id), [], f.rows.slice(1));
  });

  it('status and purchaseRequestId filters intersect authorization without exposing hidden status', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await pool!.query("UPDATE material_requests SET status = 'CANCELLED' WHERE id = $1", [f.rows[1].id]);
    expectRows(await list(f.item.id, reader.token, '?status=CANCELLED'), [], f.rows);
    expectRows(await list(f.item.id, reader.token, `?status=OPEN&purchaseRequestId=${f.prs[0].id}`), [f.rows[0]], f.rows.slice(1));
    expectRows(await list(f.item.id, reader.token, `?status=CANCELLED&purchaseRequestId=${f.prs[1].id}`), []);
  });

  it('A+B assigned actor sees A+B but never C; ties use id DESC', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    expectRows(await list(f.item.id, multi.token), f.rows.slice(0, 2), [f.rows[2]]);
    const timestamp = '2031-01-03T01:02:03.000Z';
    await pool!.query('UPDATE material_requests SET created_at = $2 WHERE id = ANY($1::uuid[])', [f.rows.map((r) => r.id), timestamp]);
    const expected = f.rows.slice(0, 2).map((r) => ({ ...r, createdAt: timestamp })).sort((x, y) => x.id < y.id ? 1 : -1);
    expectRows(await list(f.item.id, multi.token), expected, [f.rows[2]]);
  });

  it('foreign-client populated/empty items and missing items have identical scoped 404', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const missing = await list(randomUUID());
    const foreignEmpty = await list(f.foreignItem.id);
    const pr = await purchaseRequestService.createPurchaseRequest({ clientId: f.foreignClient.id, buildingId: f.d.id, requestNumber: `PR_${suffix()}`, requestType: 'MATERIAL', title: 'Foreign', requestedByUserId: owner.userId });
    const foreignRow = await materialRequestService.createMaterialRequest({ purchaseRequestId: pr.id, itemId: f.foreignItem.id, quantity: 999, requestedByUserId: owner.userId, notes: 'foreign-secret' });
    const foreignPopulated = await list(f.foreignItem.id);
    for (const response of [missing, foreignEmpty, foreignPopulated]) {
      assert.equal(response.status, 404, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'INVENTORY_ITEM_NOT_FOUND');
      assert.deepEqual(withoutRequestId(response.body), withoutRequestId(missing.body));
      assert.ok(!JSON.stringify(response.body).includes(foreignRow.id));
    }
  });

  it('permission-only zero-assignment actor receives fixed 403 before any item lookup', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    let lookups = 0;
    // Observe the old global lookup and the new scoped lookup independently.
    const oldLookup = t.mock.method(inventoryItemRepository, 'findById', async () => { lookups++; throw new Error('global item lookup forbidden'); });
    const scoped = 'itemExistsInScope' in materialRequestRepository
      ? t.mock.method(materialRequestRepository as any, 'itemExistsInScope', async () => { lookups++; throw new Error('scoped item lookup forbidden'); })
      : null;
    const responses = [];
    for (const id of [f.item.id, f.emptyItem.id, f.foreignItem.id, randomUUID()]) responses.push(await list(id, unassigned.token));
    oldLookup.mock.restore();
    scoped?.mock.restore();
    assert.equal(lookups, 0);
    for (const response of responses) {
      assert.equal(response.status, 403, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
      assert.deepEqual(withoutRequestId(response.body), withoutRequestId(responses[0].body));
    }
  });

  it('missing session is 401; assigned actor without material_request.read is 403', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await buildingAssignmentService.createAssignment(plain.userId, { buildingId: f.a.id });
    assert.equal((await api().get(`/api/v1/items/${f.item.id}/material-requests`)).status, 401);
    const response = await list(f.item.id, plain.token);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('PLATFORM_ADMIN has no sibling/global bypass and ordinary MR-only readers need no inventory permission', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    expectRows(await list(f.item.id, owner.token), [f.rows[0]], f.rows.slice(1));
    expectRows(await list(f.item.id), [f.rows[0]], f.rows.slice(1));
    await pool!.query("UPDATE user_building_assignments SET status = 'INACTIVE' WHERE user_id = $1", [owner.userId]);
    const response = await list(f.item.id, owner.token);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('deactivating an assignment immediately removes its rows', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await buildingAssignmentService.deactivateAssignment(multi.userId, f.a.id);
    expectRows(await list(f.item.id, multi.token), [f.rows[1]], [f.rows[0], f.rows[2]]);
  });

  it('deactivating a building immediately removes its rows', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await pool!.query("UPDATE buildings SET status = 'INACTIVE' WHERE id = $1", [f.a.id]);
    expectRows(await list(f.item.id, multi.token), [f.rows[1]], [f.rows[0], f.rows[2]]);
  });

  const corruptions: Array<[string, (f: Fixture) => Promise<unknown>]> = [
    ['MR client disagrees with item/context', (f) => pool!.query('UPDATE material_requests SET client_id = $2 WHERE id = $1', [f.rows[0].id, f.foreignClient.id])],
    ['parent purchase request building disagrees', (f) => pool!.query('UPDATE purchase_requests SET building_id = $2 WHERE id = $1', [f.prs[0].id, f.b.id])],
    ['parent purchase request client disagrees', (f) => pool!.query('UPDATE purchase_requests SET client_id = $2 WHERE id = $1', [f.prs[0].id, f.foreignClient.id])],
    ['inventory item client disagrees', (f) => pool!.query('UPDATE inventory_items SET client_id = $2 WHERE id = $1', [f.item.id, f.foreignClient.id])],
    ['optional warehouse belongs to sibling building', (f) => pool!.query('UPDATE material_requests SET warehouse_id = $2 WHERE id = $1', [f.rows[0].id, f.warehouses[1].id])],
    ['optional warehouse belongs to foreign client', (f) => pool!.query('UPDATE inventory_warehouses SET client_id = $2 WHERE id = $1', [f.warehouses[0].id, f.foreignClient.id])],
  ];
  for (const [name, corrupt] of corruptions) {
    it(`fails closed: ${name}`, async (t) => {
      if (!ready(t)) return;
      const f = await fixture();
      await corrupt(f);
      const response = await list(f.item.id);
      if (name === 'inventory item client disagrees') {
        assert.equal(response.status, 404);
        assert.equal(response.body.error.code, 'INVENTORY_ITEM_NOT_FOUND');
      } else {
        expectRows(response, [], f.rows);
      }
    });
  }

  it('repository rejects empty/missing scope without issuing SQL; service requires an actor', async (t) => {
    if (!ready(t)) return;
    const query = t.mock.method(pool!, 'query', async () => { throw new Error('must not query with no scope'); });
    assert.deepEqual(await materialRequestRepository.listByItem(randomUUID(), {}, []), []);
    assert.deepEqual(await (materialRequestRepository.listByItem as any)(randomUUID(), {}), []);
    assert.equal(await (materialRequestRepository as any).itemExistsInScope(randomUUID(), []), false);
    assert.equal(await (materialRequestRepository as any).itemExistsInScope(randomUUID()), false);
    await assert.rejects((materialRequestService.listMaterialRequestsByItem as any)(randomUUID(), {}), (e: any) => e.code === 'BUILDING_ACCESS_DENIED');
    assert.equal(query.mock.callCount(), 0);
    query.mock.restore();
  });

  it('repository matches pairs, not independent building/client sets; trusted parent consumers remain unchanged', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const crossedScope = [{ clientId: f.foreignClient.id, buildingId: f.a.id }, { clientId: f.client.id, buildingId: f.d.id }];
    assert.deepEqual(await materialRequestRepository.listByItem(f.item.id, {}, crossedScope), []);
    const validScope = [{ clientId: f.client.id, buildingId: f.a.id }];
    assert.deepEqual((await materialRequestRepository.listByItem(f.item.id, {}, validScope)).map((r) => r.id), [f.rows[0].id]);
    // PO readiness and other material-chain services use this trusted contract,
    // not the actor-facing item-list operation. No new argument is required.
    assert.deepEqual((await materialRequestRepository.listByPurchaseRequest(f.prs[1].id, {})).map((r) => r.id), [f.rows[1].id]);
    assert.equal((await materialRequestRepository.findById(f.rows[1].id))?.id, f.rows[1].id);
    assert.equal((await materialRequestRepository.listByBuilding(f.b.id, {}))[0].id, f.rows[1].id);
  });

  it('unsupported pagination/export/building/client parameters cannot widen scope or add metadata', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    expectRows(await list(f.item.id, reader.token, `?buildingId=${f.b.id}&clientId=${f.foreignClient.id}&limit=1&offset=1&export=true`), [f.rows[0]], f.rows.slice(1));
  });
});
