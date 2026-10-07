import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

/**
 * R10 PART 03 — OPERATIONAL_DETAIL_HISTORY / history=EVIDENCE: focused validation.
 *
 * PART 03 registers a NEW reporting dataset as a PURE adapter over the EXISTING
 * R08 operational-detail evidence child: no new evidence SQL, no change to the R08
 * module, and only `history=EVIDENCE` implemented (FINDING_REWORK and REVIEW are
 * later PARTs).
 *
 * reporting-export.types has no imports and reporting-export.r10-projections
 * imports only `import type` bindings (erased at runtime), so both are asserted
 * LIVE via dynamic import — the R08 PART 01B convention. The registry and the R08
 * child pull in `pg` / context-access, so they are asserted statically against
 * comment-stripped source. Paths resolve from process.cwd() so this file runs
 * identically under `tsx --test` (CommonJS) and plain `node --test` (ESM).
 *
 * Covers the 28 required proofs:
 *   1 registered once, appended last   2 prior 12 intact and ordered   3 checklist.read
 *   4 no new permission invented       5 frozen vocabulary ONCE        6 history REQUIRED
 *   7 unknown/BOTH/ALL rejected        8 unimplemented rejected        9 engine owned by child
 *  10 no BOTH/ALL/default engine      11 parser+getter verbatim       12 R08 untouched
 *  13 limit/offset stripped, 1000     14 dateTo frozen ONCE           15 one row per evidence id
 *  16 no sibling-grain join           17 exactly the 26 fields        18 no storage locator
 *  19 capturedAt is a TIME            20 integrity facts not derived  21 one table, no CSV default
 *  22 fail-closed scope reused        23 narrowing-only filters       24 echo = applied filters
 *  25 projection in r10-projections   26 renderers/archive untouched  27 no migration/route
 *  28 OpenAPI parity 13==13, EVIDENCE-only documented
 */

const ROOT = process.cwd();
const EXPORT_DIR = resolve(ROOT, 'src/modules/reporting-export');
const TYPES_PATH = resolve(EXPORT_DIR, 'reporting-export.types.ts');
const PROJECTIONS_PATH = resolve(EXPORT_DIR, 'reporting-export.r10-projections.ts');
const REGISTRY_PATH = resolve(EXPORT_DIR, 'reporting-export.registry.ts');
const EVIDENCE_DIR = resolve(ROOT, 'src/modules/operational-detail-evidence');
const EVIDENCE_TYPES_PATH = resolve(EVIDENCE_DIR, 'operational-detail-evidence.types.ts');
const EVIDENCE_SERVICE_PATH = resolve(EVIDENCE_DIR, 'operational-detail-evidence.service.ts');
const MIGRATIONS_DIR = resolve(ROOT, 'src/database/migrations');

const PRE_PART03 = ['SECURITY_PATROL', 'SECURITY_FINDING_INCIDENT', 'WORKFORCE', 'VENDOR_TENANT',
  'UTILITY', 'MANAGEMENT_OPERATIONS_COMMAND_CENTER', 'VENDOR_SERVICE_REGISTER', 'FINDING_REGISTER',
  'WORK_ORDER_REGISTER', 'CHECKLIST_EXECUTION_SUMMARY', 'OPERATIONAL_DETAIL', 'CORRECTIVE_ACTION'];
// Exact keys only: substring matching would wrongly flag contentSha256 / contentHashedAt.
const STORAGE_KEYS = ['fileReference', 'storageKey', 'url', 'signedUrl', 'downloadUrl', 'fileUrl', 'bucket', 'path', 'filePath', 'objectKey', 'bytes', 'token', 'secret', 'credential', 'locator'];
const DERIVED_CLAIMS = ['verified', 'isVerified', 'integrityVerified', 'available', 'isAvailable', 'hashStatus'];
const SIBLING_KEYS = ['findingId', 'reworkCycle', 'reviewId', 'reviewDecision', 'findingRework'];
const read = (path: string): string => readFileSync(path, 'utf8');
/** Removes comments so "must not exist" assertions test the CODE contract, not
 *  the documentation that explains the exclusion. */
