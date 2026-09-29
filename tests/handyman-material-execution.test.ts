import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  HANDYMAN_MATERIAL_EXECUTION_STATUSES,
  HANDYMAN_MATERIAL_EXECUTION_EVENT_TYPES,
  handymanMaterialExecutionRepository,
} from '../src/modules/handyman-material-execution';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { inventoryItemService } from '../src/modules/inventory-items';
import { createAdminUser } from './helpers/access';
import {
  realmFixture,
  locationChain,
  scopeFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-09 PART 01 — material execution persistence foundation ONLY
 * (FROZEN governance `CR-HM-09_START_GOVERNANCE.md` D1–D7): two
 * tables (line aggregate + append-only event stream), exact frozen
 * status/event sets, quantity CHECK invariants, acquisition
 * exclusivity, quotation-snapshot identity immutability, idempotency
 * boundary, ZERO pricing/payment/FM surface. NO commands/services
 * exist yet. Six focused cases.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE
    handyman_material_execution_events,
    handyman_material_execution_lines,
    handyman_execution_scopes, handyman_quotation_decisions,
    handyman_quotation_lines, handyman_quotation_versions,
    handyman_quotations,
    handyman_request_diagnoses, handyman_request_inspections,
    handyman_request_triage_decisions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    handyman_discipline_service_associations, service_catalog,
    inventory_items, price_catalog_entries,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings,
    properties, units_of_measure, users, roles, permissions,
    clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const d = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!d) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  initHandymanFixtures({
    adminUserId,
    disciplineId: d.id,
    query: async (text, params = []) => {
      if (!pool) throw new Error('db pool not initialized');
      return pool.query(text, params);
    },
  });
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

/**
 * Approved-scope fixture chain (server-derived scope authority from
 * an APPROVED quotation version; the ART of scope creation is
 * CR-HM-06's — this suite only needs the identity).
 */
async function approvedFixture() {
  const realm = await realmFixture();
  const chain = await locationChain(realm);
  const f = await scopeFixture(realm, chain);
  assert.ok(f.scope, 'approved scope required');
  const scope = f.scope!;
  // The approved version carries one MATERIAL quotation line inserted
  // as an immutable snapshot fact (test-only direct insert mirrors the
  // CR-HM-06 line shape; NOT a runtime write path of CR-HM-09).
  const materialLineId = randomUUID();
  await q(
    `INSERT INTO handyman_quotation_lines (
       id, quotation_version_id, line_type, description, quantity,
       uom_id, final_quoted_unit_amount, line_total, currency,
       source_item_id, created_by_user_id
     ) SELECT $1, $2, 'MATERIAL', 'Copper pipe', 4,
              u.id, 25, 100, 'IDR', NULL, $3
         FROM units_of_measure u
        WHERE u.client_id = $4
        LIMIT 1`,
    [materialLineId, scope.approvedQuotationVersionId,
      adminUserId, scope.clientId],
  );
  return {
    clientId: scope.clientId,
    executionScopeId: scope.id,
    quotationVersionId: scope.approvedQuotationVersionId,
    materialLineId,
    realm,
  };
}

type LineParams = {
  clientId: string;
  executionScopeId: string;
  quotationVersionId: string;
  quotationLineId: string;
  estimatedQty?: number;
  sourceItemId?: string | null;
};

async function createLine(p: LineParams) {
  return handymanMaterialExecutionRepository
    .createMaterialExecutionLine(undefined, {
      clientId: p.clientId,
      executionScopeId: p.executionScopeId,
      quotationVersionId: p.quotationVersionId,
      quotationLineId: p.quotationLineId,
      sourceItemId: p.sourceItemId ?? null,
      estimatedQty: p.estimatedQty ?? 4,
    });
}

async function assertPgError(
  code: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  let caught: { code?: string } | null = null;
  try {
    await fn();
  } catch (error) {
    caught = error as { code?: string };
  }
  assert.ok(caught, 'expected database error');
  assert.equal(caught!.code, code);
}

async function setHead(
  lineId: string,
  patch: Partial<{
    status: string; acquisitionMode: string;
    approvedQty: number; issuedQty: number; purchasedQty: number;
    usedQty: number; returnedQty: number;
  }>,
): Promise<void> {
  const line = await handymanMaterialExecutionRepository
    .findMaterialExecutionLineById(undefined, lineId);
  if (!line) throw new Error('line not found');
  await handymanMaterialExecutionRepository
    .updateMaterialExecutionLineHead(undefined, lineId, {
      status: (patch.status ?? line.status) as never,
      acquisitionMode: (patch.acquisitionMode !== undefined
        ? patch.acquisitionMode
        : line.acquisitionMode) as never,
      approvedQty: patch.approvedQty ?? line.approvedQty,
      issuedQty: patch.issuedQty ?? line.issuedQty,
      purchasedQty: patch.purchasedQty ?? line.purchasedQty,
      usedQty: patch.usedQty ?? line.usedQty,
      returnedQty: patch.returnedQty ?? line.returnedQty,
      supplierReference: line.supplierReference,
    });
}

