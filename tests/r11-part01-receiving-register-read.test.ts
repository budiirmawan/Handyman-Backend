/**
 * R11 PART 01 — RECEIVING REGISTER READ FOUNDATION: focused contract test.
 *
 * This is a STATIC contract validation in the r10-part20-closure-guard
 * tradition: the read model's guarantees are proven from source text plus
 * two dependency-free runtime imports (this module's own types file and
 * the frozen Reporting dataset enum). There is no database, no express
 * and no dependency installation required; the runtime data-path proof
 * belongs to the CI integration harness (tsx --test with PostgreSQL),
 * exactly as CR-BE-REPORT-READ-01 splits its contract and register tests.
 *
 * PROVES (PART 01 checklist):
 *   01 one row per receiving (single table, zero joins, no fan-out)
 *   02 identity preserved (receivings.id → receivingId)
 *   03 accessible-building scope (ANY($1::uuid[]) first condition +
 *      contextAccessService rollup)
 *   04 explicit building access fail-closed (findById + assertBuildingAccess)
 *   05 half-open received_at window (>= start, < end; date-only dateTo
 *      whole-UTC-day; bounded 366-day range; no created_at/updated_at)
 *   06 native status filter (authority validator, verbatim vocabulary)
 *   07 native receivingType filter (authority validator)
 *   08 request/vendor filters UUID-validated and parameterized
 *   09 materialRequestId filter (authoritative optional line binding)
 *   10 deterministic ordering (received_at DESC, id DESC; no post-sort)
 *   11 no purchaseOrderId inference
 *   12 no purchaseOrderLineId inference
 *   13 no money / currency / valuation authority
 *   14 receivedBy semantics preserved (no actor relabeling)
 *   15 stockMovementId copied verbatim only (movement grain not expanded)
 *   16 exactly one repository query
 *   17 no N+1 / loops / post-query filtering / dedup-group-collapse
 *   18 no route, no controller, no router mount
 *   19 no migration
 *   20 no new permission
 *   21 Reporting dataset count remains 18 and RECEIVING_REGISTER is NOT
 *      registered yet (PART 02 performs 18 → 19; this pin is legitimately
 *      re-scoped by that registration commit)
 *   +  type-strip validation of every changed production file
 *   +  bounded module footprint (exactly four internal files)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Comment stripper mirrored from the R10 closure guard. */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const MOD = 'src/modules/receiving-register';
const TYPES = `${MOD}/receiving-register.types.ts`;
const REPO = `${MOD}/receiving-register.repository.ts`;
const SVC = `${MOD}/receiving-register.service.ts`;
const IDX = `${MOD}/index.ts`;
const SELF = 'tests/r11-part01-receiving-register-read.test.ts';

const typesSrc = rd(TYPES);
const repoSrc = rd(REPO);
const svcSrc = rd(SVC);
const idxSrc = rd(IDX);
const sRepo = strip(repoSrc);
const sSvc = strip(svcSrc);
const sTypes = strip(typesSrc);
const sIdx = strip(idxSrc);
const sModule = sTypes + sRepo + sSvc + sIdx;

/** Dependency-free runtime imports (explicit .ts specifiers, guard precedent). */
const ownTypes = await import('../src/modules/receiving-register/receiving-register.types.ts');
const reportingTypes = await import('../src/modules/reporting-export/reporting-export.types.ts');

