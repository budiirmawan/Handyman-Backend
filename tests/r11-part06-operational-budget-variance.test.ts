/**
 * R11 PART 06 — OPERATIONAL_BUDGET_VARIANCE registration: focused contract test.
 *
 * Proves the 22 → 23 registration ripple and the two-view adapter/projection
 * contract WITHOUT executing any historical test and WITHOUT live
 * PostgreSQL (node_modules absent). Method — the established R11 hybrid: the
 * dependency-free runtime surfaces (dataset vocabulary, view vocabulary +
 * validator, CSV-default metadata, both projections) are EXECUTED for real
 * under `node --test` with native type stripping; the registry adapter and
 * OpenAPI ripple are proven from source text; `stripTypeScriptTypes`
 * validates every changed file; byte-identity of the operational-finance
 * source authority, frozen Reporting surfaces and all historical tests is
 * proven via git against the PART 05C baseline.
 *
 * PROVES (PART 06 checklist 1–58): declared once; view REQUIRED with the
 * frozen two-member BUDGET|CATEGORY vocabulary and no default; parity
 * 23/23/23 with equal sets and order; operational_budget.read reused;
 * public variance authority consumed (no repository, no SQL, userId passed,
 * source-owned scope preserved); BUDGET view one table
 * `operationalBudgetVariance`, one row per budget summary, budgetId
 * identity, currency/period/status native, all source monetary and
 * percentage fields verbatim including nulls, failClosed and gapCount
 * preserved; CATEGORY view one table `operationalBudgetVarianceCategory`,
 * one row per source category, budgetId+budgetCategoryId identity, parent
 * context verbatim, category figures verbatim, NO budget×category
 * flattening; zero Reporting-side arithmetic/percentage/rounding; no
 * cross-currency aggregation, FX, tax or invented financial status; no gap
 * valuation and no zero-fill; no PO/invoice/cost/WO/commitment-entry
 * enrichment and no traceability mega-read; kpis = []; no CSV default
 * (OPERATIONAL_DETAIL remains the only one); no route, migration or new
 * permission; source module and historical tests byte-unchanged.
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

/** PART 05C closure — the fixed baseline this PART builds on. */
const BASE = '301eccf2c1284fefce3e4bca3f0696d856476a71';
const RE = 'src/modules/reporting-export';
const TYPES = `${RE}/reporting-export.types.ts`;
const REG = `${RE}/reporting-export.registry.ts`;
const R11PROJ = `${RE}/reporting-export.r11-projections.ts`;
const OPENAPI = 'docs/api/openapi.yaml';
const SELF = 'tests/r11-part06-operational-budget-variance.test.ts';
const CHANGED = [TYPES, REG, R11PROJ, OPENAPI, SELF];
const HISTORICAL_TESTS = [
  'tests/r10-part20-closure-guard.test.ts',
  'tests/r11-part01-receiving-register-read.test.ts',
  'tests/r11-part02-receiving-register.test.ts',
  'tests/r11-part03b-purchase-order-line-register-read.test.ts',
  'tests/r11-part03c-purchase-order-register.test.ts',
  'tests/r11-part04-vendor-invoice-register.test.ts',
  'tests/r11-part05b-stock-movement-register-read.test.ts',
  'tests/r11-part05c-stock-movement-register.test.ts',
];

