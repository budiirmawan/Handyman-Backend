/**
 * R11 PART 02 — RECEIVING_REGISTER registration: focused contract test.
 *
 * Proves the 18 → 19 registration ripple and the adapter/projection contract
 * WITHOUT executing the R10 closure guard and WITHOUT touching any historical
 * R10 test. Method: the dependency-free runtime surfaces are EXECUTED for real
 * under `node --test` with native TypeScript type stripping (node_modules is
 * absent; live-PostgreSQL execution of the full adapter chain remains
 * CI-required, exactly as in R10 PART 19):
 *
 *   - the frozen dataset enum + CSV-default metadata (reporting-export.types)
 *   - the RECEIVING_REGISTER projection (reporting-export.r11-projections) —
 *     fed canned authoritative rows and OBSERVED: one table, key, rowCount,
 *     column order, verbatim field copies, empty kpis
 *
 * The registry adapter (which transitively imports every sibling KPI module
 * and cannot load without node_modules) and the OpenAPI ripple are proven
 * from source text, plus `stripTypeScriptTypes` syntax validation of every
 * changed TypeScript file — the defect class R10 PART 19 caught at runtime
 * (a dropped brace in the registry) is caught here at strip time.
 *
 * PROVES (PART 02 checklist 1–31): dataset declared once; 19/19/19 parity;
 * equal sets; adapter consumes the PART 01 PUBLIC authority (no repository
 * import); permission `receiving.read` reused; userId passed through; one
 * table `receivingRegister`; one projected row per source row; identity,
 * status, type, lineage, materialRequestId, stockMovementId, receivedBy,
 * receivedAt, quantity/UOM all verbatim with no aggregation/conversion; no
 * purchaseOrderId / purchaseOrderLineId anywhere; no money/currency/
 * valuation; kpis = []; no CSV default added (OPERATIONAL_DETAIL remains the
 * only one); no route; no migration; no new permission; the R10 closure
 * guard file is byte-unchanged and no historical R10 test was modified.
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

/** PART 01 closure — the fixed baseline this PART builds on. */
const BASE = 'ff9502227abbb32230dc89f2a4691e967a401b3e';
const RE = 'src/modules/reporting-export';
const TYPES = `${RE}/reporting-export.types.ts`;
const REG = `${RE}/reporting-export.registry.ts`;
const R11PROJ = `${RE}/reporting-export.r11-projections.ts`;
const OPENAPI = 'docs/api/openapi.yaml';
const GUARD = 'tests/r10-part20-closure-guard.test.ts';
const SELF = 'tests/r11-part02-receiving-register.test.ts';

const typesSrc = rd(TYPES);
const regSrc = rd(REG);
const projSrc = rd(R11PROJ);
const openapiSrc = rd(OPENAPI);
const sReg = strip(regSrc);
const sProj = strip(projSrc);

/** Dependency-free runtime imports (explicit .ts specifiers, R10 guard precedent). */
const types = await import('../src/modules/reporting-export/reporting-export.types.ts');
const r11proj = await import('../src/modules/reporting-export/reporting-export.r11-projections.ts');

