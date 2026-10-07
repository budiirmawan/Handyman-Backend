/**
 * R11 PART 04 — VENDOR_INVOICE_REGISTER registration: focused contract test.
 *
 * Proves the 20 → 21 registration ripple and the adapter/projection contract
 * WITHOUT executing any historical test and WITHOUT live PostgreSQL
 * (node_modules absent). Method — the established R11 hybrid: the
 * dependency-free runtime surfaces (dataset vocabulary, CSV-default
 * metadata, the projection) are EXECUTED for real under `node --test` with
 * native type stripping; the registry adapter and OpenAPI ripple are proven
 * from source text; `stripTypeScriptTypes` validates every changed file;
 * byte-identity of the source authority modules, frozen Reporting surfaces
 * and all historical tests is proven via git against the PART 03C baseline.
 *
 * PROVES (PART 04 checklist 1–50): declared once; 21/21/21 parity with
 * equal sets and order; vendor_invoice.read reused; public vendor-invoices
 * authority consumed (no repository, no SQL, userId passed); one table
 * `vendorInvoiceRegister`; one row per invoice; id → vendorInvoiceId;
 * lineage/number/date verbatim; the three native status dimensions separate
 * and verbatim; discrepancyCodes on-row (comma-joined, never fanned out);
 * money verbatim with zero arithmetic, no FX, no tax; payment = current
 * state only (no event rows, no history flattening, no payment actor);
 * dateFrom/dateTo transport-mapped to invoiceDateFrom/invoiceDateTo with
 * native names fail-closed; invoice_date the only period authority; kpis =
 * []; no CSV default; no drill enrichment (matching, trace, settlement,
 * BAST gate, consistency, payment recording are never called); no route,
 * migration or permission; frozen surfaces byte-unchanged.
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

/** PART 03C closure — the fixed baseline this PART builds on. */
const BASE = '7f2554587750ddf3b7a3f92bb77ef7bab4baec6b';
const RE = 'src/modules/reporting-export';
const TYPES = `${RE}/reporting-export.types.ts`;
const REG = `${RE}/reporting-export.registry.ts`;
const R11PROJ = `${RE}/reporting-export.r11-projections.ts`;
const OPENAPI = 'docs/api/openapi.yaml';
const SELF = 'tests/r11-part04-vendor-invoice-register.test.ts';
const CHANGED = [TYPES, REG, R11PROJ, OPENAPI, SELF];
const HISTORICAL_TESTS = [
  'tests/r10-part20-closure-guard.test.ts',
  'tests/r11-part01-receiving-register-read.test.ts',
  'tests/r11-part02-receiving-register.test.ts',
  'tests/r11-part03b-purchase-order-line-register-read.test.ts',
  'tests/r11-part03c-purchase-order-register.test.ts',
];