const typesSrc = rd(TYPES);
const regSrc = rd(REG);
const projSrc = rd(R11PROJ);
const openapiSrc = rd(OPENAPI);
const sReg = strip(regSrc);
const adapterBlock = regSrc.slice(regSrc.indexOf('  OPERATIONAL_BUDGET_VARIANCE: {'));
const sAdapter = strip(adapterBlock);
const registryKeys = [...regSrc.matchAll(/^ {2}([A-Z][A-Z0-9_]+): \{$/gm)].map((m) => m[1]);
const archiveBlock = openapiSrc.split('    ReportArchiveDataset:')[1].split('    ReportArchiveFormat:')[0];
const enumBody = archiveBlock.slice(archiveBlock.indexOf('['), archiveBlock.indexOf(']') + 1);
const openapiEnum = enumBody.match(/[A-Z][A-Z0-9_]+/g) ?? [];
/** The PART 06 projection slice: both view projections, stripped (earlier PARTs' projections
 *  legitimately live in the same frozen seam file and are out of scan scope). */
const sP6Proj = strip(projSrc.slice(projSrc.indexOf('export function projectOperationalBudgetVariance(')));
const sBoth = sAdapter + sP6Proj;

/** Dependency-free runtime imports (explicit .ts specifiers, house precedent). */
const types = await import('../src/modules/reporting-export/reporting-export.types.ts');
const r11proj = await import('../src/modules/reporting-export/reporting-export.r11-projections.ts');

const DATASETS = types.REPORTING_EXPORT_DATASETS;

/** Canned rows in the exact PublicOperationalBudgetVarianceSummary shape (source-verified). */
const TOTALS_A = {
  plannedAmount: 80000000,
  ledgerCommittedAmount: 30000000.5,
  ledgerOpenAmount: 7500000.25,
  ledgerActualizedAmount: 22500000.25,
  ledgerReleasedAmount: 0,
  legacyCommittedAmount: 2500000,
  uncommittedMaterialActualAmount: 1200000,
  uncommittedInvoiceActualAmount: 800000,
  unallocatedActualAmount: 150000,
  openCommitmentAmount: 10000000.25,
  actualAmount: 24500000.25,
  consumedAmount: 34500000.25,
  availableAmount: 45499999.75,
  varianceAmount: -1234.56,
  utilizationPercent: 43.13,
  committedUtilizationPercent: 50.63,
};
const ZERO_TOTALS = {
  plannedAmount: 0,
  ledgerCommittedAmount: 0,
  ledgerOpenAmount: 0,
  ledgerActualizedAmount: 0,
  ledgerReleasedAmount: 0,
  legacyCommittedAmount: 0,
  uncommittedMaterialActualAmount: 0,
  uncommittedInvoiceActualAmount: 0,
  unallocatedActualAmount: 0,
  openCommitmentAmount: 0,
  actualAmount: 0,
  consumedAmount: 0,
  availableAmount: 0,
  varianceAmount: 0,
  utilizationPercent: null,
  committedUtilizationPercent: null,
};
const BUD_A = {
  budgetId: 'eeee0000-0000-4000-8000-000000000001',
  clientId: 'eeee0000-0000-4000-8000-0000000000c1',
  buildingId: 'eeee0000-0000-4000-8000-0000000000b1',
  budgetName: 'Building Operations 2026',
  budgetPeriod: { start: '2026-01-01', end: '2026-12-31' },
  currency: 'IDR',
  status: 'ACTIVE',
  totals: TOTALS_A,
  failClosed: false,
  gapCount: 0,
};
const BUD_B = {
  budgetId: 'eeee0000-0000-4000-8000-000000000002',
  clientId: 'eeee0000-0000-4000-8000-0000000000c1',
  buildingId: 'eeee0000-0000-4000-8000-0000000000b2',
  budgetName: 'Utilities Q3 2026',
  budgetPeriod: { start: '2026-07-01', end: '2026-09-30' },
  currency: 'USD',
  status: 'DRAFT',
  totals: ZERO_TOTALS,
  // A fail-closed budget with recorded gaps: both diagnostics must survive verbatim.
  failClosed: true,
  gapCount: 2,
};

/** Canned categories + detail envelope in the exact source shapes. */
const CAT_A = {
  budgetCategoryId: 'eeee0000-0000-4000-8000-0000000000a1',
  categoryCode: 'OPEX-MAT',
  categoryName: 'Materials',
  plannedAmount: 50000000,
  ledgerCommittedAmount: 18000000.5,
  ledgerOpenAmount: 4000000,
  ledgerActualizedAmount: 14000000.5,
  ledgerReleasedAmount: 500000,
  legacyCommittedAmount: 1000000,
  openCommitmentAmount: 5000000,
  actualAmount: 15200000.75,
  consumedAmount: 33200000.75,
  availableAmount: 16799999.25,
  varianceAmount: -2000000.75,
  utilizationPercent: 66.4,
  committedUtilizationPercent: 46,
  commitmentCount: 4,
};
const CAT_B = {
  budgetCategoryId: 'eeee0000-0000-4000-8000-0000000000a2',
  categoryCode: 'OPEX-UTL',
  categoryName: 'Utilities',
  plannedAmount: 0,
  ledgerCommittedAmount: 0,
  ledgerOpenAmount: 0,
  ledgerActualizedAmount: 0,
  ledgerReleasedAmount: 0,
  legacyCommittedAmount: 0,
  openCommitmentAmount: 0,
  actualAmount: 0,
  consumedAmount: 0,
  availableAmount: 0,
  varianceAmount: 0,
  utilizationPercent: null,
  committedUtilizationPercent: null,
  commitmentCount: 0,
};
const DET = {
  budgetId: 'eeee0000-0000-4000-8000-000000000001',
  clientId: 'eeee0000-0000-4000-8000-0000000000c1',
  buildingId: 'eeee0000-0000-4000-8000-0000000000b1',
  budgetName: 'Building Operations 2026',
  budgetPeriod: { start: '2026-01-01', end: '2026-12-31' },
  currency: 'IDR',
  status: 'ACTIVE',
  overspendPolicy: 'STRICT',
  totals: TOTALS_A,
  categories: [CAT_A, CAT_B],
  controls: {
    categoryScopeIncludesUnallocatedActual: true,
    legacyCommitmentSupersededCount: 0,
    failClosed: false,
    excludedContributionCount: 1,
    exclusions: [],
  },
  gaps: [{
    code: 'CURRENCYLESS_COST_AUTHORITY',
    reference: 'B-02',
    message: 'A cost authority without a currency was excluded.',
    affectedSourceCount: 1,
  }],
  asOf: '2026-09-13T00:00:00.000Z',
};

const TOTALS_KEYS = Object.keys(TOTALS_A);
const BUDGET_ROW_KEYS = ['budgetId', 'clientId', 'buildingId', 'budgetName', 'periodStart',
  'periodEnd', 'currency', 'status', ...TOTALS_KEYS, 'failClosed', 'gapCount'];
const CATEGORY_ROW_KEYS = ['budgetId', 'budgetCategoryId', 'clientId', 'buildingId', 'currency',
  'periodStart', 'periodEnd', 'status', 'overspendPolicy', 'categoryCode', 'categoryName',
  'plannedAmount', 'ledgerCommittedAmount', 'ledgerOpenAmount', 'ledgerActualizedAmount',
  'ledgerReleasedAmount', 'legacyCommittedAmount', 'openCommitmentAmount', 'actualAmount',
  'consumedAmount', 'availableAmount', 'varianceAmount', 'utilizationPercent',
  'committedUtilizationPercent', 'commitmentCount'];

test('R11 P06 01/05–09/52/53 — declared once, parity 23/23/23, sets and order equal, CSV default untouched', () => {
  // 01 — declared exactly once, appended last.
  assert.equal(DATASETS.filter((d) => d === 'OPERATIONAL_BUDGET_VARIANCE').length, 1);
  assert.equal((typesSrc.match(/'OPERATIONAL_BUDGET_VARIANCE',/g) ?? []).length, 1);
  assert.equal(DATASETS[DATASETS.length - 1], 'OPERATIONAL_BUDGET_VARIANCE');
  // 05/06/07 — parity 23/23/23.
  assert.equal(DATASETS.length, 23, 'runtime dataset enum is 23');
  assert.equal(registryKeys.length, 23, 'registry adapter count is 23');
  assert.equal(openapiEnum.length, 23, 'OpenAPI dataset enum is 23');
  // 08/09 — same set everywhere; OpenAPI order matches runtime order position by position.
  assert.deepEqual([...registryKeys].sort(), [...DATASETS].sort());
  assert.deepEqual([...openapiEnum].sort(), [...DATASETS].sort());
  assert.deepEqual(openapiEnum, [...DATASETS]);
  assert.equal(new Set(registryKeys).size, 23);
  assert.equal(registryKeys[registryKeys.length - 1], 'OPERATIONAL_BUDGET_VARIANCE');
  // 52/53 — no CSV default added; OPERATIONAL_DETAIL remains the ONLY configured default
  // (two possible tables by view ⇒ the generic export requires the selected table).
  assert.deepEqual(Object.keys(types.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
  assert.equal((typesSrc.match(/csvDefaultTableKey:/g) ?? []).length, 1);
  assert.equal(/csvDefaultTableKey/.test(adapterBlock), false);
  // The management subset is untouched.
  assert.deepEqual([...types.MANAGEMENT_REPORTING_EXPORT_DATASETS], ['MANAGEMENT_OPERATIONS_COMMAND_CENTER']);
  // OpenAPI documents the dataset and BOTH view table keys.
  assert.equal(openapiSrc.includes('OPERATIONAL_BUDGET_VARIANCE (R11)'), true);
  assert.ok(archiveBlock.includes('operationalBudgetVariance'));
  assert.ok(archiveBlock.includes('operationalBudgetVarianceCategory'));
});

test('R11 P06 02/03/04/10/54–56 — view REQUIRED BUDGET|CATEGORY, no default, permission reused, no route/migration/permission', () => {
  // 03 — the frozen two-member vocabulary, executed for real.
  assert.deepEqual([...types.OPERATIONAL_BUDGET_VARIANCE_VIEWS], ['BUDGET', 'CATEGORY']);
  assert.equal(types.isOperationalBudgetVarianceView('BUDGET'), true);
  assert.equal(types.isOperationalBudgetVarianceView('CATEGORY'), true);
  for (const bad of ['budget', 'HEADER', 'LINE', 'SUMMARY', 'DETAIL', '', null, undefined, 123, ['BUDGET']]) {
    assert.equal(types.isOperationalBudgetVarianceView(bad), false, `${String(bad)} rejected`);
  }
  // 02/04 — the registry reader REQUIRES the view: missing, empty, non-string or unknown
  // values throw; there is no default, no `??`/`||` fallback and no implicit BUDGET.
  assert.match(sAdapter, /const view = readOperationalBudgetVarianceView\(passThrough\.view\);/);
  assert.match(regSrc, /function readOperationalBudgetVarianceView\(\s+value: unknown,\s+\): OperationalBudgetVarianceView \{\s+const raw = typeof value === 'string' \? value\.trim\(\)\.toUpperCase\(\) : undefined;\s+if \(!raw \|\| !isOperationalBudgetVarianceView\(raw\)\) \{\s+throw AppError\.validation\('Request validation failed\.', \[\s+\{\s+field: 'view',\s+message: `view is required and must be one of: \$\{OPERATIONAL_BUDGET_VARIANCE_VIEWS\.join\(', '\)\}\.`/);
  assert.equal(/view\s*\?\?\s*'BUDGET'|view\s*\|\|\s*'BUDGET'|view = 'BUDGET'|defaultView/i.test(sAdapter), false,
    'no default view exists in any form');
  assert.equal(/view === '(?!BUDGET)/.test(sAdapter), false, 'no third view can route anywhere');
  // The two views fail closed on each other's exclusive filters — no silent drop.
  assert.match(sAdapter, /budgetId is only valid for view=CATEGORY\./);
  assert.match(sAdapter, /only valid for view=BUDGET\./);
  // 10 — the EXISTING permission is reused, source-verified where it already gates every
  // variance route; no new permission surface exists anywhere in this ripple.
  assert.match(adapterBlock, /requiredReadPermission: 'operational_budget\.read'/);
  const routesSrc = rd('src/modules/operational-finance/operational-finance.routes.ts');
  assert.match(routesSrc, /requirePermission\('operational_budget\.read'\)/);
  assert.match(routesSrc, /'\/operational-budget-variance'/);
  assert.match(routesSrc, /'\/operational-budgets\/:budgetId\/variance'/);
  assert.equal(/requirePermission\(|code: '[a-z_]+\.(read|manage)'/.test(sAdapter), false);
  assert.equal(git('diff', BASE, '--', 'src/modules/auth'), '', '56 — no permission vocabulary changed');
  // 54 — no HTTP surface added.
  assert.equal(git('diff', BASE, '--', 'src/routes'), '');
  assert.equal(rd('src/routes/index.ts').includes('OPERATIONAL_BUDGET_VARIANCE'), false);
  assert.equal(rd('src/routes/index.ts').includes('operational-budget-variance'), false);
  // 55 — no migration added or changed.
  assert.equal(git('diff', BASE, '--', 'src/database'), '');
});

test('R11 P06 11–15 — public variance authority; no repository, SQL or Reporting-side scope', () => {
  // 11 — the adapter imports the PUBLIC module contract (index): the variance service object
  // and the two owning parsers only.
  assert.match(regSrc, /import \{\s+operationalVarianceService,\s+parseOperationalBudgetFilters,\s+parseOperationalBudgetIdParam,\s+\} from '\.\.\/operational-finance';/);
  const ofImports = [...regSrc.matchAll(/from '(\.\.\/operational-finance[^']*)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(ofImports)], ['../operational-finance']);
  assert.match(sAdapter, /const filters = parseOperationalBudgetFilters\(\{/);
  assert.match(sAdapter, /const budgetId = parseOperationalBudgetIdParam\(rawBudgetId\);/);
  assert.match(sAdapter, /const rows = await operationalVarianceService\.listOperationalBudgetVariance\(\s+filters,\s+userId,\s+\);/);
  assert.match(sAdapter, /const source = await operationalVarianceService\.getOperationalBudgetVariance\(\s+budgetId,\s+userId,\s+\);/);
  // 14 — the authenticated userId reaches BOTH source reads (exactly the two call sites).
  assert.equal((sAdapter.match(/userId,\s+\);/g) ?? []).length, 2);
  // 12/13 — no repository symbol and no SQL anywhere in the registry.
  assert.equal(/operationalVarianceRepository|operationalFinanceRepository|operationalCommitmentRepository|operationalFinanceBindingRepository|operationalFinanceAggregationRepository/.test(sReg), false,
    'no repository symbol in stripped registry');
  assert.equal(/getPool|\.query\(/.test(sReg), false);
  assert.equal(/FROM\s+operational_budgets|FROM\s+operational_budget_categories/i.test(regSrc), false);
  // 15 — scope stays entirely source-owned: no context-access or building symbol in the
  // adapter, and the frozen source text is re-proven to own the assertions, the rollup, the
  // structural Building-set scope and the fail-closed empty scope.
  assert.equal(/contextAccessService|getAccessibleBuildingIds|assertBuildingAccess|buildingRepository/.test(sAdapter), false);
  const varSvc = rd('src/modules/operational-finance/operational-variance.service.ts');
  assert.match(varSvc, /await contextAccessService\.assertBuildingAccess\(actorUserId, filters\.buildingId\);/);
  assert.match(varSvc, /const buildingIds = await contextAccessService\.getAccessibleBuildingIds\(\s+actorUserId,\s+\);/);
  assert.match(varSvc, /await contextAccessService\.assertBuildingAccess\(actorUserId, budget\.buildingId\);/);
  assert.match(varSvc, /if \(!budget\) throw operationalBudgetNotFoundError\(\);/);
  const finRepo = rd('src/modules/operational-finance/operational-finance.repository.ts');
  assert.match(finRepo, /if \(buildingIds\.length === 0\) return \[\];/);
  assert.match(finRepo, /clauses = \['building_id = ANY\(\$1::uuid\[\]\)'\]/);
  // The BUDGET view forwards exactly the four source-owned filter keys — no currency,
  // vendorId, categoryId or pagination key can reach the source parser.
  const forwarded = sAdapter.slice(sAdapter.indexOf('parseOperationalBudgetFilters({'),
    sAdapter.indexOf('});', sAdapter.indexOf('parseOperationalBudgetFilters({')));
  assert.deepEqual([...forwarded.matchAll(/(\w+): passThrough\.\w+/g)].map((m) => m[1]).sort(),
    ['buildingId', 'periodFrom', 'periodTo', 'status']);
  // CATEGORY is addressed by a REQUIRED budgetId (string, non-empty) validated by the OWNING
  // param parser — never widened into a cross-budget category search.
  assert.match(sAdapter, /typeof passThrough\.budgetId === 'string' && passThrough\.budgetId\.trim\(\) !== ''/);
  assert.match(sAdapter, /budgetId is required for view=CATEGORY\./);
  // The traceability drill authority is NEVER consumed.
  assert.equal(/getOperationalBudgetTraceability|traceability/i.test(sAdapter), false);
  // Envelope truthfulness: BUDGET mints the only Reporting clock immediately before the call
  // and derives the scope set from the authoritative rows; CATEGORY forwards the source
  // envelope's own clock, Building and single-Building scope with a null window.
  assert.match(sAdapter, /const asOf = new Date\(\)\.toISOString\(\);\s+const rows = await operationalVarianceService\.listOperationalBudgetVariance/);
  assert.equal((sAdapter.match(/new Date\(/g) ?? []).length, 1, 'CATEGORY reads no Reporting clock');
  assert.match(sAdapter, /buildingId: filters\.buildingId \?\? null,\s+buildingScope: \[\.\.\.new Set\(rows\.map\(\(row\) => row\.buildingId\)\)\]\.sort\(\),\s+dateFrom: filters\.periodFrom \?\? null,\s+dateTo: filters\.periodTo \?\? null,\s+asOf,/);
  assert.match(sAdapter, /buildingId: source\.buildingId,\s+buildingScope: \[source\.buildingId\],\s+dateFrom: null,\s+dateTo: null,\s+asOf: source\.asOf,/);
  // Applied filters echo the required view plus only what the owning parser accepted.
  assert.match(sAdapter, /appliedFilters: echoFilters\(filters, \{ view \}\)/);
  assert.match(sAdapter, /appliedFilters: echoFilters\(\{ budgetId \}, \{ view \}\)/);
  // View/table exclusivity: exactly two projected branches, one per view.
  assert.equal((sAdapter.match(/projected: /g) ?? []).length, 2);
  assert.match(sAdapter, /projected: projectOperationalBudgetVariance\(rows\)/);
  assert.match(sAdapter, /projected: projectOperationalBudgetVarianceCategory\(source\)/);
});

test('R11 P06 16–26 — BUDGET view executed: one table, source figures verbatim, diagnostics preserved', () => {
  const projected = r11proj.projectOperationalBudgetVariance([BUD_A, BUD_B]);
  // 51 — kpis empty: the source-owned totals are never duplicated into a Reporting KPI layer.
  assert.deepEqual(projected.kpis, []);
  // 16/17 — exactly ONE table with the frozen key.
  assert.equal(projected.tables.length, 1);
  const t = projected.tables[0];
  assert.equal(t.key, 'operationalBudgetVariance');
  assert.equal(t.label, 'Operational Budget Variance');
  // 18 — one row per budget summary: two budgets in, two rows out; no category fan-out.
  assert.equal(t.rowCount, 2);
  assert.equal(t.rows.length, 2);
  // Column contract: the 26 summary-grain fields in authoritative order.
  assert.deepEqual(t.columns.map((c) => c.key), BUDGET_ROW_KEYS);
  for (const k of ['plannedAmount', 'ledgerCommittedAmount', 'ledgerOpenAmount',
    'ledgerActualizedAmount', 'ledgerReleasedAmount', 'legacyCommittedAmount',
    'uncommittedMaterialActualAmount', 'uncommittedInvoiceActualAmount', 'unallocatedActualAmount',
    'openCommitmentAmount', 'actualAmount', 'consumedAmount', 'availableAmount', 'varianceAmount',
    'gapCount']) {
    assert.equal(t.columns.find((c) => c.key === k).type, 'NUMBER', `${k} is NUMBER`);
  }
  for (const k of ['utilizationPercent', 'committedUtilizationPercent']) {
    assert.equal(t.columns.find((c) => c.key === k).type, 'PERCENT', `${k} is PERCENT`);
  }
  for (const k of ['periodStart', 'periodEnd']) {
    assert.equal(t.columns.find((c) => c.key === k).type, 'DATE', `${k} is DATE`);
  }
  assert.equal(t.columns.find((c) => c.key === 'failClosed').type, 'BOOLEAN');
  for (const k of ['budgetId', 'clientId', 'buildingId', 'budgetName', 'currency', 'status']) {
    assert.equal(t.columns.find((c) => c.key === k).type, 'STRING', `${k} is STRING`);
  }
  // 19–26 — every value verbatim, including nested flattening by pure field copy.
  for (const [i, src] of [BUD_A, BUD_B].entries()) {
    const out = t.rows[i];
    assert.deepEqual(Object.keys(out).sort(), [...BUDGET_ROW_KEYS].sort());
    for (const k of BUDGET_ROW_KEYS) {
      const expected = k === 'periodStart' ? src.budgetPeriod.start
        : k === 'periodEnd' ? src.budgetPeriod.end
        : TOTALS_KEYS.includes(k) ? src.totals[k]
        : src[k];
      assert.deepEqual(out[k], expected, `${k} verbatim (row ${i})`);
    }
    assert.equal('id' in out, false, 'no bare id');
  }
  // 19 — budgetId identity preserved; 20 — currencies stay SEPARATE per row (IDR next to USD,
  // never merged or converted); 21 — control period from the budget's own budgetPeriod.
  assert.equal(t.rows[0].budgetId, BUD_A.budgetId);
  assert.equal(t.rows[0].currency, 'IDR');
  assert.equal(t.rows[1].currency, 'USD');
  assert.equal(t.rows[0].periodStart, '2026-01-01');
  assert.equal(t.rows[0].periodEnd, '2026-12-31');
  // 22 — native status verbatim; the summary grain owns no overspendPolicy, so none exists.
  assert.equal(t.rows[0].status, 'ACTIVE');
  assert.equal(t.rows[1].status, 'DRAFT');
  assert.equal('overspendPolicy' in t.rows[0], false);
  // 23/24 — fractional, zero and NEGATIVE source figures survive bit-for-bit; the source's
  // null percentages (planned = 0) stay null — never zero-filled.
  assert.equal(t.rows[0].ledgerCommittedAmount, 30000000.5);
  assert.equal(t.rows[0].varianceAmount, -1234.56);
  assert.equal(t.rows[0].utilizationPercent, 43.13);
  assert.equal(t.rows[1].utilizationPercent, null);
  assert.equal(t.rows[1].committedUtilizationPercent, null);
  // 25/26 — the fail-closed control and gap count survive verbatim, never suppressed.
  assert.equal(t.rows[0].failClosed, false);
  assert.equal(t.rows[1].failClosed, true);
  assert.equal(t.rows[1].gapCount, 2);
  // The categories child grain is NEVER embedded in a budget row, and no invented field exists.
  for (const out of t.rows) {
    for (const banned of ['categories', 'totals', 'budgetPeriod', 'controls', 'gaps', 'exclusions',
      'asOf', 'health', 'atRisk', 'overBudget', 'trafficLight', 'budgetHealth', 'severity']) {
      assert.equal(banned in out, false, `no ${banned} on a budget row`);
    }
  }
  // Empty source → still exactly one well-formed table.
  const empty = r11proj.projectOperationalBudgetVariance([]);
  assert.equal(empty.tables.length, 1);
  assert.equal(empty.tables[0].rowCount, 0);
  assert.deepEqual(empty.kpis, []);
});

test('R11 P06 27–32 — CATEGORY view executed: one table, identities, context, no flattening', () => {
  const projected = r11proj.projectOperationalBudgetVarianceCategory(DET);
  assert.deepEqual(projected.kpis, []);
  // 27/28 — exactly ONE table with the frozen key.
  assert.equal(projected.tables.length, 1);
  const t = projected.tables[0];
  assert.equal(t.key, 'operationalBudgetVarianceCategory');
  assert.equal(t.label, 'Operational Budget Variance Category');
  // 29 — one row per SOURCE CATEGORY: two categories in, two rows out. The budget itself is
  // NOT duplicated as a row and its totals are NOT flattened onto the category rows.
  assert.equal(t.rowCount, 2);
  assert.deepEqual(t.columns.map((c) => c.key), CATEGORY_ROW_KEYS);
  // 30 — composite source identity: envelope budgetId + the category's own persisted id; no
  // synthetic key and the category NAME is not an identity.
  assert.equal(t.rows[0].budgetId, DET.budgetId);
  assert.equal(t.rows[0].budgetCategoryId, CAT_A.budgetCategoryId);
  assert.equal(t.rows[1].budgetCategoryId, CAT_B.budgetCategoryId);
  assert.equal('id' in t.rows[0], false);
  // Parent context verbatim from the envelope: one currency binds every row; native status and
  // overspendPolicy preserved; control period from the budget's own budgetPeriod.
  for (const out of t.rows) {
    assert.equal(out.clientId, DET.clientId);
    assert.equal(out.buildingId, DET.buildingId);
    assert.equal(out.currency, DET.currency);
    assert.equal(out.currency, 'IDR');
    assert.equal(out.periodStart, DET.budgetPeriod.start);
    assert.equal(out.periodEnd, DET.budgetPeriod.end);
    assert.equal(out.status, DET.status);
    assert.equal(out.overspendPolicy, DET.overspendPolicy);
  }
  // 31 — category financial values verbatim, including the negative variance, the fractional
  // amounts, the null percentages of the unplanned category and commitmentCount.
  for (const [i, cat] of [CAT_A, CAT_B].entries()) {
    const out = t.rows[i];
    assert.deepEqual(Object.keys(out).sort(), [...CATEGORY_ROW_KEYS].sort());
    for (const k of CATEGORY_ROW_KEYS) {
      const expected = ['budgetId', 'clientId', 'buildingId', 'currency', 'status',
        'overspendPolicy'].includes(k) ? DET[k]
        : k === 'periodStart' ? DET.budgetPeriod.start
        : k === 'periodEnd' ? DET.budgetPeriod.end
        : cat[k];
      assert.deepEqual(out[k], expected, `${k} verbatim (category row ${i})`);
    }
  }
  assert.equal(t.rows[0].varianceAmount, -2000000.75);
  assert.equal(t.rows[0].plannedAmount, 50000000);
  assert.notEqual(t.rows[0].plannedAmount, DET.totals.plannedAmount,
    '32 — the category figure is the category’s own, never the budget total');
  assert.equal(t.rows[1].utilizationPercent, null);
  assert.equal(t.rows[1].commitmentCount, 0);
  // 32 — no budget×category flattening: budget-only totals fields and budget diagnostics are
  // NOT keys on a category row, and no gap/control/exclusion structure is attached.
  for (const out of t.rows) {
    for (const banned of ['uncommittedMaterialActualAmount', 'uncommittedInvoiceActualAmount',
      'unallocatedActualAmount', 'failClosed', 'gapCount', 'gaps', 'controls', 'exclusions',
      'totals', 'categories', 'asOf', 'budgetName']) {
      assert.equal(banned in out, false, `no budget-grain ${banned} on a category row`);
    }
  }
  // Empty categories → still exactly one well-formed table, no fabricated row.
  const empty = r11proj.projectOperationalBudgetVarianceCategory({ ...DET, categories: [] });
  assert.equal(empty.tables.length, 1);
  assert.equal(empty.tables[0].rowCount, 0);
  assert.deepEqual(empty.kpis, []);
});

test('R11 P06 33–44 — zero financial arithmetic, FX, tax, invented status, gap valuation or zero-fill', () => {
  // 33–36 — no addition, subtraction, multiplication or division over ANY financial field, and
  // no aggregate function, anywhere in the adapter or the PART 06 projection slice.
  assert.equal(/Amount\s*[-+*/]|[-+*/]\s*\w*Amount|Percent\s*[-+*/]|[-+*/]\s*\w*Percent|planned\s*-|-\s*actual/i.test(sBoth), false);
  assert.equal(/SUM\(|COUNT\(|AVG\(|MIN\(|MAX\(|\.reduce\(|\.sort\(\(a/i.test(sBoth), false);
  // 37/38 — no percentage computation and no rounding: the source's own percent()/round2()
  // stay in the frozen source module; Reporting copies results only.
  assert.equal(/percent\(|\*\s*100|\/\s*100|\/\s*planned|toFixed|Math\.round|ROUND\(/i.test(sBoth), false);
  // 39/40 — no cross-currency aggregation, no consolidated total, no FX or conversion.
  assert.equal(/consolidat|crossCurrency|baseCurrency|reportingCurrency|clientCurrency|totalAmount|grandTotal/i.test(sBoth), false);
  assert.equal(/\bfx\b|exchange[Rr]ate|convert/i.test(sBoth), false);
  // 41 — no tax/VAT/accounting surface.
  assert.equal(/\btax\b|\bvat\b|accounting|journal|ledgerEntry/i.test(sBoth), false);
  // Hard-prohibition financial tokens are absent from the Reporting production code.
  assert.equal(/COGS|valuation|FIFO|LIFO|weightedAverage|inventoryValue|stockValue|invoiceAmount|paidAmount/i.test(sBoth), false);
  // 42 — no invented financial status: the native budget status is the only status vocabulary.
  assert.equal(/healthy|atRisk|overBudget|'GREEN'|'AMBER'|'RED'|trafficLight|budgetHealth/i.test(sBoth), false);
  // 43/44 — gaps stay described, never valued; exclusions never become zero-valued facts; no
  // null is ever zero-filled and no gap/exclusion structure is projected.
  assert.equal(/gapAmount|gapValue|valuedGap|exclusionAmount|exclusionValue/i.test(sBoth), false);
  assert.equal(/\bgaps\b|\bcontrols\b|exclusions/i.test(sBoth), false);
  assert.equal(/\?\?\s*0\b|\|\|\s*0\b/.test(sBoth), false);
});

test('R11 P06 45–50 — no enrichment, no traceability mega-read, seam stays type-only', () => {
  // 45–49 — no PO, PO-line, vendor-invoice, vendor-service-cost, WO-material-usage,
  // basic-expense, source-binding, commitment-entry, RFQ or receiving surface: the
  // operational-finance import is exactly the variance service + the two parsers, and no
  // drill/commitment/aggregation export is ever called.
  assert.equal(/purchaseOrder|purchase_order|vendorInvoice|vendor_invoice|vendor_service_cost|materialUsage|workOrderMaterialUsage|basicExpense|basic_expense|sourceBinding|source_binding|commitmentEntry|listCommitments|operationalCommitment|\brfq\b|receivings/i.test(sBoth), false);
  // 50 — no traceability expansion: the flat source-transaction drill read is never consumed
  // and no lineage id from it appears anywhere in the dataset code.
  assert.equal(/Traceability|traceabilityRow|classification|sourceType|purchaseOrderId|purchaseOrderLineId|vendorInvoiceId|workOrderId|materialRequestId|vendorId|bindingId|commitmentId/i.test(sBoth), false);
  // The projection seam stays dependency-free at runtime (type-only imports only).
  assert.equal(/^import\s+(?!type)/m.test(projSrc), false);
  assert.match(projSrc, /^import type \{\s+PublicOperationalBudgetVariance,\s+PublicOperationalBudgetVarianceSummary,\s+\} from '\.\.\/operational-finance';$/m);
  // Read-only discipline: no write statement shape anywhere in the ripple's stripped code.
  assert.equal(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|recordOperationalEvent/i.test(sBoth), false);
  // Governance token discipline (scan scope matches the guard and PART 01–05C).
  const all = typesSrc + regSrc + openapiSrc;
  for (const banned of ['PART 21', 'PART21', 'R11 —', 'COMMERCIAL_JOURNEY', 'RESOURCE_JOURNEY',
    'SERVICE_JOURNEY']) {
    assert.equal(all.includes(banned), false, `no ${banned} artifact exists`);
  }
});

test('R11 P06 51/57/58 — source byte-unchanged, historical tests byte-unchanged, bounded footprint', () => {
  // 51 — kpis [] for BOTH views (re-asserted at the delivery level).
  assert.deepEqual(r11proj.projectOperationalBudgetVariance([]).kpis, []);
  assert.deepEqual(r11proj.projectOperationalBudgetVarianceCategory({ ...DET, categories: [] }).kpis, []);
  // 57 — the operational-finance source authority and every previously closed source/frozen
  // surface is byte-unchanged versus the PART 05C baseline.
  assert.equal(git('diff', BASE, '--', 'src/modules/operational-finance',
    'src/modules/stock-movement-register', 'src/modules/inventory-stock-movements',
    'src/modules/receiving-register', 'src/modules/purchase-order-line-register',
    'src/modules/purchase-orders', 'src/modules/vendor-invoices',
    `${RE}/reporting-export.service.ts`, `${RE}/reporting-export.projections.ts`,
    `${RE}/reporting-export.management-projections.ts`, `${RE}/reporting-export.r10-projections.ts`),
  '', 'source authorities and frozen Reporting files untouched');
  // 58 — every historical test is blob-identical to the baseline and none was executed; the
  // only test touched is this file (commit-state independent).
  for (const t of HISTORICAL_TESTS) {
    assert.equal(git('hash-object', t), git('rev-parse', `${BASE}:${t}`), `${t} blob identical`);
  }
  const trackedTestChanges = git('diff', '--name-only', BASE, '--', 'tests').split('\n').filter(Boolean);
  const untrackedTests = git('ls-files', '--others', '--exclude-standard', 'tests').split('\n').filter(Boolean);
  assert.deepEqual([...new Set([...trackedTestChanges, ...untrackedTests])], [SELF]);
  // Bounded PART 06 footprint: the four registration-ripple files plus this test only.
  const changedTracked = git('diff', '--name-only', BASE).split('\n').filter(Boolean);
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  const changed = [...new Set([...changedTracked, ...untracked])];
  assert.deepEqual(changed.filter((f) => !CHANGED.includes(f)), [],
    'PART 06 changes only the registration ripple + this test');
});

test('R11 P06 — type-strip validation of every changed TS file; registry structurally closed', () => {
  for (const f of [TYPES, REG, R11PROJ, SELF]) {
    assert.doesNotThrow(() => stripTypeScriptTypes(rd(f), { mode: 'strip' }), `${f} type-strips cleanly`);
  }
  // The adapter is the LAST registry entry and the registry object stays structurally closed
  // (the dropped-brace defect class R10 PART 19 caught).
  assert.match(regSrc, /\n\};\n\nexport function getReportingExportDatasetAdapter\(/);
  // The view vocabulary is declared exactly once, in the Reporting types seam.
  assert.equal((typesSrc.match(/OPERATIONAL_BUDGET_VARIANCE_VIEWS = \['BUDGET', 'CATEGORY'\]/g) ?? []).length, 1);
});
