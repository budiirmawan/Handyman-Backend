/**
 * R11 PART 07 — FINAL CLOSURE GUARD.
 *
 * This is a CLOSURE VALIDATION test, not a feature test. It pins the frozen R11 end state at
 * CURRENT HEAD so the track can be declared complete, bounded and internally coherent:
 * 23 Reporting datasets (18 inherited + exactly 5 R11 additions), exactly three R11 internal
 * source foundations, one table per response, required view discriminators with no defaults,
 * the single OPERATIONAL_DETAIL CSV default, per-dataset safety invariants (grain, identity,
 * period authority, money/currency discipline, actor semantics, gap/diagnostic preservation),
 * zero Reporting-side financial arithmetic, zero direct SQL, zero Reporting-side scope
 * authority, zero delivery expansion (routes/migrations/permissions/renderers/archives) and
 * no R10 regression or reopen.
 *
 * METHOD — deliberately STATIC and bounded, mirroring the R10 PART 20 closure guard. Only the
 * dependency-free surfaces are imported at runtime (`reporting-export.types.ts` and the
 * type-only `reporting-export.r11-projections.ts` seam, executed with empty/canned inputs to
 * pin table keys, kpis and column contracts); every other invariant is proven from source text
 * and from the R11 commit range `PRE_R11..HEAD`, where PRE_R11 is the R10 closure head (the
 * parent of ff95022, R11 PART 01). There is no dynamic harness, no database, no live-PostgreSQL
 * requirement and no historical regression sweep.
 *
 * SCOPE — R11 only. The per-PART focused tests (PART 01–06) already executed the runtime
 * behaviour of each dataset and foundation; this file exists to prove the WHOLE is coherent,
 * which is a static property. Historical R10/R11 phase tests are immutable artifacts: they are
 * NOT repaired, NOT executed and their expired count/footprint pins are NOT modernized — the
 * current-head truth lives here. Unlike the R10 PART 20 worktree-footprint assertion (which
 * pinned a whole-tree state), this guard pins the bounded R11 DIFF range, so R11's legitimate
 * file additions never conflict with R10 closure.
 *
 * This file adds no dataset, no adapter, no read model and no production change.
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

/** PART 06 head — the frozen R11 implementation this guard closes. */
const BASE = 'b5d1e412064998e011df6392400fb995efa56fd5';
/** R10 closure head (parent of ff95022, R11 PART 01): everything after it is R11. */
const PRE_R11 = '04b95485bfcb75de0c4e91e94b4e0c054c33f5fb';
const SELF = 'tests/r11-part07-closure-guard.test.ts';

const RE = 'src/modules/reporting-export';
const TYPES = `${RE}/reporting-export.types.ts`;
const REG = `${RE}/reporting-export.registry.ts`;
const R11PROJ = `${RE}/reporting-export.r11-projections.ts`;
const OPENAPI = 'docs/api/openapi.yaml';

const HISTORICAL_TESTS = [
  'tests/r10-part20-closure-guard.test.ts',
  'tests/r11-part01-receiving-register-read.test.ts',
  'tests/r11-part02-receiving-register.test.ts',
  'tests/r11-part03b-purchase-order-line-register-read.test.ts',
  'tests/r11-part03c-purchase-order-register.test.ts',
  'tests/r11-part04-vendor-invoice-register.test.ts',
  'tests/r11-part05b-stock-movement-register-read.test.ts',
  'tests/r11-part05c-stock-movement-register.test.ts',
  'tests/r11-part06-operational-budget-variance.test.ts',
];

/** The 18 datasets inherited from R01–R10, in frozen executable order. */
const INHERITED_18 = ['SECURITY_PATROL', 'SECURITY_FINDING_INCIDENT', 'WORKFORCE', 'VENDOR_TENANT',
  'UTILITY', 'MANAGEMENT_OPERATIONS_COMMAND_CENTER', 'VENDOR_SERVICE_REGISTER', 'FINDING_REGISTER',
  'WORK_ORDER_REGISTER', 'CHECKLIST_EXECUTION_SUMMARY', 'OPERATIONAL_DETAIL', 'CORRECTIVE_ACTION',
  'OPERATIONAL_DETAIL_HISTORY', 'WORK_ORDER_SLA', 'SCHEDULED_OPERATION_LINEAGE', 'PERMIT_TO_WORK',
  'SECURITY_OPERATIONAL_DETAIL', 'INCIDENT_REGISTER'];
/** The exactly-5 R11 additions, in frozen executable (tail) order. */
const R11_FIVE = ['RECEIVING_REGISTER', 'PURCHASE_ORDER_REGISTER', 'VENDOR_INVOICE_REGISTER',
  'STOCK_MOVEMENT_REGISTER', 'OPERATIONAL_BUDGET_VARIANCE'];
/** The exactly-3 R11 internal source foundations. */
const R11_FOUNDATIONS = ['receiving-register', 'purchase-order-line-register', 'stock-movement-register'];

const typesSrc = rd(TYPES);
const regSrc = rd(REG);
const projSrc = rd(R11PROJ);
const openapiSrc = rd(OPENAPI);
const sReg = strip(regSrc);

/** The contiguous R11 adapter region: the five R11 entries appended after R10's
 *  INCIDENT_REGISTER, through the registry's structural close. */
const r11Region = regSrc.slice(regSrc.indexOf('  RECEIVING_REGISTER: {'));
const sR11Region = strip(r11Region);
const CLOSURE_AT = '\n};\n\nexport function getReportingExportDatasetAdapter(';
const blockOf = (name, next) => {
  const s = regSrc.indexOf(`  ${name}: {`);
  const e = next ? regSrc.indexOf(`  ${next}: {`) : regSrc.indexOf(CLOSURE_AT);
  assert.ok(s !== -1 && e !== -1 && s < e, `adapter block ${name} located`);
  return regSrc.slice(s, e);
};
const ADAPTERS = {
  RECEIVING: blockOf('RECEIVING_REGISTER', 'PURCHASE_ORDER_REGISTER'),
  PO: blockOf('PURCHASE_ORDER_REGISTER', 'VENDOR_INVOICE_REGISTER'),
  VI: blockOf('VENDOR_INVOICE_REGISTER', 'STOCK_MOVEMENT_REGISTER'),
  SM: blockOf('STOCK_MOVEMENT_REGISTER', 'OPERATIONAL_BUDGET_VARIANCE'),
  OBV: blockOf('OPERATIONAL_BUDGET_VARIANCE', null),
};
const sAdapters = Object.fromEntries(
  Object.entries(ADAPTERS).map(([k, v]) => [k, strip(v)]));

/** Projection slices in the R11 seam, function by function (frozen earlier-PART projections
 *  stay out of later guards' scan scope). */
const PROJ_FNS = ['projectReceivingRegister', 'projectPurchaseOrderHeader', 'projectPurchaseOrderLine',
  'projectVendorInvoiceRegister', 'projectStockMovementRegister', 'projectOperationalBudgetVariance',
  'projectOperationalBudgetVarianceCategory'];
const projSlice = (fn) => {
  const s = projSrc.indexOf(`export function ${fn}(`);
  assert.ok(s !== -1, `${fn} exists`);
  const later = PROJ_FNS.map((f) => projSrc.indexOf(`export function ${f}(`))
    .filter((i) => i > s);
  return strip(projSrc.slice(s, later.length ? Math.min(...later) : undefined));
};
const sRecvProj = projSlice('projectReceivingRegister');
const sPoHeaderProj = projSlice('projectPurchaseOrderHeader');
const sPoLineProj = projSlice('projectPurchaseOrderLine');
const sViProj = projSlice('projectVendorInvoiceRegister');
const sSmProj = projSlice('projectStockMovementRegister');
const sObvProj = projSlice('projectOperationalBudgetVariance') +
  projSlice('projectOperationalBudgetVarianceCategory');

