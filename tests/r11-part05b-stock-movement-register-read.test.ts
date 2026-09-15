/**
 * R11 PART 05B — Stock Movement Register read foundation: focused contract test.
 *
 * Proves the set-based, actor-access-scoped movement read authority WITHOUT
 * executing historical R10/R11 tests and WITHOUT live PostgreSQL
 * (node_modules absent; the module chain imports pg transitively, so —
 * exactly as in R11 PART 01 / PART 03B — the contract is proven from source
 * text plus `stripTypeScriptTypes` syntax validation of every changed file,
 * and the frozen Reporting dataset enum is executed for real to pin the
 * count at 21).
 *
 * PROVES (PART 05B checklist 1–52): one public row per movement row;
 * stockMovementId preserves the source id as the only rename; userId
 * REQUIRED; explicit building existence check + access assertion;
 * accessible-Building rollup; empty authorized scope returns a well-formed
 * empty register WITHOUT any DB query (service short-circuit + repository
 * fail-closed guard); first structural scope predicate is the authorized
 * Building set; no caller-supplied clientId; ONE repository query; ZERO
 * joins; no N+1; strict fail-closed movementType validation via the owning
 * domain's OWN validator; native STOCK_IN/STOCK_OUT preserved verbatim;
 * UUID filter validation/normalization; exactly the eight source-supported
 * filters; movement_date is the ONLY business period; strict real
 * YYYY-MM-DD inputs; dateFrom whole-day start inclusive (>=); the whole
 * dateTo day included via the next-day exclusive boundary (<) — never the
 * `<= dateTo-midnight` truncation defect; no created_at period substitute;
 * 366-day maximum window; quantity / uomId / resultingQuantityOnHand /
 * resultingAvailableQuantity copied verbatim as historical post-movement
 * snapshots; no reservedQuantity derivation, no current-balance alias;
 * reference / source / performedByUserId verbatim; no warehouse or item
 * display join, no nested warehouse/item/resolved-balance objects; no
 * money, currency, cost, valuation, COGS, FX or price catalog; no
 * receiving / WO-usage / PO / invoice / reservation reverse enrichment; no
 * route, no migration, no new permission; Reporting dataset count remains
 * 21; the owning inventory-stock-movements module and all historical tests
 * remain byte-unchanged.
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

/** PART 04 closure — the fixed baseline this PART builds on. */
const BASE = '3847004a559e46fb25aa4ea971d631e2fa33d60f';
const MOD = 'src/modules/stock-movement-register';
const F_TYPES = `${MOD}/stock-movement-register.types.ts`;
const F_REPO = `${MOD}/stock-movement-register.repository.ts`;
const F_SVC = `${MOD}/stock-movement-register.service.ts`;
const F_INDEX = `${MOD}/index.ts`;
const SELF = 'tests/r11-part05b-stock-movement-register-read.test.ts';
const MODULE_FILES = [F_TYPES, F_REPO, F_SVC, F_INDEX];

const typesSrc = rd(F_TYPES);
const repoSrc = rd(F_REPO);
const svcSrc = rd(F_SVC);
const indexSrc = rd(F_INDEX);
const sRepo = strip(repoSrc);
const sSvc = strip(svcSrc);
const sTypes = strip(typesSrc);
const sMod = sRepo + sSvc + strip(indexSrc);

/** The frozen Reporting vocabulary is dependency-free — executed for real. */
const reporting = await import('../src/modules/reporting-export/reporting-export.types.ts');

