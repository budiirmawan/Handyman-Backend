import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import {
  closePool,
  initDatabase,
  migrateDown,
  migrateUp,
  withTransaction,
} from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { inventoryItemService } from '../src/modules/inventory-items';
import { materialRequestService } from '../src/modules/material-requests';
import {
  WORK_ORDER_FIELD_PURCHASE_REQUEST_TYPE,
  WORK_ORDER_FIELD_REQUEST_NUMBER_PREFIX,
  getOrCreateWorkOrderFieldPurchaseRequest,
  purchaseRequestRepository,
  purchaseRequestService,
} from '../src/modules/purchase-requests';
import { workOrderRepository, workOrderService } from '../src/modules/work-orders';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-RN11-MATERIAL-FIELD-01 PART 00 — Work-Order procurement parent
 * cardinality foundation.
 *
 * Proves: purchase_requests.work_order_id (nullable, partial-unique),
 * getOrCreateWorkOrderFieldPurchaseRequest (idempotent + race safe), many
 * canonical material_requests under one Work Order parent, legacy
 * work_order_procurement_bindings untouched, no stock / reservation / usage
 * side effects, no mobile route / field permission, migration reversibility.
 */

const MIGRATION_ID = '0350_add_purchase_request_work_order';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE work_order_procurement_bindings, inventory_material_reservations,
            inventory_work_order_material_usages, inventory_stock_movements,
            inventory_stock_balances, material_requests, purchase_requests,
            work_orders, inventory_items, inventory_warehouses, users, roles,
            clients, properties, buildings CASCADE`,
  );
  const admin = await createAdminUser();
  adminUserId = admin.userId;
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

async function fixture() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Field Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  return { client, building };
}

async function createWorkOrderRecord(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await workOrderService.createWorkOrder({
    clientId: f.client.id,
    buildingId: f.building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Field WO',
    workType: 'HVAC',
    createdByUserId: adminUserId,
  });
  const record = await workOrderRepository.findById(created.id);
  assert.ok(record);
  return record;
}

async function createItem(clientId: string) {
  return inventoryItemService.createInventoryItem({
    clientId,
    code: `ITM_${suffix()}`,
    name: 'Field Material',
    itemType: 'MATERIAL',
    uomId: null,
  });
}

async function countRows(table: string): Promise<number> {
  const res = await pool!.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}`,
  );
  return Number(res.rows[0].count);
}

describe('PART 00 — schema', () => {
  it('adds nullable work_order_id FK on purchase_requests', async (t) => {
    if (!ready(t)) return;
    const col = await pool!.query(
      `SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_name = 'purchase_requests' AND column_name = 'work_order_id'`,
    );
    assert.equal(col.rows.length, 1);
    assert.equal(col.rows[0].is_nullable, 'YES');
    assert.equal(col.rows[0].data_type, 'uuid');
    const fk = await pool!.query(
      `SELECT 1 FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
       WHERE tc.table_name = 'purchase_requests'
         AND tc.constraint_type = 'FOREIGN KEY'
         AND kcu.column_name = 'work_order_id'`,
    );
    assert.equal(fk.rows.length, 1);
  });

  it('management Purchase Request keeps work_order_id NULL (no heuristic backfill)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await purchaseRequestService.createPurchaseRequest({
      clientId: f.client.id,
      buildingId: f.building.id,
      requestNumber: `PRQ_${suffix()}`,
      requestType: 'MATERIAL',
      title: 'Management PR',
      requestedByUserId: adminUserId,
    });
    const rec = await purchaseRequestRepository.findById(pr.id);
    assert.equal(rec?.workOrderId, null);
    // The public DTO stays unchanged in PART 00.
    assert.equal('workOrderId' in pr, false);
    // Even a management PR created for a Building that owns Work Orders is
    // never linked heuristically.
    const wo = await createWorkOrderRecord(f);
    assert.equal(await purchaseRequestRepository.findByWorkOrderId(wo.id), null);
  });

  it('partial unique index rejects a duplicate non-null work_order_id', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const wo = await createWorkOrderRecord(f);
    const first = await getOrCreateWorkOrderFieldPurchaseRequest(wo, adminUserId);
    await assert.rejects(
      pool!.query(
        `INSERT INTO purchase_requests
           (id, client_id, building_id, request_number, request_type, title,
            requested_by_user_id, work_order_id)
         VALUES ($1, $2, $3, $4, 'MATERIAL', 'dup', $5, $6)`,
        [randomUUID(), f.client.id, f.building.id, `DUP_${suffix()}`, adminUserId, wo.id],
      ),
      (e: any) =>
        e.code === '23505' && e.constraint === 'purchase_requests_work_order_unique',
    );
    // ...while multiple NULLs remain allowed.
    await pool!.query(
      `INSERT INTO purchase_requests
         (id, client_id, building_id, request_number, request_type, title,
          requested_by_user_id, work_order_id)
       VALUES ($1, $2, $3, $4, 'MATERIAL', 'null-a', $5, NULL),
              ($6, $2, $3, $7, 'MATERIAL', 'null-b', $5, NULL)`,
      [randomUUID(), f.client.id, f.building.id, `N_${suffix()}`, adminUserId, randomUUID(), `N_${suffix()}`],
    );
    assert.equal((await purchaseRequestRepository.findByWorkOrderId(wo.id))?.id, first.id);
  });
});

