/**
 * R11 PART 03B — Purchase Order LINE Register read foundation: focused contract test.
 *
 * Proves the set-based, access-scoped LINE read authority WITHOUT executing
 * historical R10/R11 tests and WITHOUT live PostgreSQL (node_modules absent;
 * the module chain imports pg transitively, so — exactly as in R11 PART 01 —
 * the contract is proven from source text plus `stripTypeScriptTypes` syntax
 * validation of every changed file, and the frozen Reporting dataset enum is
 * executed for real to pin the count at 19).
 *
 * PROVES (PART 03B checklist 1–36): one public row per line row; explicit
 * purchaseOrderLineId identity; ONE set-based query; ONE 1:1 structural
 * parent join; no per-PO loop / N+1; fail-closed accessible-building scope;
 * explicit building access assertion; structural client+building join
 * equality; empty scope returns empty WITHOUT query; po.po_date-only period
 * with INCLUSIVE dateFrom/dateTo and no created_at substitute; native PO
 * status and requestLineType preserved; lineage, item/UOM/sourceService,
 * quantitySnapshot (SERVICE-null preserved), unitPrice and lineAmount copied
 * verbatim; currency from the parent PO; lineAmount never recomputed; no PO
 * total; no FX; no price catalog; no RFQ / receiving / invoice / SPK / WO
 * enrichment; no route; no migration; no permission; dataset count remains
 * 19; the purchase-orders HEADER authority and all historical tests remain
 * byte-unchanged.
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

/** PART 02 closure — the fixed baseline this PART builds on. */
const BASE = '02c516720c66ce0b4ec1d88b6951e2fe8e59d2be';
const MOD = 'src/modules/purchase-order-line-register';
const F_TYPES = `${MOD}/purchase-order-line-register.types.ts`;
const F_REPO = `${MOD}/purchase-order-line-register.repository.ts`;
const F_SVC = `${MOD}/purchase-order-line-register.service.ts`;
const F_INDEX = `${MOD}/index.ts`;
const SELF = 'tests/r11-part03b-purchase-order-line-register-read.test.ts';
const MODULE_FILES = [F_TYPES, F_REPO, F_SVC, F_INDEX];

const typesSrc = rd(F_TYPES);
const repoSrc = rd(F_REPO);
const svcSrc = rd(F_SVC);
const indexSrc = rd(F_INDEX);
const sRepo = strip(repoSrc);
const sSvc = strip(svcSrc);
const sMod = sRepo + sSvc + strip(indexSrc);

/** The frozen Reporting vocabulary is dependency-free — executed for real. */
const reporting = await import('../src/modules/reporting-export/reporting-export.types.ts');

