/**
 * R11 PART 03C — PURCHASE_ORDER_REGISTER registration: focused contract test.
 *
 * Proves the 19 → 20 registration ripple and the two-view adapter/projection
 * contract WITHOUT executing any historical test and WITHOUT live PostgreSQL
 * (node_modules absent). Method — the R11 PART 02 hybrid, unchanged:
 *
 *   - the frozen dataset vocabulary, the new `view` vocabulary + type guard
 *     and the CSV-default metadata are EXECUTED for real (dependency-free);
 *   - BOTH projections are EXECUTED for real against canned authoritative
 *     rows (the projection seam keeps type-only imports only);
 *   - the registry adapter and the OpenAPI ripple are proven from source
 *     text, plus `stripTypeScriptTypes` syntax validation of every changed
 *     file;
 *   - byte-identity of both source authority modules, all frozen Reporting
 *     surfaces and every historical test is proven via git against the
 *     PART 03B baseline.
 *
 * PROVES (PART 03C checklist 1–47): declared once; view required with no
 * default and only HEADER|LINE; 20/20/20 parity with equal sets and order;
 * permission purchase_order.read reused (no price_catalog.read); HEADER via
 * the public purchase-orders authority with dateFrom/dateTo transport-mapped
 * to poDateFrom/poDateTo and LINE-only filters fail-closed; LINE via the
 * public purchase-order-line-register with header-native date names
 * fail-closed; one selected table per response (purchaseOrderHeader /
 * purchaseOrderLine); id → purchaseOrderId; every fact verbatim (status,
 * currency, lineage, snapshots, money, parent status); no header total, no
 * lineStatus, kpis = [], no monetary arithmetic / FX / price catalog / RFQ /
 * receiving / invoice / SPK enrichment; no repository import, no SQL; no CSV
 * default added; no route, no migration, no new permission; source modules
 * and historical tests byte-unchanged.
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

/** PART 03B closure — the fixed baseline this PART builds on. */
const BASE = '53cda5cba9ee0136d74ebf96cfdb3cfab22446e4';
const RE = 'src/modules/reporting-export';
const TYPES = `${RE}/reporting-export.types.ts`;
const REG = `${RE}/reporting-export.registry.ts`;
const R11PROJ = `${RE}/reporting-export.r11-projections.ts`;
const OPENAPI = 'docs/api/openapi.yaml';
const SELF = 'tests/r11-part03c-purchase-order-register.test.ts';
const CHANGED = [TYPES, REG, R11PROJ, OPENAPI, SELF];
const HISTORICAL_TESTS = [
  'tests/r10-part20-closure-guard.test.ts',
  'tests/r11-part01-receiving-register-read.test.ts',
  'tests/r11-part02-receiving-register.test.ts',
  'tests/r11-part03b-purchase-order-line-register-read.test.ts',
];