const DATASETS = types.REPORTING_EXPORT_DATASETS;
const adapterBlock = regSrc.slice(regSrc.indexOf('  RECEIVING_REGISTER: {'));
const registryKeys = [...regSrc.matchAll(/^ {2}([A-Z][A-Z0-9_]+): \{$/gm)].map((m) => m[1]);
const archiveBlock = openapiSrc.split('    ReportArchiveDataset:')[1].split('    ReportArchiveFormat:')[0];
const enumBody = archiveBlock.slice(archiveBlock.indexOf('['), archiveBlock.indexOf(']') + 1);
const openapiEnum = enumBody.match(/[A-Z][A-Z0-9_]+/g) ?? [];

/** Canned authoritative rows in the exact PART 01 public row shape. */
const ROW_A = {
  receivingId: '11111111-1111-4111-8111-111111111111',
  clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  buildingId: '66666666-6666-4666-8666-666666666666',
  requestType: 'PURCHASE_REQUEST',
  purchaseRequestId: '22222222-2222-4222-8222-222222222222',
  serviceRequestId: null,
  materialRequestId: '33333333-3333-4333-8333-333333333333',
  vendorId: '44444444-4444-4444-8444-444444444444',
  receivingType: 'MATERIAL',
  itemId: '55555555-5555-4555-8555-555555555555',
  warehouseId: '77777777-7777-4777-8777-777777777777',
  quantity: 5,
  uomId: '88888888-8888-4888-8888-888888888888',
  stockMovementId: '99999999-9999-4999-8999-999999999999',
  receivedByUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  receivedAt: '2026-09-01T03:00:00.000Z',
  status: 'RECEIVED',
  notes: 'Partial delivery, pallet 2',
};
const ROW_B = {
  ...ROW_A,
  receivingId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  requestType: 'SERVICE_REQUEST',
  purchaseRequestId: null,
  serviceRequestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  materialRequestId: null,
  receivingType: 'SERVICE',
  itemId: null,
  warehouseId: null,
  quantity: null,
  uomId: null,
  stockMovementId: null,
  receivedAt: '2026-09-02T05:30:00.000Z',
  status: 'FINALIZED',
  notes: null,
};

test('R11 P02 01/02/26/27 — enum declared once at 19; CSV default untouched', () => {
  // 01 — declared exactly once, appended last (order parity with the registry/OpenAPI).
  assert.equal(DATASETS.filter((d) => d === 'RECEIVING_REGISTER').length, 1);
  assert.equal((typesSrc.match(/'RECEIVING_REGISTER',/g) ?? []).length, 1);
  assert.equal(DATASETS[DATASETS.length - 1], 'RECEIVING_REGISTER');
  // 02 — runtime count 18 → 19.
  assert.equal(DATASETS.length, 19, 'runtime dataset enum is 19');
  // 26/27 — no CSV default added; OPERATIONAL_DETAIL remains the ONLY configured default.
  assert.deepEqual(Object.keys(types.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
  assert.deepEqual(types.REPORTING_EXPORT_DATASET_METADATA, {
    OPERATIONAL_DETAIL: { csvDefaultTableKey: 'operationalDetail' },
  });
  assert.equal((typesSrc.match(/csvDefaultTableKey:/g) ?? []).length, 1);
  assert.equal(/csvDefaultTableKey/.test(adapterBlock), false, 'adapter configures no CSV default');
  // The management subset is untouched.
  assert.deepEqual([...types.MANAGEMENT_REPORTING_EXPORT_DATASETS], ['MANAGEMENT_OPERATIONS_COMMAND_CENTER']);
});

test('R11 P02 03/04/05 — registry 19, OpenAPI 19, all three sets equal', () => {
  // 03 — registry adapter count and key set.
  assert.equal(registryKeys.length, 19, 'registry adapter count is 19');
  assert.deepEqual([...registryKeys].sort(), [...DATASETS].sort(), 'registry set equals runtime set');
  assert.equal(new Set(registryKeys).size, 19, 'no duplicate adapter key');
  // 04 — OpenAPI enum count.
  assert.equal(openapiEnum.length, 19, 'OpenAPI dataset enum is 19');
  // 05 — same set everywhere, and OpenAPI order matches runtime order position by position.
  assert.deepEqual([...openapiEnum].sort(), [...DATASETS].sort(), 'OpenAPI set equals runtime set');
  assert.deepEqual(openapiEnum, [...DATASETS], 'OpenAPI order matches runtime order');
  assert.equal(regSrc.includes('RECEIVING_REGISTER'), true);
  assert.equal(openapiSrc.includes('RECEIVING_REGISTER (R11)'), true, 'dataset is documented');
  assert.ok(archiveBlock.includes('receivingRegister'), 'the documented table key exists');
  assert.ok(projSrc.includes("'receivingRegister'"), 'and in the projection seam');
});

test('R11 P02 06/07/08/09/30 — adapter consumes the PART 01 public authority under receiving.read', () => {
  // 06 — the adapter imports the PUBLIC module contract (index), parser + read reused verbatim.
  assert.match(
    regSrc,
    /import \{\s+getReceivingRegister,\s+parseReceivingRegisterQuery,\s+\} from '\.\.\/receiving-register';/,
  );
  assert.match(adapterBlock, /parseReceivingRegisterQuery\(passThrough\)/);
  assert.match(adapterBlock, /getReceivingRegister\(filters, userId\)/);
  // 07 — the repository is NOT imported and no SQL is issued from Reporting. (The governance
  // comment names the symbol it refuses to import, exactly like the R10 incident adapter, so
  // the check is scoped to import statements — R10 PART 19 proved the same boundary behaviorally.)
  assert.equal(sReg.includes('receivingRegisterRepository'), false,
    'the repository symbol never appears in stripped registry code');
  assert.equal(/getPool|\.query\(/.test(sReg), false, 'no adapter issues SQL, scoped or otherwise');
  assert.equal(/FROM\s+receivings/i.test(adapterBlock), false, 'no receivings table is queried here');
  // 08 — the EXISTING permission is reused, source-verified where it already gates the routes.
  assert.match(adapterBlock, /requiredReadPermission: 'receiving\.read'/);
  assert.match(rd('src/modules/receivings/receiving.routes.ts'), /requirePermission\('receiving\.read'\)/);
  // 30 — no new permission surface anywhere in this ripple.
  assert.equal(/requirePermission\(/.test(strip(adapterBlock)), false);
  assert.equal(/code: '[a-z_]+\.(read|manage)'/.test(strip(adapterBlock)), false);
  // 09 — the authenticated userId reaches the source authority (scope stays source-owned).
  assert.equal(/contextAccessService|getAccessibleBuildingIds|assertBuildingAccess/.test(strip(adapterBlock)),
    false, 'the adapter never re-resolves or expands building scope itself');
  assert.match(adapterBlock, /buildingId: source\.buildingId/);
  assert.match(adapterBlock, /buildingScope: source\.buildingScope/);
  assert.match(adapterBlock, /dateFrom: source\.dateFrom/);
  assert.match(adapterBlock, /dateTo: source\.dateTo/);
  assert.match(adapterBlock, /asOf: source\.asOf/);
  assert.match(adapterBlock, /projectReceivingRegister\(source\.rows\)/);
  assert.match(adapterBlock, /appliedFilters: echoFilters\(filters\)/);
});

test('R11 P02 10–25 — projection executed for real: one table, verbatim rows, no PO, no money, no KPI', () => {
  const projected = r11proj.projectReceivingRegister([ROW_A, ROW_B]);
  // 25 — kpis is empty; this PART introduces no KPI authority.
  assert.deepEqual(projected.kpis, []);
  // 10/11 — exactly ONE table with the recommended key; no child/summary/metadata/drill table.
  assert.equal(projected.tables.length, 1);
  const t = projected.tables[0];
  assert.equal(t.key, 'receivingRegister');
  assert.equal(t.label, 'Receiving Register');
  // 12 — one projected row per source row, in source order.
  assert.equal(t.rowCount, 2);
  assert.equal(t.rows.length, 2);
  // Column contract: the 18 authoritative fields in authoritative order.
  assert.deepEqual(
    t.columns.map((c) => c.key),
    ['receivingId', 'clientId', 'buildingId', 'requestType', 'purchaseRequestId', 'serviceRequestId',
     'materialRequestId', 'vendorId', 'receivingType', 'itemId', 'warehouseId', 'quantity', 'uomId',
     'stockMovementId', 'receivedByUserId', 'receivedAt', 'status', 'notes'],
  );
  const qtyCol = t.columns.find((c) => c.key === 'quantity');
  assert.equal(qtyCol.type, 'NUMBER');
  assert.equal(t.columns.find((c) => c.key === 'receivedAt').type, 'DATE');
  // 13–21 — every fact copied verbatim; nulls preserved; every row key is a declared column.
  for (const [i, src] of [ROW_A, ROW_B].entries()) {
    const out = t.rows[i];
    assert.deepEqual(Object.keys(out).sort(), t.columns.map((c) => c.key).sort());
    for (const k of Object.keys(src)) {
      assert.deepEqual(out[k], src[k], `${k} copied verbatim (row ${i})`);
    }
    // 13 identity, 14/15 native vocabularies, 19/20 actor + period authority.
    assert.equal(out.receivingId, src.receivingId);
    assert.equal(out.status, src.status);
    assert.equal(out.receivingType, src.receivingType);
    assert.equal(out.receivedByUserId, src.receivedByUserId);
    assert.equal(out.receivedAt, src.receivedAt);
  }
  // 16/17 — request lineage incl. the optional MATERIAL-line binding survives both shapes.
  assert.equal(t.rows[0].materialRequestId, ROW_A.materialRequestId);
  assert.equal(t.rows[1].materialRequestId, null);
  assert.equal(t.rows[1].serviceRequestId, ROW_B.serviceRequestId);
  // 21 — quantity/UOM: identical values, no aggregation, no conversion, no derivation.
  assert.equal(t.rows[0].quantity, 5);
  assert.equal(t.rows[1].quantity, null);
  assert.equal(/\.reduce\(|\.sort\(|sum|total|convert|remaining/i.test(sProj), false,
    'projection performs no aggregation, conversion or derivation');
  // 22/23/24 — no PO linkage and no monetary surface, in rows and in code.
  for (const out of t.rows) {
    const keys = Object.keys(out);
    assert.equal(keys.some((k) => /purchaseOrder/i.test(k)), false, 'no purchaseOrderId/LineId field');
    assert.equal(keys.some((k) => /price|amount|cost|currency|value|valuation|cogs/i.test(k)), false,
      'no money/currency/valuation field');
  }
  assert.equal(/purchaseOrder(Id|LineId)|purchase_order/i.test(sProj), false);
  assert.equal(/\bprice\b|\bamount\b|\bcost\b|currency|valuation|cogs/i.test(sProj), false);
  // 18 — the movement grain is never expanded: the projection touches no inventory authority.
  assert.equal(/inventory_stock_movements|stock-movement|StockMovement[A-Z]/.test(projSrc), false);
  // Empty source → still exactly one well-formed table.
  const empty = r11proj.projectReceivingRegister([]);
  assert.equal(empty.tables.length, 1);
  assert.equal(empty.tables[0].rowCount, 0);
  assert.deepEqual(empty.kpis, []);
});

test('R11 P02 28/29/31 — no route, no migration, R10 guard and historical tests byte-unchanged', () => {
  // 28 — no HTTP surface was added anywhere for this dataset.
  assert.equal(rd('src/routes/index.ts').includes('receiving-register'), false);
  assert.equal(rd('src/routes/index.ts').includes('RECEIVING_REGISTER'), false);
  assert.deepEqual(
    fs.readdirSync(path.join(ROOT, 'src/modules/receiving-register')).sort(),
    ['index.ts', 'receiving-register.repository.ts', 'receiving-register.service.ts',
      'receiving-register.types.ts'],
    'PART 01 module still has no routes/controller',
  );
  // 29 — no migration exists for this dataset.
  assert.equal(
    fs.readdirSync(path.join(ROOT, 'src/database/migrations'))
      .some((f) => /receiving[-_]register/i.test(f)),
    false,
  );
  // 31 — the R10 closure guard is byte-unchanged versus the PART 01 baseline (and was NOT run).
  assert.equal(git('diff', BASE, '--', GUARD), '', 'closure guard byte-unchanged');
  assert.equal(git('hash-object', GUARD), git('rev-parse', `${BASE}:${GUARD}`),
    'closure guard blob identical to baseline');
  // No historical R10 phase test was modified; the only test added is this one.
  const changedTracked = git('diff', '--name-only', BASE).split('\n').filter(Boolean);
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  const changed = [...new Set([...changedTracked, ...untracked])];
  assert.deepEqual(changed.filter((f) => /^tests\/r10-/.test(f)), [], 'no R10 test touched');
  // Bounded PART 02 footprint: the four registration-ripple files plus this test only.
  const ALLOWED = [TYPES, REG, R11PROJ, OPENAPI, SELF];
  assert.deepEqual(changed.filter((f) => !ALLOWED.includes(f)), [],
    'PART 02 changes only the registration ripple + this test');
  // R10 production surfaces and the closed PART 01 module are byte-unchanged.
  assert.equal(git('diff', BASE, '--', `${RE}/reporting-export.r10-projections.ts`,
    `${RE}/reporting-export.projections.ts`, `${RE}/reporting-export.management-projections.ts`,
    'src/modules/receiving-register'), '', 'R10 projections and PART 01 module untouched');
});

test('R11 P02 — type-strip validation and banned-token discipline', () => {
  // Syntax integrity of every changed TypeScript file (catches the dropped-brace defect class
  // R10 PART 19 found at runtime) plus this test itself.
  for (const f of [TYPES, REG, R11PROJ, SELF]) {
    assert.doesNotThrow(() => stripTypeScriptTypes(rd(f), { mode: 'strip' }), `${f} type-strips cleanly`);
  }
  // The projection seam stays dependency-free at runtime (type-only imports).
  assert.equal(/^import\s+(?!type)/m.test(projSrc), false, 'r11-projections has only type imports');
  // Governance token discipline (R10 guard bans, kept without running the guard). Scan scope
  // matches the guard and PART 01: the frozen enum, the registry and the OpenAPI text. The
  // projection seam keeps the r10-projections house header style ("R11 — bounded ..."), which
  // the R10 guard also never scanned in its projection file.
  const all = typesSrc + regSrc + openapiSrc;
  for (const banned of ['PART 21', 'PART21', 'R11 —', 'COMMERCIAL_JOURNEY', 'RESOURCE_JOURNEY',
    'SERVICE_JOURNEY']) {
    assert.equal(all.includes(banned), false, `no ${banned} artifact exists`);
  }
});