test('R11 P03B 01/03/04/05/06/09/10 — ONE set-based query, ONE structural 1:1 parent join, no N+1', () => {
  // 03 — exactly one repository query; nothing else touches the database.
  assert.equal((sRepo.match(/getPool\(\)\.query/g) ?? []).length, 1, 'one getPool().query call');
  assert.equal(/withTransaction|client\.query/.test(sMod), false, 'read-only: no transaction, no client queries');
  // 04 — exactly one JOIN: the owning parent header, on the full structural relationship.
  // Case-sensitive `\sJOIN\s` — `Array.prototype.join(` (lowercase) must not match, the known
  // R11 PART 01 test-authoring pitfall.
  assert.equal((sRepo.match(/\sJOIN\s/g) ?? []).length, 1, 'one join only');
  assert.match(sRepo, /FROM purchase_order_lines line\s+JOIN purchase_orders po\s+ON po\.id = line\.purchase_order_id\s+AND po\.client_id = line\.client_id\s+AND po\.building_id = line\.building_id/);
  // 09 — structural scope equality, not UUID coincidence alone (0269/0270 both carry client+building).
  assert.match(sRepo, /po\.client_id = line\.client_id/);
  assert.match(sRepo, /po\.building_id = line\.building_id/);
  // 01 — one public row per line row: 1:1 PK join, rows mapped, never filtered or reshaped.
  assert.match(sRepo, /result\.rows\.map\(mapRow\)/);
  assert.equal(/\.filter\(|DISTINCT|GROUP BY|ROW_NUMBER|LIMIT/i.test(sRepo), false,
    'no post-query filter, dedup, group, ranking or LIMIT selector');
  // 05/06 — no per-PO loop anywhere: no iteration constructs, no Promise.all, no per-PO
  // authority consumed (the N+1 shape list→loop→listPurchaseOrderLines is structurally absent).
  assert.equal(/Promise\.all|forEach|\bfor \(|\bwhile \(|\.map\(async/.test(sMod), false, 'no loops');
  assert.equal(/listPurchaseOrderLines|purchaseOrderLineRepository|purchaseOrderRepository|listPurchaseOrders/.test(sMod),
    false, 'the per-PO and header authorities are never imported or called');
  assert.equal((sSvc.match(/getPurchaseOrderLineRegisterRows\(/g) ?? []).length, 1,
    'the service issues exactly one repository call per register read');
  // 10 — empty authorized scope: the SERVICE returns a well-formed empty register before any
  // repository call, and the REPOSITORY fail-closes before any SQL — no DB round trip either way.
  const svcEmptyAt = sSvc.indexOf('if (buildingIds.length === 0)');
  const svcRepoCallAt = sSvc.indexOf('getPurchaseOrderLineRegisterRows(');
  assert.ok(svcEmptyAt !== -1 && svcRepoCallAt !== -1 && svcEmptyAt < svcRepoCallAt,
    'service short-circuits empty scope before the repository call');
  assert.match(sSvc, /if \(buildingIds\.length === 0\) \{\s+return \{ \.\.\.base, rows: \[\] \};/);
  const repoGuardAt = sRepo.indexOf('if (buildingIds.length === 0) return [];');
  assert.ok(repoGuardAt !== -1 && repoGuardAt < sRepo.indexOf('getPool().query'),
    'repository fail-closes before building or issuing SQL');
  // 07 — the scope predicate is the FIRST SQL condition, structurally bounding every row.
  assert.match(sRepo, /const conditions: string\[\] = \['line\.building_id = ANY\(\$1::uuid\[\]\)'\];/);
  assert.match(sRepo, /const values: unknown\[\] = \[buildingIds\];/);
  // Deterministic ordering, no post-query sort, no business ranking.
  assert.match(sRepo, /ORDER BY po\.po_date DESC, line\.purchase_order_id ASC,\s+line\.line_number ASC, line\.id ASC/);
  assert.equal(/\.sort\(/.test(sMod), false, 'no post-query sort');
});

test('R11 P03B 07/08/33 — context-access security pattern; no permission vocabulary', () => {
  // 08 — explicit buildingId: existence-checked, then Building access asserted for the actor.
  assert.match(sSvc, /if \(filters\.buildingId\) \{\s+const building = await buildingRepository\.findById\(filters\.buildingId\);\s+if \(!building\) \{\s+throw buildingNotFoundError\(\);/);
  assert.match(sSvc, /await contextAccessService\.assertBuildingAccess\(userId, filters\.buildingId\);/);
  assert.match(sSvc, /return \[filters\.buildingId\];/);
  // 07 — omitted buildingId: rollup across exactly the accessible Buildings of the actor.
  assert.match(sSvc, /return contextAccessService\.getAccessibleBuildingIds\(userId\);/);
  // No caller-supplied clientId, no all-client fallback, no scope widening.
  assert.equal(/query\.clientId|filters\.clientId|clientId ===|allClient/i.test(sSvc), false);
  assert.equal(/getAccessibleBuildingIds\(\)/.test(sSvc), false, 'scope is always actor-bound');
  // 33 — this internal read creates NO authorization vocabulary; the future adapter reuses
  // the existing purchase_order.read, which is asserted here to already gate the PO routes.
  assert.equal(/requirePermission|rbac|permission/i.test(sMod), false, 'no permission surface');
  assert.match(rd('src/modules/purchase-orders/purchase-order.routes.ts'),
    /requirePermission\('purchase_order\.read'\)/);
  // Envelope follows the receiving-register convention exactly — no invented semantics.
  assert.match(sSvc, /buildingId: filters\.buildingId \?\? null,\s+buildingScope: buildingIds,\s+dateFrom: filters\.dateFrom \?\? null,\s+dateTo: filters\.dateTo \?\? null,\s+asOf: asOf\.toISOString\(\)/);
  // Filter contract: exactly the nine source-backed filters, UUIDs normalized, status via the
  // purchase-orders authority's OWN validator, strict calendar dates, bounded span, order guard.
  for (const f of ['buildingId', 'vendorId', 'purchaseRequestId', 'serviceRequestId',
    'materialRequestId', 'itemId']) {
    assert.match(sSvc, new RegExp(`readOptionalUuid\\(\\s*query\\.${f},\\s*'${f}',\\s*details,?\\s*\\)`));
  }
  assert.match(sSvc, /import \{ isPurchaseOrderStatus \} from '\.\.\/purchase-orders';/);
  assert.match(sSvc, /isPurchaseOrderStatus/);
  assert.match(sSvc, /DATE_ONLY = \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  assert.match(sSvc, /MAX_RANGE_DAYS = 366/);
  assert.match(sSvc, /dateTo must be the same as or after dateFrom/);
  assert.equal(/query\.(poNumber|requestType|receivingId|invoiceId|workOrderId|rfqId|rfqStatus|priceDeviationStatus|search|latestOnly|currentOnly|page|limit)\b/.test(sSvc),
    false, 'no filter beyond the frozen nine is read');
  assert.match(sSvc, /AppError\.validation\('Request validation failed\.', details\)/);
  // The service owns validation + scope + ONE repository call + envelope; nothing else.
  // (Write-statement shapes only — the `updated_at` audit FACT column legitimately exists.)
  assert.equal(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|recordOperationalEvent/i.test(sMod),
    false, 'read-only: no write statement, no events');
});

test('R11 P03B 11/12/13/14 — po.po_date is the only period authority, inclusive on both ends', () => {
  // 12/13 — inclusive DATE semantics, identical in meaning to the HEADER authority's window.
  assert.match(sRepo, /conditions\.push\(`po\.po_date >= \$\$\{values\.length\}::date`\)/);
  assert.match(sRepo, /conditions\.push\(`po\.po_date <= \$\$\{values\.length\}::date`\)/);
  // No half-open comparison ever touches po_date.
  assert.equal(/po\.po_date\s*<(?!=)/.test(sRepo), false, 'no exclusive dateTo bound');
  assert.equal(/po\.po_date\s*>(?!=)/.test(sRepo), false, 'no exclusive dateFrom bound');
  // 11 — po_date is the ONLY date-window column: exactly two period conditions exist.
  assert.equal((sRepo.match(/po_date (>=|<=)/g) ?? []).length, 2);
  // 14 — no created_at/updated_at (line or PO) is ever a period filter; they are selected only
  // as verbatim audit facts.
  assert.equal(/(created_at|updated_at)\s*(>=|<=|>|<)/.test(sRepo), false,
    'no timestamp column participates in any condition');
  assert.equal(/::timestamptz|::timestamp\b/.test(sRepo), false, 'no timestamp window casting');
});

test('R11 P03B 02/15–27 — row contract: verbatim facts, parent context, money discipline', () => {
  // 02 — identity explicitly named: line.id is published ONLY as purchaseOrderLineId.
  assert.match(sRepo, /line\.id AS purchase_order_line_id/);
  assert.match(sRepo, /purchaseOrderLineId: row\.purchase_order_line_id/);
  assert.equal(/\bid: row\.id\b|as 'id'|: row\.id,/.test(sRepo), false, 'never published as a bare id');
  // 15/16 — native vocabularies preserved verbatim; the discriminator is the persisted column,
  // never inferred from nullable fields; no CASE reshaping anywhere.
  assert.match(sRepo, /requestLineType: row\.request_line_type/);
  assert.match(sRepo, /purchaseOrderStatus: row\.purchase_order_status/);
  assert.match(sRepo, /po\.status AS purchase_order_status/);
  assert.equal(/CASE\s|WHEN\s/i.test(sRepo), false, 'no SQL reshaping of native values');
  assert.equal(/lineStatus:/.test(typesSrc + sRepo), false, 'the parent status is never called lineStatus');
  // 17/18/19 — lineage and snapshots copied column-for-column.
  for (const [pub, col] of [['materialRequestId', 'material_request_id'],
    ['serviceRequestId', 'service_request_id'], ['itemId', 'item_id'], ['uomId', 'uom_id'],
    ['sourceServiceId', 'source_service_id'], ['lineNumber', 'line_number'],
    ['description', 'description'], ['notes', 'notes'], ['createdByUserId', 'created_by_user_id']]) {
    assert.match(sRepo, new RegExp(`${pub}: row\\.${col}`), `${pub} verbatim`);
  }
  // 20/21 — quantitySnapshot: Number-boundary conversion only, NULL preserved (SERVICE lines).
  assert.match(sRepo, /quantitySnapshot:\s+row\.quantity_snapshot === null \? null : Number\(row\.quantity_snapshot\)/);
  assert.match(typesSrc, /NULL for SERVICE lines — preserved as NULL/);
  // 22/23 — unitPrice/lineAmount: same single Number() boundary conversion, verbatim.
  assert.match(sRepo, /unitPrice: Number\(row\.unit_price\)/);
  assert.match(sRepo, /lineAmount: Number\(row\.line_amount\)/);
  // 24 — currency comes from the PARENT PO (lines persist none) — the one authoritative currency.
  assert.match(sRepo, /po\.currency AS currency/);
  assert.equal(/line\.currency/.test(sRepo), false);
  // Parent context columns all come from the joined header, verbatim.
  for (const [pub, col] of [['purchaseOrderId', 'purchase_order_id'], ['clientId', 'client_id'],
    ['buildingId', 'building_id'], ['vendorId', 'vendor_id'], ['purchaseRequestId', 'purchase_request_id'],
    ['poNumber', 'po_number'], ['poDate', 'po_date']]) {
    assert.match(sRepo, new RegExp(`${pub}: row\\.${col}`), `parent context ${pub} verbatim`);
  }
  assert.match(sRepo, /po\.po_date::text AS po_date/, 'po_date published as its calendar-date text');
  assert.match(sRepo, /createdAt: row\.created_at\.toISOString\(\)/);
  assert.match(sRepo, /updatedAt: row\.updated_at\.toISOString\(\)/);
  // The full 25-key public row contract exists on the type.
  for (const key of ['purchaseOrderLineId', 'purchaseOrderId', 'clientId', 'buildingId', 'vendorId',
    'purchaseRequestId', 'poNumber', 'poDate', 'currency', 'purchaseOrderStatus', 'lineNumber',
    'requestLineType', 'materialRequestId', 'serviceRequestId', 'itemId', 'uomId', 'sourceServiceId',
    'description', 'quantitySnapshot', 'unitPrice', 'lineAmount', 'notes', 'createdByUserId',
    'createdAt', 'updatedAt']) {
    assert.match(typesSrc, new RegExp(`\\b${key}:`), `row type declares ${key}`);
  }
  // 25/26/27 — no monetary arithmetic of any kind: lineAmount is never recomputed, no PO total,
  // no quantity×price product, no rounding, no FX.
  assert.equal(/deriveLineAmount|toFixed|ROUND\(|Math\.round/i.test(sMod), false);
  assert.equal(/quantity_snapshot\s*\*|\*\s*unit_price|quantitySnapshot\s*\*|\*\s*unitPrice/.test(sMod), false);
  assert.equal(/SUM\(|COUNT\(|totalAmount|grandTotal/i.test(sRepo), false, 'no aggregation, no PO total');
  assert.equal(/\bfx\b|exchange[Rr]ate|convert/i.test(sMod), false, 'no FX/conversion');
});

test('R11 P03B 28/29/30 — no enrichment: exactly two tables, exactly the allowed imports', () => {
  // The SQL touches ONLY purchase_order_lines and its parent purchase_orders — no RFQ, price
  // catalog, deviation, receiving, invoice, SPK or work-order table appears in any FROM/JOIN.
  const tables = [...sRepo.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)].sort(), ['purchase_order_lines', 'purchase_orders']);
  assert.equal(/rfq|price_catalog|priceCatalog|deviation|receivings|vendor_invoice|work_order|spk|purchase_order_readiness|inventory|material_requests\b|service_requests\b/i.test(sRepo),
    false, 'no drill-authority table is queried');
  // Module imports are exactly the proven register-read dependency set — no drill module, no
  // price authority, no reporting vocabulary.
  const imports = [...sMod.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)].sort(), [
    '../../database', '../../shared/errors', '../buildings', '../clients', '../context-access',
    '../purchase-orders', './purchase-order-line-register.repository',
    './purchase-order-line-register.service', './purchase-order-line-register.types',
  ]);
  // No Reporting-specific vocabulary leaks into the source read contract.
  assert.equal(/PURCHASE_ORDER_REGISTER|dataset|kpis|csvDefault|reporting/i.test(sMod), false);
  // No header duplication: no header list/projection/read model is created (the header table is
  // joined for context only, asserted above by the 1:1 structural join).
  assert.equal(/listPurchaseOrderHeaders|projectPurchaseOrder|headerRegister/i.test(sMod + typesSrc), false);
});

test('R11 P03B 31/32/34/35/36 — no route, no migration, count 19, baseline surfaces byte-unchanged', () => {
  // 31 — no HTTP surface: the module is exactly the four house-shape files; routes untouched.
  assert.deepEqual(fs.readdirSync(path.join(ROOT, MOD)).sort(),
    ['index.ts', 'purchase-order-line-register.repository.ts', 'purchase-order-line-register.service.ts',
      'purchase-order-line-register.types.ts']);
  assert.equal(/controller|router\.|createPurchaseOrderLineRegisterRouter/i.test(sMod), false);
  assert.equal(rd('src/routes/index.ts').includes('purchase-order-line-register'), false);
  assert.equal(git('diff', BASE, '--', 'src/routes'), '', 'no route file changed');
  // 32 — no migration exists or changed.
  assert.equal(git('diff', BASE, '--', 'src/database'), '', 'no database/migration change');
  assert.equal(fs.readdirSync(path.join(ROOT, 'src/database/migrations'))
    .some((f) => /purchase[-_]order[-_]line[-_]register/i.test(f)), false);
  // 34 — the Reporting dataset vocabulary is executed for real and remains frozen at 19.
  assert.equal(reporting.REPORTING_EXPORT_DATASETS.length, 19);
  assert.equal(reporting.REPORTING_EXPORT_DATASETS.includes('PURCHASE_ORDER_REGISTER'), false);
  assert.deepEqual(Object.keys(reporting.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
  assert.equal(git('diff', BASE, '--', 'src/modules/reporting-export', 'docs/api/openapi.yaml'), '',
    'Reporting registration and OpenAPI dataset enum untouched');
  // 35 — the existing HEADER authority (whole purchase-orders module) is byte-unchanged.
  assert.equal(git('diff', BASE, '--', 'src/modules/purchase-orders'), '', 'HEADER authority untouched');
  // 36 — every historical test is byte-unchanged, including the frozen R10 closure guard; the
  // only test added by this PART is this file. (No historical test is executed.) Commit-state
  // independent: tracked test changes ∪ untracked test files == exactly this file, pre- and
  // post-commit.
  const trackedTestChanges = git('diff', '--name-only', BASE, '--', 'tests').split('\n').filter(Boolean);
  const untrackedTests = git('ls-files', '--others', '--exclude-standard', 'tests').split('\n').filter(Boolean);
  assert.deepEqual([...new Set([...trackedTestChanges, ...untrackedTests])], [SELF],
    'the only test touched by this PART is this one');
  assert.equal(git('hash-object', 'tests/r10-part20-closure-guard.test.ts'),
    git('rev-parse', `${BASE}:tests/r10-part20-closure-guard.test.ts`), 'R10 guard blob identical');
  for (const t of ['tests/r11-part01-receiving-register-read.test.ts',
    'tests/r11-part02-receiving-register.test.ts']) {
    assert.equal(git('hash-object', t), git('rev-parse', `${BASE}:${t}`), `${t} blob identical`);
  }
  // Bounded PART 03B footprint: the four module files plus this test only.
  const changedTracked = git('diff', '--name-only', BASE).split('\n').filter(Boolean);
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  const changed = [...new Set([...changedTracked, ...untracked])];
  const ALLOWED = [...MODULE_FILES, SELF];
  assert.deepEqual(changed.filter((f) => !ALLOWED.includes(f)), [],
    'PART 03B changes only the new module + this test');
});

test('R11 P03B — type-strip validation of every PART 03B file and this test', () => {
  for (const f of [...MODULE_FILES, SELF]) {
    assert.doesNotThrow(() => stripTypeScriptTypes(rd(f), { mode: 'strip' }), `${f} type-strips cleanly`);
  }
  // The index publishes the governed service contract (repository exported but documented as
  // never consumed by Reporting), mirroring the receiving-register index precedent.
  assert.match(indexSrc, /export \{\s+getPurchaseOrderLineRegister,\s+parsePurchaseOrderLineRegisterQuery,\s+purchaseOrderLineRegisterService,\s+\} from '\.\/purchase-order-line-register\.service';/);
  assert.match(indexSrc, /export type \{\s+PublicPurchaseOrderLineRegister,\s+PublicPurchaseOrderLineRegisterRow,\s+PurchaseOrderLineRegisterFilters,\s+\} from '\.\/purchase-order-line-register\.types';/);
});