const typesSrc = rd(TYPES);
const regSrc = rd(REG);
const projSrc = rd(R11PROJ);
const openapiSrc = rd(OPENAPI);
const sReg = strip(regSrc);
const sProj = strip(projSrc);
const adapterBlock = regSrc.slice(regSrc.indexOf('  PURCHASE_ORDER_REGISTER: {'));
const sAdapter = strip(adapterBlock);
const readerSrc = regSrc.slice(
  regSrc.indexOf('function readPurchaseOrderRegisterView'),
  regSrc.indexOf('export const REPORTING_EXPORT_DATASET_REGISTRY'),
);
const registryKeys = [...regSrc.matchAll(/^ {2}([A-Z][A-Z0-9_]+): \{$/gm)].map((m) => m[1]);
const archiveBlock = openapiSrc.split('    ReportArchiveDataset:')[1].split('    ReportArchiveFormat:')[0];
const enumBody = archiveBlock.slice(archiveBlock.indexOf('['), archiveBlock.indexOf(']') + 1);
const openapiEnum = enumBody.match(/[A-Z][A-Z0-9_]+/g) ?? [];

/** Dependency-free runtime imports (explicit .ts specifiers, house precedent). */
const types = await import('../src/modules/reporting-export/reporting-export.types.ts');
const r11proj = await import('../src/modules/reporting-export/reporting-export.r11-projections.ts');

const DATASETS = types.REPORTING_EXPORT_DATASETS;

/** Canned HEADER row in the exact PublicPurchaseOrder shape. */
const HDR = {
  id: 'aaaa0000-0000-4000-8000-000000000001',
  clientId: 'aaaa0000-0000-4000-8000-0000000000c1',
  buildingId: 'aaaa0000-0000-4000-8000-0000000000b1',
  poNumber: 'PO-2026-000123',
  poDate: '2026-09-01',
  vendorId: 'aaaa0000-0000-4000-8000-0000000000e1',
  requestType: 'PURCHASE_REQUEST',
  purchaseRequestId: 'aaaa0000-0000-4000-8000-0000000000f1',
  serviceRequestId: null,
  poReadinessId: 'aaaa0000-0000-4000-8000-0000000000a1',
  currency: 'IDR',
  status: 'ISSUED',
  vendorReference: 'Q-8891',
  requiredDate: '2026-09-15',
  notes: null,
  createdByUserId: 'aaaa0000-0000-4000-8000-0000000000d1',
  issuedAt: '2026-09-02T02:00:00.000Z',
  issuedByUserId: 'aaaa0000-0000-4000-8000-0000000000d2',
  cancelledAt: null,
  cancelledByUserId: null,
  createdAt: '2026-09-01T01:00:00.000Z',
  updatedAt: '2026-09-02T02:00:00.000Z',
};
const HDR_KEYS = ['purchaseOrderId', 'clientId', 'buildingId', 'vendorId', 'purchaseRequestId',
  'serviceRequestId', 'poReadinessId', 'requestType', 'poNumber', 'currency', 'status', 'poDate',
  'requiredDate', 'vendorReference', 'notes', 'createdByUserId', 'issuedByUserId', 'issuedAt',
  'cancelledByUserId', 'cancelledAt', 'createdAt', 'updatedAt'];

/** Canned LINE rows in the exact PART 03B public row shape (MATERIAL + SERVICE). */
const LNM = {
  purchaseOrderLineId: 'bbbb0000-0000-4000-8000-000000000011',
  purchaseOrderId: HDR.id,
  clientId: HDR.clientId,
  buildingId: HDR.buildingId,
  vendorId: HDR.vendorId,
  purchaseRequestId: HDR.purchaseRequestId,
  poNumber: HDR.poNumber,
  poDate: '2026-09-01',
  currency: 'IDR',
  purchaseOrderStatus: 'ISSUED',
  lineNumber: 1,
  requestLineType: 'MATERIAL_REQUEST',
  materialRequestId: 'bbbb0000-0000-4000-8000-000000000021',
  serviceRequestId: null,
  itemId: 'bbbb0000-0000-4000-8000-000000000031',
  uomId: 'bbbb0000-0000-4000-8000-000000000041',
  sourceServiceId: null,
  description: 'Spare part A',
  quantitySnapshot: 4,
  unitPrice: 25000.5,
  lineAmount: 100002,
  notes: null,
  createdByUserId: HDR.createdByUserId,
  createdAt: '2026-09-01T01:30:00.000Z',
  updatedAt: '2026-09-01T01:30:00.000Z',
};
const LNS = {
  ...LNM,
  purchaseOrderLineId: 'bbbb0000-0000-4000-8000-000000000012',
  lineNumber: 2,
  requestLineType: 'SERVICE_REQUEST',
  materialRequestId: null,
  // A PR-based PO carrying a service line: the LINE's own originating SR is
  // set while the parent purchaseRequestId anchor stays — the exact case in
  // which parent and line facts differ and neither may overwrite the other.
  serviceRequestId: 'bbbb0000-0000-4000-8000-000000000051',
  itemId: null,
  uomId: null,
  sourceServiceId: 'bbbb0000-0000-4000-8000-000000000061',
  description: 'AC maintenance visit',
  quantitySnapshot: null,
  unitPrice: 750000,
  lineAmount: 750000,
};
const LINE_KEYS = Object.keys(LNM);

test('R11 P03C 01/02/03/04/05/06/07/41/42 — vocabulary executed: declared once, view frozen, 20/20/20', () => {
  // 01 — declared exactly once, appended last.
  assert.equal(DATASETS.filter((d) => d === 'PURCHASE_ORDER_REGISTER').length, 1);
  assert.equal((typesSrc.match(/'PURCHASE_ORDER_REGISTER',/g) ?? []).length, 1);
  assert.equal(DATASETS[DATASETS.length - 1], 'PURCHASE_ORDER_REGISTER');
  // 04/05/06 — parity 20/20/20.
  assert.equal(DATASETS.length, 20, 'runtime dataset enum is 20');
  assert.equal(registryKeys.length, 20, 'registry adapter count is 20');
  assert.equal(openapiEnum.length, 20, 'OpenAPI dataset enum is 20');
  // 07 — same set everywhere and OpenAPI order matches runtime order position by position.
  assert.deepEqual([...registryKeys].sort(), [...DATASETS].sort());
  assert.deepEqual([...openapiEnum].sort(), [...DATASETS].sort());
  assert.deepEqual(openapiEnum, [...DATASETS]);
  assert.equal(new Set(registryKeys).size, 20);
  // 02/03 — the view vocabulary is frozen at HEADER|LINE and the guard is exact-case; the
  // registry reader (proven statically below) rejects everything else instead of defaulting.
  assert.deepEqual([...types.PURCHASE_ORDER_REGISTER_VIEWS], ['HEADER', 'LINE']);
  assert.equal(types.isPurchaseOrderRegisterView('HEADER'), true);
  assert.equal(types.isPurchaseOrderRegisterView('LINE'), true);
  assert.equal(types.isPurchaseOrderRegisterView('header'), false, 'guard is exact; reader normalizes');
  assert.equal(types.isPurchaseOrderRegisterView('DRAFT'), false);
  assert.equal(types.isPurchaseOrderRegisterView(''), false);
  assert.equal(types.isPurchaseOrderRegisterView(undefined), false);
  assert.equal(types.isPurchaseOrderRegisterView(['HEADER']), false, 'repeated values never pass');
  // 41/42 — no CSV default added; OPERATIONAL_DETAIL remains the ONLY configured default.
  assert.deepEqual(Object.keys(types.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
  assert.equal((typesSrc.match(/csvDefaultTableKey:/g) ?? []).length, 1);
  assert.equal(/csvDefaultTableKey/.test(adapterBlock), false, 'adapter configures no CSV default');
  // The management subset is untouched.
  assert.deepEqual([...types.MANAGEMENT_REPORTING_EXPORT_DATASETS], ['MANAGEMENT_OPERATIONS_COMMAND_CENTER']);
  // OpenAPI documents the dataset and BOTH table keys.
  assert.equal(openapiSrc.includes('PURCHASE_ORDER_REGISTER (R11)'), true);
  assert.ok(archiveBlock.includes('purchaseOrderHeader') && archiveBlock.includes('purchaseOrderLine'));
});

test('R11 P03C 02/03/08/12/45 — view required fail-closed, cross-view filters rejected, permission reused', () => {
  // 02 — the reader mirrors readSecurityOperationalDetailSource exactly: normalized, validated,
  // and every missing/empty/array/unknown value rejected via the established Reporting
  // query-validation behavior. NO default exists anywhere.
  assert.match(readerSrc, /const raw = typeof value === 'string' \? value\.trim\(\)\.toUpperCase\(\) : undefined;/);
  assert.match(readerSrc, /if \(!raw \|\| !isPurchaseOrderRegisterView\(raw\)\) \{\s+throw AppError\.validation\('Request validation failed\.', \[/);
  assert.match(readerSrc, /view is required and must be one of: \$\{PURCHASE_ORDER_REGISTER_VIEWS\.join\(', '\)\}/);
  assert.match(sAdapter, /const view = readPurchaseOrderRegisterView\(passThrough\.view\);/);
  for (const dflt of ["?? 'HEADER'", "|| 'HEADER'", "?? 'LINE'", "|| 'LINE'", "view = 'HEADER'", "view: 'HEADER'"]) {
    assert.equal(sAdapter.includes(dflt), false, `no default view (${dflt})`);
  }
  // 03 — only the two frozen members route: HEADER branch + exhausted-vocabulary LINE branch.
  assert.match(sAdapter, /if \(view === 'HEADER'\) \{/);
  // 12 — HEADER: LINE-only filters FAIL CLOSED (never silently ignored by the owning parser).
  assert.match(sAdapter, /\(\['materialRequestId', 'itemId'\] as const\)\.filter\(\s*\(key\) => passThrough\[key\] !== undefined && passThrough\[key\] !== null,\s*\)/);
  assert.match(sAdapter, /only valid for view=LINE/);
  // LINE: header-native period names FAIL CLOSED symmetrically.
  assert.match(sAdapter, /\(\['poDateFrom', 'poDateTo'\] as const\)\.filter\(/);
  assert.match(sAdapter, /not a PURCHASE_ORDER_REGISTER query name; use dateFrom\/dateTo/);
  // 08/45 — the EXISTING purchase_order.read is reused (source-verified where it already gates
  // the PO routes); price_catalog.read is NOT added; no new permission surface exists.
  assert.match(adapterBlock, /requiredReadPermission: 'purchase_order\.read'/);
  assert.match(rd('src/modules/purchase-orders/purchase-order.routes.ts'), /requirePermission\('purchase_order\.read'\)/);
  assert.equal(/price_catalog\.read/.test(sAdapter), false, 'deviation gating stays out');
  assert.equal(/requirePermission\(|code: '[a-z_]+\.(read|manage)'/.test(sAdapter), false);
  assert.equal(git('diff', BASE, '--', 'src/modules/auth'), '', 'no permission vocabulary changed');
  // The frozen view vocabulary is declared once, in types — the registry only consumes it.
  assert.equal((typesSrc.match(/PURCHASE_ORDER_REGISTER_VIEWS = \[/g) ?? []).length, 1);
  assert.equal(/PURCHASE_ORDER_REGISTER_VIEWS = \[/.test(regSrc), false);
});

test('R11 P03C 09/10/11/19/20/21/34 — both views consume PUBLIC authorities only; transport mapping; userId passed', () => {
  // 09 — HEADER: the public purchase-orders authority, parser + list read, nothing else.
  assert.match(regSrc, /import \{\s+listPurchaseOrders,\s+parsePurchaseOrderFilters,\s+\} from '\.\.\/purchase-orders';/);
  assert.match(sAdapter, /const filters = parsePurchaseOrderFilters\(\{/);
  assert.match(sAdapter, /const rows = await listPurchaseOrders\(filters, userId\);/);
  // 20 — LINE: the public purchase-order-line-register authority from PART 03B.
  assert.match(regSrc, /import \{\s+getPurchaseOrderLineRegister,\s+parsePurchaseOrderLineRegisterQuery,\s+\} from '\.\.\/purchase-order-line-register';/);
  assert.match(sAdapter, /const filters = parsePurchaseOrderLineRegisterQuery\(passThrough\);/);
  assert.match(sAdapter, /const source = await getPurchaseOrderLineRegister\(filters, userId\);/);
  // 34 — the authenticated userId reaches BOTH source authorities (the load signature itself
  // carries it; exactly two source calls consume it); scope is never re-resolved.
  assert.equal((sAdapter.match(/\(filters, userId\)/g) ?? []).length, 2);
  assert.equal(/contextAccessService|getAccessibleBuildingIds|assertBuildingAccess/.test(sAdapter), false);
  // 10/21 — NO repository of either module is imported and Reporting issues no SQL at all.
  for (const repo of ['purchaseOrderRepository', 'purchaseOrderLineRepository',
    'purchaseOrderLineRegisterRepository']) {
    assert.equal(sReg.includes(repo), false, `${repo} never appears in stripped registry code`);
  }
  assert.equal(/getPool|\.query\(/.test(sReg), false, 'no SQL from Reporting');
  assert.equal(/FROM\s+purchase_order/i.test(regSrc), false);
  // 11 — dateFrom/dateTo → poDateFrom/poDateTo is a pure transport mapping for HEADER only:
  // exactly the seven documented keys are forwarded and the owning parser validates them.
  assert.match(sAdapter, /poDateFrom: passThrough\.dateFrom,\s+poDateTo: passThrough\.dateTo,/);
  const forwarded = sAdapter.slice(sAdapter.indexOf('parsePurchaseOrderFilters({'),
    sAdapter.indexOf('});', sAdapter.indexOf('parsePurchaseOrderFilters({')));
  assert.deepEqual([...forwarded.matchAll(/(\w+): passThrough\.\w+/g)].map((m) => m[1]).sort(),
    ['buildingId', 'poDateFrom', 'poDateTo', 'purchaseRequestId', 'serviceRequestId', 'status', 'vendorId']);
  assert.match(sAdapter, /dateFrom: filters\.poDateFrom \?\? null,\s+dateTo: filters\.poDateTo \?\? null,/);
  // The LINE branch never touches the header authority and vice versa (no merged mega-read).
  // The LINE branch is the exhausted-vocabulary remainder, anchored at its own fail-closed
  // header-native-name rejection.
  const lineBranchAt = sAdapter.indexOf('const headerNativePresent');
  assert.ok(lineBranchAt > 0);
  const headerBranch = sAdapter.slice(sAdapter.indexOf("if (view === 'HEADER')"), lineBranchAt);
  assert.equal(/getPurchaseOrderLineRegister|projectPurchaseOrderLine/.test(headerBranch), false);
  const lineBranch = sAdapter.slice(lineBranchAt);
  assert.equal(/listPurchaseOrders|parsePurchaseOrderFilters|projectPurchaseOrderHeader/.test(lineBranch), false);
  // 19 — HEADER rows are the untouched source rows: no lines child, no enrichment fetch.
  assert.match(sAdapter, /projectPurchaseOrderHeader\(rows\)/);
  // Both views echo view + only the filters the owning parser accepted.
  assert.equal((sAdapter.match(/echoFilters\(filters, \{ view \}\)/g) ?? []).length, 2);
  // LINE common is the owning envelope forwarded field-for-field; HEADER asOf is minted
  // immediately before the call (rows-only source convention) — the only Reporting clock.
  assert.match(sAdapter, /buildingId: source\.buildingId,\s+buildingScope: source\.buildingScope,\s+dateFrom: source\.dateFrom,\s+dateTo: source\.dateTo,\s+asOf: source\.asOf,/);
  assert.match(sAdapter, /const asOf = new Date\(\)\.toISOString\(\);\s+const rows = await listPurchaseOrders/);
  assert.match(sAdapter, /buildingScope: \[\.\.\.new Set\(rows\.map\(\(row\) => row\.buildingId\)\)\]\.sort\(\)/);
});

test('R11 P03C 13–18 — HEADER projection executed: one table, id→purchaseOrderId, verbatim, no total', () => {
  const projected = r11proj.projectPurchaseOrderHeader([HDR]);
  // 35 (header) — kpis empty.
  assert.deepEqual(projected.kpis, []);
  // 13/14 — exactly ONE table with the frozen key.
  assert.equal(projected.tables.length, 1);
  const t = projected.tables[0];
  assert.equal(t.key, 'purchaseOrderHeader');
  assert.equal(t.label, 'Purchase Order Header');
  assert.equal(t.rowCount, 1);
  // 22 columns in authoritative order.
  assert.deepEqual(t.columns.map((c) => c.key), HDR_KEYS);
  assert.equal(t.columns.find((c) => c.key === 'poDate').type, 'DATE');
  assert.equal(t.columns.find((c) => c.key === 'currency').type, 'STRING');
  const out = t.rows[0];
  // 15 — identity mapping: source `id` published ONLY as the explicit purchaseOrderId.
  assert.equal(out.purchaseOrderId, HDR.id);
  assert.equal('id' in out, false, 'never published as a bare id');
  assert.deepEqual(Object.keys(out).sort(), [...HDR_KEYS].sort());
  // 16/17 — native status and currency verbatim; every other fact copied field-for-field.
  assert.equal(out.status, 'ISSUED');
  assert.equal(out.currency, 'IDR');
  for (const k of HDR_KEYS) {
    const srcKey = k === 'purchaseOrderId' ? 'id' : k;
    assert.deepEqual(out[k], HDR[srcKey], `${k} verbatim`);
  }
  // 18 — NO header total and no quantity ledger of any kind.
  for (const banned of ['totalAmount', 'orderedQuantity', 'receivedQuantity', 'remainingQuantity',
    'lineCount', 'lines', 'amount', 'total']) {
    assert.equal(banned in out, false, `no ${banned} on the header row`);
    assert.equal(t.columns.some((c) => c.key === banned), false);
  }
  // Empty source → still exactly one well-formed table.
  const empty = r11proj.projectPurchaseOrderHeader([]);
  assert.equal(empty.tables.length, 1);
  assert.equal(empty.tables[0].rowCount, 0);
  assert.deepEqual(empty.kpis, []);
});

test('R11 P03C 22–33/35 — LINE projection executed: one table, all 25 facts verbatim, no lineStatus', () => {
  const projected = r11proj.projectPurchaseOrderLine([LNM, LNS]);
  // 35 (line) — kpis empty.
  assert.deepEqual(projected.kpis, []);
  // 22/23 — exactly ONE table with the frozen key.
  assert.equal(projected.tables.length, 1);
  const t = projected.tables[0];
  assert.equal(t.key, 'purchaseOrderLine');
  assert.equal(t.label, 'Purchase Order Line');
  assert.equal(t.rowCount, 2);
  // 25 columns in authoritative order.
  assert.deepEqual(t.columns.map((c) => c.key), LINE_KEYS);
  assert.equal(LINE_KEYS.length, 25);
  for (const money of ['unitPrice', 'lineAmount', 'quantitySnapshot', 'lineNumber']) {
    assert.equal(t.columns.find((c) => c.key === money).type, 'NUMBER');
  }
  assert.equal(t.columns.find((c) => c.key === 'poDate').type, 'DATE');
  // 24–32 — every fact copied verbatim for BOTH line shapes, nulls preserved.
  for (const [i, src] of [LNM, LNS].entries()) {
    const out = t.rows[i];
    assert.deepEqual(Object.keys(out).sort(), [...LINE_KEYS].sort());
    for (const k of LINE_KEYS) {
      assert.deepEqual(out[k], src[k], `${k} verbatim (row ${i})`);
    }
  }
  // 24 — identity preserved.
  assert.equal(t.rows[0].purchaseOrderLineId, LNM.purchaseOrderLineId);
  // 25 — the authoritative persisted discriminator, both native values, never inferred.
  assert.equal(t.rows[0].requestLineType, 'MATERIAL_REQUEST');
  assert.equal(t.rows[1].requestLineType, 'SERVICE_REQUEST');
  // 26 — the LINE's own serviceRequestId survives next to the parent purchaseRequestId anchor
  // (PR-based PO with a service line): never overwritten with parent-header semantics.
  assert.equal(t.rows[1].serviceRequestId, LNS.serviceRequestId);
  assert.equal(t.rows[1].purchaseRequestId, HDR.purchaseRequestId);
  // 27/28 — lineage and frozen snapshot verbatim; SERVICE null preserved.
  assert.equal(t.rows[0].materialRequestId, LNM.materialRequestId);
  assert.equal(t.rows[0].quantitySnapshot, 4);
  assert.equal(t.rows[1].quantitySnapshot, null);
  // 29/30/31 — money and currency verbatim, no recomputation observable (4 × 25000.5 = 100002
  // was persisted by the source; the projection copies, it never multiplies).
  assert.equal(t.rows[0].unitPrice, 25000.5);
  assert.equal(t.rows[0].lineAmount, 100002);
  assert.equal(t.rows[1].lineAmount, 750000);
  assert.equal(t.rows[0].currency, 'IDR');
  // 32/33 — parent status under its explicit name; no line lifecycle exists.
  assert.equal(t.rows[0].purchaseOrderStatus, 'ISSUED');
  for (const out of t.rows) {
    assert.equal('lineStatus' in out, false);
    assert.equal('status' in out, false, 'no unqualified status on a line row');
  }
  assert.equal(/lineStatus/.test(sProj), false);
  // No PO total is materialized at the line grain either.
  for (const out of t.rows) {
    assert.equal('totalAmount' in out, false);
    assert.equal('poTotal' in out, false);
  }
  const empty = r11proj.projectPurchaseOrderLine([]);
  assert.equal(empty.tables.length, 1);
  assert.equal(empty.tables[0].rowCount, 0);
  assert.deepEqual(empty.kpis, []);
});

test('R11 P03C 36–40 — no arithmetic, FX, price catalog, RFQ or other commercial enrichment', () => {
  const sBoth = sAdapter + sProj;
  // 36 — no monetary arithmetic anywhere in adapter or projections.
  assert.equal(/quantitySnapshot\s*\*|\*\s*unitPrice|unitPrice\s*\*|\*\s*quantity|lineAmount\s*[-+*/]|toFixed|Math\.round|SUM\(|\.reduce\(/.test(sBoth), false);
  // 37 — no FX or conversion.
  assert.equal(/\bfx\b|exchange|convert/i.test(sBoth), false);
  // 38 — no price catalog or deviation surface.
  assert.equal(/price[_-]?catalog|priceCatalog|deviation/i.test(sBoth), false);
  // 39/40 — no RFQ, readiness FETCH, receiving, invoice, SPK, work-order or commitment
  // enrichment: no such module is imported and no such token survives in stripped code.
  // (`poReadinessId` is the header row's OWN persisted id and is legitimately projected —
  // only fetching/enriching the readiness authority is prohibited.)
  assert.equal(/rfq|purchase-order-readiness|readinessService|readinessRepository|receivings|vendor_invoice|vendorInvoice|work_order|workOrder|\bspk\b|commitment/i.test(sBoth), false);
  // The ONLY purchase-order-family modules the registry imports are the two view authorities —
  // the purchase-order-readiness drill is provably not among them. (The registry's pre-existing
  // work-order-register / work-order-sla-register imports belong to the R10 WORK_ORDER_REGISTER
  // and WORK_ORDER_SLA datasets and are untouched by this PART.)
  const poImports = [...regSrc.matchAll(/from '(\.\.\/purchase-order[^']*)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(poImports)].sort(), ['../purchase-order-line-register', '../purchase-orders']);
  // The projection seam stays dependency-free at runtime (type-only imports only).
  assert.equal(/^import\s+(?!type)/m.test(projSrc), false);
  assert.match(projSrc, /^import type \{ PublicPurchaseOrder \} from '\.\.\/purchase-orders';$/m);
  assert.match(projSrc, /^import type \{ PublicPurchaseOrderLineRegisterRow \} from '\.\.\/purchase-order-line-register';$/m);
  // Governance token discipline (R10 guard bans kept without running it; scan scope matches
  // the guard and PART 01/02: enum, registry, OpenAPI).
  const all = typesSrc + regSrc + openapiSrc;
  for (const banned of ['PART 21', 'PART21', 'R11 —', 'COMMERCIAL_JOURNEY', 'RESOURCE_JOURNEY',
    'SERVICE_JOURNEY']) {
    assert.equal(all.includes(banned), false, `no ${banned} artifact exists`);
  }
});

test('R11 P03C 43/44/46/47 — no route, no migration, source modules and historical tests byte-unchanged', () => {
  // 43 — no HTTP surface added for this dataset.
  assert.equal(git('diff', BASE, '--', 'src/routes'), '');
  assert.equal(rd('src/routes/index.ts').includes('PURCHASE_ORDER_REGISTER'), false);
  // 44 — no migration added or changed.
  assert.equal(git('diff', BASE, '--', 'src/database'), '');
  // 46 — BOTH source authority modules and every frozen Reporting surface are byte-unchanged.
  assert.equal(git('diff', BASE, '--', 'src/modules/purchase-orders',
    'src/modules/purchase-order-line-register', 'src/modules/receiving-register',
    `${RE}/reporting-export.service.ts`, `${RE}/reporting-export.projections.ts`,
    `${RE}/reporting-export.management-projections.ts`, `${RE}/reporting-export.r10-projections.ts`),
  '', 'source authorities and frozen Reporting files untouched');
  // 47 — every historical test is byte-unchanged (blob-identical to the baseline) and none was
  // executed by this PART; the only test touched is this file.
  for (const t of HISTORICAL_TESTS) {
    assert.equal(git('hash-object', t), git('rev-parse', `${BASE}:${t}`), `${t} blob identical`);
  }
  const trackedTestChanges = git('diff', '--name-only', BASE, '--', 'tests').split('\n').filter(Boolean);
  const untrackedTests = git('ls-files', '--others', '--exclude-standard', 'tests').split('\n').filter(Boolean);
  assert.deepEqual([...new Set([...trackedTestChanges, ...untrackedTests])], [SELF]);
  // Bounded PART 03C footprint: the four registration-ripple files plus this test only.
  const changedTracked = git('diff', '--name-only', BASE).split('\n').filter(Boolean);
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  const changed = [...new Set([...changedTracked, ...untracked])];
  assert.deepEqual(changed.filter((f) => !CHANGED.includes(f)), [],
    'PART 03C changes only the registration ripple + this test');
});

test('R11 P03C — type-strip validation of every changed file', () => {
  for (const f of [TYPES, REG, R11PROJ, SELF]) {
    assert.doesNotThrow(() => stripTypeScriptTypes(rd(f), { mode: 'strip' }), `${f} type-strips cleanly`);
  }
  // The adapter is the LAST registry entry and the registry object stays structurally closed
  // (the dropped-brace defect class R10 PART 19 caught): the getter still follows the object.
  assert.match(regSrc, /\n\};\n\nexport function getReportingExportDatasetAdapter\(/);
  assert.equal(registryKeys[registryKeys.length - 1], 'PURCHASE_ORDER_REGISTER');
});