test('R11 P01 01/02/15/16/17 — one row per receiving, identity verbatim, single query, no collapse', () => {
  // Single table, zero joins: fan-out is structurally impossible.
  // (`\sJOIN\s` targets the SQL keyword only — `conditions.join(...)` is
  // the Array method, not a join.)
  assert.match(sRepo, /FROM receivings r\s+WHERE/);
  assert.equal(/\sJOIN\s/i.test(sRepo), false, 'no SQL join of any kind');
  assert.equal(/GROUP BY|DISTINCT|ROW_NUMBER|LIMIT/i.test(sRepo), false,
    'no dedup/group/collapse/ranking in SQL');
  // 02 — identity: receivings.id selected and mapped, nothing synthesized.
  assert.match(sRepo, /r\.id AS receiving_id/);
  assert.match(sRepo, /receivingId: row\.receiving_id/);
  // 15 — stockMovementId copied verbatim; the movement table is never consulted.
  assert.match(sRepo, /r\.stock_movement_id AS stock_movement_id/);
  assert.match(sRepo, /stockMovementId: row\.stock_movement_id/);
  assert.equal(/inventory_stock_movements/.test(sRepo), false,
    'movement grain is not expanded here (belongs to the movement register PART)');
  // 16 — exactly one repository query, exactly one service call into it.
  assert.equal((sRepo.match(/getPool\(\)\.query/g) ?? []).length, 1, 'one bounded set-based query');
  assert.equal((sSvc.match(/receivingRegisterRepository\.getReceivingRegisterRows\(/g) ?? []).length, 1,
    'service calls the repository exactly once');
  // 17 — no N+1, no loops, no post-query row filtering or sorting.
  assert.equal(/for \(|forEach|while \(|Promise\.all/.test(sRepo + sSvc), false, 'no iteration/N+1');
  assert.equal(/\.filter\(|\.slice\(|\.sort\(|\.reduce\(/.test(sRepo + sSvc), false,
    'no post-query filter/sort/slice/aggregate; rows.map is a pure 1:1 projection');
  assert.match(sRepo, /result\.rows\.map\(mapRow\)/);
});

test('R11 P01 03/04 — building isolation is structural and fail-closed', () => {
  // 03 — first WHERE condition is the authorized Building set; no all-client fallback.
  assert.match(sRepo, /const conditions: string\[\] = \['r\.building_id = ANY\(\$1::uuid\[\]\)'\]/);
  assert.match(sSvc, /contextAccessService\.getAccessibleBuildingIds\(/);
  // Empty authorized scope → well-formed empty register, never a query, never a 403.
  assert.match(sSvc, /if \(buildingIds\.length === 0\) \{\s+return \{ \.\.\.base, rows: \[\] \};/);
  // 04 — explicit buildingId: existence check + access assertion before any read.
  assert.match(sSvc, /buildingRepository\.findById\(filters\.buildingId\)/);
  assert.match(sSvc, /throw buildingNotFoundError\(\)/);
  assert.match(sSvc, /contextAccessService\.assertBuildingAccess\(userId, filters\.buildingId\)/);
  // Envelope mirrors the proven register contract.
  assert.match(sTypes, /buildingScope: string\[\]/);
  assert.match(sSvc, /buildingScope: buildingIds/);
});

test('R11 P01 05/10 — received_at half-open window is the only period authority; ordering deterministic', () => {
  // 05 — half-open [start, end) over received_at, parameterized.
  assert.match(sRepo, /r\.received_at >= \$\$\{values\.length\}/);
  assert.match(sRepo, /r\.received_at < \$\$\{values\.length\}/);
  // created_at/updated_at are neither selected nor windowed anywhere in the read.
  assert.equal(/created_at|updated_at/.test(sRepo), false,
    'no record-metadata timestamp is a period substitute');
  // Window conversion mirrors vendorServiceRegisterRange: date-only dateTo
  // includes the whole UTC day; bounded reporting range reused, not reinvented.
  assert.match(sSvc, /DATE_ONLY\.test\(filters\.dateTo\)\s+\? new Date\(to\.getTime\(\) \+ 86400000\)/);
  assert.match(sSvc, /MAX_RANGE_DAYS = 366/);
  assert.match(sSvc, /dateFrom must not exceed dateTo\./);
  assert.match(sSvc, /Report date range must not exceed/);
  // 10 — source-compatible ordering (receivings lists ORDER BY received_at DESC)
  // plus an id tiebreak for determinism; no business ranking.
  assert.match(sRepo, /ORDER BY r\.received_at DESC, r\.id DESC/);
});

test('R11 P01 06/07/08/09 — filters are the authority’s own, validated and parameterized', () => {
  // 06/07 — native vocabularies validated by the receivings authority’s own
  // validators; this module declares no competing vocabulary.
  assert.match(sSvc, /import \{ isReceivingStatus, isReceivingType \} from '\.\.\/receivings'/);
  assert.match(sSvc, /isReceivingType,\s+'receivingType must be a valid receiving type\.'/);
  assert.match(sSvc, /isReceivingStatus,\s+'status must be a valid receiving status\.'/);
  assert.match(sRepo, /r\.receiving_type = \$\$\{values\.length\}/);
  assert.match(sRepo, /r\.status = \$\$\{values\.length\}/);
  // 08/09 — UUID identity filters (client-scoped UUID validation via isValidUuid)
  // for vendor and the persisted request lineage, including the optional
  // MATERIAL-request line binding.
  assert.match(sSvc, /import \{ isValidUuid \} from '\.\.\/clients'/);
  for (const f of ['buildingId', 'vendorId', 'purchaseRequestId', 'serviceRequestId', 'materialRequestId']) {
    assert.match(sSvc, new RegExp(`readOptionalUuid\\(\\s*query\\.${f},\\s*'${f}'`), `${f} is UUID-validated`);
  }
  assert.match(sRepo, /r\.vendor_id = \$\$\{values\.length\}/);
  assert.match(sRepo, /r\.purchase_request_id = \$\$\{values\.length\}/);
  assert.match(sRepo, /r\.service_request_id = \$\$\{values\.length\}/);
  assert.match(sRepo, /r\.material_request_id = \$\$\{values\.length\}/);
  // No filter beyond the authoritative set: forbidden selectors never exist.
  assert.equal(
    /purchaseOrderId|purchaseOrderLineId|invoiceId|workOrderId|latestOnly|currentOnly|receivedOnly|completedOnly|\bsearch\b|\bsort\b|\bpage\b/i
      .test(sModule),
    false,
    'no invented or premature filter key',
  );
});

test('R11 P01 11/12 — no purchase order or PO line inference of any kind', () => {
  // The schema persists no receiving → PO / PO-line reference; the read must
  // not derive one from vendor, readiness, item, quantity, request,
  // timestamp or the current live PO.
  assert.equal(/purchase_order/i.test(sModule), false, 'no purchase_order token in module code');
  assert.equal(/purchaseOrder/i.test(sModule), false, 'no purchaseOrder identifier in module code');
  assert.equal(/po_readiness|purchaseOrderReadiness|readiness/i.test(sModule), false,
    'no readiness-based PO derivation');
  // Request-anchored lineage only.
  assert.match(sTypes, /purchaseRequestId: string \| null/);
  assert.match(sTypes, /serviceRequestId: string \| null/);
  assert.match(sTypes, /materialRequestId: string \| null/);
});

test('R11 P01 13/14 — no monetary authority; actor semantics unpromoted', () => {
  // 13 — receiving is a quantity/operational receipt fact only.
  assert.equal(
    /\bprice\b|\bamount\b|\bcost\b|currency|valuation|cogs|unit_price|invoice/i.test(sModule),
    false,
    'no money/currency/valuation field or inference',
  );
  // Quantity stays a per-row native fact; UOM stays a snapshot.
  assert.match(sRepo, /quantity: row\.quantity === null \? null : Number\(row\.quantity\)/);
  assert.match(sTypes, /quantity: number \| null/);
  assert.match(sTypes, /uomId: string \| null/);
  assert.equal(/convert|conversion|remaining|approvedQuantity|approved_quantity/i.test(sModule), false,
    'no UOM conversion, no remaining/approved quantity derivation');
  // 14 — receivedByUserId maps the persisted receiving actor, verbatim.
  assert.match(sRepo, /r\.received_by_user_id AS received_by_user_id/);
  assert.match(sRepo, /receivedByUserId: row\.received_by_user_id/);
  assert.equal(/performedBy|executor|approver|verifier|requester|issuedBy/i.test(sModule), false,
    'no actor relabeling / semantic promotion');
});

test('R11 P01 18/19/20 — no route, no migration, no permission, bounded footprint', () => {
  // 18 — internal read contract only: exactly four files, no HTTP surface.
  const files = fs.readdirSync(path.join(ROOT, MOD)).sort();
  assert.deepEqual(files, [
    'index.ts',
    'receiving-register.repository.ts',
    'receiving-register.service.ts',
    'receiving-register.types.ts',
  ]);
  assert.equal(/express|Router|router|controller|routes/.test(sIdx), false, 'index exports no HTTP surface');
  assert.equal(rd('src/routes/index.ts').includes('receiving-register'), false,
    'no router mount anywhere');
  // 19 — no migration was added for this read model.
  assert.equal(
    fs.readdirSync(path.join(ROOT, 'src/database/migrations'))
      .some((f) => f.includes('receiving-register') || f.includes('receiving_register')),
    false,
    'no receiving-register migration exists',
  );
  // 20 — no new permission: the future adapter reuses `receiving.read`.
  assert.equal(/requirePermission|\.read'|\.manage'/i.test(sModule), false,
    'module declares no permission surface');
  assert.equal(/receiving_register\.read|receivingRegister\.read/i.test(rd('src/routes/index.ts')), false);
});

test('R11 P01 21 — Reporting registration untouched: dataset count is still 18', async () => {
  // Runtime: the frozen enum is unchanged and carries no RECEIVING_REGISTER.
  const datasets = reportingTypes.REPORTING_EXPORT_DATASETS;
  assert.equal(datasets.length, 18, 'runtime dataset enum is 18');
  assert.equal(datasets.includes('RECEIVING_REGISTER'), false, 'not registered in PART 01');
  // The own types module is dependency-free and loads under type stripping.
  assert.equal(typeof ownTypes, 'object');
  // Static: registry adapters and the OpenAPI archive enum are untouched.
  const regSrc = rd('src/modules/reporting-export/reporting-export.registry.ts');
  const registryKeys = [...regSrc.matchAll(/^ {2}([A-Z][A-Z0-9_]+): \{$/gm)].map((m) => m[1]);
  assert.equal(registryKeys.length, 18, 'registry adapter count is 18');
  assert.deepEqual([...registryKeys].sort(), [...datasets].sort(), 'registry set equals enum set');
  assert.equal(regSrc.includes('RECEIVING_REGISTER'), false, 'no adapter added');
  assert.equal(regSrc.includes('receiving-register'), false, 'registry does not import this module yet');
  const openapiBlock = rd('docs/api/openapi.yaml')
    .split('    ReportArchiveDataset:')[1]
    .split('    ReportArchiveFormat:')[0];
  const enumBody = openapiBlock.slice(openapiBlock.indexOf('['), openapiBlock.indexOf(']') + 1);
  const openapiEnum = enumBody.match(/[A-Z][A-Z0-9_]+/g) ?? [];
  assert.equal(openapiEnum.length, 18, 'OpenAPI dataset enum is 18');
  assert.deepEqual([...openapiEnum].sort(), [...datasets].sort(), 'OpenAPI set equals runtime set');
});

test('R11 P01 — type-strip validation of every PART 01 production file and this test', () => {
  // Erasable-syntax-only proof: each changed file passes Node’s own TypeScript
  // type stripping, so it is loadable by both the tsx CI harness and bare
  // node --test without a transpiler or dependency installation.
  for (const f of [TYPES, REPO, SVC, IDX, SELF]) {
    assert.doesNotThrow(() => stripTypeScriptTypes(rd(f), { mode: 'strip' }), `${f} type-strips cleanly`);
  }
  // The types file must stay dependency-free (runtime-importable in isolation).
  assert.equal(/^import\s/m.test(typesSrc), false, 'types module has zero imports');
});