const typesSrc = rd(TYPES);
const regSrc = rd(REG);
const projSrc = rd(R11PROJ);
const openapiSrc = rd(OPENAPI);
const sReg = strip(regSrc);
const sProj = strip(projSrc);
const adapterBlock = regSrc.slice(regSrc.indexOf('  VENDOR_INVOICE_REGISTER: {'));
const sAdapter = strip(adapterBlock);
const registryKeys = [...regSrc.matchAll(/^ {2}([A-Z][A-Z0-9_]+): \{$/gm)].map((m) => m[1]);
const archiveBlock = openapiSrc.split('    ReportArchiveDataset:')[1].split('    ReportArchiveFormat:')[0];
const enumBody = archiveBlock.slice(archiveBlock.indexOf('['), archiveBlock.indexOf(']') + 1);
const openapiEnum = enumBody.match(/[A-Z][A-Z0-9_]+/g) ?? [];

/** Dependency-free runtime imports (explicit .ts specifiers, house precedent). */
const types = await import('../src/modules/reporting-export/reporting-export.types.ts');
const r11proj = await import('../src/modules/reporting-export/reporting-export.r11-projections.ts');

const DATASETS = types.REPORTING_EXPORT_DATASETS;

/** Canned rows in the exact PublicVendorInvoice shape (source-verified field-for-field). */
const INV_A = {
  id: 'cccc0000-0000-4000-8000-000000000001',
  clientId: 'cccc0000-0000-4000-8000-0000000000c1',
  buildingId: 'cccc0000-0000-4000-8000-0000000000b1',
  vendorId: 'cccc0000-0000-4000-8000-0000000000e1',
  invoiceNumber: 'INV-2026-0007',
  invoiceDate: '2026-09-05',
  receivedDate: '2026-09-06',
  currency: 'IDR',
  invoiceAmount: 5000000,
  status: 'FINALIZED',
  vendorReference: 'V-REF-11',
  vendorWorkId: null,
  workOrderId: 'cccc0000-0000-4000-8000-0000000000w1',
  completionReportId: null,
  serviceReportId: null,
  bastDocumentId: 'cccc0000-0000-4000-8000-0000000000a1',
  purchaseOrderId: 'cccc0000-0000-4000-8000-0000000000p1',
  workContractId: 'cccc0000-0000-4000-8000-0000000000s1',
  notes: null,
  createdByUserId: 'cccc0000-0000-4000-8000-0000000000u1',
  verificationStatus: 'DISCREPANCY',
  verifiedByUserId: 'cccc0000-0000-4000-8000-0000000000u2',
  verifiedAt: '2026-09-07T02:00:00.000Z',
  verificationNotes: 'Amount differs from committed total',
  discrepancyCodes: ['CURRENCY_MISMATCH', 'PURCHASE_ORDER_VENDOR_MISMATCH'],
  paymentStatus: 'PARTIALLY_PAID',
  paidAmount: 2000000,
  outstandingAmount: 3000000,
  lastPaymentDate: '2026-09-10',
  finalizedAt: '2026-09-06T01:00:00.000Z',
  finalizedByUserId: 'cccc0000-0000-4000-8000-0000000000u1',
  cancelledAt: null,
  cancelledByUserId: null,
  createdAt: '2026-09-05T00:30:00.000Z',
  updatedAt: '2026-09-10T04:00:00.000Z',
};
const INV_B = {
  ...INV_A,
  id: 'cccc0000-0000-4000-8000-000000000002',
  invoiceNumber: 'INV-2026-0008',
  invoiceDate: '2026-09-08',
  receivedDate: '2026-09-08',
  currency: 'USD',
  invoiceAmount: 1250500.75,
  status: 'DRAFT',
  vendorReference: null,
  workOrderId: null,
  bastDocumentId: null,
  purchaseOrderId: null,
  workContractId: null,
  notes: 'Draft awaiting documents',
  verificationStatus: 'PENDING',
  verifiedByUserId: null,
  verifiedAt: null,
  verificationNotes: null,
  discrepancyCodes: [],
  paymentStatus: 'UNPAID',
  paidAmount: 0,
  outstandingAmount: 1250500.75,
  lastPaymentDate: null,
  finalizedAt: null,
  finalizedByUserId: null,
};

/** The 35 projected fields in authoritative record order (id renamed first). */
const ROW_KEYS = ['vendorInvoiceId', 'clientId', 'buildingId', 'vendorId', 'invoiceNumber',
  'invoiceDate', 'receivedDate', 'currency', 'invoiceAmount', 'status', 'vendorReference',
  'vendorWorkId', 'workOrderId', 'completionReportId', 'serviceReportId', 'bastDocumentId',
  'purchaseOrderId', 'workContractId', 'notes', 'createdByUserId', 'verificationStatus',
  'verifiedByUserId', 'verifiedAt', 'verificationNotes', 'discrepancyCodes', 'paymentStatus',
  'paidAmount', 'outstandingAmount', 'lastPaymentDate', 'finalizedAt', 'finalizedByUserId',
  'cancelledAt', 'cancelledByUserId', 'createdAt', 'updatedAt'];

test('R11 P04 01–05/38/39 — declared once, parity 21/21/21, sets and order equal, CSV default untouched', () => {
  // 01 — declared exactly once, appended last.
  assert.equal(DATASETS.filter((d) => d === 'VENDOR_INVOICE_REGISTER').length, 1);
  assert.equal((typesSrc.match(/'VENDOR_INVOICE_REGISTER',/g) ?? []).length, 1);
  assert.equal(DATASETS[DATASETS.length - 1], 'VENDOR_INVOICE_REGISTER');
  // 02/03/04 — parity 21/21/21.
  assert.equal(DATASETS.length, 21, 'runtime dataset enum is 21');
  assert.equal(registryKeys.length, 21, 'registry adapter count is 21');
  assert.equal(openapiEnum.length, 21, 'OpenAPI dataset enum is 21');
  // 05 — same set everywhere; OpenAPI order matches runtime order position by position.
  assert.deepEqual([...registryKeys].sort(), [...DATASETS].sort());
  assert.deepEqual([...openapiEnum].sort(), [...DATASETS].sort());
  assert.deepEqual(openapiEnum, [...DATASETS]);
  assert.equal(new Set(registryKeys).size, 21);
  // 38/39 — no CSV default added; OPERATIONAL_DETAIL remains the ONLY configured default
  // (sole-table selection is sufficient for this dataset).
  assert.deepEqual(Object.keys(types.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
  assert.equal((typesSrc.match(/csvDefaultTableKey:/g) ?? []).length, 1);
  assert.equal(/csvDefaultTableKey/.test(adapterBlock), false);
  // The management subset is untouched.
  assert.deepEqual([...types.MANAGEMENT_REPORTING_EXPORT_DATASETS], ['MANAGEMENT_OPERATIONS_COMMAND_CENTER']);
  // OpenAPI documents the dataset and its table key.
  assert.equal(openapiSrc.includes('VENDOR_INVOICE_REGISTER (R11)'), true);
  assert.ok(archiveBlock.includes('vendorInvoiceRegister'));
});

test('R11 P04 06–10/46–48 — public authority under vendor_invoice.read; no repository, SQL, route, migration or permission', () => {
  // 07 — the adapter imports the PUBLIC module contract (index): parser + list read only.
  assert.match(regSrc, /import \{\s+listVendorInvoices,\s+parseVendorInvoiceFilters,\s+\} from '\.\.\/vendor-invoices';/);
  assert.match(sAdapter, /const filters = parseVendorInvoiceFilters\(\{/);
  assert.match(sAdapter, /const rows = await listVendorInvoices\(filters, userId\);/);
  // 10 — the authenticated userId reaches the source authority; scope is never re-resolved.
  assert.equal((sAdapter.match(/\(filters, userId\)/g) ?? []).length, 1);
  assert.equal(/contextAccessService|getAccessibleBuildingIds|assertBuildingAccess/.test(sAdapter), false);
  // 08/09 — the repository is NOT imported and Reporting issues no SQL at all.
  assert.equal(sReg.includes('vendorInvoiceRepository'), false, 'no repository symbol in stripped registry');
  assert.equal(/getPool|\.query\(/.test(sReg), false);
  assert.equal(/FROM\s+vendor_invoices/i.test(regSrc), false);
  // 06/48 — the EXISTING permission is reused, source-verified where it already gates the list
  // route; no new permission surface exists anywhere in this ripple.
  assert.match(adapterBlock, /requiredReadPermission: 'vendor_invoice\.read'/);
  assert.match(rd('src/modules/vendor-invoices/vendor-invoice.routes.ts'), /requirePermission\('vendor_invoice\.read'\)/);
  assert.equal(/requirePermission\(|code: '[a-z_]+\.(read|manage)'/.test(sAdapter), false);
  assert.equal(git('diff', BASE, '--', 'src/modules/auth'), '', 'no permission vocabulary changed');
  // 46 — no HTTP surface added.
  assert.equal(git('diff', BASE, '--', 'src/routes'), '');
  assert.equal(rd('src/routes/index.ts').includes('VENDOR_INVOICE_REGISTER'), false);
  assert.equal(rd('src/routes/index.ts').includes('vendor-invoice-register'), false);
  // 47 — no migration added or changed.
  assert.equal(git('diff', BASE, '--', 'src/database'), '');
});

test('R11 P04 34–36 — invoice_date transport mapping, inclusive source semantics, no createdAt fallback', () => {
  // 34 — dateFrom/dateTo are transport-mapped to the owning parser's native names; exactly the
  // eight documented keys are forwarded, so no other query key can reach the source parser.
  assert.match(sAdapter, /invoiceDateFrom: passThrough\.dateFrom,\s+invoiceDateTo: passThrough\.dateTo,/);
  const forwarded = sAdapter.slice(sAdapter.indexOf('parseVendorInvoiceFilters({'),
    sAdapter.indexOf('});', sAdapter.indexOf('parseVendorInvoiceFilters({')));
  assert.deepEqual([...forwarded.matchAll(/(\w+): passThrough\.\w+/g)].map((m) => m[1]).sort(),
    ['buildingId', 'invoiceDateFrom', 'invoiceDateTo', 'purchaseOrderId', 'status', 'vendorId',
      'workContractId', 'workOrderId']);
  // Source-native period names FAIL CLOSED rather than being silently ignored (the same
  // truthfulness rule PURCHASE_ORDER_REGISTER enforces for poDateFrom/poDateTo).
  assert.match(sAdapter, /\(\['invoiceDateFrom', 'invoiceDateTo'\] as const\)\.filter\(/);
  assert.match(sAdapter, /not a VENDOR_INVOICE_REGISTER query name; use dateFrom\/dateTo/);
  // 35 — invoice_date remains the period authority: the envelope echoes the owning parser's own
  // accepted invoice-date window, and the source repository applies it INCLUSIVE (>= from::date,
  // <= to::date) — verified against the untouched source authority.
  assert.match(sAdapter, /dateFrom: filters\.invoiceDateFrom \?\? null,\s+dateTo: filters\.invoiceDateTo \?\? null,/);
  const repoSrc = rd('src/modules/vendor-invoices/vendor-invoice.repository.ts');
  assert.match(repoSrc, /invoice_date >= \$\$\{values\.length\}::date/);
  assert.match(repoSrc, /invoice_date <= \$\$\{values\.length\}::date/);
  // 36 — no createdAt/receivedDate/finalizedAt/verifiedAt/lastPaymentDate fallback: the window
  // values echoed are the invoice-date ones and nothing else feeds the envelope period.
  assert.equal(/dateFrom: (?!filters\.invoiceDateFrom)/.test(sAdapter), false);
  assert.equal(/dateTo: (?!filters\.invoiceDateTo)/.test(sAdapter), false);
  // The owning read stays set-based, scoped, fail-closed, join-free and deterministically
  // ordered — the qualities that make the pure adapter safe (source byte-unchanged, re-proven
  // here against the frozen text).
  assert.match(repoSrc, /if \(buildingIds\.length === 0\) return \[\];/);
  assert.match(repoSrc, /building_id = ANY\(\$1::uuid\[\]\)/);
  assert.match(repoSrc, /ORDER BY invoice_date DESC, created_at DESC/);
  assert.equal(/\sJOIN\s/.test(repoSrc.split('async function list')[1].split('async function update')[0]), false,
    'the list query has zero joins (case-sensitive: clauses.join( is not a SQL JOIN)');
  // asOf is envelope metadata minted immediately before the call — the only Reporting clock.
  assert.match(sAdapter, /const asOf = new Date\(\)\.toISOString\(\);\s+const rows = await listVendorInvoices/);
  assert.match(sAdapter, /buildingScope: \[\.\.\.new Set\(rows\.map\(\(row\) => row\.buildingId\)\)\]\.sort\(\)/);
});

test('R11 P04 11–24/29–33/37 — projection executed: one table, verbatim row, statuses separate, payment current-state', () => {
  const projected = r11proj.projectVendorInvoiceRegister([INV_A, INV_B]);
  // 37 — kpis empty; no count, total, rate, aging or overdue figure exists.
  assert.deepEqual(projected.kpis, []);
  // 11/12 — exactly ONE table with the recommended key.
  assert.equal(projected.tables.length, 1);
  const t = projected.tables[0];
  assert.equal(t.key, 'vendorInvoiceRegister');
  assert.equal(t.label, 'Vendor Invoice Register');
  // 13/32 — one projected row per source row: two invoices in, two rows out. No payment-event
  // row, no history row and no discrepancy fan-out materializes (A carries TWO codes yet the
  // register stays at exactly two rows).
  assert.equal(t.rowCount, 2);
  assert.equal(t.rows.length, 2);
  // Column contract: the 35 authoritative fields in record order.
  assert.deepEqual(t.columns.map((c) => c.key), ROW_KEYS);
  for (const money of ['invoiceAmount', 'paidAmount', 'outstandingAmount']) {
    assert.equal(t.columns.find((c) => c.key === money).type, 'NUMBER');
  }
  for (const date of ['invoiceDate', 'receivedDate', 'verifiedAt', 'lastPaymentDate', 'finalizedAt',
    'cancelledAt', 'createdAt', 'updatedAt']) {
    assert.equal(t.columns.find((c) => c.key === date).type, 'DATE');
  }
  assert.equal(t.columns.find((c) => c.key === 'discrepancyCodes').type, 'STRING');
  // 14 — identity: source `id` published ONLY as the explicit vendorInvoiceId.
  assert.equal(t.rows[0].vendorInvoiceId, INV_A.id);
  assert.equal('id' in t.rows[0], false);
  // 15–24/29/30 — every fact verbatim for both rows; discrepancyCodes comma-joined on-row.
  for (const [i, src] of [INV_A, INV_B].entries()) {
    const out = t.rows[i];
    assert.deepEqual(Object.keys(out).sort(), [...ROW_KEYS].sort());
    for (const k of ROW_KEYS) {
      const srcKey = k === 'vendorInvoiceId' ? 'id' : k;
      const expected = k === 'discrepancyCodes' ? src.discrepancyCodes.join(',') : src[srcKey];
      assert.deepEqual(out[k], expected, `${k} verbatim (row ${i})`);
    }
  }
  // 20 — codes preserved in persisted order, one cell, never fanned out, never interpreted.
  assert.equal(t.rows[0].discrepancyCodes, 'CURRENCY_MISMATCH,PURCHASE_ORDER_VENDOR_MISMATCH');
  assert.equal(t.rows[1].discrepancyCodes, '');
  // 17/18/19 — the three native dimensions stay separate under their own names.
  assert.equal(t.rows[0].status, 'FINALIZED');
  assert.equal(t.rows[0].verificationStatus, 'DISCREPANCY');
  assert.equal(t.rows[0].paymentStatus, 'PARTIALLY_PAID');
  assert.equal(t.rows[1].status, 'DRAFT');
  assert.equal(t.rows[1].verificationStatus, 'PENDING');
  assert.equal(t.rows[1].paymentStatus, 'UNPAID');
  // 21–24 — money and currency verbatim, including the fractional USD draft.
  assert.equal(t.rows[0].invoiceAmount, 5000000);
  assert.equal(t.rows[0].paidAmount, 2000000);
  assert.equal(t.rows[0].outstandingAmount, 3000000);
  assert.equal(t.rows[1].outstandingAmount, 1250500.75);
  assert.equal(t.rows[0].currency, 'IDR');
  assert.equal(t.rows[1].currency, 'USD');
  // 29/31 — actor semantics exact; no payment actor, payer or approver is invented.
  assert.equal(t.rows[0].verifiedByUserId, INV_A.verifiedByUserId);
  assert.equal(t.rows[0].createdByUserId, INV_A.createdByUserId);
  assert.equal(t.rows[0].finalizedByUserId, INV_A.finalizedByUserId);
  assert.equal(t.rows[0].cancelledByUserId, null);
  for (const out of t.rows) {
    for (const invented of ['payer', 'payerUserId', 'paymentActor', 'approverUserId', 'executorUserId',
      'vendorPic', 'lineStatus', 'genericStatus', 'totalAmount', 'paymentEvents', 'historyAction']) {
      assert.equal(invented in out, false, `no invented ${invented}`);
    }
  }
  // 33 — no vendor_invoice_history flattening anywhere in the projection or adapter code.
  assert.equal(/vendor_invoice_history|historyAction|paymentEvent/i.test(sProj + sAdapter), false);
  // Empty source → still exactly one well-formed table.
  const empty = r11proj.projectVendorInvoiceRegister([]);
  assert.equal(empty.tables.length, 1);
  assert.equal(empty.tables[0].rowCount, 0);
  assert.deepEqual(empty.kpis, []);
});

test('R11 P04 25–28/40–45 — zero monetary arithmetic; zero drill enrichment', () => {
  // Enrichment/arithmetic scans are scoped to the adapter plus the VENDOR INVOICE projection
  // slice — the R11 seam file legitimately also carries the receiving and purchase-order
  // projections of earlier PARTs, which are frozen and out of scope here.
  const sViProj = strip(projSrc.slice(projSrc.indexOf('export function projectVendorInvoiceRegister')));
  const sBoth = sAdapter + sViProj;
  // 25/26 — no arithmetic and no cross-row aggregation of any kind.
  assert.equal(/invoiceAmount\s*[-+*/]|paidAmount\s*[-+*/]|outstandingAmount\s*[-+*/]|[-+*/]\s*paidAmount|toFixed|Math\.round|SUM\(|\.reduce\(|\.sort\(\(a/i.test(sBoth), false);
  // 27/28 — no FX, no tax/VAT, no accounting classification.
  assert.equal(/\bfx\b|exchange|convert|\btax\b|\bvat\b|accounting|journal|ledger/i.test(sBoth), false);
  // 40–45 — no RFQ, receiving, PO, BAST, budget/commitment or price-catalog surface: the
  // vendor-invoices import is exactly parser + list read, and NONE of the module's drill or
  // command exports (matching, trace, consistency, settlement readiness, BAST hard gate,
  // payment recording, available actions) is ever called from the adapter.
  assert.equal(/evaluateMatching|getVendorInvoiceMatching|getVendorInvoiceTrace|getVendorInvoiceConsistency|evaluateBastHardGate|evaluateSettlementReadiness|getSettlementReadiness|recordVendorPayment|resolveVendorInvoiceAvailableActions|evaluateVendorConsistency/.test(sBoth), false);
  assert.equal(/rfq|price[_-]?catalog|priceCatalog|deviation|receivings|receivingRegister|budget|commitment/i.test(sBoth), false);
  assert.equal(/bastRepository|workOrderRepository|vendorWorkRepository|purchaseOrderRepository/i.test(sBoth), false);
  const viImports = [...regSrc.matchAll(/from '(\.\.\/vendor-invoices[^']*)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(viImports)], ['../vendor-invoices']);
  // The projection seam stays dependency-free at runtime (type-only imports only).
  assert.equal(/^import\s+(?!type)/m.test(projSrc), false);
  assert.match(projSrc, /^import type \{ PublicVendorInvoice \} from '\.\.\/vendor-invoices';$/m);
  // Governance token discipline (scan scope matches the guard and PART 01–03C).
  const all = typesSrc + regSrc + openapiSrc;
  for (const banned of ['PART 21', 'PART21', 'R11 —', 'COMMERCIAL_JOURNEY', 'RESOURCE_JOURNEY',
    'SERVICE_JOURNEY']) {
    assert.equal(all.includes(banned), false, `no ${banned} artifact exists`);
  }
});

test('R11 P04 49/50 — source modules and historical tests byte-unchanged; bounded footprint', () => {
  // 49 — the vendor-invoices authority and every previously closed source/frozen surface is
  // byte-unchanged versus the PART 03C baseline.
  assert.equal(git('diff', BASE, '--', 'src/modules/vendor-invoices', 'src/modules/purchase-orders',
    'src/modules/purchase-order-line-register', 'src/modules/receiving-register',
    `${RE}/reporting-export.service.ts`, `${RE}/reporting-export.projections.ts`,
    `${RE}/reporting-export.management-projections.ts`, `${RE}/reporting-export.r10-projections.ts`),
  '', 'source authorities and frozen Reporting files untouched');
  // 50 — every historical test is blob-identical to the baseline and none was executed; the
  // only test touched is this file (commit-state independent).
  for (const t of HISTORICAL_TESTS) {
    assert.equal(git('hash-object', t), git('rev-parse', `${BASE}:${t}`), `${t} blob identical`);
  }
  const trackedTestChanges = git('diff', '--name-only', BASE, '--', 'tests').split('\n').filter(Boolean);
  const untrackedTests = git('ls-files', '--others', '--exclude-standard', 'tests').split('\n').filter(Boolean);
  assert.deepEqual([...new Set([...trackedTestChanges, ...untrackedTests])], [SELF]);
  // Bounded PART 04 footprint: the four registration-ripple files plus this test only.
  const changedTracked = git('diff', '--name-only', BASE).split('\n').filter(Boolean);
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  const changed = [...new Set([...changedTracked, ...untracked])];
  assert.deepEqual(changed.filter((f) => !CHANGED.includes(f)), [],
    'PART 04 changes only the registration ripple + this test');
});

test('R11 P04 — type-strip validation of every changed file', () => {
  for (const f of [TYPES, REG, R11PROJ, SELF]) {
    assert.doesNotThrow(() => stripTypeScriptTypes(rd(f), { mode: 'strip' }), `${f} type-strips cleanly`);
  }
  // The adapter is the LAST registry entry and the registry object stays structurally closed
  // (the dropped-brace defect class R10 PART 19 caught).
  assert.match(regSrc, /\n\};\n\nexport function getReportingExportDatasetAdapter\(/);
  assert.equal(registryKeys[registryKeys.length - 1], 'VENDOR_INVOICE_REGISTER');
});