const registryKeys = [...regSrc.matchAll(/^ {2}([A-Z][A-Z0-9_]+): \{$/gm)].map((m) => m[1]);
const archiveBlock = openapiSrc.split('    ReportArchiveDataset:')[1].split('    ReportArchiveFormat:')[0];
const enumBody = archiveBlock.slice(archiveBlock.indexOf('['), archiveBlock.indexOf(']') + 1);
const openapiEnum = enumBody.match(/[A-Z][A-Z0-9_]+/g) ?? [];

/** Dependency-free runtime imports (explicit .ts specifiers, house precedent). */
const types = await import('../src/modules/reporting-export/reporting-export.types.ts');
const r11proj = await import('../src/modules/reporting-export/reporting-export.r11-projections.ts');
const DATASETS = [...types.REPORTING_EXPORT_DATASETS];

/** Minimal canned envelope so the CATEGORY projection executes with zero rows. */
const EMPTY_OBV_ENVELOPE = {
  budgetId: 'b', clientId: 'c', buildingId: 'g', budgetName: 'n',
  budgetPeriod: { start: '2026-01-01', end: '2026-12-31' }, currency: 'IDR', status: 'ACTIVE',
  overspendPolicy: 'STRICT', totals: {}, categories: [], controls: {}, gaps: [],
  asOf: '2026-01-01T00:00:00.000Z',
};
const PROJECTED = {
  receiving: r11proj.projectReceivingRegister([]),
  poHeader: r11proj.projectPurchaseOrderHeader([]),
  poLine: r11proj.projectPurchaseOrderLine([]),
  vendorInvoice: r11proj.projectVendorInvoiceRegister([]),
  stockMovement: r11proj.projectStockMovementRegister([]),
  obvBudget: r11proj.projectOperationalBudgetVariance([]),
  obvCategory: r11proj.projectOperationalBudgetVarianceCategory(EMPTY_OBV_ENVELOPE),
};
const colsOf = (p) => p.tables[0].columns.map((c) => c.key);

/** Frozen column contracts — pinned exactly as the PART 02/03C/04/05C/06 focused tests proved
 *  them, so any later column drift is a hard closure failure. */
const COLS = {
  receiving: ['receivingId', 'clientId', 'buildingId', 'requestType', 'purchaseRequestId',
    'serviceRequestId', 'materialRequestId', 'vendorId', 'receivingType', 'itemId', 'warehouseId',
    'quantity', 'uomId', 'stockMovementId', 'receivedByUserId', 'receivedAt', 'status', 'notes'],
  poHeader: ['purchaseOrderId', 'clientId', 'buildingId', 'vendorId', 'purchaseRequestId',
    'serviceRequestId', 'poReadinessId', 'requestType', 'poNumber', 'currency', 'status', 'poDate',
    'requiredDate', 'vendorReference', 'notes', 'createdByUserId', 'issuedByUserId', 'issuedAt',
    'cancelledByUserId', 'cancelledAt', 'createdAt', 'updatedAt'],
  poLine: ['purchaseOrderLineId', 'purchaseOrderId', 'clientId', 'buildingId', 'vendorId',
    'purchaseRequestId', 'poNumber', 'poDate', 'currency', 'purchaseOrderStatus', 'lineNumber',
    'requestLineType', 'materialRequestId', 'serviceRequestId', 'itemId', 'uomId',
    'sourceServiceId', 'description', 'quantitySnapshot', 'unitPrice', 'lineAmount', 'notes',
    'createdByUserId', 'createdAt', 'updatedAt'],
  vendorInvoice: ['vendorInvoiceId', 'clientId', 'buildingId', 'vendorId', 'invoiceNumber',
    'invoiceDate', 'receivedDate', 'currency', 'invoiceAmount', 'status', 'vendorReference',
    'vendorWorkId', 'workOrderId', 'completionReportId', 'serviceReportId', 'bastDocumentId',
    'purchaseOrderId', 'workContractId', 'notes', 'createdByUserId', 'verificationStatus',
    'verifiedByUserId', 'verifiedAt', 'verificationNotes', 'discrepancyCodes', 'paymentStatus',
    'paidAmount', 'outstandingAmount', 'lastPaymentDate', 'finalizedAt', 'finalizedByUserId',
    'cancelledAt', 'cancelledByUserId', 'createdAt', 'updatedAt'],
  stockMovement: ['stockMovementId', 'clientId', 'buildingId', 'warehouseId', 'itemId',
    'movementType', 'quantity', 'uomId', 'movementDate', 'reference', 'source',
    'performedByUserId', 'notes', 'resultingQuantityOnHand', 'resultingAvailableQuantity',
    'createdAt'],
  obvBudget: ['budgetId', 'clientId', 'buildingId', 'budgetName', 'periodStart', 'periodEnd',
    'currency', 'status', 'plannedAmount', 'ledgerCommittedAmount', 'ledgerOpenAmount',
    'ledgerActualizedAmount', 'ledgerReleasedAmount', 'legacyCommittedAmount',
    'uncommittedMaterialActualAmount', 'uncommittedInvoiceActualAmount', 'unallocatedActualAmount',
    'openCommitmentAmount', 'actualAmount', 'consumedAmount', 'availableAmount', 'varianceAmount',
    'utilizationPercent', 'committedUtilizationPercent', 'failClosed', 'gapCount'],
  obvCategory: ['budgetId', 'budgetCategoryId', 'clientId', 'buildingId', 'currency',
    'periodStart', 'periodEnd', 'status', 'overspendPolicy', 'categoryCode', 'categoryName',
    'plannedAmount', 'ledgerCommittedAmount', 'ledgerOpenAmount', 'ledgerActualizedAmount',
    'ledgerReleasedAmount', 'legacyCommittedAmount', 'openCommitmentAmount', 'actualAmount',
    'consumedAmount', 'availableAmount', 'varianceAmount', 'utilizationPercent',
    'committedUtilizationPercent', 'commitmentCount'],
};

test('R11 G01/G19 — dataset parity 23/23/23, frozen order, exactly 5 additions, closure boundary', () => {
  // GUARD 1 — runtime = registry = OpenAPI = 23; same set, same executable order, no duplicates.
  assert.equal(DATASETS.length, 23, 'runtime dataset vocabulary is 23');
  assert.equal(registryKeys.length, 23, 'registry adapter count is 23');
  assert.equal(openapiEnum.length, 23, 'OpenAPI dataset enum is 23');
  assert.equal(new Set(DATASETS).size, 23, 'no duplicate dataset names');
  assert.equal(new Set(registryKeys).size, 23, 'no duplicate registry keys');
  assert.deepEqual([...registryKeys].sort(), [...DATASETS].sort(), 'registry set == runtime set');
  assert.deepEqual(openapiEnum, DATASETS, 'OpenAPI order == runtime executable order');
  // The frozen R11 tail order — the actual executable dataset order is pinned.
  assert.deepEqual(DATASETS.slice(18), R11_FIVE);
  assert.deepEqual(registryKeys.slice(18), R11_FIVE, 'R11 adapters are the executable tail');
  // GUARD 19 — final boundary: 23 = 18 inherited + exactly 5; closure test is PART 07 and no
  // PART 08+ implementation test exists.
  assert.deepEqual(DATASETS.slice(0, 18), INHERITED_18);
  const testFiles = fs.readdirSync(path.join(ROOT, 'tests'));
  assert.equal(testFiles.includes('r11-part07-closure-guard.test.ts'), true);
  assert.equal(testFiles.some((f) => /r11-part0[89]|r11-part1[0-9]/.test(f)), false,
    'no PART 08+ implementation test exists');
});

test('R11 G02 — exact R11 dataset set; no extra registers, no journey engine', () => {
  // GUARD 2 — R11 added exactly the five frozen names; every rejected candidate is absent from
  // the runtime vocabulary AND from the declared enum text.
  for (const banned of ['TENANT_INVOICE_REGISTER', 'RFQ_REGISTER', 'PRICE_CATALOG_REGISTER',
    'WORK_CONTRACT_REGISTER', 'MATERIAL_RESERVATION_REGISTER', 'WO_MATERIAL_USAGE_REGISTER',
    'PAYMENT_RECEIPT_REGISTER', 'VENDOR_SERVICE_COST_REGISTER']) {
    assert.equal(DATASETS.includes(banned), false, `${banned} is not a dataset`);
    assert.equal(typesSrc.includes(`'${banned}'`), false, `${banned} is not declared`);
  }
  // No synthetic journey-engine vocabulary anywhere in the registration surfaces.
  const all = typesSrc + regSrc + openapiSrc + projSrc;
  for (const banned of ['COMMERCIAL_JOURNEY', 'RESOURCE_JOURNEY', 'SERVICE_JOURNEY',
    'JOURNEY_ENGINE', 'PART 21', 'PART21']) {
    assert.equal(all.includes(banned), false, `no ${banned} artifact exists`);
  }
});

test('R11 G03 — one table per response for every R11 view; no hidden summary/child/drill table', () => {
  // GUARD 3 — executed: each of the seven R11 projections emits EXACTLY ONE table with the
  // frozen key and zero kpis; the exact column contracts are pinned (guards 6–10, 14–16 reuse
  // these pins).
  const expected = {
    receiving: ['receivingRegister', 'Receiving Register'],
    poHeader: ['purchaseOrderHeader', 'Purchase Order Header'],
    poLine: ['purchaseOrderLine', 'Purchase Order Line'],
    vendorInvoice: ['vendorInvoiceRegister', 'Vendor Invoice Register'],
    stockMovement: ['stockMovementRegister', 'Stock Movement Register'],
    obvBudget: ['operationalBudgetVariance', 'Operational Budget Variance'],
    obvCategory: ['operationalBudgetVarianceCategory', 'Operational Budget Variance Category'],
  };
  for (const [name, p] of Object.entries(PROJECTED)) {
    assert.equal(p.tables.length, 1, `${name}: exactly one table`);
    assert.equal(p.tables[0].key, expected[name][0], `${name}: frozen table key`);
    assert.equal(p.tables[0].label, expected[name][1], `${name}: frozen table label`);
    assert.deepEqual(p.kpis, [], `${name}: kpis stay empty`);
    assert.equal(p.tables[0].rowCount, 0, `${name}: empty source → zero rows, no fabricated row`);
    assert.deepEqual(colsOf(p), COLS[name], `${name}: frozen column contract`);
  }
  // Adapter side: each single-view adapter projects exactly once; each multi-view adapter
  // projects exactly twice — once per exclusive branch — and never both tables for one view.
  assert.equal((sAdapters.RECEIVING.match(/projected: /g) ?? []).length, 1);
  assert.equal((sAdapters.VI.match(/projected: /g) ?? []).length, 1);
  assert.equal((sAdapters.SM.match(/projected: /g) ?? []).length, 1);
  assert.equal((sAdapters.PO.match(/projected: /g) ?? []).length, 2);
  assert.equal((sAdapters.OBV.match(/projected: /g) ?? []).length, 2);
  assert.match(sAdapters.RECEIVING, /projected: projectReceivingRegister\(source\.rows\)/);
  assert.match(sAdapters.PO, /projected: projectPurchaseOrderHeader\(rows\)/);
  assert.match(sAdapters.PO, /projected: projectPurchaseOrderLine\(source\.rows\)/);
  assert.match(sAdapters.VI, /projected: projectVendorInvoiceRegister\(rows\)/);
  assert.match(sAdapters.SM, /projected: projectStockMovementRegister\(source\.rows\)/);
  assert.match(sAdapters.OBV, /projected: projectOperationalBudgetVariance\(rows\)/);
  assert.match(sAdapters.OBV, /projected: projectOperationalBudgetVarianceCategory\(source\)/);
  // No adapter builds tables directly and no cross-view projection call exists.
  assert.equal(/tables:/.test(sR11Region), false, 'tables only come from projection functions');
  assert.equal(/projectPurchaseOrderHeader/.test(sAdapters.RECEIVING + sAdapters.VI + sAdapters.SM + sAdapters.OBV), false);
  assert.equal(/projectOperationalBudgetVariance/.test(sAdapters.RECEIVING + sAdapters.PO + sAdapters.VI + sAdapters.SM), false);
});

test('R11 G04/G05 — required view discriminators without defaults; single CSV default', () => {
  // GUARD 4 — both multi-view vocabularies are frozen two-member sets, executed for real, and
  // their registry readers REQUIRE the view: no default, no inference, no third value.
  assert.deepEqual([...types.PURCHASE_ORDER_REGISTER_VIEWS], ['HEADER', 'LINE']);
  assert.deepEqual([...types.OPERATIONAL_BUDGET_VARIANCE_VIEWS], ['BUDGET', 'CATEGORY']);
  for (const v of ['HEADER', 'LINE']) {
    assert.equal(types.isPurchaseOrderRegisterView(v), true);
  }
  for (const v of ['BUDGET', 'CATEGORY']) {
    assert.equal(types.isOperationalBudgetVarianceView(v), true);
  }
  for (const bad of ['header', 'line', 'budget', 'category', 'SUMMARY', 'DETAIL', '', null,
    undefined, 42, ['HEADER']]) {
    assert.equal(types.isPurchaseOrderRegisterView(bad), false);
    assert.equal(types.isOperationalBudgetVarianceView(bad), false);
  }
  assert.match(sAdapters.PO, /const view = readPurchaseOrderRegisterView\(passThrough\.view\);/);
  assert.match(sAdapters.OBV, /const view = readOperationalBudgetVarianceView\(passThrough\.view\);/);
  assert.match(sReg, /view is required and must be one of: \$\{PURCHASE_ORDER_REGISTER_VIEWS\.join\(', '\)\}\./);
  assert.match(sReg, /view is required and must be one of: \$\{OPERATIONAL_BUDGET_VARIANCE_VIEWS\.join\(', '\)\}\./);
  assert.equal(/view\s*\?\?|view\s*\|\||defaultView/i.test(sR11Region), false,
    'no default view exists in any form');
  // Single-view datasets take NO discriminator: no view token in their adapters.
  assert.equal(/\bview\b/.test(sAdapters.RECEIVING + sAdapters.VI + sAdapters.SM), false);
  // GUARD 5 — OPERATIONAL_DETAIL → operationalDetail is STILL the only configured CSV default;
  // R11 added zero; the two multi-view datasets define none.
  assert.deepEqual(Object.keys(types.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
  assert.equal(types.REPORTING_EXPORT_DATASET_METADATA.OPERATIONAL_DETAIL.csvDefaultTableKey,
    'operationalDetail');
  assert.equal((typesSrc.match(/csvDefaultTableKey:/g) ?? []).length, 1);
  assert.equal(/csvDefaultTableKey/.test(r11Region), false, 'no R11 adapter configures a default');
});

test('R11 G06 — RECEIVING_REGISTER safety (grain, period, scope, no PO inference, no money)', () => {
  // Adapter consumes the PART 01 foundation's public index (parser + governed read); userId is
  // passed; the envelope is forwarded field-for-field.
  assert.match(regSrc, /import \{\s+getReceivingRegister,\s+parseReceivingRegisterQuery,\s+\} from '\.\.\/receiving-register';/);
  assert.match(sAdapters.RECEIVING, /const filters = parseReceivingRegisterQuery\(passThrough\);/);
  assert.match(sAdapters.RECEIVING, /const source = await getReceivingRegister\(filters, userId\);/);
  // Foundation (frozen text): one scoped query over `receivings`, zero joins, structural
  // Building scope first, half-open received_at window, no period substitute.
  const repo = rd('src/modules/receiving-register/receiving-register.repository.ts');
  const sRepo = strip(repo);
  assert.equal((sRepo.match(/getPool\(\)\.query/g) ?? []).length, 1);
  assert.equal((sRepo.match(/\sJOIN\s/g) ?? []).length, 0);
  assert.deepEqual([...new Set([...sRepo.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map((m) => m[1]))],
    ['receivings']);
  assert.match(sRepo, /const conditions: string\[\] = \['r\.building_id = ANY\(\$1::uuid\[\]\)'\];/);
  assert.match(sRepo, /r\.received_at >= \$\$\{values\.length\}/);
  assert.match(sRepo, /r\.received_at < \$\$\{values\.length\}/);
  assert.equal(/(created_at|updated_at)\s*(>=|<=|>|<)/.test(sRepo), false);
  // No purchase-order linkage or inference, no readiness traversal, no reverse commercial
  // enrichment, no monetary field anywhere in the foundation or projection.
  assert.equal(/purchase_order|purchaseOrder(?!Id|LineId)|readiness|price_catalog|deviation|listPurchaseOrders/i.test(sRepo), false);
  assert.equal(/\bprice\b|\bamount\b|\bcost\b|\bcurrency\b|valuation/i.test(sRepo + sRecvProj), false);
  // Column contract (executed above): no purchaseOrderId/purchaseOrderLineId key exists;
  // stockMovementId survives ONLY as the persisted reference; receivedByUserId keeps its exact
  // "Received By" meaning; receivedAt is the period fact.
  const cols = COLS.receiving;
  assert.equal(cols.includes('purchaseOrderId'), false);
  assert.equal(cols.includes('purchaseOrderLineId'), false);
  assert.equal(cols.includes('stockMovementId'), true);
  assert.match(sRecvProj, /stockMovementId: row\.stockMovementId/);
  assert.equal(cols.includes('receivedByUserId'), true);
  assert.equal(/executorUserId|performedByUserId|approverUserId|requesterUserId/.test(sRecvProj), false);
  // Governed building scope in the foundation service: explicit assert + actor rollup.
  const svc = rd('src/modules/receiving-register/receiving-register.service.ts');
  assert.match(svc, /await contextAccessService\.assertBuildingAccess\(userId, filters\.buildingId\);/);
  assert.match(svc, /getAccessibleBuildingIds\(\s+userId,\s+\)/);
  assert.match(svc, /if \(buildingIds\.length === 0\) \{\s+return \{ \.\.\.base, rows: \[\] \};/);
});

test('R11 G07 — PURCHASE_ORDER_REGISTER safety (HEADER public authority; LINE set-based, inclusive po_date, verbatim money)', () => {
  // HEADER — the EXISTING purchase-orders public authority remains the source; no duplicate
  // header SQL or read model exists in Reporting; no header total; no line flattening.
  assert.match(regSrc, /import \{\s+listPurchaseOrders,\s+parsePurchaseOrderFilters,\s+\} from '\.\.\/purchase-orders';/);
  assert.match(sAdapters.PO, /const rows = await listPurchaseOrders\(filters, userId\);/);
  assert.equal(/\bFROM\s+purchase_orders|SELECT[\s\S]*purchase_orders/i.test(sReg), false);
  assert.equal(/totalAmount|grandTotal|lineAmount|unitPrice|\bprice\b/i.test(sPoHeaderProj), false);
  assert.equal(COLS.poHeader.includes('currency'), true, 'HEADER currency is context only');
  assert.equal(/rfq|deviation|spk|work_contract|vendor_invoice|invoice/i.test(sPoHeaderProj), false);
  // LINE — the PART 03B foundation is the source: ONE set-based query, structural parent join
  // with client AND building equality, no N+1.
  assert.match(regSrc, /import \{\s+getPurchaseOrderLineRegister,\s+parsePurchaseOrderLineRegisterQuery,\s+\} from '\.\.\/purchase-order-line-register';/);
  assert.match(sAdapters.PO, /const source = await getPurchaseOrderLineRegister\(filters, userId\);/);
  const lineRepo = strip(rd('src/modules/purchase-order-line-register/purchase-order-line-register.repository.ts'));
  assert.equal((lineRepo.match(/getPool\(\)\.query/g) ?? []).length, 1);
  assert.equal((lineRepo.match(/\sJOIN\s/g) ?? []).length, 1, 'the single structural parent join');
  assert.match(lineRepo, /FROM purchase_order_lines line\s+JOIN purchase_orders po\s+ON po\.id = line\.purchase_order_id\s+AND po\.client_id = line\.client_id\s+AND po\.building_id = line\.building_id/);
  assert.match(lineRepo, /if \(buildingIds\.length === 0\) return \[\];/);
  const lineSvc = strip(rd('src/modules/purchase-order-line-register/purchase-order-line-register.service.ts'));
  // True N+1 shapes only: the legacy per-row public loop and the parent repository. The
  // foundation's OWN public seam (`purchaseOrderLineRepository`) is the intended consumer
  // path and must NOT be banned; doc-comment mentions are stripped before the scan.
  assert.equal(/listPurchaseOrderLines|purchaseOrderRepository/.test(lineSvc + lineRepo), false,
    'no per-PO loop authority: N+1 shape structurally absent');
  // Period authority is the parent po_date with INCLUSIVE calendar-date semantics; no
  // created_at/updated_at substitute and no timestamp casting.
  assert.match(lineRepo, /conditions\.push\(`po\.po_date >= \$\$\{values\.length\}::date`\)/);
  assert.match(lineRepo, /conditions\.push\(`po\.po_date <= \$\$\{values\.length\}::date`\)/);
  assert.equal((lineRepo.match(/po_date (>=|<=)/g) ?? []).length, 2);
  assert.equal(/(created_at|updated_at)\s*(>=|<=|>|<)/.test(lineRepo), false);
  assert.equal(/::timestamptz|::timestamp\b/.test(lineRepo), false);
  // Native requestLineType; serviceRequestId stays the line's own authority; quantitySnapshot
  // stays a historical snapshot (NULL preserved); unitPrice/lineAmount copied verbatim with the
  // single Number() boundary conversion; currency from the parent PO.
  assert.match(lineRepo, /requestLineType: row\.request_line_type/);
  assert.match(lineRepo, /serviceRequestId: row\.service_request_id/);
  assert.match(lineRepo, /quantitySnapshot:\s+row\.quantity_snapshot === null \? null : Number\(row\.quantity_snapshot\)/);
  assert.match(lineRepo, /unitPrice: Number\(row\.unit_price\)/);
  assert.match(lineRepo, /lineAmount: Number\(row\.line_amount\)/);
  assert.match(lineRepo, /po\.currency AS currency/);
  assert.equal(/line\.currency/.test(lineRepo), false);
  // No lineAmount recomputation, no PO total, no FX, no price-catalog lookup.
  assert.equal(/line_amount\s*[-+*/]|quantity_snapshot\s*\*|\*\s*unit_price|unitPrice\s*\*|\*\s*quantitySnapshot|toFixed|Math\.round|SUM\(|\.reduce\(/i.test(strip(lineSvc) + lineRepo + sPoLineProj), false);
  assert.equal(/\bfx\b|exchange[Rr]ate|convert|price[_-]?catalog/i.test(strip(lineSvc) + lineRepo + sPoLineProj), false);
});

test('R11 G08 — VENDOR_INVOICE_REGISTER safety (separate status dimensions, on-row codes, current-state payments, verbatim money)', () => {
  // Adapter consumes the EXISTING public vendor-invoices authority (parser + list read).
  assert.match(regSrc, /import \{\s+listVendorInvoices,\s+parseVendorInvoiceFilters,\s+\} from '\.\.\/vendor-invoices';/);
  assert.match(sAdapters.VI, /const rows = await listVendorInvoices\(filters, userId\);/);
  // The three native status dimensions remain SEPARATE columns; discrepancyCodes stays an
  // on-row comma-joined fact, never fanned out.
  const cols = COLS.vendorInvoice;
  for (const dim of ['status', 'verificationStatus', 'paymentStatus']) {
    assert.equal(cols.includes(dim), true, `${dim} stays its own dimension`);
  }
  assert.equal(/genericStatus|lineStatus|invoiceState/.test(sViProj), false);
  assert.match(sViProj, /discrepancyCodes: row\.discrepancyCodes\.join\(','\)/);
  // Payment semantics are CURRENT STATE only: no payment-event row, no receipt/instrument
  // claim, no history flattening anywhere in adapter or projection.
  assert.equal(/paymentEvent|historyAction|vendor_invoice_history|receipt|instrument|bankTransfer/i.test(sViProj + sAdapters.VI), false);
  // Money verbatim: invoiceAmount/paidAmount/outstandingAmount copied; no outstanding
  // recomputation, no cross-currency sum, no FX, no tax.
  assert.match(sViProj, /invoiceAmount: row\.invoiceAmount,/);
  assert.match(sViProj, /paidAmount: row\.paidAmount,/);
  assert.match(sViProj, /outstandingAmount: row\.outstandingAmount,/);
  assert.equal(/invoiceAmount\s*[-+*/]|[-+*/]\s*paidAmount|paidAmount\s*[-+*/]|outstandingAmount\s*[-+*/]|toFixed|Math\.round|SUM\(|\.reduce\(/i.test(sViProj + sAdapters.VI), false);
  assert.equal(/\bfx\b|exchange[Rr]ate|convert|\btax\b|\bvat\b/i.test(sViProj + sAdapters.VI), false);
  // No BAST/PO/receiving/RFQ/budget enrichment: lineage ids stay bare persisted references and
  // none of the module's drill or command exports is ever called.
  for (const k of ['vendorWorkId', 'workOrderId', 'completionReportId', 'serviceReportId',
    'bastDocumentId', 'purchaseOrderId', 'workContractId']) {
    assert.equal(cols.includes(k), true, `${k} stays a bare persisted drill handle`);
  }
  assert.equal(/evaluateMatching|getVendorInvoiceMatching|getVendorInvoiceTrace|getVendorInvoiceConsistency|evaluateBastHardGate|evaluateSettlementReadiness|recordVendorPayment|resolveVendorInvoiceAvailableActions|bastRepository|workOrderRepository|vendorWorkRepository|purchaseOrderRepository/i.test(sViProj + sAdapters.VI), false);
  // Period: the source's own INCLUSIVE invoice_date window; transport dateFrom/dateTo mapped to
  // the parser's native names, with native names failing closed on the transport contract.
  assert.match(sAdapters.VI, /invoiceDateFrom: passThrough\.dateFrom,\s+invoiceDateTo: passThrough\.dateTo,/);
  assert.match(sAdapters.VI, /not a VENDOR_INVOICE_REGISTER query name; use dateFrom\/dateTo/);
  const viRepo = rd('src/modules/vendor-invoices/vendor-invoice.repository.ts');
  assert.match(viRepo, /invoice_date >= \$\$\{values\.length\}::date/);
  assert.match(viRepo, /invoice_date <= \$\$\{values\.length\}::date/);
});

test('R11 G09 — STOCK_MOVEMENT_REGISTER safety (required userId, fail-closed scope, half-open movement_date window, historical snapshots, zero money)', () => {
  const FND = 'src/modules/stock-movement-register';
  const svc = rd(`${FND}/stock-movement-register.service.ts`);
  const repo = strip(rd(`${FND}/stock-movement-register.repository.ts`));
  const sSvc = strip(svc);
  // Adapter consumes the PART 05B governed public read with the authenticated userId REQUIRED.
  assert.match(regSrc, /import \{\s+getStockMovementRegister,\s+parseStockMovementRegisterQuery,\s+\} from '\.\.\/stock-movement-register';/);
  assert.match(sAdapters.SM, /const source = await getStockMovementRegister\(filters, userId\);/);
  assert.match(sSvc, /getStockMovementRegister\(\s+filters: StockMovementRegisterFilters,\s+userId: string,/);
  assert.equal(/actorUserId|userId\?/.test(sSvc), false, 'no optional-actor form');
  // Accessible-building scope, fail-closed on empty BEFORE any DB query (service short-circuit
  // plus repository guard), structural Building-set predicate first, one query, zero joins.
  assert.match(sSvc, /await contextAccessService\.assertBuildingAccess\(userId, filters\.buildingId\);/);
  assert.match(sSvc, /getAccessibleBuildingIds\(\s+userId,\s+\)/);
  const svcEmptyAt = sSvc.indexOf('if (buildingIds.length === 0)');
  assert.ok(svcEmptyAt !== -1 && svcEmptyAt < sSvc.indexOf('getStockMovementRegisterRows('));
  assert.ok(repo.indexOf('if (buildingIds.length === 0) return [];') < repo.indexOf('getPool().query'));
  assert.equal((repo.match(/getPool\(\)\.query/g) ?? []).length, 1);
  assert.equal((repo.match(/\sJOIN\s/g) ?? []).length, 0, 'zero display-name and reverse-domain joins');
  assert.deepEqual([...new Set([...repo.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map((m) => m[1]))],
    ['inventory_stock_movements']);
  assert.match(repo, /const conditions: string\[\] = \['movement\.building_id = ANY\(\$1::uuid\[\]\)'\];/);
  // movement_date is the period authority: strict calendar inputs normalized to the half-open
  // UTC window; the whole dateTo day is included via the next-day exclusive bound; the
  // <= dateTo-midnight truncation defect never exists; no created_at substitute.
  assert.match(sSvc, /DATE_ONLY = \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  assert.match(sSvc, /function isCalendarDate/);
  assert.match(sSvc, /MAX_RANGE_DAYS = 366/);
  assert.match(sSvc, /new Date\(toUtcMidnight\(filters\.dateTo\)\.getTime\(\) \+ 86400000\)/);
  assert.match(repo, /conditions\.push\(`movement\.movement_date >= \$\$\{values\.length\}`\)/);
  assert.match(repo, /conditions\.push\(`movement\.movement_date < \$\$\{values\.length\}`\)/);
  assert.equal((repo.match(/movement\.movement_date (>=|<)/g) ?? []).length, 2);
  assert.equal(/movement_date\s*<=(?!=)/.test(repo), false);
  assert.equal(/(created_at|updated_at)\s*(>=|<=|>|<)/.test(repo), false);
  // Native STOCK_IN|STOCK_OUT vocabulary via the owning domain's own validator; no generic
  // status; no normalization.
  assert.match(sSvc, /import \{ isStockMovementType \} from '\.\.\/inventory-stock-movements';/);
  assert.match(repo, /movementType: row\.movement_type/);
  assert.equal(/'IN'|'OUT'|\bRECEIPT\b|\bISSUE\b|\bCONSUMPTION\b|\bstatus\b/.test(sSvc + repo + sSmProj), false);
  // Quantity/UOM verbatim; resulting snapshots historical; no reservedQuantity derivation, no
  // current-balance alias, zero money in foundation, adapter and projection.
  assert.match(repo, /quantity: Number\(row\.quantity\)/);
  assert.match(repo, /uomId: row\.uom_id/);
  assert.match(repo, /resultingQuantityOnHand: Number\(row\.resulting_quantity_on_hand\)/);
  assert.match(repo, /resultingAvailableQuantity: Number\(row\.resulting_available_quantity\)/);
  assert.equal(/reservedQuantity|currentQuantityOnHand|currentAvailableQuantity|currentBalance|resultingQuantityOnHand\s*-|- *Number\(row\.resulting_available/i.test(sSvc + repo + sSmProj + sAdapters.SM), false);
  assert.equal(/currency|unitCost|totalCost|averageCost|standardCost|inventoryValue|stockValue|COGS|valuation|FIFO|LIFO|weightedAverage|\bprice\b|\bamount\b/i.test(sSvc + repo + sSmProj + sAdapters.SM), false);
  // No receiving/WO-usage/PO/invoice/reservation reverse enrichment.
  assert.equal(/receivings|material_usages|material_requests|reservations|purchase_orders|vendor_invoices|stock_transfers|stock_adjustments|inventory_stock_balances/i.test(repo + sSmProj + sAdapters.SM), false);
  // Actor semantics: performedByUserId = "Performed By" only, in the movement register alone.
  assert.equal(COLS.stockMovement.includes('performedByUserId'), true);
  assert.equal(/receivedByUserId|usedByUserId|consumedByUserId|requesterUserId|approverUserId|executorUserId/i.test(sSmProj + repo + sSvc), false);
});

test('R11 G10 — OPERATIONAL_BUDGET_VARIANCE safety (source-owned figures only; zero Reporting financial math)', () => {
  const FND = 'src/modules/operational-finance';
  const varSvc = rd(`${FND}/operational-variance.service.ts`);
  const finRepo = rd(`${FND}/operational-finance.repository.ts`);
  // Adapter consumes ONLY the public variance service + the owning parsers; userId reaches both
  // reads; the traceability drill stays out.
  assert.match(regSrc, /import \{\s+operationalVarianceService,\s+parseOperationalBudgetFilters,\s+parseOperationalBudgetIdParam,\s+\} from '\.\.\/operational-finance';/);
  assert.equal((sAdapters.OBV.match(/userId,\s+\);/g) ?? []).length, 2);
  assert.equal(/getOperationalBudgetTraceability/i.test(sAdapters.OBV), false);
  // Identities and per-row currency/period pins (executed column contracts).
  assert.equal(COLS.obvBudget[0], 'budgetId', 'BUDGET identity is the source budgetId');
  assert.deepEqual(COLS.obvCategory.slice(0, 2), ['budgetId', 'budgetCategoryId'],
    'CATEGORY identity is budgetId + source budgetCategoryId');
  for (const cols of [COLS.obvBudget, COLS.obvCategory]) {
    assert.equal(cols.includes('currency'), true, 'one budget currency per row');
    assert.equal(cols.includes('periodStart') && cols.includes('periodEnd'), true,
      'budget control period preserved');
    assert.equal(cols.includes('status'), true, 'native status preserved');
  }
  assert.equal(COLS.obvCategory.includes('overspendPolicy'), true, 'native policy preserved');
  assert.equal(COLS.obvBudget.includes('failClosed') && COLS.obvBudget.includes('gapCount'), true,
    'source-owned fail-closed control and gap count preserved at the summary grain');
  assert.equal(/healthy|atRisk|overBudget|'GREEN'|'AMBER'|'RED'|trafficLight|budgetHealth/i.test(sObvProj + sAdapters.OBV), false,
    'no invented financial status');
  // HARD FAIL on any Reporting-side financial formula: no addition, subtraction,
  // multiplication, division, reduce/sum, rounding, percentage calculation or zero-fill over
  // financial fields in the R11 budget adapter/projections (ordinary non-financial string/array
  // operations — the envelope buildingScope Set/sort — are the frozen house convention and are
  // scoped out by scanning for operators bound to financial operands).
  assert.equal(/Amount\s*[-+*/]|[-+*/]\s*\w*Amount|Percent\s*[-+*/]|[-+*/]\s*\w*Percent|planned\s*-|-\s*actual/i.test(sObvProj + sAdapters.OBV), false);
  assert.equal(/percent\(|\*\s*100|\/\s*100|\/\s*planned|toFixed|Math\.round|ROUND\(|SUM\(|AVG\(|\.reduce\(/i.test(sObvProj + sAdapters.OBV), false);
  assert.equal(/\?\?\s*0\b|\|\|\s*0\b/.test(sObvProj + sAdapters.OBV), false, 'no zero-fill for excluded amounts or null percentages');
  assert.equal(/gapAmount|gapValue|valuedGap|exclusionAmount|exclusionValue/i.test(sObvProj + sAdapters.OBV), false,
    'gaps stay described, never valued');
  assert.equal(/consolidat|crossCurrency|baseCurrency|reportingCurrency|totalAmount|grandTotal|\bfx\b|exchange[Rr]ate|convert|\btax\b|\bvat\b|COGS|valuation|FIFO|LIFO|weightedAverage/i.test(sObvProj + sAdapters.OBV), false);
  // No traceability expansion, no PO/invoice/cost/expense/WO-usage enrichment.
  assert.equal(/purchaseOrder|purchase_order|vendorInvoice|vendor_invoice|vendor_service_cost|materialUsage|workOrderMaterialUsage|basicExpense|basic_expense|sourceBinding|source_binding|commitmentEntry|listCommitments|operationalCommitment|\brfq\b|receivings|classification|sourceType/i.test(sObvProj + sAdapters.OBV), false);
  // Scope and period semantics stay source-owned (frozen source text re-proven): explicit
  // Building assertion, actor rollup, structural Building-set scope with fail-closed empty
  // scope, and the budget-period OVERLAP filter over period_start/period_end.
  assert.match(varSvc, /await contextAccessService\.assertBuildingAccess\(actorUserId, filters\.buildingId\);/);
  assert.match(varSvc, /const buildingIds = await contextAccessService\.getAccessibleBuildingIds\(\s+actorUserId,\s+\);/);
  assert.match(varSvc, /if \(!budget\) throw operationalBudgetNotFoundError\(\);/);
  assert.match(varSvc, /await contextAccessService\.assertBuildingAccess\(actorUserId, budget\.buildingId\);/);
  assert.match(finRepo, /if \(buildingIds\.length === 0\) return \[\];/);
  assert.match(finRepo, /clauses = \['building_id = ANY\(\$1::uuid\[\]\)'\]/);
  assert.match(finRepo, /period_end >= \$\$\{values\.length\}::date/);
  assert.match(finRepo, /period_start <= \$\$\{values\.length\}::date/);
  // The adapter forwards the source-owned filter names unchanged (no second period parser) and
  // never substitutes createdAt/updatedAt for the budget period.
  assert.match(sAdapters.OBV, /periodFrom: passThrough\.periodFrom,\s+periodTo: passThrough\.periodTo,/);
  assert.equal(/DATE_ONLY|toUtcMidnight|isCalendarDate|86400000/.test(sAdapters.OBV), false);
  assert.equal(/dateFrom: (?!filters\.periodFrom|source\.dateFrom|null)/.test(sAdapters.OBV), false);
  assert.equal(/dateFrom: .*createdAt|dateTo: .*createdAt/.test(sR11Region), false,
    'no createdAt business-period fallback in any R11 adapter');
});

test('R11 G11/G12/G13 — foundation boundaries, no direct SQL, no Reporting-side scope authority', () => {
  // GUARD 11 — the exactly-3 R11 foundations remain bounded, read-only, internal: 4-file house
  // shape, no route/controller/permission vocabulary, no write statement, not mounted anywhere.
  for (const f of R11_FOUNDATIONS) {
    const dir = `src/modules/${f}`;
    assert.deepEqual(fs.readdirSync(path.join(ROOT, dir)).sort(),
      ['index.ts', `${f}.repository.ts`, `${f}.service.ts`, `${f}.types.ts`].sort(),
      `${f}: exactly the four house-shape files`);
    const mod = ['index.ts', `${f}.repository.ts`, `${f}.service.ts`, `${f}.types.ts`]
      .map((part) => rd(`${dir}/${part}`)).join('\n');
    const sMod = strip(mod.replace(/export \* from/g, 'exportStar from'));
    assert.equal(/createRouter|router\.|controller|requirePermission|rbac/i.test(sMod), false,
      `${f}: no route/controller/permission surface`);
    assert.equal(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|recordOperationalEvent/i.test(sMod), false,
      `${f}: read-only, no write statement`);
    assert.equal(rd('src/routes/index.ts').includes(f), false, `${f}: never mounted`);
    // Reporting consumes the PUBLIC index; the repository symbol is never imported.
    assert.equal(regSrc.includes(`from '../${f}'`), true, `${f}: public index consumed`);
  }
  assert.equal(/receivingRegisterRepository|purchaseOrderLineRegisterRepository|stockMovementRegisterRepository/.test(sReg), false,
    'no foundation repository symbol anywhere in the stripped registry');
  // GUARD 12 — no direct SQL in ANY Reporting adapter: no pool, no query call, no SQL shape.
  assert.equal(/getPool|\.query\(|\bSELECT\b|\bFROM\s+[a-z_]+|\bWHERE\b/i.test(sReg), false);
  // GUARD 13 — no Reporting-side scope authority in the R11 adapters: context-access and
  // building authorities are never imported or used; scope stays source-owned.
  assert.equal(/contextAccessService|buildingRepository|getAccessibleBuildingIds|assertBuildingAccess|management-read-scope|managementReadScope/.test(sR11Region), false);
  assert.equal(regSrc.includes("from '../context-access'"), false);
  assert.equal(regSrc.includes("from '../buildings'"), false);
});

test('R11 G14/G15/G16 — money/currency discipline, actor semantics, period authorities across R11', () => {
  // GUARD 14 — money keys per dataset, pinned from the EXECUTED column contracts.
  const moneyish = (cols) => cols.filter((k) => /amount|price|cost|currency|value|percent/i.test(k));
  assert.deepEqual(moneyish(COLS.receiving), [], 'RECEIVING_REGISTER: no money at all');
  assert.deepEqual(moneyish(COLS.stockMovement), [], 'STOCK_MOVEMENT_REGISTER: no money at all');
  assert.deepEqual(moneyish(COLS.poHeader), ['currency'],
    'PO HEADER: currency context only, no header amount');
  assert.deepEqual(moneyish(COLS.poLine), ['currency', 'unitPrice', 'lineAmount'],
    'PO LINE: unitPrice + lineAmount + the one parent-PO currency only');
  assert.deepEqual(moneyish(COLS.vendorInvoice),
    ['currency', 'invoiceAmount', 'paidAmount', 'outstandingAmount'],
    'VENDOR_INVOICE_REGISTER: the three persisted money facts + invoice currency only');
  assert.deepEqual(moneyish(COLS.obvBudget), ['currency', 'plannedAmount', 'ledgerCommittedAmount',
    'ledgerOpenAmount', 'ledgerActualizedAmount', 'ledgerReleasedAmount', 'legacyCommittedAmount',
    'uncommittedMaterialActualAmount', 'uncommittedInvoiceActualAmount', 'unallocatedActualAmount',
    'openCommitmentAmount', 'actualAmount', 'consumedAmount', 'availableAmount', 'varianceAmount',
    'utilizationPercent', 'committedUtilizationPercent'],
    'OBV BUDGET: exactly the source-owned figures');
  assert.deepEqual(moneyish(COLS.obvCategory), ['currency', 'plannedAmount', 'ledgerCommittedAmount',
    'ledgerOpenAmount', 'ledgerActualizedAmount', 'ledgerReleasedAmount', 'legacyCommittedAmount',
    'openCommitmentAmount', 'actualAmount', 'consumedAmount', 'availableAmount', 'varianceAmount',
    'utilizationPercent', 'committedUtilizationPercent'],
    'OBV CATEGORY: exactly the source-owned per-category figures');
  // Across the whole R11 seam + region: no cross-currency aggregation, FX, tax, COGS,
  // inventory valuation or invented price authority in stripped production code.
  const sAll = strip(projSrc) + sR11Region;
  assert.equal(/exchange[Rr]ate|convertCurrency|\bfx\b|\btax\b|\bvat\b|COGS|FIFO|LIFO|weightedAverage|inventoryValue|stockValue|valuation|price[_-]?catalog|crossCurrency|consolidat/i.test(sAll), false);
  assert.equal(/SUM\(|\.reduce\(|toFixed|Math\.round/i.test(sAll), false);
  // GUARD 15 — actor semantics: exact source meanings only, no promotion, no inference.
  assert.equal(COLS.receiving.includes('receivedByUserId'), true);
  assert.equal(COLS.stockMovement.includes('performedByUserId'), true);
  assert.equal(COLS.receiving.includes('performedByUserId'), false,
    'Performed By never leaks into receiving');
  assert.equal(COLS.stockMovement.includes('receivedByUserId'), false,
    'Received By never leaks into movements');
  for (const k of ['createdByUserId', 'verifiedByUserId', 'finalizedByUserId', 'cancelledByUserId']) {
    assert.equal(COLS.vendorInvoice.includes(k), true, `invoice actor ${k} keeps its exact meaning`);
  }
  for (const k of ['createdByUserId', 'issuedByUserId', 'cancelledByUserId']) {
    assert.equal(COLS.poHeader.includes(k), true, `PO actor ${k} keeps its exact meaning`);
  }
  const allCols = Object.values(COLS).flat();
  for (const invented of ['executorUserId', 'payerUserId', 'approverUserId', 'requesterUserId',
    'usedByUserId', 'consumedByUserId', 'performedBy', 'actorUserId']) {
    assert.equal(allCols.includes(invented), false, `no invented actor ${invented}`);
  }
  assert.equal(moneyish(COLS.obvBudget).includes('commitmentCount'), false);
  assert.equal(COLS.obvBudget.concat(COLS.obvCategory).some((k) => /UserId$/.test(k)), false,
    'OBV rows claim no actor at all');
  // GUARD 16 — period authorities pinned per dataset (source-side predicates, frozen text).
  assert.match(rd('src/modules/receiving-register/receiving-register.repository.ts'),
    /r\.received_at >= \$\$\{values\.length\}`\);[\s\S]*r\.received_at < \$\$\{values\.length\}/);
  assert.match(rd('src/modules/purchase-order-line-register/purchase-order-line-register.repository.ts'),
    /po\.po_date >= \$\$\{values\.length\}::date/);
  assert.match(rd('src/modules/vendor-invoices/vendor-invoice.repository.ts'),
    /invoice_date >= \$\$\{values\.length\}::date/);
  assert.match(rd('src/modules/stock-movement-register/stock-movement-register.repository.ts'),
    /movement\.movement_date >= \$\$\{values\.length\}`\);[\s\S]*movement\.movement_date < \$\$\{values\.length\}/);
  assert.match(rd('src/modules/operational-finance/operational-finance.repository.ts'),
    /period_end >= \$\$\{values\.length\}::date/);
  // Adapter envelopes echo only the source-owned window values.
  assert.match(sAdapters.RECEIVING, /dateFrom: source\.dateFrom,\s+dateTo: source\.dateTo,/);
  assert.match(sAdapters.PO, /dateFrom: filters\.poDateFrom \?\? null,\s+dateTo: filters\.poDateTo \?\? null,/);
  assert.match(sAdapters.PO, /dateFrom: source\.dateFrom,\s+dateTo: source\.dateTo,/);
  assert.match(sAdapters.VI, /dateFrom: filters\.invoiceDateFrom \?\? null,\s+dateTo: filters\.invoiceDateTo \?\? null,/);
  assert.match(sAdapters.SM, /dateFrom: source\.dateFrom,\s+dateTo: source\.dateTo,/);
  assert.match(sAdapters.OBV, /dateFrom: filters\.periodFrom \?\? null,\s+dateTo: filters\.periodTo \?\? null,/);
});

test('R11 G17/G18 — no R10 regression/reopen; no delivery expansion; bounded R11 diff range', () => {
  // GUARD 17 — R10 immutability at CURRENT HEAD (bounded-range proof, NOT the old whole-tree
  // workprint assertion): the inherited 18 keep their exact names and order (no rename, no
  // removal), the eight R10 artifacts remain present, and the frozen R10-era Reporting
  // production files are untouched across the whole R11 range.
  assert.deepEqual(DATASETS.slice(0, 18), INHERITED_18);
  for (const a of ['FINDING_REGISTER', 'CORRECTIVE_ACTION', 'OPERATIONAL_DETAIL_HISTORY',
    'WORK_ORDER_SLA', 'SCHEDULED_OPERATION_LINEAGE', 'PERMIT_TO_WORK',
    'SECURITY_OPERATIONAL_DETAIL', 'INCIDENT_REGISTER']) {
    assert.equal(DATASETS.includes(a), true, `R10 artifact ${a} remains registered`);
  }
  for (const f of [`${RE}/reporting-export.service.ts`, `${RE}/reporting-export.projections.ts`,
    `${RE}/reporting-export.management-projections.ts`, `${RE}/reporting-export.r10-projections.ts`,
    `${RE}/reporting-export.controller.ts`, `${RE}/reporting-export.routes.ts`,
    `${RE}/reporting-export.validation.ts`, `${RE}/csv-renderer.ts`, `${RE}/xlsx-renderer.ts`,
    `${RE}/pdf-renderer.ts`, `${RE}/index.ts`]) {
    assert.equal(fs.existsSync(path.join(ROOT, f)), true, `${f} remains present`);
  }
  assert.equal(git('diff', '--name-only', `${PRE_R11}..HEAD`, '--', RE), 
    [`${RE}/reporting-export.r11-projections.ts`, `${RE}/reporting-export.registry.ts`,
      `${RE}/reporting-export.types.ts`].sort().join('\n'),
    'R10 closure note: across ALL of R11, only the three registration-ripple files changed in reporting-export');
  // GUARD 18 — zero routes, zero migrations, zero new permissions, zero renderer/archive
  // special cases, zero workflow mutation across the whole R11 range; registration went
  // through the existing generic mechanism only.
  assert.equal(git('diff', '--name-only', `${PRE_R11}..HEAD`, '--', 'src/routes', 'src/database',
    'src/modules/auth'), '', 'no route, migration or permission surface changed in R11');
  const R11_TOKENS = /RECEIVING_REGISTER|PURCHASE_ORDER_REGISTER|VENDOR_INVOICE_REGISTER|STOCK_MOVEMENT_REGISTER|OPERATIONAL_BUDGET_VARIANCE|receivingRegister|purchaseOrderHeader|purchaseOrderLine|vendorInvoiceRegister|stockMovementRegister|operationalBudgetVariance/;
  for (const f of [`${RE}/reporting-export.service.ts`, `${RE}/csv-renderer.ts`,
    `${RE}/xlsx-renderer.ts`, `${RE}/pdf-renderer.ts`, `${RE}/reporting-export.controller.ts`,
    `${RE}/reporting-export.routes.ts`, `${RE}/reporting-export.validation.ts`]) {
    assert.equal(R11_TOKENS.test(rd(f)), false, `${f}: no R11 special case`);
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'src/modules/reporting-archives'))
    .filter((name) => name.endsWith('.ts'))) {
    assert.equal(R11_TOKENS.test(rd(`src/modules/reporting-archives/${f}`)), false,
      `reporting-archives/${f}: no R11 special case`);
  }
  assert.equal(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|recordOperationalEvent/i.test(sR11Region), false,
    'no workflow/lifecycle mutation in the R11 adapters');
  // The whole-R11 production footprint: exactly the three foundations (4 files each) plus the
  // three registration-ripple files plus the OpenAPI doc — and nothing else outside tests.
  const allChanged = git('diff', '--name-only', `${PRE_R11}..HEAD`).split('\n').filter(Boolean);
  const nonTest = allChanged.filter((f) => !f.startsWith('tests/'));
  const expectedProduction = [
    'docs/api/openapi.yaml',
    ...R11_FOUNDATIONS.flatMap((f) => [`${f}/index.ts`, `${f}/${f}.repository.ts`,
      `${f}/${f}.service.ts`, `${f}/${f}.types.ts`].map((p) => `src/modules/${p}`)),
    `${RE}/reporting-export.r11-projections.ts`, `${RE}/reporting-export.registry.ts`,
    `${RE}/reporting-export.types.ts`,
  ].sort();
  assert.deepEqual(nonTest.slice().sort(), expectedProduction,
    'R11 production+docs footprint is exactly the frozen 16-file set');
  // New module directories since R10 closure: exactly the three foundations.
  const newDirs = [...new Set(allChanged.filter((f) => f.startsWith('src/modules/'))
    .map((f) => f.split('/')[2]))].sort();
  assert.deepEqual(newDirs, [...R11_FOUNDATIONS, 'reporting-export'].sort());
  // The R11 test family is exactly the eight historical phase tests plus THIS closure guard
  // (commit-state independent), and every historical test is byte-unchanged at BASE and was
  // never executed here.
  const r11Tests = [...new Set([
    ...git('diff', '--name-only', `${PRE_R11}..HEAD`, '--', 'tests').split('\n').filter(Boolean),
    ...git('ls-files', '--others', '--exclude-standard', 'tests').split('\n').filter(Boolean),
  ])].sort();
  assert.deepEqual(r11Tests, [...HISTORICAL_TESTS.filter((t) => t.startsWith('tests/r11-')), SELF].sort());
  for (const t of HISTORICAL_TESTS) {
    assert.equal(git('hash-object', t), git('rev-parse', `${BASE}:${t}`), `${t} blob identical`);
  }
  // PART 07 itself changes exactly one file: this guard. Zero production change.
  const changedTracked = git('diff', '--name-only', BASE).split('\n').filter(Boolean);
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  const changed = [...new Set([...changedTracked, ...untracked])];
  assert.deepEqual(changed, [SELF], 'PART 07 footprint is exactly this closure guard');
});

test('R11 G-CLOSE — type-strip validation of this guard; registry structurally closed', () => {
  assert.doesNotThrow(() => stripTypeScriptTypes(rd(SELF), { mode: 'strip' }),
    'the closure guard type-strips cleanly');
  // The registry object stays structurally closed with the R11 tail in executable order and
  // the generic accessor intact (the dropped-brace defect class R10 PART 19 caught).
  assert.match(regSrc, new RegExp(`\\n\\};\\n\\nexport function getReportingExportDatasetAdapter\\(`));
  assert.equal(registryKeys[registryKeys.length - 1], 'OPERATIONAL_BUDGET_VARIANCE');
  assert.match(regSrc, /dataset must be one of: \$\{REPORTING_EXPORT_DATASETS\.join\(', '\)\}\./);
});
