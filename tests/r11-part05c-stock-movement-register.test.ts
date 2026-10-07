/**
 * R11 PART 05C — STOCK_MOVEMENT_REGISTER registration: focused contract test.
 *
 * Proves the 21 → 22 registration ripple and the adapter/projection contract
 * WITHOUT executing any historical test and WITHOUT live PostgreSQL
 * (node_modules absent). Method — the established R11 hybrid: the
 * dependency-free runtime surfaces (dataset vocabulary, CSV-default
 * metadata, the projection) are EXECUTED for real under `node --test` with
 * native type stripping; the registry adapter and OpenAPI ripple are proven
 * from source text; `stripTypeScriptTypes` validates every changed file;
 * byte-identity of the PART 05B source foundation, the owning
 * inventory-stock-movements module, frozen Reporting surfaces and all
 * historical tests is proven via git against the PART 05B baseline.
 *
 * PROVES (PART 05C checklist 1–57): declared once; 22/22/22 parity with
 * equal sets and order; inventory_stock.read reused; public
 * stock-movement-register authority consumed (no repository, no SQL,
 * authenticated userId passed, no Reporting-side scope resolution); one
 * table `stockMovementRegister`; one row per movement; stockMovementId and
 * all sixteen persisted facts verbatim; native STOCK_IN/STOCK_OUT preserved
 * with no invented status; quantities/UOM never summed, converted or
 * netted; resulting snapshots historical (no reservedQuantity, no
 * current-balance alias); dateFrom/dateTo passed through to the source
 * parser with no second date parser/window and no createdAt fallback; zero
 * monetary authority; no receiving / WO-usage / reservation / PO-invoice /
 * display-name enrichment; kpis = []; no CSV default (OPERATIONAL_DETAIL
 * remains the only one); no route, migration or new permission; source
 * foundation, owning module and historical tests byte-unchanged.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const git = (...a) =>
  execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** PART 05B closure — the fixed baseline this PART builds on. */
const BASE = '0f119618d91b75b98a67d5f24780b43fcf7a2387';
const RE = 'src/modules/reporting-export';
const TYPES = `${RE}/reporting-export.types.ts`;
const REG = `${RE}/reporting-export.registry.ts`;
const R11PROJ = `${RE}/reporting-export.r11-projections.ts`;
const OPENAPI = 'docs/api/openapi.yaml';
const SELF = 'tests/r11-part05c-stock-movement-register.test.ts';
const CHANGED = [TYPES, REG, R11PROJ, OPENAPI, SELF];
const HISTORICAL_TESTS = [
  'tests/r10-part20-closure-guard.test.ts',
  'tests/r11-part01-receiving-register-read.test.ts',
  'tests/r11-part02-receiving-register.test.ts',
  'tests/r11-part03b-purchase-order-line-register-read.test.ts',
  'tests/r11-part03c-purchase-order-register.test.ts',
  'tests/r11-part04-vendor-invoice-register.test.ts',
  'tests/r11-part05b-stock-movement-register-read.test.ts',
];