describe('PART 00 — getOrCreateWorkOrderFieldPurchaseRequest', () => {
  it('creates exactly one server-derived field parent per Work Order', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const wo = await createWorkOrderRecord(f);
    const pr = await getOrCreateWorkOrderFieldPurchaseRequest(wo, adminUserId);
    assert.equal(pr.workOrderId, wo.id);
    assert.equal(pr.clientId, wo.clientId);
    assert.equal(pr.buildingId, wo.buildingId);
    assert.equal(pr.requestedByUserId, adminUserId);
    assert.equal(pr.requestType, WORK_ORDER_FIELD_PURCHASE_REQUEST_TYPE);
    assert.equal(pr.requestType, 'MATERIAL');
    assert.equal(pr.status, 'OPEN');
    assert.equal(pr.priority, wo.priority);
    assert.ok(pr.requestNumber.startsWith(WORK_ORDER_FIELD_REQUEST_NUMBER_PREFIX));
    assert.match(pr.requestNumber, /^WOF_[A-F0-9]{8}$/);
    assert.equal(pr.title, `Work order ${wo.workOrderNumber} field material request`);
  });

  it('second call returns the same Purchase Request', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const wo = await createWorkOrderRecord(f);
    const a = await getOrCreateWorkOrderFieldPurchaseRequest(wo, adminUserId);
    const b = await getOrCreateWorkOrderFieldPurchaseRequest(wo, adminUserId);
    assert.equal(b.id, a.id);
    assert.equal(b.requestNumber, a.requestNumber);
    const rows = await pool!.query(
      `SELECT COUNT(*)::int AS n FROM purchase_requests WHERE work_order_id = $1`,
      [wo.id],
    );
    assert.equal(rows.rows[0].n, 1);
  });

  it('works on an injected transaction executor', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const wo = await createWorkOrderRecord(f);
    const created = await withTransaction((client) =>
      getOrCreateWorkOrderFieldPurchaseRequest(wo, adminUserId, client),
    );
    const again = await withTransaction((client) =>
      getOrCreateWorkOrderFieldPurchaseRequest(wo, adminUserId, client),
    );
    assert.equal(again.id, created.id);
  });

  it('two concurrent calls commit only one parent (partial unique arbitration)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const wo = await createWorkOrderRecord(f);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        getOrCreateWorkOrderFieldPurchaseRequest(wo, adminUserId),
      ),
    );
    const ids = new Set(results.map((r) => r.id));
    assert.equal(ids.size, 1);
    const rows = await pool!.query(
      `SELECT COUNT(*)::int AS n FROM purchase_requests WHERE work_order_id = $1`,
      [wo.id],
    );
    assert.equal(rows.rows[0].n, 1);
  });

  it('race lost inside an explicit transaction re-reads the committed winner', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const wo = await createWorkOrderRecord(f);
    // Real two-connection race: A inserts but has not committed; B's pre-check
    // misses, B's INSERT blocks on the partial unique index until A commits,
    // then B receives 23505, rolls back its SAVEPOINT and re-reads the winner
    // — on a transaction that stays usable.
    const a = await pool!.connect();
    const b = await pool!.connect();
    try {
      await a.query('BEGIN');
      const winner = await getOrCreateWorkOrderFieldPurchaseRequest(wo, adminUserId, a);
      await b.query('BEGIN');
      const loserPromise = getOrCreateWorkOrderFieldPurchaseRequest(wo, adminUserId, b);
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      const loser = await loserPromise;
      await b.query('SELECT 1'); // not aborted
      await b.query('COMMIT');
      assert.equal(loser.id, winner.id);
      assert.equal(loser.requestNumber, winner.requestNumber);
    } finally {
      a.release();
      b.release();
    }
    const rows = await pool!.query(
      `SELECT COUNT(*)::int AS n FROM purchase_requests WHERE work_order_id = $1`,
      [wo.id],
    );
    assert.equal(rows.rows[0].n, 1);
  });

  it('different Work Orders get different field Purchase Requests', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const wo1 = await createWorkOrderRecord(f);
    const wo2 = await createWorkOrderRecord(f);
    const a = await getOrCreateWorkOrderFieldPurchaseRequest(wo1, adminUserId);
    const b = await getOrCreateWorkOrderFieldPurchaseRequest(wo2, adminUserId);
    assert.notEqual(a.id, b.id);
    assert.equal(a.workOrderId, wo1.id);
    assert.equal(b.workOrderId, wo2.id);
  });
});