describe('CR-HM-09 PART 01 — material execution persistence', () => {
  it('1: exact tables, frozen status set and event set', async (t) => {
    if (!requireDatabase(t)) return;
    const tables = await q(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('handyman_material_execution_lines',
                             'handyman_material_execution_events')
        ORDER BY table_name`,
    );
    assert.deepEqual(tables.rows.map((r) => r.table_name), [
      'handyman_material_execution_events',
      'handyman_material_execution_lines',
    ]);
    assert.deepEqual([...HANDYMAN_MATERIAL_EXECUTION_STATUSES], [
      'ESTIMATED', 'APPROVED', 'ISSUED', 'PURCHASED', 'USED',
      'FINAL_CHARGE_READY',
    ]);
    assert.deepEqual([...HANDYMAN_MATERIAL_EXECUTION_EVENT_TYPES], [
      'ESTIMATE', 'APPROVE', 'ISSUE', 'PURCHASE', 'USE', 'RETURN',
      'FINAL_CHARGE_READY',
    ]);
    // RETURNED is NOT a sticky status — absent from BOTH sets.
    assert.equal(
      HANDYMAN_MATERIAL_EXECUTION_STATUSES.includes('RETURNED' as never),
      false);
    assert.equal(
      HANDYMAN_MATERIAL_EXECUTION_STATUSES.includes(
        'ISSUED_OR_PURCHASED' as never),
      false);
    // DB-level: the line CHECK accepts every frozen status and the
    // default is ESTIMATED with all quantities zero.
    const f = await approvedFixture();
    const line = await createLine({
      clientId: f.clientId,
      executionScopeId: f.executionScopeId,
      quotationVersionId: f.quotationVersionId,
      quotationLineId: f.materialLineId,
    });
    assert.equal(line.status, 'ESTIMATED');
    assert.equal(line.acquisitionMode, null);
    assert.deepEqual(
      [line.approvedQty, line.issuedQty, line.purchasedQty,
        line.usedQty, line.returnedQty],
      [0, 0, 0, 0, 0]);
    for (const status of HANDYMAN_MATERIAL_EXECUTION_STATUSES) {
      await setHead(line.id, { status });
    }
    // A non-frozen status is rejected by the line CHECK.
    await assertPgError('23514', () =>
      q(
        `INSERT INTO handyman_material_execution_lines (
           id, client_id, execution_scope_id, quotation_version_id,
           quotation_line_id, estimated_qty, status
         ) VALUES ($1, $2, $3, $4, $5, 1, 'RETURNED')`,
        [randomUUID(), f.clientId, f.executionScopeId,
          f.quotationVersionId, f.materialLineId]));
    // DB-level: unknown event types are rejected by the event CHECK.
    await assertPgError('23514', () =>
      q(
        `INSERT INTO handyman_material_execution_events (
           id, client_id, line_id, execution_scope_id, event_type,
           idempotency_key, actor_user_id
         ) VALUES ($1, $2, $3, $4, 'FINDINGS', $5, $6)`,
        [randomUUID(), f.clientId, line.id, f.executionScopeId,
          `k-${randomUUID()}`, adminUserId]));
  });

  it('2: quantity CHECK invariants at the DB boundary', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await approvedFixture();
    const seed = {
      clientId: f.clientId,
      executionScopeId: f.executionScopeId,
      quotationVersionId: f.quotationVersionId,
      quotationLineId: f.materialLineId,
    };
    // Negative estimated_qty at insert is rejected by its CHECK.
    await assertPgError('23514', () =>
      q(
        `INSERT INTO handyman_material_execution_lines (
           id, client_id, execution_scope_id, quotation_version_id,
           quotation_line_id, estimated_qty
         ) VALUES ($1, $2, $3, $4, $5, -1)`,
        [randomUUID(), seed.clientId, seed.executionScopeId,
          seed.quotationVersionId, seed.quotationLineId]));
    // All mutable quantity heads reject negative values via the head
    // mutation primitive (which routes through the DB CHECKs).
    const lineA = await createLine(seed);
    for (const [key, value] of [
      ['approvedQty', -1],
      ['issuedQty', -1],
      ['purchasedQty', -1],
      ['usedQty', -1],
      ['returnedQty', -1],
    ] as Array<['approvedQty' | 'issuedQty' | 'purchasedQty'
        | 'usedQty' | 'returnedQty', number]>) {
      await assertPgError('23514', () =>
        setHead(lineA.id, { [key]: value }));
    }
    // used <= issued+purchased-returned: violating rows are rejected.
    const lineB = await createLine(seed);
    await assertPgError('23514', () =>
      setHead(lineB.id, { usedQty: 1 }));
    await setHead(lineB.id, {
      acquisitionMode: 'ISSUED', issuedQty: 5, usedQty: 5,
    });
    await assertPgError('23514', () =>
      setHead(lineB.id, { usedQty: 6 }));
    // returned <= issued+purchased-used: violating rows are rejected.
    const lineC = await createLine(seed);
    await setHead(lineC.id, {
      acquisitionMode: 'PURCHASED', purchasedQty: 5, usedQty: 2,
    });
    await assertPgError('23514', () =>
      setHead(lineC.id, { returnedQty: 4 }));
    // Legal boundary: returned reduces final usage exactly.
    await setHead(lineC.id, { returnedQty: 3 });
    assert.ok(true);
  });

  it('3: acquisition mode exclusivity once chosen', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await approvedFixture();
    const seed = {
      clientId: f.clientId,
      executionScopeId: f.executionScopeId,
      quotationVersionId: f.quotationVersionId,
      quotationLineId: f.materialLineId,
    };
    // issued_qty > 0 requires ISSUED.
    const lineA = await createLine(seed);
    await assertPgError('23514', () =>
      setHead(lineA.id, { issuedQty: 2 }));
    await assertPgError('23514', () =>
      setHead(lineA.id,
        { acquisitionMode: 'PURCHASED', issuedQty: 2 }));
    // purchased_qty > 0 requires PURCHASED.
    const lineB = await createLine(seed);
    await assertPgError('23514', () =>
      setHead(lineB.id, { purchasedQty: 2 }));
    await assertPgError('23514', () =>
      setHead(lineB.id,
        { acquisitionMode: 'ISSUED', purchasedQty: 2 }));
    // A line NEVER carries both issuance and purchase quantities.
    const lineC = await createLine(seed);
    await setHead(lineC.id, { acquisitionMode: 'ISSUED', issuedQty: 3 });
    await assertPgError('23514', () =>
      setHead(lineC.id, { purchasedQty: 1 }));
    // Unknown acquisition modes are rejected.
    const lineD = await createLine(seed);
    await assertPgError('23514', () =>
      setHead(lineD.id,
        { acquisitionMode: 'RESERVATION' }));
    // Legal: exactly one acquisition axis per line.
    const lineE = await createLine(seed);
    await setHead(lineE.id,
      { acquisitionMode: 'PURCHASED', purchasedQty: 7, usedQty: 7 });
    assert.ok(true);
  });

  it('4: quotation snapshot refs + scope/client integrity', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await approvedFixture();
    const seed = {
      clientId: f.clientId,
      executionScopeId: f.executionScopeId,
      quotationVersionId: f.quotationVersionId,
      quotationLineId: f.materialLineId,
    };
    // Happy path (plain line creator used elsewhere in the suite).
    const line = await createLine(seed);
    assert.ok(line.id);
    // Cross-client binding is rejected by the consistency trigger —
    // a client id that does NOT belong to the scope's client is
    // refused BEFORE the clients FK fires (BEFORE-INSERT trigger).
    await assertPgError('P0001', () =>
      q(
        `INSERT INTO handyman_material_execution_lines (
           id, client_id, execution_scope_id, quotation_version_id,
           quotation_line_id, estimated_qty
         ) VALUES ($1, $2, $3, $4, $5, 1)`,
        [randomUUID(), randomUUID(),
          f.executionScopeId, f.quotationVersionId, f.materialLineId]));
    // FK enforcement: garbage scope/version/line references rejected.
    await assertPgError('23503', () =>
      q(
        `INSERT INTO handyman_material_execution_lines (
           id, client_id, execution_scope_id, quotation_version_id,
           quotation_line_id, estimated_qty
         ) VALUES ($1, $2, $3, $4, $5, 1)`,
        [randomUUID(), f.clientId, randomUUID(),
          f.quotationVersionId, f.materialLineId]));
    await assertPgError('23503', () =>
      q(
        `INSERT INTO handyman_material_execution_lines (
           id, client_id, execution_scope_id, quotation_version_id,
           quotation_line_id, estimated_qty
         ) VALUES ($1, $2, $3, $4, $5, 1)`,
        [randomUUID(), f.clientId, f.executionScopeId,
          randomUUID(), f.materialLineId]));
    await assertPgError('23503', () =>
      q(
        `INSERT INTO handyman_material_execution_lines (
           id, client_id, execution_scope_id, quotation_version_id,
           quotation_line_id, estimated_qty
         ) VALUES ($1, $2, $3, $4, $5, 1)`,
        [randomUUID(), f.clientId, f.executionScopeId,
          f.quotationVersionId, randomUUID()]));
    // Identity immutability: the quotation snapshot references written
    // at creation can NEVER be rewritten (distinct replacement ids
    // force the BEFORE-trigger — it raises BEFORE any FK fires).
    await assertPgError('P0001', () =>
      q(
        `UPDATE handyman_material_execution_lines
            SET quotation_version_id = $2, quotation_line_id = $3,
                execution_scope_id = $4
          WHERE id = $1`,
        [line.id, randomUUID(), randomUUID(), randomUUID()]));
    await assertPgError('P0001', () =>
      q(
        `UPDATE handyman_material_execution_lines
            SET source_item_id = $2 WHERE id = $1`,
        [line.id, randomUUID()]));
    // Line DELETE is blocked — history lives in the event stream.
    await assertPgError('P0001', () =>
      q(
        `DELETE FROM handyman_material_execution_lines WHERE id = $1`,
        [line.id]));
    // source_item_id FK exists (nullable; garbage id rejected).
    await assertPgError('23503', () =>
      q(
        `INSERT INTO handyman_material_execution_lines (
           id, client_id, execution_scope_id, quotation_version_id,
           quotation_line_id, source_item_id, estimated_qty
         ) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
        [randomUUID(), f.clientId, f.executionScopeId,
          f.quotationVersionId, f.materialLineId, randomUUID()]));
  });

  it('5: events are append-only with the idempotency boundary', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await approvedFixture();
    const line = await createLine({
      clientId: f.clientId,
      executionScopeId: f.executionScopeId,
      quotationVersionId: f.quotationVersionId,
      quotationLineId: f.materialLineId,
    });
    const key = `k-${randomUUID()}`;
    const event = await handymanMaterialExecutionRepository
      .appendMaterialExecutionEvent(undefined, {
        clientId: f.clientId,
        lineId: line.id,
        executionScopeId: f.executionScopeId,
        eventType: 'ESTIMATE',
        idempotencyKey: key,
        actorUserId: adminUserId,
      });
    assert.equal(event.lineId, line.id);
    assert.ok(event.occurredAt);
    assert.ok(Number.isNaN(Date.parse(event.occurredAt)) === false);
    // Replay lookup over the (line, type, key) boundary finds the
    // SAME row.
    const again = await handymanMaterialExecutionRepository
      .findMaterialExecutionEventByIdempotency(
        undefined, line.id, 'ESTIMATE', key);
    assert.ok(again);
    assert.equal(again!.id, event.id);
    // Duplicate (line, type, key) insert raises 23505.
    await assertPgError('23505', () =>
      q(
        `INSERT INTO handyman_material_execution_events (
           id, client_id, line_id, execution_scope_id, event_type,
           idempotency_key, actor_user_id
         ) VALUES ($1, $2, $3, $4, 'ESTIMATE', $5, $6)`,
        [randomUUID(), f.clientId, line.id, f.executionScopeId,
          key, adminUserId]));
    // The same key under a DIFFERENT event type is legal (the
    // boundary is the pair line+type+key).
    await handymanMaterialExecutionRepository
      .appendMaterialExecutionEvent(undefined, {
        clientId: f.clientId,
        lineId: line.id,
        executionScopeId: f.executionScopeId,
        eventType: 'APPROVE',
        idempotencyKey: key,
        actorUserId: adminUserId,
      });
    // Cross-line/cross-scope child binding is blocked.
    await assertPgError('P0001', () =>
      q(
        `INSERT INTO handyman_material_execution_events (
           id, client_id, line_id, execution_scope_id, event_type,
           idempotency_key, actor_user_id
         ) VALUES ($1, $2, $3, $4, 'USE', $5, $6)`,
        [randomUUID(), f.clientId, line.id, randomUUID(),
          `k-${randomUUID()}`, adminUserId]));
    // Events are append-only: UPDATE and DELETE blocked.
    await assertPgError('P0001', () =>
      q(
        `UPDATE handyman_material_execution_events
            SET occurred_at = NOW() WHERE id = $1`,
        [event.id]));
    await assertPgError('P0001', () =>
      q(
        `DELETE FROM handyman_material_execution_events WHERE id = $1`,
        [event.id]));
    // Ordered listing reflects the event stream.
    const events = await handymanMaterialExecutionRepository
      .listMaterialExecutionEventsByLine(undefined, line.id);
    assert.deepEqual(events.map((e) => e.eventType),
      ['ESTIMATE', 'APPROVE']);
    // Scope listing sees the line.
    const lines = await handymanMaterialExecutionRepository
      .listMaterialExecutionLinesByScope(
        undefined, f.executionScopeId);
    assert.ok(lines.some((l) => l.id === line.id));
  });

  it('6: zero pricing/payment/FM surface anywhere', async (t) => {
    if (!requireDatabase(t)) return;
    // Possession/evidence facts ONLY — NO amount/currency/price/
    // charge/billing/payment/stock/reservation/purchase-order/
    // material-request/goods-receipt/work-order columns on either
    // table.
    const cols = await q(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('handyman_material_execution_lines',
                             'handyman_material_execution_events')`,
    );
    const names = cols.rows.map((r) =>
      String(r.column_name).toLowerCase());
    for (const token of ['amount', 'currency', 'price', 'charge',
      'billing', 'bill', 'payment', 'invoice', 'rate', 'stock',
      'reservation', 'purchase_order', 'material_request',
      'goods_receipt', 'work_order', 'work_order_id', 'wallet',
      'tariff', 'fee']) {
      assert.equal(
        names.filter((n) => n.includes(token)).length, 0,
        `zero ${token} column`);
    }
    // Column sets are exactly the persisted execution-truth surface.
    const lineCols = cols.rows
      .filter((r) => r.table_name
        === 'handyman_material_execution_lines')
      .map((r) => String(r.column_name)).sort();
    assert.deepEqual(lineCols, [
      'acquisition_mode', 'approved_qty', 'client_id', 'created_at',
      'estimated_qty', 'execution_scope_id', 'id', 'issued_qty',
      'purchased_qty', 'quotation_line_id', 'quotation_version_id',
      'returned_qty', 'source_item_id', 'status', 'supplier_reference',
      'updated_at', 'used_qty',
    ]);
    const eventCols = cols.rows
      .filter((r) => r.table_name
        === 'handyman_material_execution_events')
      .map((r) => String(r.column_name)).sort();
    assert.deepEqual(eventCols, [
      'actor_user_id', 'client_id', 'created_at', 'event_type', 'id',
      'idempotency_key', 'line_id', 'occurred_at',
      'execution_scope_id',
    ].sort());
    // Module source: no commercial/FM identifiers anywhere in the 4
    // PART 01 files (comment-stripped scan).
    const strip = (src: string) => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const file of [
      'handyman-material-execution.types.ts',
      'handyman-material-execution.errors.ts',
      'handyman-material-execution.repository.ts',
      'index.ts',
    ]) {
      const src = strip(readFileSync(
        `src/modules/handyman-material-execution/${file}`, 'utf8'))
        .toLowerCase()
        // The FROZEN status literal FINAL_CHARGE_READY is a state
        // name (usage-basis handoff complete), NOT a commercial
        // charge field — exempt it from the commercial-token scan
        // before matching (governance D-boundary).
        .replaceAll('final_charge_ready', 'settled_state');
      for (const token of ['amount', 'currency', 'price', 'charge',
        'billing', 'payment', 'invoice', 'rate', 'stock_movement',
        'reservation', 'purchase_order', 'material_request',
        'goods_receipt', 'work_order', 'work-order',
        'reverse-geocode', 'api.co.id']) {
        assert.equal(src.includes(token), false,
          `zero ${token} in ${file}`);
      }
      assert.equal(/from '.*(inventory|purchase-|material-request)/
        .test(src), false,
        `zero FM imports in ${file}`);
    }
    // NO service/controller/routes file exists in this PART.
    assert.deepEqual(
      readdirSync('src/modules/handyman-material-execution').sort(),
      [
        'handyman-material-execution.errors.ts',
        'handyman-material-execution.repository.ts',
        'handyman-material-execution.types.ts',
        'index.ts',
      ].sort());
    // helpers' inventory seam was exercised here ONLY as an offered
    // service (the module itself never imports it).
    const uomRows = await q(
      `SELECT id FROM units_of_measure LIMIT 1`);
    assert.ok(uomRows.rows[0]);
    void inventoryItemService; // unused: master reference only via FK
  });
});