const typesSrc = rd(TYPES);
const regSrc = rd(REG);
const projSrc = rd(R11PROJ);
const openapiSrc = rd(OPENAPI);
const sReg = strip(regSrc);
const adapterBlock = regSrc.slice(regSrc.indexOf('  STOCK_MOVEMENT_REGISTER: {'));
const sAdapter = strip(adapterBlock);
const registryKeys = [...regSrc.matchAll(/^ {2}([A-Z][A-Z0-9_]+): \{$/gm)].map((m) => m[1]);
const archiveBlock = openapiSrc.split('    ReportArchiveDataset:')[1].split('    ReportArchiveFormat:')[0];
const enumBody = archiveBlock.slice(archiveBlock.indexOf('['), archiveBlock.indexOf(']') + 1);
const openapiEnum = enumBody.match(/[A-Z][A-Z0-9_]+/g) ?? [];

/** Dependency-free runtime imports (explicit .ts specifiers, house precedent). */
const types = await import('../src/modules/reporting-export/reporting-export.types.ts');
const r11proj = await import('../src/modules/reporting-export/reporting-export.r11-projections.ts');

const DATASETS = types.REPORTING_EXPORT_DATASETS;

/** Canned rows in the exact PublicStockMovementRegisterRow shape (source-verified field-for-field). */
const MOV_A = {
  stockMovementId: 'dddd0000-0000-4000-8000-000000000001',
  clientId: 'dddd0000-0000-4000-8000-0000000000c1',
  buildingId: 'dddd0000-0000-4000-8000-0000000000b1',
  warehouseId: 'dddd0000-0000-4000-8000-0000000000h1',
  itemId: 'dddd0000-0000-4000-8000-0000000000i1',
  movementType: 'STOCK_IN',
  quantity: 120.5,
  uomId: 'dddd0000-0000-4000-8000-0000000000m1',
  movementDate: '2026-09-05T02:00:00.000Z',
  reference: 'GRN-2026-0114',
  source: 'RECEIVING',
  performedByUserId: 'dddd0000-0000-4000-8000-0000000000u1',
  notes: null,
  resultingQuantityOnHand: 320.5,
  resultingAvailableQuantity: 300.5,
  createdAt: '2026-09-05T02:00:01.000Z',
};
const MOV_B = {
  ...MOV_A,
  stockMovementId: 'dddd0000-0000-4000-8000-000000000002',
  warehouseId: 'dddd0000-0000-4000-8000-0000000000h2',
  itemId: 'dddd0000-0000-4000-8000-0000000000i2',
  movementType: 'STOCK_OUT',
  quantity: 15,
  uomId: null,
  movementDate: '2026-09-08T03:30:00.000Z',
  reference: 'WO-2026-0233',
  source: 'WORK_ORDER',
  performedByUserId: 'dddd0000-0000-4000-8000-0000000000u2',
  notes: 'Material issued against corrective work',
  resultingQuantityOnHand: 305.5,
  resultingAvailableQuantity: 285.5,
  createdAt: '2026-09-08T03:30:02.000Z',
};

/** The 16 projected fields in authoritative record order (identity first). */
const ROW_KEYS = ['stockMovementId', 'clientId', 'buildingId', 'warehouseId', 'itemId',
  'movementType', 'quantity', 'uomId', 'movementDate', 'reference', 'source',
  'performedByUserId', 'notes', 'resultingQuantityOnHand', 'resultingAvailableQuantity',
  'createdAt'];

test('R11 P05C 01–06/50/51 — declared once, parity 22/22/22, sets and order equal, CSV default untouched', () => {
  // 01 — declared exactly once, appended last.
  assert.equal(DATASETS.filter((d) => d === 'STOCK_MOVEMENT_REGISTER').length, 1);
  assert.equal((typesSrc.match(/'STOCK_MOVEMENT_REGISTER',/g) ?? []).length, 1);
  assert.equal(DATASETS[DATASETS.length - 1], 'STOCK_MOVEMENT_REGISTER');
  // 02/03/04 — parity 22/22/22.
  assert.equal(DATASETS.length, 22, 'runtime dataset enum is 22');
  assert.equal(registryKeys.length, 22, 'registry adapter count is 22');
  assert.equal(openapiEnum.length, 22, 'OpenAPI dataset enum is 22');
  // 05/06 — same set everywhere; OpenAPI order matches runtime order position by position.
  assert.deepEqual([...registryKeys].sort(), [...DATASETS].sort());
  assert.deepEqual([...openapiEnum].sort(), [...DATASETS].sort());
  assert.deepEqual(openapiEnum, [...DATASETS]);
  assert.equal(new Set(registryKeys).size, 22);
  // 50/51 — no CSV default added; OPERATIONAL_DETAIL remains the ONLY configured default
  // (sole-table selection is sufficient for this dataset).
  assert.deepEqual(Object.keys(types.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
  assert.equal((typesSrc.match(/csvDefaultTableKey:/g) ?? []).length, 1);
  assert.equal(/csvDefaultTableKey/.test(adapterBlock), false);
  // The management subset is untouched.
  assert.deepEqual([...types.MANAGEMENT_REPORTING_EXPORT_DATASETS], ['MANAGEMENT_OPERATIONS_COMMAND_CENTER']);
  // OpenAPI documents the dataset and its table key.
  assert.equal(openapiSrc.includes('STOCK_MOVEMENT_REGISTER (R11)'), true);
  assert.ok(archiveBlock.includes('stockMovementRegister'));
});

test('R11 P05C 07–12/52–54 — public authority under inventory_stock.read; no repository, SQL, scope, route, migration or permission', () => {
  // 08 — the adapter imports the PUBLIC module contract (index): parser + governed read only.
  assert.match(regSrc, /import \{\s+getStockMovementRegister,\s+parseStockMovementRegisterQuery,\s+\} from '\.\.\/stock-movement-register';/);
  const smImports = [...regSrc.matchAll(/from '(\.\.\/stock-movement-register[^']*)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(smImports)], ['../stock-movement-register']);
  assert.match(sAdapter, /const filters = parseStockMovementRegisterQuery\(\{/);
  assert.match(sAdapter, /const source = await getStockMovementRegister\(filters, userId\);/);
  // 11 — the authenticated userId reaches the source authority; scope is never re-resolved.
  assert.equal((sAdapter.match(/\(filters, userId\)/g) ?? []).length, 1);
  // 12 — no Reporting-side scope resolution: no context-access or building authority symbol.
  assert.equal(/contextAccessService|getAccessibleBuildingIds|assertBuildingAccess|buildingRepository/.test(sAdapter), false);
  // 09/10 — the repository is NOT imported and Reporting issues no SQL at all.
  assert.equal(sReg.includes('stockMovementRegisterRepository'), false, 'no repository symbol in stripped registry');
  assert.equal(/getPool|\.query\(/.test(sReg), false);
  assert.equal(/FROM\s+inventory_stock_movements/i.test(regSrc), false);
  // 07 — the EXISTING permission is reused, source-verified where it already gates the owning
  // module's read routes; no new permission surface exists anywhere in this ripple.
  assert.match(adapterBlock, /requiredReadPermission: 'inventory_stock\.read'/);
  assert.match(rd('src/modules/inventory-stock-movements/inventory-stock-movement.routes.ts'),
    /requirePermission\('inventory_stock\.read'\)/);
  assert.equal(/requirePermission\(|code: '[a-z_]+\.(read|manage)'/.test(sAdapter), false);
  assert.equal(git('diff', BASE, '--', 'src/modules/auth'), '', 'no permission vocabulary changed');
  // 52 — no HTTP surface added.
  assert.equal(git('diff', BASE, '--', 'src/routes'), '');
  assert.equal(rd('src/routes/index.ts').includes('STOCK_MOVEMENT_REGISTER'), false);
  assert.equal(rd('src/routes/index.ts').includes('stock-movement-register'), false);
  // 53 — no migration added or changed.
  assert.equal(git('diff', BASE, '--', 'src/database'), '');
  // 54 — the foundation itself created no permission vocabulary and still creates none.
  assert.equal(/requirePermission|rbac/i.test(rd('src/modules/stock-movement-register/stock-movement-register.service.ts')), false);
});

test('R11 P05C 34–36 — date pass-through, no second parser/window, no createdAt fallback', () => {
  // 34 — dateFrom/dateTo are passed through under IDENTICAL names (no mapping exists to
  // misdescribe); exactly the eight documented keys are forwarded, so no other query key can
  // reach the source parser.
  assert.match(sAdapter, /dateFrom: passThrough\.dateFrom,\s+dateTo: passThrough\.dateTo,/);
  const forwarded = sAdapter.slice(sAdapter.indexOf('parseStockMovementRegisterQuery({'),
    sAdapter.indexOf('});', sAdapter.indexOf('parseStockMovementRegisterQuery({')));
  assert.deepEqual([...forwarded.matchAll(/(\w+): passThrough\.\w+/g)].map((m) => m[1]).sort(),
    ['buildingId', 'dateFrom', 'dateTo', 'itemId', 'movementType', 'performedByUserId',
      'reference', 'warehouseId']);
  // 35 — no second date parser or window in the adapter: no regex, midnight helper, day-millis
  // arithmetic, Date construction or calendar-date helper exists in the adapter code; the
  // envelope simply echoes the source's own accepted values and instant.
  assert.equal(/DATE_ONLY|toUtcMidnight|isCalendarDate|86400000|getTime\(|new Date\(/.test(sAdapter), false);
  assert.match(sAdapter, /dateFrom: source\.dateFrom,\s+dateTo: source\.dateTo,\s+asOf: source\.asOf,/);
  // The source foundation (byte-unchanged below) owns the strict validation and the half-open
  // UTC normalization — re-proven here against the frozen text.
  const fSvc = rd('src/modules/stock-movement-register/stock-movement-register.service.ts');
  assert.match(fSvc, /DATE_ONLY = \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  assert.match(fSvc, /MAX_RANGE_DAYS = 366/);
  assert.match(fSvc, /new Date\(toUtcMidnight\(filters\.dateTo\)\.getTime\(\) \+ 86400000\)/);
  // 36 — no createdAt period fallback: nothing but the source envelope's own movement-date
  // window values feeds the envelope period.
  assert.equal(/dateFrom: (?!source\.dateFrom|passThrough\.dateFrom)/.test(sAdapter), false);
  assert.equal(/dateTo: (?!source\.dateTo|passThrough\.dateTo)/.test(sAdapter), false);
  // The frozen foundation stays set-based, scoped, fail-closed, join-free and deterministically
  // ordered — the qualities that make the pure adapter safe.
  const fRepo = rd('src/modules/stock-movement-register/stock-movement-register.repository.ts');
  assert.match(fRepo, /if \(buildingIds\.length === 0\) return \[\];/);
  assert.match(fRepo, /movement\.building_id = ANY\(\$1::uuid\[\]\)/);
  assert.match(fRepo, /conditions\.push\(`movement\.movement_date >= \$\$\{values\.length\}`\)/);
  assert.match(fRepo, /conditions\.push\(`movement\.movement_date < \$\$\{values\.length\}`\)/);
  assert.equal(/movement_date\s*<=(?!=)/.test(fRepo), false, 'no midnight-truncation defect');
  assert.match(fRepo, /ORDER BY movement\.movement_date DESC, movement\.created_at DESC,\s+movement\.id DESC/);
  assert.equal((strip(fRepo).match(/\sJOIN\s/g) ?? []).length, 0, 'zero joins in the frozen source query');
});

test('R11 P05C 13–28/49 — projection executed: one table, all sixteen facts verbatim', () => {
  const projected = r11proj.projectStockMovementRegister([MOV_A, MOV_B]);
  // 49 — kpis empty; no movement count, stock-in/out total, net quantity, current balance,
  // inventory value, turnover or consumption figure exists.
  assert.deepEqual(projected.kpis, []);
  // 13/14 — exactly ONE table with the governed key.
  assert.equal(projected.tables.length, 1);
  const t = projected.tables[0];
  assert.equal(t.key, 'stockMovementRegister');
  assert.equal(t.label, 'Stock Movement Register');
  // 15 — one projected row per source row: two movements in, two rows out; no fan-out.
  assert.equal(t.rowCount, 2);
  assert.equal(t.rows.length, 2);
  // Column contract: the 16 authoritative fields in record order.
  assert.deepEqual(t.columns.map((c) => c.key), ROW_KEYS);
  for (const num of ['quantity', 'resultingQuantityOnHand', 'resultingAvailableQuantity']) {
    assert.equal(t.columns.find((c) => c.key === num).type, 'NUMBER');
  }
  for (const date of ['movementDate', 'createdAt']) {
    assert.equal(t.columns.find((c) => c.key === date).type, 'DATE');
  }
  for (const str of ['stockMovementId', 'clientId', 'buildingId', 'warehouseId', 'itemId',
    'movementType', 'uomId', 'reference', 'source', 'performedByUserId', 'notes']) {
    assert.equal(t.columns.find((c) => c.key === str).type, 'STRING');
  }
  // 16 — identity preserved; no bare id is ever published.
  assert.equal(t.rows[0].stockMovementId, MOV_A.stockMovementId);
  assert.equal(t.rows[1].stockMovementId, MOV_B.stockMovementId);
  assert.equal('id' in t.rows[0], false);
  // 17–28 — every fact verbatim for both rows: scope ids, native movement type, fractional
  // quantity, nullable UOM snapshot, period, generic reference/source texts, actor, notes, the
  // two historical snapshots and the audit instant.
  for (const [i, src] of [MOV_A, MOV_B].entries()) {
    const out = t.rows[i];
    assert.deepEqual(Object.keys(out).sort(), [...ROW_KEYS].sort());
    for (const k of ROW_KEYS) {
      assert.deepEqual(out[k], src[k], `${k} verbatim (row ${i})`);
    }
  }
  // 18 — native vocabulary preserved: STOCK_IN / STOCK_OUT exactly as persisted.
  assert.equal(t.rows[0].movementType, 'STOCK_IN');
  assert.equal(t.rows[1].movementType, 'STOCK_OUT');
  // 19/20 — fractional quantity and the nullable historical UOM snapshot verbatim.
  assert.equal(t.rows[0].quantity, 120.5);
  assert.equal(t.rows[1].uomId, null);
  // 26/27 — historical post-movement snapshots verbatim, under their own names.
  assert.equal(t.rows[0].resultingQuantityOnHand, 320.5);
  assert.equal(t.rows[0].resultingAvailableQuantity, 300.5);
  assert.equal(t.rows[1].resultingQuantityOnHand, 305.5);
  // 29–33 and semantics — no derived, relabeled or enriched field exists on any output row.
  for (const out of t.rows) {
    for (const invented of ['reservedQuantity', 'currentQuantityOnHand', 'currentAvailableQuantity',
      'currentBalance', 'status', 'directionLabel', 'receiptType', 'issueType', 'netQuantity',
      'totalQuantity', 'movementCount', 'unitCost', 'totalCost', 'currency', 'inventoryValue',
      'stockValue', 'warehouseName', 'itemName', 'uomName', 'warehouse', 'item', 'resultingBalance',
      'receivedByUserId', 'usedByUserId', 'consumedByUserId', 'requesterUserId', 'approverUserId',
      'executorUserId']) {
      assert.equal(invented in out, false, `no invented ${invented}`);
    }
  }
  // Empty source → still exactly one well-formed table.
  const empty = r11proj.projectStockMovementRegister([]);
  assert.equal(empty.tables.length, 1);
  assert.equal(empty.tables[0].rowCount, 0);
  assert.deepEqual(empty.kpis, []);
});

test('R11 P05C 29–33/37–48 — zero arithmetic, zero money, zero enrichment in adapter + projection', () => {
  // Scans are scoped to the adapter plus the STOCK MOVEMENT projection slice — the R11 seam
  // file legitimately also carries the receiving, purchase-order and vendor-invoice projections
  // of earlier PARTs, which are frozen and out of scope here.
  const sSmProj = strip(projSrc.slice(projSrc.indexOf('export function projectStockMovementRegister')));
  const sBoth = sAdapter + sSmProj;
  // 31/32/33 — no quantity aggregation, no UOM conversion, no net-movement derivation: no
  // arithmetic operator ever touches a quantity or snapshot, no rounding, no reduce.
  assert.equal(/quantity\s*[-+*/]|[-+*/]\s*quantity|resultingQuantityOnHand\s*[-+*/]|[-+*/]\s*resultingAvailableQuantity|toFixed|Math\.round|SUM\(|\.reduce\(|\.sort\(\(a/i.test(sBoth), false);
  assert.equal(/convert|normali[sz]e.*uom|uom.*convert/i.test(sBoth), false);
  // 29/30 — no reservedQuantity derivation and no current-balance alias anywhere in code.
  assert.equal(/reservedQuantity|currentQuantityOnHand|currentAvailableQuantity|currentBalance/i.test(sBoth), false);
  // 37–43 — ZERO monetary authority: no currency, money, cost, valuation, COGS, FX or price
  // catalog token exists in the adapter or projection code.
  assert.equal(/currency|unitCost|totalCost|averageCost|standardCost|inventoryValue|stockValue|COGS|valuation|FIFO|LIFO|weightedAverage|\bprice\b|\bamount\b|\bfx\b|exchange[Rr]ate|\btax\b|\bvat\b/i.test(sBoth), false);
  assert.equal(/price[_-]?catalog|priceCatalog/i.test(sBoth), false);
  // 18 (code side) — no vocabulary normalization and no invented lifecycle/direction labels.
  assert.equal(/'IN'|'OUT'|\bRECEIPT\b|\bISSUE\b|\bCONSUMPTION\b|directionLabel|receiptType|issueType|\bstatus\b/i.test(sBoth), false);
  // 44–47 — no reverse-domain or drill enrichment: the owning module's public list, receiving,
  // WO-usage, reservation, PO, invoice, budget and commitment authorities are never called,
  // and no balance domain is consulted.
  assert.equal(/listMovements|getMovementById|inventoryStockMovementService|inventoryStockMovementRepository|receivings|material_usages|material_requests|reservations|purchase_orders|vendor_invoices|stock_transfers|stock_adjustments|inventory_stock_balances|budget|commitment/i.test(sBoth), false);
  // 48 — no display-name enrichment of any kind.
  assert.equal(/warehouseName|itemName|uomName|displayName|\.name\b/i.test(sBoth), false);
  // The projection seam stays dependency-free at runtime (type-only imports only).
  assert.equal(/^import\s+(?!type)/m.test(projSrc), false);
  assert.match(projSrc, /^import type \{ PublicStockMovementRegisterRow \} from '\.\.\/stock-movement-register';$/m);
  // Governance token discipline (scan scope matches the guard and PART 01–04).
  const all = typesSrc + regSrc + openapiSrc;
  for (const banned of ['PART 21', 'PART21', 'R11 —', 'COMMERCIAL_JOURNEY', 'RESOURCE_JOURNEY',
    'SERVICE_JOURNEY']) {
    assert.equal(all.includes(banned), false, `no ${banned} artifact exists`);
  }
});

test('R11 P05C 55–57 — foundation, owning module and historical tests byte-unchanged; bounded footprint', () => {
  // 55 — the PART 05B source foundation is byte-unchanged versus its own closure baseline.
  assert.equal(git('diff', BASE, '--', 'src/modules/stock-movement-register'), '',
    'source foundation untouched');
  // 56 — the owning movements authority and every previously closed source/frozen surface is
  // byte-unchanged.
  assert.equal(git('diff', BASE, '--', 'src/modules/inventory-stock-movements',
    'src/modules/receiving-register', 'src/modules/purchase-order-line-register',
    'src/modules/purchase-orders', 'src/modules/vendor-invoices',
    `${RE}/reporting-export.service.ts`, `${RE}/reporting-export.projections.ts`,
    `${RE}/reporting-export.management-projections.ts`, `${RE}/reporting-export.r10-projections.ts`),
  '', 'owning module, source authorities and frozen Reporting files untouched');
  // 57 — every historical test is blob-identical to the baseline and none was executed; the
  // only test touched is this file (commit-state independent).
  for (const t of HISTORICAL_TESTS) {
    assert.equal(git('hash-object', t), git('rev-parse', `${BASE}:${t}`), `${t} blob identical`);
  }
  const trackedTestChanges = git('diff', '--name-only', BASE, '--', 'tests').split('\n').filter(Boolean);
  const untrackedTests = git('ls-files', '--others', '--exclude-standard', 'tests').split('\n').filter(Boolean);
  assert.deepEqual([...new Set([...trackedTestChanges, ...untrackedTests])], [SELF]);
  // Bounded PART 05C footprint: the four registration-ripple files plus this test only.
  const changedTracked = git('diff', '--name-only', BASE).split('\n').filter(Boolean);
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  const changed = [...new Set([...changedTracked, ...untracked])];
  assert.deepEqual(changed.filter((f) => !CHANGED.includes(f)), [],
    'PART 05C changes only the registration ripple + this test');
});

test('R11 P05C — type-strip validation of every changed TS file; registry structurally closed', () => {
  for (const f of [TYPES, REG, R11PROJ, SELF]) {
    assert.doesNotThrow(() => stripTypeScriptTypes(rd(f), { mode: 'strip' }), `${f} type-strips cleanly`);
  }
  // The adapter is the LAST registry entry and the registry object stays structurally closed
  // (the dropped-brace defect class R10 PART 19 caught).
  assert.match(regSrc, /\n\};\n\nexport function getReportingExportDatasetAdapter\(/);
  assert.equal(registryKeys[registryKeys.length - 1], 'STOCK_MOVEMENT_REGISTER');
  // The projection is wired into the registry's R11 seam import.
  assert.match(regSrc, /projectReceivingRegister,\s+projectStockMovementRegister,\s+projectVendorInvoiceRegister,\s+\} from '\.\/reporting-export\.r11-projections';/);
});