describe('PART 00 — multi-material cardinality', () => {
  it('three material_requests share one Work Order parent without replacement', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const wo = await createWorkOrderRecord(f);
    const parent = await getOrCreateWorkOrderFieldPurchaseRequest(wo, adminUserId);
    const items = await Promise.all([
      createItem(f.client.id),
      createItem(f.client.id),
      createItem(f.client.id),
    ]);
    const created: string[] = [];
    for (const [index, item] of items.entries()) {
      const mr = await materialRequestService.createMaterialRequest({
        purchaseRequestId: parent.id,
        itemId: item.id,
        quantity: index + 1,
        requestedByUserId: adminUserId,
      });
      assert.equal(mr.purchaseRequestId, parent.id);
      assert.equal(mr.status, 'OPEN');
      created.push(mr.id);
    }
    assert.equal(new Set(created).size, 3);
    const rows = await pool!.query<{ id: string; item_id: string; quantity: string }>(
      `SELECT mr.id, mr.item_id, mr.quantity::text
       FROM material_requests mr
       JOIN purchase_requests pr ON pr.id = mr.purchase_request_id
       WHERE pr.work_order_id = $1
       ORDER BY mr.created_at`,
      [wo.id],
    );
    assert.deepEqual(rows.rows.map((r) => r.id), created);
    assert.deepEqual(rows.rows.map((r) => r.item_id), items.map((i) => i.id));
    assert.deepEqual(rows.rows.map((r) => Number(r.quantity)), [1, 2, 3]);
    // First row still intact after later creations.
    const first = await materialRequestService.getMaterialRequestById(created[0]);
    assert.equal(first.itemId, items[0].id);
    assert.equal(first.quantity, 1);
  });

  it('cardinality does not depend on a work_order_procurement_bindings row', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const wo = await createWorkOrderRecord(f);
    const parent = await getOrCreateWorkOrderFieldPurchaseRequest(wo, adminUserId);
    const item = await createItem(f.client.id);
    await materialRequestService.createMaterialRequest({
      purchaseRequestId: parent.id,
      itemId: item.id,
      quantity: 2,
      requestedByUserId: adminUserId,
    });
    const bindings = await pool!.query(
      `SELECT 1 FROM work_order_procurement_bindings WHERE work_order_id = $1`,
      [wo.id],
    );
    assert.equal(bindings.rows.length, 0);
  });
});