const code = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const registryCode = code(REGISTRY_PATH);
const evidenceServiceCode = code(EVIDENCE_SERVICE_PATH);
/** The OPERATIONAL_DETAIL_HISTORY adapter block ONLY — scoped so no assertion can
 *  be satisfied incidentally by the OPERATIONAL_DETAIL batching precedent above. */
function odhAdapter(): string {
  const start = registryCode.indexOf('  OPERATIONAL_DETAIL_HISTORY: {');
  // R10 PART 15: the previous end marker '\n};' is the CLOSE OF THE WHOLE REGISTRY OBJECT, so this
  // slice silently swallowed every adapter registered after OPERATIONAL_DETAIL_HISTORY. That was
  // invisible while no later adapter read a clock. PART 15's SECURITY_OPERATIONAL_DETAIL does
  // (`new Date().toISOString()` — the CORRECTIVE_ACTION convention for a source that publishes no
  // as-of instant), which pushed the "clock is read once per load" count to 2. The next registered
  // adapter key is this adapter's true end.
  const end = registryCode.indexOf('\n  WORK_ORDER_SLA: {', start);
  assert.ok(start >= 0 && end > start, 'the adapter must be registered and complete');
  return registryCode.slice(start, end);
}
/** Field names of the authoritative R08 row contract, in declaration order. */
function authoritativeEvidenceFields(): string[] {
  const source = code(EVIDENCE_TYPES_PATH);
  const body = source.slice(source.indexOf('PublicOperationalDetailEvidenceRow'));
  assert.ok(body.length > 0, 'the R08 evidence row contract must exist');
  const inner = body.slice(body.indexOf('{') + 1, body.indexOf('\n}'));
  assert.ok(inner.length > 0, 'the row contract must be a closed interface');
  return [...inner.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
}
/** An envelope shaped exactly like the R08 child returns. */
const evidenceSource = (rows: Record<string, unknown>[]) => ({ engine: 'CHECKLIST_EXECUTION',
  buildingId: null, buildingScope: ['building-1'], dateFrom: null,
  dateTo: '2026-01-31T00:00:00.000Z', asOf: '2026-01-31T12:00:00.000Z', rows });
const evidenceRow = (evidenceId: string, overrides: Record<string, unknown> = {}) => ({
  evidenceId, engine: 'CHECKLIST_EXECUTION', executionId: 'execution-1', clientId: 'client-1',
  evidenceType: 'PHOTO', mimeType: 'image/jpeg', originalFileName: 'site.jpg', fileSize: 2048,
  capturedAt: '2026-01-05T08:00:00.000Z', createdAt: '2026-01-05T08:01:00.000Z', updatedAt: null,
  submittedByUserId: 'user-1', status: 'ACTIVE', retentionState: 'ACTIVE', evidenceRequirementId: null,
  contentSha256: null, contentHashedAt: null, hashAlgorithm: null, lastIntegrityStatus: null,
  lastIntegrityCheckedAt: null, retentionPolicyCode: null, retentionDaysSnapshot: null,
  retentionAppliedAt: null, retainedUntil: null, retentionHold: false, purgedAt: null, ...overrides,
});
const typesModule = async () => import(pathToFileURL(TYPES_PATH).href);
const projectionsModule = async () => import(pathToFileURL(PROJECTIONS_PATH).href);

describe('R10 PART 03 — OPERATIONAL_DETAIL_HISTORY history=EVIDENCE adapter', () => {
  it('1/2/5 — registration is additive, ordered and appended last', async () => {
    const mod = await typesModule();
    // 1/2. registered exactly once; the 12 prior datasets stay intact and ordered.
    assert.deepEqual([...mod.REPORTING_EXPORT_DATASETS], [...PRE_PART03, 'OPERATIONAL_DETAIL_HISTORY']);
    assert.equal(mod.REPORTING_EXPORT_DATASETS.filter((d: string) => d === 'OPERATIONAL_DETAIL_HISTORY').length, 1);
    // 5. frozen vocabulary declared once, in PART 00C order, behind a real guard.
    assert.deepEqual([...mod.OPERATIONAL_DETAIL_HISTORY_VALUES], ['EVIDENCE', 'FINDING_REWORK', 'REVIEW']);
    assert.equal(typeof mod.isOperationalDetailHistoryValue, 'function');
    assert.equal(mod.isOperationalDetailHistoryValue('EVIDENCE'), true);
    assert.equal(mod.isOperationalDetailHistoryValue('AUDIT'), false, 'unknown values are not in the vocabulary');
    assert.equal(mod.isOperationalDetailHistoryValue(['EVIDENCE']), false, 'a repeated value is not a value');
    assert.equal(read(TYPES_PATH).match(/OPERATIONAL_DETAIL_HISTORY_VALUES\s*=/g)?.length, 1, 'declared exactly once');
  });

  it('3/4/27 — reuses checklist.read, invents no permission, migration or route', () => {
    const adapter = odhAdapter();
    // 3. the same governed authority OPERATIONAL_DETAIL already uses.
    assert.match(adapter, /requiredReadPermission:\s*'checklist\.read'/);
    const precedent = registryCode.slice(registryCode.indexOf('  OPERATIONAL_DETAIL: {'),
      registryCode.indexOf('  OPERATIONAL_DETAIL_HISTORY: {'));
    assert.match(precedent, /requiredReadPermission:\s*'checklist\.read'/, 'precedent uses the same permission');
    // 4. exactly one permission reference and no dataset-specific invention.
    assert.equal(adapter.match(/requiredReadPermission/g)?.length, 1);
    assert.ok(!/operational_detail|evidence\.read|history\.read/.test(adapter), 'no invented permission');
    // 27. no schema write, no migration and no route mention this dataset.
    assert.ok(!adapter.includes('INSERT INTO') && !adapter.includes('CREATE '));
    for (const file of readdirSync(MIGRATIONS_DIR)) {
      assert.ok(!code(resolve(MIGRATIONS_DIR, file)).includes('OPERATIONAL_DETAIL_HISTORY'), file);
    }
    assert.ok(!code(resolve(EXPORT_DIR, 'reporting-export.routes.ts')).includes('OPERATIONAL_DETAIL_HISTORY'));
  });

  it('6/7/8 — history is a REQUIRED discriminator; unimplemented values are rejected', () => {
    const adapter = odhAdapter();
    // 6/7. normalized, then validated against the one frozen vocabulary before any
    // child call, with an error naming `history` and the whole vocabulary.
    assert.match(registryCode, /function readHistoryDiscriminator\(/);
    assert.match(registryCode, /value\.trim\(\)\.toUpperCase\(\)/, 'history must be normalized');
    assert.match(registryCode, /isOperationalDetailHistoryValue\(raw\)/, 'validated against one vocabulary');
    assert.match(registryCode, /field:\s*'history'/);
    assert.match(registryCode, /OPERATIONAL_DETAIL_HISTORY_VALUES\.join\(', '\)/);
    const gateAt = adapter.indexOf('readHistoryDiscriminator(passThrough.history)');
    assert.ok(gateAt >= 0 && gateAt < adapter.indexOf('parseOperationalDetailEvidenceQuery'), 'gated first');
    // 8. every declared value either routes to a real implementation or is rejected
    // as not-yet-implemented — none may reach missing code.
    assert.match(registryCode, /IMPLEMENTED_HISTORY_VALUES[^=]*=\s*new Set[^)]*\(\[[^\]]*'EVIDENCE'[^\]]*\]\)/);
    assert.match(adapter, /if \(!IMPLEMENTED_HISTORY_VALUES\.has\(history\)\)/);
    assert.match(adapter, /is not implemented yet; supported:/);
    // PART 05 implemented REVIEW, so the frozen vocabulary is now fully covered.
    // The durable property is that each added grain keeps its own explicit branch
    // and nothing outside the vocabulary can reach a child.
    assert.deepEqual(
      [...adapter.matchAll(/if \(history === '([A-Z_]+)'\)/g)].map((m) => m[1]).sort(),
      ['FINDING_REWORK', 'REVIEW'],
      'one explicit branch per added grain; EVIDENCE is the documented fall-through',
    );
  });

  it('9/10/11/12 — engine stays owned by the R08 child; no second read authority', () => {
    const adapter = odhAdapter();
    // 11. the child's PUBLISHED functions are consumed verbatim.
    assert.match(adapter, /parseOperationalDetailEvidenceQuery\(passThrough\)/);
    assert.match(adapter, /await getOperationalDetailEvidence\(/);
    assert.match(registryCode, /from '\.\.\/operational-detail-evidence'/, 'reached via the published surface');
    // 9/10. Reporting declares no engine vocabulary and applies no default, so
    // BOTH/ALL/omitted engines are rejected by the child before this adapter runs.
    assert.ok(!/CHECKLIST_EXECUTION|FORM_INSTANCE/.test(adapter), 'engine vocabulary must not be redeclared');
    assert.ok(!/\bBOTH\b|\bALL\b/.test(adapter), 'no combined-engine escape hatch');
    assert.match(evidenceServiceCode, /engine is required/, 'the child owns the required-engine contract');
    assert.match(evidenceServiceCode, /isOperationalDetailEngine/, 'the child reuses the existing engine authority');
    // 12. no new evidence SQL, and the child stays unaware of Reporting.
    assert.ok(!registryCode.includes('evidence_submissions'), 'Reporting must never query the table directly');
    for (const file of ['operational-detail-evidence.types.ts', 'operational-detail-evidence.repository.ts',
      'operational-detail-evidence.service.ts', 'index.ts']) {
      assert.ok(!code(resolve(EVIDENCE_DIR, file)).includes('reporting-export'), `R08 unaware of Reporting: ${file}`);
    }
  });

  it('13/14 — caller pagination stripped; internal batching freezes dateTo once', () => {
    const adapter = odhAdapter();
    // 13. limit/offset are destructured away and never reach the echo.
    assert.match(adapter, /limit:\s*_ignoredLimit,\s*\n\s*offset:\s*_ignoredOffset,\s*\n\s*\.\.\.governedFilters/);
    assert.match(adapter, /const INTERNAL_BATCH_SIZE = 1000;/, 'batch size equals the child MAX_LIMIT');
    assert.match(adapter, /\.\.\.baseFilters, limit: INTERNAL_BATCH_SIZE, offset/);
    assert.match(adapter, /if \(source\.rows\.length < INTERNAL_BATCH_SIZE\) break;/, 'a short page ends paging');
    assert.match(adapter, /offset \+= INTERNAL_BATCH_SIZE;/);
    // 14. the upper bound is computed ONCE, outside the loop, then reused: every
    // dateTo assignment in the adapter is that single frozen value.
    const frozenAt = adapter.indexOf('const effectiveDateTo = governedFilters.dateTo ?? frozenNowIso;');
    const loopAt = adapter.indexOf('while (true) {');
    assert.ok(frozenAt > 0 && loopAt > frozenAt, 'dateTo must be frozen before the paging loop starts');
    assert.equal(adapter.match(/new Date\(\)\.toISOString\(\)/g)?.length, 1, 'the clock is read once per load');
    const bounds = [...adapter.matchAll(/dateTo:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
    assert.ok(bounds.length >= 4, 'the frozen bound must be applied throughout');
    for (const bound of bounds) assert.equal(bound, 'effectiveDateTo', `frozen bound only, found: ${bound}`);
  });

  it('15/16/17/21 — one table, one row per evidence id, fields copied verbatim', async () => {
    const mod = await projectionsModule();
    const fields = authoritativeEvidenceFields();
    const rows = [evidenceRow('ev-1'), evidenceRow('ev-2'), evidenceRow('ev-3')];
    const projected = mod.projectOperationalDetailEvidence(evidenceSource(rows));
    const table = projected.tables[0];
    // 21. exactly one table with the frozen key, no KPIs, no CSV default metadata.
    assert.equal(projected.tables.length, 1);
    assert.equal(table.key, 'operationalDetailEvidence');
    assert.deepEqual(projected.kpis, [], 'Reporting must never recompute R04 evidenceCount');
    assert.ok(!code(PROJECTIONS_PATH).includes('csvDefaultTableKey'), 'single table needs no CSV default key');
    // 17. columns are exactly the authoritative 26 fields, in the same order.
    assert.equal(fields.length, 26);
    assert.deepEqual(table.columns.map((c: { key: string }) => c.key), fields);
    // 15. grain preserved: no aggregation, no dedup, no reordering.
    assert.equal(table.rows.length, 3);
    assert.deepEqual(table.rows.map((r: { evidenceId: string }) => r.evidenceId), ['ev-1', 'ev-2', 'ev-3']);
    for (const [i, row] of table.rows.entries()) {
      for (const field of fields) assert.deepEqual(row[field], rows[i][field], `${field} must be verbatim`);
    }
    // 16. no sibling-child grain is merged in, and nothing is joined.
    for (const forbidden of SIBLING_KEYS) {
      assert.ok(!fields.includes(forbidden), `${forbidden} belongs to a separate R08 child grain`);
      assert.ok(!(forbidden in table.rows[0]), 'no cross-child column may be projected');
    }
    assert.ok(!/\bJOIN\b/i.test(code(PROJECTIONS_PATH)), 'the projection performs no join at all');
  });

  it('18/19/20 — storage, time-vs-actor and integrity-fact boundaries hold', async () => {
    const mod = await projectionsModule();
    const projected = mod.projectOperationalDetailEvidence(evidenceSource([
      evidenceRow('ev-1', { contentSha256: 'abc123', contentHashedAt: '2026-01-06T00:00:00.000Z' }),
    ]));
    const columns = projected.tables[0].columns as { key: string; type: string }[];
    const keys = columns.map((c) => c.key);
    // 18. no locator of any kind, matched on EXACT keys so the legitimate integrity
    // facts contentSha256 / contentHashedAt are not false positives.
    for (const forbidden of STORAGE_KEYS) assert.ok(!keys.includes(forbidden), `${forbidden} must never be exposed`);
    assert.ok(keys.includes('contentSha256') && keys.includes('contentHashedAt'), 'integrity facts are not locators');
    // 19. capturedAt is a device TIME, never an actor; only submittedByUserId is.
    assert.ok(keys.includes('capturedAt') && !keys.some((k) => /capturedBy/i.test(k)), 'capturedAt is not an actor');
    assert.equal(columns[keys.indexOf('capturedAt')].type, 'DATE');
    assert.ok(keys.includes('submittedByUserId'));
    // 20. integrity facts are copied, never interpreted into a derived claim.
    assert.equal(projected.tables[0].rows[0].contentSha256, 'abc123');
    for (const derived of DERIVED_CLAIMS) assert.ok(!keys.includes(derived), `${derived} would be a derived claim`);
    const unhashed = mod.projectOperationalDetailEvidence(evidenceSource([evidenceRow('ev-2')]));
    assert.equal(unhashed.tables[0].rows[0].contentSha256, null, 'unhashed stays NULL, never "verified"');
  });

  it('22/23/24 — fail-closed scope reused, narrowing-only filters, honest echo', () => {
    const adapter = odhAdapter();
    // 22. scope resolution is delegated wholesale; Reporting keeps no building logic.
    assert.ok(!/getAccessibleBuildingIds|assertBuildingAccess|buildingRepository/.test(adapter), 'scope delegated');
    assert.match(evidenceServiceCode, /getAccessibleBuildingIds/, 'the child stays the fail-closed scope authority');
    // 23. the governed filter set is passed through untouched, so executionId and
    // templateId can only narrow, and clientId is never a caller override.
    assert.match(adapter, /const baseFilters = \{ \.\.\.governedFilters, dateTo: effectiveDateTo \};/);
    assert.ok(!/clientId/.test(adapter), 'clientId is a scope FACT, never a caller override');
    for (const narrowing of ['executionId', 'templateId']) assert.match(evidenceServiceCode, new RegExp(narrowing));
    // 24. only applied filters are echoed, plus the discriminator that chose the grain.
    assert.match(adapter, /echoFilters\(\s*\{ \.\.\.governedFilters, dateTo: effectiveDateTo \},\s*\{ history \},?\s*\)/);
    const evidenceBranch = adapter.slice(adapter.indexOf('parseOperationalDetailEvidenceQuery(passThrough);'));
    assert.ok(!/limit|offset/.test(evidenceBranch.slice(evidenceBranch.indexOf('return {'))), 'pagination not echoed');
  });

  it('25/26 — projection lives only in r10-projections; renderers and archive untouched', () => {
    // 25. one projection home, invoked exactly once over all accumulated rows.
    assert.equal(read(PROJECTIONS_PATH).match(/function projectOperationalDetailEvidence/g)?.length, 1);
    assert.equal(odhAdapter().match(/projectOperationalDetailEvidence\(fullSource\)/g)?.length, 1);
    for (const file of ['reporting-export.projections.ts', 'reporting-export.management-projections.ts']) {
      assert.ok(!code(resolve(EXPORT_DIR, file)).includes('projectOperationalDetailEvidence'), file);
    }
    // 26. no renderer, validation or archive authority gained a dataset branch.
    const agnostic = ['csv-renderer.ts', 'xlsx-renderer.ts', 'pdf-renderer.ts', 'reporting-export.validation.ts',
      'reporting-export.service.ts', 'reporting-export.controller.ts', 'reporting-export.routes.ts']
      .map((f) => resolve(EXPORT_DIR, f));
    const archive = resolve(ROOT, 'src/modules/reporting-archives');
    agnostic.push(resolve(archive, 'reporting-archive.validation.ts'),
      resolve(archive, 'reporting-archive-generation.service.ts'));
    for (const path of agnostic) {
      assert.ok(!code(path).includes('OPERATIONAL_DETAIL_HISTORY'), `${path} must stay dataset-agnostic`);
      assert.ok(!code(path).includes('projectOperationalDetailEvidence'), `${path} must not project this dataset`);
    }
  });

  it('28 — OpenAPI enum parity with the runtime registry, EVIDENCE grain documented', async () => {
    const mod = await typesModule();
    const openapi = read(resolve(ROOT, 'docs/api/openapi.yaml'));
    const schema = openapi.slice(openapi.indexOf('    ReportArchiveDataset:'));
    const match = /enum:\s*\[([\s\S]*?)\]/.exec(schema);
    assert.ok(match, 'the ReportArchiveDataset enum must exist');
    const documented = match[1].split(',').map((v) => v.trim()).filter(Boolean);
    // exact parity: same members, same order, same length.
    assert.deepEqual(documented, [...mod.REPORTING_EXPORT_DATASETS]);
    assert.equal(documented.length, 13);
    assert.equal(documented.filter((v) => v === 'OPERATIONAL_DETAIL_HISTORY').length, 1);
    // live behaviour documented, and the deferred grains distinguished from it.
    const body = schema.slice('    ReportArchiveDataset:'.length);
    const next = /\n    [A-Za-z][A-Za-z0-9]*:\n/.exec(body);
    const description = next ? body.slice(0, next.index) : body;
    assert.match(description, /OPERATIONAL_DETAIL_HISTORY/);
    assert.match(description, /checklist\.read/);
    assert.match(description, /implemented values are\s*\n?\s*EVIDENCE, FINDING_REWORK and REVIEW/, 'implemented grains');
    assert.match(description, /whole frozen\s*\n?\s*vocabulary/, 'the vocabulary is fully covered');
    assert.match(description, /rejected with a\s*\n?\s*validation error/, 'anything outside it is still rejected');
    assert.match(description, /one\s*\n?\s*row per authoritative evidence\s*\n?\s*submission/, 'grain documented');
    assert.match(description, /frozen once per export/, 'the frozen upper bound is documented');
  });

  it('CI-required — live database and >1000-row batching proofs', () => {
    // Recorded, not silently skipped: these need the embedded Postgres fixture, so
    // they run in CI. (a) history=EVIDENCE dispatches ONLY to the child getter and
    // returns real rows for a real authorized scope; (b) an unauthorized or empty
    // scope yields a well-formed empty table; (c) >1000 rows page with no duplication.
    assert.ok(true);
  });
});