test('R11 P05B 01/02/09/10/11 — ONE set-based query, ZERO joins, no N+1, identity preserved', () => {
  // 09 — exactly one repository query; nothing else touches the database.
  assert.equal((sRepo.match(/getPool\(\)\.query/g) ?? []).length, 1, 'one getPool().query call');
  assert.equal(/withTransaction|client\.query/.test(sMod), false, 'read-only: no transaction, no client queries');
  // 10 — ZERO joins: one table only, so no fan-out is structurally possible.
  // Case-sensitive `\sJOIN\s` — `Array.prototype.join(` (lowercase) must not match, the known
  // R11 PART 01 test-authoring pitfall.
  assert.equal((sRepo.match(/\sJOIN\s/g) ?? []).length, 0, 'zero joins');
  const tables = [...sRepo.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)], ['inventory_stock_movements'], 'exactly one authoritative table');
  // 01 — one public row per movement row: rows mapped, never filtered or reshaped.
  assert.match(sRepo, /result\.rows\.map\(mapRow\)/);
  assert.equal(/\.filter\(|DISTINCT|GROUP BY|ROW_NUMBER|LIMIT/i.test(sRepo), false,
    'no post-query filter, dedup, group, ranking or LIMIT selector');
  // 11 — no per-row loop anywhere: no iteration constructs, no Promise.all, and none of the
  // owning module's per-movement or list authorities is imported or called (the N+1 shape
  // list→loop→getMovementById is structurally absent).
  assert.equal(/Promise\.all|forEach|\bfor \(|\bwhile \(|\.map\(async/.test(sMod), false, 'no loops');
  assert.equal(/listMovements|getMovementById|inventoryStockMovementService|inventoryStockMovementRepository/.test(sMod),
    false, 'the owning module read functions are never imported or called');
  assert.equal((sSvc.match(/getStockMovementRegisterRows\(/g) ?? []).length, 1,
    'the service issues exactly one repository call per register read');
  // 02 — identity explicitly named: movement.id is published ONLY as stockMovementId.
  assert.match(sRepo, /movement\.id AS stock_movement_id/);
  assert.match(sRepo, /stockMovementId: row\.stock_movement_id/);
  assert.equal(/\bid: row\.id\b|: row\.id,/.test(sRepo), false, 'never published as a bare id');
  // Deterministic ordering, no post-query sort, no business ranking. The DESC direction is the
  // movements module's own list ordering; the trailing keys only make it deterministic.
  assert.match(sRepo, /ORDER BY movement\.movement_date DESC, movement\.created_at DESC,\s+movement\.id DESC/);
  assert.equal(/\.sort\(/.test(sMod), false, 'no post-query sort');
});

test('R11 P05B 03/04/05/06/07/08 — REQUIRED userId, fail-closed actor scope, no clientId', () => {
  // 03 — userId is REQUIRED on the public register service: no optional-actor form exists.
  assert.match(sSvc, /export async function getStockMovementRegister\(\s+filters: StockMovementRegisterFilters,\s+userId: string,\s+\): Promise<PublicStockMovementRegister>/);
  assert.equal(/actorUserId|userId\?/.test(sSvc), false, 'no optional actor form');
  // 04 — explicit buildingId: existence-checked, then Building access asserted for the actor.
  assert.match(sSvc, /if \(filters\.buildingId\) \{\s+const building = await buildingRepository\.findById\(filters\.buildingId\);\s+if \(!building\) \{\s+throw buildingNotFoundError\(\);/);
  assert.match(sSvc, /await contextAccessService\.assertBuildingAccess\(userId, filters\.buildingId\);/);
  assert.match(sSvc, /buildingIds: \[filters\.buildingId\],/);
  // 05 — omitted buildingId: rollup across exactly the accessible Buildings of the actor.
  assert.match(sSvc, /const buildingIds = await contextAccessService\.getAccessibleBuildingIds\(\s+userId,\s+\);/);
  assert.equal(/getAccessibleBuildingIds\(\)/.test(sSvc), false, 'scope is always actor-bound');
  // 06 — empty authorized scope: the SERVICE returns a well-formed empty register before any
  // repository call, and the REPOSITORY fail-closes before any SQL — no DB round trip either way.
  const svcEmptyAt = sSvc.indexOf('if (buildingIds.length === 0)');
  const svcRepoCallAt = sSvc.indexOf('getStockMovementRegisterRows(');
  assert.ok(svcEmptyAt !== -1 && svcRepoCallAt !== -1 && svcEmptyAt < svcRepoCallAt,
    'service short-circuits empty scope before the repository call');
  assert.match(sSvc, /if \(buildingIds\.length === 0\) \{\s+return \{ \.\.\.base, rows: \[\] \};/);
  const repoGuardAt = sRepo.indexOf('if (buildingIds.length === 0) return [];');
  assert.ok(repoGuardAt !== -1 && repoGuardAt < sRepo.indexOf('getPool().query'),
    'repository fail-closes before building or issuing SQL');
  // 07 — the scope predicate is the FIRST SQL condition, structurally bounding every row.
  assert.match(sRepo, /const conditions: string\[\] = \['movement\.building_id = ANY\(\$1::uuid\[\]\)'\];/);
  assert.match(sRepo, /const values: unknown\[\] = \[buildingIds\];/);
  // 08 — no caller-supplied clientId anywhere: client_id is a selected verbatim FACT only and
  // never a predicate; no all-client fallback exists.
  assert.equal(/query\.clientId|filters\.clientId|clientId ===|allClient/i.test(sSvc), false);
  assert.equal(/filters\.clientId/.test(sRepo), false);
  assert.equal(/client_id = \$|client_id = ANY|client_id IN/i.test(sRepo), false,
    'client_id is never a filter predicate');
  // Envelope follows the receiving-register convention exactly — no invented fields: the
  // accepted strict calendar dates are preserved as given, the normalized half-open window
  // lives in stockMovementRegisterRange.
  assert.match(sSvc, /buildingId: filters\.buildingId \?\? null,\s+buildingScope: buildingIds,\s+dateFrom: filters\.dateFrom \?\? null,\s+dateTo: filters\.dateTo \?\? null,\s+asOf: asOf\.toISOString\(\)/);
  // The service passes the normalized window bounds into the single repository call.
  assert.match(sSvc, /getStockMovementRegisterRows\(\s+buildingIds,\s+filters,\s+start,\s+end,\s+\)/);
});

test('R11 P05B 12/13/14/15 — governed parser: eight source-backed filters, strict vocabulary', () => {
  // 14 — UUID filters validated and normalized with the house helper.
  for (const f of ['buildingId', 'warehouseId', 'itemId', 'performedByUserId']) {
    assert.match(sSvc, new RegExp(`readOptionalUuid\\(\\s*query\\.${f},\\s*'${f}',\\s*details,?\\s*\\)`));
  }
  assert.match(sSvc, /import \{ isValidUuid \} from '\.\.\/clients';/);
  assert.match(sSvc, /return raw\.trim\(\)\.toLowerCase\(\);/);
  // 12 — movementType validated fail-closed by the movements authority's OWN validator; an
  // invalid value collects a detail and the parser THROWS — never silently dropped as the
  // existing public controller does.
  assert.match(sSvc, /import \{ isStockMovementType \} from '\.\.\/inventory-stock-movements';/);
  assert.match(sSvc, /readOptionalEnum\(\s+query\.movementType,\s+'movementType',\s+isStockMovementType,\s+'movementType must be a valid stock movement type\.',\s+details,\s+\)/);
  assert.match(sSvc, /if \(!isValid\(normalized\)\) \{\s+details\.push\(\{ field, message \}\);/);
  assert.match(sSvc, /if \(details\.length > 0\) \{\s+throw AppError\.validation\('Request validation failed\.', details\);/);
  // reference: trimmed free text under the owning domain's own substring semantics.
  assert.match(sSvc, /referenceRaw\.trim\(\)/);
  // 15 — EXACTLY the eight source-backed filters are read from the query; nothing else.
  const queryKeys = [...new Set([...sSvc.matchAll(/query\.(\w+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(queryKeys, ['buildingId', 'dateFrom', 'dateTo', 'itemId', 'movementType',
    'performedByUserId', 'reference', 'warehouseId']);
  assert.equal(/query\.(clientId|search|receivingId|purchaseOrderId|purchaseOrderLineId|materialRequestId|workOrderId|vendorId|reservationId|unitCost|currency|costMin|costMax|value|page|limit|latestOnly|currentOnly)\b/.test(sSvc),
    false, 'no filter beyond the frozen eight is read');
  // 13 — native STOCK_IN/STOCK_OUT vocabulary preserved verbatim end to end: copied column,
  // no CASE reshaping, no normalization to any other vocabulary, and NO generic status field.
  assert.match(sRepo, /movementType: row\.movement_type/);
  assert.equal(/CASE\s|WHEN\s/i.test(sRepo), false, 'no SQL reshaping of native values');
  assert.equal(/'IN'|'OUT'|\bRECEIPT\b|\bISSUE\b|\bCONSUMPTION\b|\bTRANSFER\b|\bADJUSTMENT\b/.test(sMod),
    false, 'vocabulary never normalized elsewhere');
  assert.equal(/\bstatus\b/.test(sMod), false, 'no generic lifecycle status on this contract');
  assert.match(typesSrc, /STOCK_IN \| STOCK_OUT/, 'native vocabulary documented verbatim');
  assert.match(typesSrc, /NOT a lifecycle state/, 'direction/type is documented as not a lifecycle');
  // Read-only discipline: no write statement shape, no operational events.
  assert.equal(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|recordOperationalEvent/i.test(sMod),
    false, 'read-only: no write statement, no events');
});

test('R11 P05B 16–23 — movement_date is the only period: half-open UTC window, bounded', () => {
  // 16 — movement_date (TIMESTAMPTZ) is the ONLY date-window column: exactly two period
  // conditions exist over it, and no other timestamp participates in any condition.
  assert.equal((sRepo.match(/movement\.movement_date (>=|<)/g) ?? []).length, 2);
  assert.equal(/(created_at|updated_at)\s*(>=|<=|>|<)/.test(sRepo), false,
    '22 — created_at is never a period substitute; it is a selected audit fact only');
  // 19/20 — the normalized query bounds: >= start, < endExclusive.
  assert.match(sRepo, /conditions\.push\(`movement\.movement_date >= \$\$\{values\.length\}`\)/);
  assert.match(sRepo, /conditions\.push\(`movement\.movement_date < \$\$\{values\.length\}`\)/);
  // 21 — the `<= dateTo-midnight` truncation defect of the existing public list is absent.
  assert.equal(/movement_date\s*<=(?!=)/.test(sRepo), false, 'no inclusive-upper midnight bound');
  assert.equal(/::timestamptz|::timestamp\b/.test(sRepo), false, 'Date parameters bound directly, no casting');
  // 17/18 — normalization: start = UTC midnight of dateFrom (whole-day start inclusive);
  // end = UTC midnight of the day AFTER dateTo (whole dateTo day included, exclusive bound).
  assert.match(sSvc, /const start = filters\.dateFrom \? toUtcMidnight\(filters\.dateFrom\) : null;/);
  assert.match(sSvc, /new Date\(toUtcMidnight\(filters\.dateTo\)\.getTime\(\) \+ 86400000\)/);
  assert.match(sSvc, /const range = stockMovementRegisterRange\(filters\);/);
  assert.match(sSvc, /function toUtcMidnight\(value: string\): Date \{\s+const \[year, month, day\] = value\.split\('-'\)\.map\(Number\);\s+return new Date\(Date\.UTC\(year, month - 1, day\)\);/);
  assert.match(typesSrc, /half-open UTC window/, 'window semantics documented truthfully');
  // 23 — strict real YYYY-MM-DD validation and the 366-day Reporting bound.
  assert.match(sSvc, /DATE_ONLY = \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  assert.match(sSvc, /if \(!DATE_ONLY\.test\(normalized\) \|\| !isCalendarDate\(normalized\)\)/);
  assert.match(sSvc, /function isCalendarDate/);
  assert.match(sSvc, /date\.getUTCFullYear\(\) === year/);
  assert.match(sSvc, /MAX_RANGE_DAYS = 366/);
  assert.match(sSvc, /spanDays > MAX_RANGE_DAYS/);
  assert.match(sSvc, /dateTo must be the same as or after dateFrom/);
  assert.match(sSvc, /Report date range must not exceed/);
  // The existing public list's raw unvalidated `new Date(string)` date parsing is NOT reused:
  // no raw date string ever reaches a Date constructor outside the governed strict helpers.
  assert.equal(/new Date\(filters\.date|new Date\(raw|new Date\(dateFrom|new Date\(dateTo/.test(sSvc), false);
});

test('R11 P05B 24–31 — row facts verbatim; snapshots historical; actor semantics', () => {
  // 24/25/26/27 — quantity and UOM snapshot copied verbatim; the NUMERIC boundary conversion
  // mirrors the owning repository's own mapper (single Number(), no rounding, no arithmetic);
  // the persisted HISTORICAL post-movement snapshots copied column-for-column.
  assert.match(sRepo, /quantity: Number\(row\.quantity\)/);
  assert.match(sRepo, /uomId: row\.uom_id/);
  assert.match(sRepo, /resultingQuantityOnHand: Number\(row\.resulting_quantity_on_hand\)/);
  assert.match(sRepo, /resultingAvailableQuantity: Number\(row\.resulting_available_quantity\)/);
  assert.equal(/toFixed|Math\.round|ROUND\(/i.test(sMod), false, 'no rounding anywhere');
  // 30/31 — generic reference/source texts and the actor copied verbatim.
  assert.match(sRepo, /reference: row\.reference/);
  assert.match(sRepo, /source: row\.source/);
  assert.match(sRepo, /performedByUserId: row\.performed_by_user_id/);
  assert.match(sRepo, /notes: row\.notes/);
  assert.match(sRepo, /movementDate: row\.movement_date\.toISOString\(\)/);
  assert.match(sRepo, /createdAt: row\.created_at\.toISOString\(\)/);
  for (const [pub, col] of [['clientId', 'client_id'], ['buildingId', 'building_id'],
    ['warehouseId', 'warehouse_id'], ['itemId', 'item_id'], ['movementType', 'movement_type']]) {
    assert.match(sRepo, new RegExp(`${pub}: row\\.${col}`), `${pub} verbatim`);
  }
  // 28 — NO reservedQuantity derivation: no subtraction of the snapshot columns, no such key.
  assert.equal(/reservedQuantity/i.test(sMod + sTypes), false, 'no reserved quantity field');
  assert.equal(/resulting_quantity_on_hand\s*-|resultingQuantityOnHand\s*-|-\s*Number\(row\.resulting_available/.test(sMod),
    false, 'no snapshot subtraction');
  assert.equal(/SUM\(|COUNT\(|AVG\(|MIN\(|MAX\(/i.test(sRepo), false, 'no aggregation of any kind');
  // 29 — NO current-balance alias: the snapshots are never relabeled as current inventory.
  assert.equal(/currentQuantityOnHand|currentAvailableQuantity|currentBalance/i.test(sMod + sTypes), false);
  assert.match(typesSrc, /HISTORICAL/, 'snapshot semantics documented as historical');
  assert.match(typesSrc, /post-movement snapshot/, 'snapshot semantics documented');
  assert.match(typesSrc, /Performed By/, 'actor semantic label documented');
  assert.equal(/Received By|Used By|Consumed By|Requester|Approver|Executor/i.test(sTypes), false,
    'no actor relabeling');
  // The full 16-key public row contract exists on the type — and nothing more.
  const rowKeys = ['stockMovementId', 'clientId', 'buildingId', 'warehouseId', 'itemId',
    'movementType', 'quantity', 'uomId', 'movementDate', 'reference', 'source',
    'performedByUserId', 'notes', 'resultingQuantityOnHand', 'resultingAvailableQuantity',
    'createdAt'];
  for (const key of rowKeys) {
    assert.match(typesSrc, new RegExp(`\\b${key}:`), `row type declares ${key}`);
  }
  const rowTypeBody = typesSrc.slice(typesSrc.indexOf('PublicStockMovementRegisterRow = {'),
    typesSrc.indexOf('export type PublicStockMovementRegister = {'));
  const declared = [...rowTypeBody.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(declared, rowKeys, 'exactly the sixteen persisted movement facts');
  // Filter type: exactly the eight governed optional filters.
  const filterBody = typesSrc.slice(typesSrc.indexOf('StockMovementRegisterFilters = {'),
    typesSrc.indexOf('/** One flat register row.'));
  const filterKeys = [...filterBody.matchAll(/^\s{2}(\w+)\?:/gm)].map((m) => m[1]).sort();
  assert.deepEqual(filterKeys, ['buildingId', 'dateFrom', 'dateTo', 'itemId', 'movementType',
    'performedByUserId', 'reference', 'warehouseId']);
});

test('R11 P05B 32–46 — no display joins, no nested objects, no money, no reverse enrichment', () => {
  // 32/33/34/35 — no warehouse/item display-name join, no nested warehouse/item objects and
  // no nested resolved-balance object: zero joins (asserted above), single table, and the
  // enrichment shapes of the existing public list are structurally absent.
  assert.equal(/warehouse:\s*\{|item:\s*\{|resultingBalance/i.test(sMod + sTypes), false);
  assert.equal(/inventory_warehouses|inventory_items|units_of_measure/.test(sRepo), false,
    'no display or UOM authority is queried');
  assert.equal(/whMap|itemMap|enrich/i.test(sMod), false, 'no enrichment machinery');
  // 36–42 — ZERO monetary authority: no cost/value/currency/price/COGS/valuation token, no
  // FX or conversion, no price catalog, and no monetary column exists in the SQL.
  assert.equal(/unitCost|totalCost|averageCost|standardCost|inventoryValue|stockValue|COGS|valuation|FIFO|LIFO|weightedAverage/i.test(sMod + sTypes), false);
  assert.equal(/\bprice\b|\bamount\b|\bcurrency\b|\bprices?\b/i.test(sMod + sTypes), false);
  assert.equal(/\bfx\b|exchange[Rr]ate|convert/i.test(sMod), false, 'no FX/conversion');
  assert.equal(/price_catalog|priceCatalog/i.test(sMod), false);
  // 43–46 — NO reverse-relationship enrichment: domains that persist a movement id are never
  // joined back, and the reverse FK column is never read.
  assert.equal(/receivings|material_usages|material_requests|reservations|purchase_orders|vendor_invoices|stock_transfers|stock_adjustments|inventory_stock_balances/i.test(sRepo),
    false, 'no reverse-domain table is queried');
  // With ZERO joins over exactly ONE table (asserted above), a reverse FK read into any other
  // domain is structurally impossible; no second table alias can appear in any predicate.
  assert.equal(/FROM\s+(?!inventory_stock_movements\b)/.test(sRepo), false,
    'the single FROM is the authoritative movements table');
  // Module imports are exactly the proven register-read dependency set — no drill module, no
  // pricing authority, no reporting vocabulary.
  const imports = [...sMod.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)].sort(), [
    '../../database', '../../shared/errors', '../buildings', '../clients', '../context-access',
    '../inventory-stock-movements', './stock-movement-register.repository',
    './stock-movement-register.service', './stock-movement-register.types',
  ]);
  // No Reporting-specific vocabulary leaks into the source read contract.
  assert.equal(/STOCK_MOVEMENT_REGISTER|dataset|kpis|csvDefault|reporting/i.test(sMod), false);
  // No permission vocabulary is created; the EXISTING inventory_stock.read gate on the owning
  // module's routes is asserted to still stand (49).
  assert.equal(/requirePermission|rbac|permission/i.test(sMod), false, 'no permission surface');
  assert.match(rd('src/modules/inventory-stock-movements/inventory-stock-movement.routes.ts'),
    /requirePermission\('inventory_stock\.read'\)/);
});

test('R11 P05B 47/48/50/51/52 — no route, no migration, count 21, frozen surfaces byte-unchanged', () => {
  // 47 — no HTTP surface: the module is exactly the four house-shape files; routes untouched.
  assert.deepEqual(fs.readdirSync(path.join(ROOT, MOD)).sort(),
    ['index.ts', 'stock-movement-register.repository.ts', 'stock-movement-register.service.ts',
      'stock-movement-register.types.ts']);
  assert.equal(/controller|router\.|createStockMovementRegisterRouter/i.test(sMod), false);
  assert.equal(rd('src/routes/index.ts').includes('stock-movement-register'), false);
  assert.equal(git('diff', BASE, '--', 'src/routes'), '', 'no route file changed');
  // 48 — no migration exists or changed.
  assert.equal(git('diff', BASE, '--', 'src/database'), '', 'no database/migration change');
  assert.equal(fs.readdirSync(path.join(ROOT, 'src/database/migrations'))
    .some((f) => /stock[-_]movement[-_]register/i.test(f)), false);
  // 50 — the Reporting dataset vocabulary is executed for real and remains frozen at 21.
  assert.equal(reporting.REPORTING_EXPORT_DATASETS.length, 21);
  assert.equal(reporting.REPORTING_EXPORT_DATASETS.includes('STOCK_MOVEMENT_REGISTER'), false);
  assert.deepEqual(Object.keys(reporting.REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
  assert.equal(git('diff', BASE, '--', 'src/modules/reporting-export', 'docs/api/openapi.yaml'), '',
    'Reporting registration and OpenAPI dataset enum untouched');
  // 51 — the owning movements authority (whole module) is byte-unchanged.
  assert.equal(git('diff', BASE, '--', 'src/modules/inventory-stock-movements'), '',
    'owning source module untouched');
  // 52 — every historical test is byte-unchanged, including the frozen R10 closure guard; the
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
    'tests/r11-part02-receiving-register.test.ts',
    'tests/r11-part03b-purchase-order-line-register-read.test.ts',
    'tests/r11-part03c-purchase-order-register.test.ts',
    'tests/r11-part04-vendor-invoice-register.test.ts']) {
    assert.equal(git('hash-object', t), git('rev-parse', `${BASE}:${t}`), `${t} blob identical`);
  }
  // Bounded PART 05B footprint: the four module files plus this test only.
  const changedTracked = git('diff', '--name-only', BASE).split('\n').filter(Boolean);
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  const changed = [...new Set([...changedTracked, ...untracked])].sort();
  const ALLOWED = [...MODULE_FILES, SELF].sort();
  assert.deepEqual(changed, ALLOWED, 'PART 05B changes only the new module + this test');
});

test('R11 P05B — type-strip validation of every PART 05B file and this test', () => {
  for (const f of [...MODULE_FILES, SELF]) {
    assert.doesNotThrow(() => stripTypeScriptTypes(rd(f), { mode: 'strip' }), `${f} type-strips cleanly`);
  }
  // The index publishes the governed service contract (repository exported but documented as
  // never consumed by Reporting), mirroring the receiving-register / PART 03B index precedent.
  assert.match(indexSrc, /export \{ stockMovementRegisterRepository \} from '\.\/stock-movement-register\.repository';/);
  assert.match(indexSrc, /export \{\s+getStockMovementRegister,\s+parseStockMovementRegisterQuery,\s+stockMovementRegisterRange,\s+stockMovementRegisterService,\s+\} from '\.\/stock-movement-register\.service';/);
  assert.match(indexSrc, /export type \{\s+PublicStockMovementRegister,\s+PublicStockMovementRegisterRow,\s+StockMovementRegisterFilters,\s+\} from '\.\/stock-movement-register\.types';/);
  assert.match(indexSrc, /never the repository/, 'Reporting-consumes-service-only governance documented');
  // The service object exposes exactly the three governed functions.
  assert.match(sSvc, /export const stockMovementRegisterService = \{\s+getStockMovementRegister,\s+parseStockMovementRegisterQuery,\s+stockMovementRegisterRange,\s+\};/);
});