describe('PART 00 — boundaries', () => {
  it('helper mutates no stock, reservation, usage, or binding rows', async (t) => {
    if (!ready(t)) return;
    const before = await Promise.all([
      countRows('inventory_stock_balances'),
      countRows('inventory_stock_movements'),
      countRows('inventory_material_reservations'),
      countRows('inventory_work_order_material_usages'),
      countRows('work_order_procurement_bindings'),
    ]);
    const f = await fixture();
    const wo = await createWorkOrderRecord(f);
    await getOrCreateWorkOrderFieldPurchaseRequest(wo, adminUserId);
    await getOrCreateWorkOrderFieldPurchaseRequest(wo, adminUserId);
    const afterCounts = await Promise.all([
      countRows('inventory_stock_balances'),
      countRows('inventory_stock_movements'),
      countRows('inventory_material_reservations'),
      countRows('inventory_work_order_material_usages'),
      countRows('work_order_procurement_bindings'),
    ]);
    assert.deepEqual(afterCounts, before);
  });

  it('legacy work_order_procurement_bindings schema / unique index unchanged', async (t) => {
    if (!ready(t)) return;
    const idx = await pool!.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'work_order_procurement_bindings'
         AND indexname = 'wo_procurement_work_order_unique'`,
    );
    assert.equal(idx.rows.length, 1);
    assert.match(idx.rows[0].indexdef, /UNIQUE INDEX .* \(work_order_id\)$/);
    const cols = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'work_order_procurement_bindings'
       ORDER BY ordinal_position`,
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const expected of [
      'work_order_id',
      'purchase_request_id',
      'material_request_id',
      'service_request_id',
      'receiving_id',
      'procurement_status',
    ]) {
      assert.ok(names.includes(expected), expected);
    }
    const chk = await pool!.query(
      `SELECT 1 FROM pg_constraint
       WHERE conname = 'wo_procurement_request_reference_check'`,
    );
    assert.equal(chk.rows.length, 1);
  });

  it('PART 00 itself adds no material route beyond the field surface owned by PART 01', () => {
    // PART 00 shipped no route / permission. PART 01 (same CR) then added the
    // mobile field surface in `mobile-material-requests` only; this pin keeps
    // any OTHER module from growing a second mobile material route.
    const root = resolve(__dirname, '../src');
    const routeFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.routes.ts')) routeFiles.push(p);
      }
    };
    walk(root);
    for (const file of routeFiles) {
      if (file.includes('/mobile-material-requests/')) continue;
      const src = readFileSync(file, 'utf8');
      assert.equal(/\/mobile\/work-orders\/[^'`]*material-requests/.test(src), false, file);
      assert.equal(/\/mobile\/material-requests/.test(src), false, file);
    }
  });
});

describe('PART 00 — migration reversibility (runs last)', () => {
  it(`migrateDown reverses ${MIGRATION_ID}; migrateUp re-applies it`, async (t) => {
    if (!ready(t)) return;
    try {
      const reversed = await migrateDown(pool!);
      assert.equal(reversed, MIGRATION_ID);
      const col = await pool!.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'purchase_requests' AND column_name = 'work_order_id'`,
      );
      assert.equal(col.rows.length, 0);
      const idx = await pool!.query(
        `SELECT 1 FROM pg_indexes WHERE indexname = 'purchase_requests_work_order_unique'`,
      );
      assert.equal(idx.rows.length, 0);
    } finally {
      await migrateUp(pool!);
    }
    const col = await pool!.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'purchase_requests' AND column_name = 'work_order_id'`,
    );
    assert.equal(col.rows.length, 1);
  });
});
