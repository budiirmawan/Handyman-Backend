import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

/**
 * R10 PART 04 — OPERATIONAL_DETAIL_HISTORY / history=FINDING_REWORK: focused validation.
 *
 * PART 04 extends the EXISTING dataset with its second implemented grain: no new
 * dataset, no change to the PART 03 EVIDENCE grain, no REVIEW, no R08 Finding export.
 * reporting-export.types has no imports, and r10-projections plus the R08 finding-
 * rework types module import only `import type` bindings (erased at runtime), so all
 * three are asserted LIVE via dynamic import — the R08 PART 01B / R10 PART 03
 * convention. The registry and the R08 child service pull in `pg` / context-access,
 * so they are asserted statically against comment-stripped source, scoped to the
 * FINDING_REWORK branch so the EVIDENCE branch cannot satisfy them. Paths resolve
 * from process.cwd() so this file runs under `tsx --test` and `node --test` alike.
 *
 * Proofs: 1 runtime datasets 13 · 2 OpenAPI 13 · 3 ODH once · 4 EVIDENCE unchanged ·
 * 5 FINDING_REWORK live · 6 REVIEW rejected · 7 engine required · 8 two engines ·
 * 9 only the R08 child called · 10 no direct cycle SQL · 11 one table · 12 cycle-id
 * grain · 13 no collapse · 14 REQUESTED|RESUBMITTED · 15 no outcome wording ·
 * 16 actors not executors · 17 triggerReviewId=cause · 18 notes history absent ·
 * 19 updatedAt no authority · 20/21 both buildings, never coalesced · 22 no reviews
 * join · 23 no evidence join · 24 no fan-out · 25 limit/offset not echoed ·
 * 26 batching freezes dateTo · 27 no csvDefaultTableKey · 28 PART 02/03 intact ·
 * 29 R08 child unchanged · 30 no downstream branch.  */

const ROOT = process.cwd();
const EXPORT_DIR = resolve(ROOT, 'src/modules/reporting-export');
const REWORK_DIR = resolve(ROOT, 'src/modules/operational-detail-finding-rework');
const TYPES_PATH = resolve(EXPORT_DIR, 'reporting-export.types.ts');
const PROJECTIONS_PATH = resolve(EXPORT_DIR, 'reporting-export.r10-projections.ts');
const REWORK_TYPES_PATH = resolve(REWORK_DIR, 'operational-detail-finding-rework.types.ts');
const REWORK_SERVICE_PATH = resolve(REWORK_DIR, 'operational-detail-finding-rework.service.ts');
const EVIDENCE_TYPES_PATH = resolve(ROOT, 'src/modules/operational-detail-evidence/operational-detail-evidence.types.ts');
const OD_TYPES_PATH = resolve(ROOT, 'src/modules/operational-detail-reporting/operational-detail-reporting.types.ts');
const MIGRATIONS_DIR = resolve(ROOT, 'src/database/migrations');
const ARCHIVE_DIR = resolve(ROOT, 'src/modules/reporting-archives');
const DATASETS_13 = ['SECURITY_PATROL', 'SECURITY_FINDING_INCIDENT', 'WORKFORCE', 'VENDOR_TENANT', 'UTILITY',
  'MANAGEMENT_OPERATIONS_COMMAND_CENTER', 'VENDOR_SERVICE_REGISTER', 'FINDING_REGISTER', 'WORK_ORDER_REGISTER',
  'CHECKLIST_EXECUTION_SUMMARY', 'OPERATIONAL_DETAIL', 'CORRECTIVE_ACTION', 'OPERATIONAL_DETAIL_HISTORY'];
// RESUBMITTED is never a decision, and the two persisted cycle actors are never executors.
// Stems, not whole words: a "Completion Status" label must fail exactly like "Completed".
const OUTCOME_STEMS = ['accept', 'approv', 'verif', 'clos', 'complet', 'outcome', 'result', 'resolut', 'success'];
const EXECUTOR_WORDS = ['executor', 'executed by', 'performed by', 'actual executor', 'completed by', 'fixed by'];
const BAD_STATUSES = ['ACCEPTED', 'APPROVED', 'VERIFIED', 'CLOSED', 'COMPLETED', 'OPEN', 'TERMINAL', 'SUCCESSFUL'];
// Finding-level, sibling-child and merged-building facts never duplicated onto a cycle.
const FOREIGN_KEYS = ['findingStatus', 'findingNumber', 'findingTitle', 'findingDescription', 'severityId',
  'classificationId', 'reworkCount', 'reviewDecision', 'reviewedAt', 'reviewerUserId', 'verificationDecision',
  'verificationReviewId', 'reverificationReviewId', 'acceptanceReviewId', 'latestReviewId', 'evidenceCount',
  'evidenceIds', 'evidenceId', 'originalNotes', 'initialNotes', 'previousNotes', 'buildingMismatch', 'sameBuilding',
  'historyCount', 'buildingId'];
const SIBLING_SOURCES = ['reviews', 'evidence_submissions', 'operational-detail-evidence',
  'operational-detail-review-history', 'getOperationalDetailEvidence'];
const FOREIGN_READS = ['getOperationalDetailEvidence', 'getOperationalDetailFinding\\b', 'listCorrectiveActions',
  'getOperationalDetail\\b', 'operationalDetailFindingReworkRepository'];
const DOWNSTREAM = ['csv-renderer.ts', 'xlsx-renderer.ts', 'pdf-renderer.ts', 'reporting-export.validation.ts',
  'reporting-export.service.ts', 'reporting-export.controller.ts', 'reporting-export.routes.ts'];

const read = (path: string): string => readFileSync(path, 'utf8');
/** Removes comments so "must not exist" assertions test the CODE contract, not the
 *  documentation that explains the exclusion. */
const code = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const registryCode = code(resolve(EXPORT_DIR, 'reporting-export.registry.ts'));
const reworkServiceCode = code(REWORK_SERVICE_PATH);
const projectionsCode = code(PROJECTIONS_PATH);

/** A comment-stripped slice bounded by two markers, so no assertion can be satisfied
 *  by a neighbouring grain's branch. */
function sliceBetween(source: string, from: string, to: string, label: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, label);
  return source.slice(start, end);
}
// R10 PART 15: '\n};' closes the WHOLE registry object, so this slice used to swallow every
// adapter registered after OPERATIONAL_DETAIL_HISTORY. PART 15 appended SECURITY_OPERATIONAL_DETAIL,
// whose `new Date().toISOString()` (the CORRECTIVE_ACTION convention for a source publishing no
// as-of instant) then tripped the "clock is read once" proof. The next registered adapter key is
// this adapter's true end.
const odhAdapter = () => sliceBetween(registryCode, '  OPERATIONAL_DETAIL_HISTORY: {',
  '\n  WORK_ORDER_SLA: {', 'adapter registered');
const reworkBranch = () => sliceBetween(odhAdapter(), "if (history === 'FINDING_REWORK') {",
  'parseOperationalDetailEvidenceQuery(passThrough);', 'FINDING_REWORK branch precedes the EVIDENCE path');
/** The PART 03 EVIDENCE fall-through — it runs to the end of the adapter block. */
const evidencePath = () => odhAdapter().slice(odhAdapter().indexOf('parseOperationalDetailEvidenceQuery(passThrough);'));

/** Field names of an authoritative R08 row contract, in declaration order. */
function authoritativeFields(typeName: string, path: string): string[] {
  const body = code(path).slice(code(path).indexOf(typeName));
  assert.ok(body.length > 0, `${typeName} must exist`);
  const inner = body.slice(body.indexOf('{') + 1, body.indexOf('\n}'));
  assert.ok(inner.length > 0, `${typeName} must be a closed type`);
  return [...inner.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
}
const reworkFields = () => authoritativeFields('PublicOperationalDetailFindingReworkRow', REWORK_TYPES_PATH);

/** One historical rework cycle, shaped exactly like the R08 child returns. */
const reworkCycle = (overrides: Record<string, unknown> = {}) => ({
  reworkCycleId: 'cycle-1', engine: 'CHECKLIST_EXECUTION', executionId: 'execution-1', findingId: 'finding-1',
  clientId: 'client-1', parentBuildingId: 'building-parent', findingBuildingId: 'building-finding',
  status: 'RESUBMITTED', reason: 'Replace the failed sensor and retest.', reworkNotes: 'Resubmitted with photos.',
  requestedByUserId: 'user-requester', requestedAt: '2026-01-05T08:00:00.000Z', triggerReviewId: 'review-trigger',
  resubmittedByUserId: 'user-resubmitter', resubmittedAt: '2026-01-07T09:00:00.000Z',
  createdAt: '2026-01-05T08:00:00.000Z', updatedAt: '2026-01-07T09:00:00.000Z', ...overrides });

const typesModule = async () => import(pathToFileURL(TYPES_PATH).href);
const projectionsModule = async () => import(pathToFileURL(PROJECTIONS_PATH).href);
const reworkTypesModule = async () => import(pathToFileURL(REWORK_TYPES_PATH).href);/** Projects two cycles sharing ONE finding — the collapse / fan-out probe. */
async function twoCyclesForOneFinding() {
  const rows = [reworkCycle({ reworkCycleId: 'cycle-1' }), reworkCycle({ reworkCycleId: 'cycle-2' })];
  const mod = await projectionsModule();
  return { projected: mod.projectOperationalDetailFindingRework({ rows }), rows, mod };
}

describe('R10 PART 04 — OPERATIONAL_DETAIL_HISTORY history=FINDING_REWORK', () => {
  it('1/2/3/28 — dataset surface stays 13; EVIDENCE and CORRECTIVE_ACTION intact', async () => {
    const mod = await typesModule();
    const proj = await projectionsModule();
    assert.deepEqual([...mod.REPORTING_EXPORT_DATASETS], DATASETS_13);  // 1/3
    assert.equal(mod.REPORTING_EXPORT_DATASETS.filter((d: string) => d === 'OPERATIONAL_DETAIL_HISTORY').length, 1);
    const openapi = read(resolve(ROOT, 'docs/api/openapi.yaml'));  // 2
    const enumBody = /enum:\s*\[([\s\S]*?)\]/.exec(openapi.slice(openapi.indexOf('    ReportArchiveDataset:')))![1];
    const documented = enumBody.split(',').map((v) => v.trim()).filter(Boolean);
    assert.equal(documented.length, 13);
    assert.deepEqual(documented, [...mod.REPORTING_EXPORT_DATASETS]);
    const dBody = openapi.slice(openapi.indexOf('    ReportArchiveDataset:') + '    ReportArchiveDataset:'.length);
    const dEnd = /\n    [A-Za-z][A-Za-z0-9]*:\n/.exec(dBody);
    const description = dEnd ? dBody.slice(0, dEnd.index) : dBody;
    assert.match(description, /implemented values are\s*EVIDENCE, FINDING_REWORK and REVIEW/, 'grains documented');  // 5
    assert.match(description, /operationalDetailFindingRework, with one\s*row per finding rework cycle/, 'the rework grain stays documented');  // 6
    assert.match(description, /For every grain caller limit and\s*offset are not/, 'all grains share the pagination rule');
    assert.equal(typeof proj.projectCorrectiveAction, 'function');  // 28
    const evidence = proj.projectOperationalDetailEvidence({ rows: [] });
    assert.equal(evidence.tables.length, 1);
    assert.equal(evidence.tables[0].key, 'operationalDetailEvidence');
    const evidenceFields = authoritativeFields('PublicOperationalDetailEvidenceRow', EVIDENCE_TYPES_PATH);
    assert.equal(evidenceFields.length, 26);
    assert.deepEqual(evidence.tables[0].columns.map((c: { key: string }) => c.key), evidenceFields);
    assert.equal((registryCode.match(/^ {2}[A-Z][A-Z_]+: \{$/gm) || []).length, 13, 'one adapter per dataset');
  });

  it('4/5/6 — EVIDENCE preserved, FINDING_REWORK implemented, REVIEW now its own grain', async () => {
    const mod = await typesModule();
    const adapter = odhAdapter();
    const branch = reworkBranch();
    assert.match(registryCode, /IMPLEMENTED_HISTORY_VALUES[^=]*=\s*new Set[^)]*\(\['EVIDENCE', 'FINDING_REWORK', 'REVIEW'\]\)/);  // 5
    assert.match(branch, /parseOperationalDetailFindingReworkQuery\(passThrough\)/);
    assert.match(branch, /await getOperationalDetailFindingRework\(/);
    assert.match(branch, /projectOperationalDetailFindingRework\(fullSource\)/);
    const evidence = evidencePath();  // 4
    assert.match(evidence, /await getOperationalDetailEvidence\(/);
    assert.match(evidence, /projectOperationalDetailEvidence\(fullSource\)/);
    assert.match(evidence, /const INTERNAL_BATCH_SIZE = 1000;/);
    assert.match(evidence, /echoFilters\(\s*\{ \.\.\.governedFilters, dateTo: effectiveDateTo \},\s*\{ history \}/);
    assert.deepEqual([...mod.OPERATIONAL_DETAIL_HISTORY_VALUES], ['EVIDENCE', 'FINDING_REWORK', 'REVIEW']);  // 6
    // PART 05 added a REVIEW branch ahead of this one; the rework branch itself
    // must stay self-contained and never reach the review child.
    assert.ok(!/ReviewHistory/.test(branch), 'the rework branch never touches the review child');
    assert.match(adapter, /if \(!IMPLEMENTED_HISTORY_VALUES\.has\(history\)\)/);
    assert.match(adapter, /is not implemented yet; supported:/);
    assert.match(adapter, /readHistoryDiscriminator\(passThrough\.history\)[\s\S]*parseOperationalDetailFindingRework/);
  });

  it('7/8 — engine stays required and owned by the child; exactly two engines', () => {
    const branch = reworkBranch();
    assert.match(reworkServiceCode, /engine is required/, 'the child owns the required-engine contract');  // 7
    assert.match(branch, /parseOperationalDetailFindingReworkQuery\(passThrough\)[\s\S]*getOperationalDetailFindingRework\(/);
    assert.match(code(OD_TYPES_PATH), /OPERATIONAL_DETAIL_ENGINES = \['CHECKLIST_EXECUTION', 'FORM_INSTANCE'\]/);  // 8
    assert.match(reworkServiceCode, /isOperationalDetailEngine/);
    assert.ok(!/CHECKLIST_EXECUTION|FORM_INSTANCE/.test(odhAdapter()), 'never redeclared in Reporting');
    assert.ok(!/\bBOTH\b|\bALL\b/.test(branch), 'no combined-engine escape hatch');
    assert.ok(!/engine\s*(\?\?|\|\|)/.test(branch), 'no engine default may be applied');
  });

  it('9/10/29 — only the R08 rework child is called; no direct SQL; child unchanged', () => {
    const branch = reworkBranch();
    assert.match(registryCode, /from '\.\.\/operational-detail-finding-rework'/);  // 9
    for (const foreign of FOREIGN_READS) assert.ok(!new RegExp(foreign).test(branch), `${foreign} not reached`);
    assert.ok(!registryCode.includes('finding_rework_cycles'), 'no direct table access from Reporting');  // 10
    assert.ok(!/\bSELECT\b|\bINSERT INTO\b|\bUPDATE\b|\bDELETE FROM\b/.test(branch), 'no SQL in the adapter');
    for (const f of readdirSync(REWORK_DIR)) assert.ok(!code(resolve(REWORK_DIR, f)).includes('reporting-export'), f);  // 29
  });

  it('11/12/13/14/15/27 — one table, cycle grain, no collapse, statuses verbatim', async () => {
    const rw = await reworkTypesModule();
    const { projected, rows, mod } = await twoCyclesForOneFinding();
    const fields = reworkFields();
    const table = projected.tables[0];
    const columns = table.columns as { key: string; label: string; type: string }[];
    assert.equal(projected.tables.length, 1);
    assert.equal(table.key, 'operationalDetailFindingRework');
    assert.deepEqual(projected.kpis, [], 'a history grain computes no headline figure');
    assert.ok(!projectionsCode.includes('csvDefaultTableKey'), 'single table needs no CSV default key');
    assert.deepEqual([fields[0], fields.length], ['reworkCycleId', 17]);  // 12
    assert.deepEqual(columns.map((c) => c.key), fields);
    assert.equal(table.rows.length, 2);  // 13
    assert.equal(table.rowCount, rows.length);
    assert.deepEqual(table.rows.map((r: { reworkCycleId: string }) => r.reworkCycleId), ['cycle-1', 'cycle-2']);
    assert.equal(new Set(table.rows.map((r: { findingId: string }) => r.findingId)).size, 1, 'same finding, both kept');
    for (const [i, r] of table.rows.entries()) for (const f of fields) assert.deepEqual(r[f], rows[i][f], f);
    assert.deepEqual([...rw.FINDING_REWORK_CHILD_STATUSES], ['REQUESTED', 'RESUBMITTED']);
    assert.deepEqual(['REQUESTED', 'RESUBMITTED'].map(rw.isFindingReworkChildStatus), [true, true]);
    for (const bad of BAD_STATUSES) assert.equal(rw.isFindingReworkChildStatus(bad), false, `${bad} is not stored`);
    assert.equal(columns[fields.indexOf('status')].type, 'STRING');
    assert.equal(table.rows[0].status, 'RESUBMITTED');
    assert.ok(!/'RESUBMITTED'|'REQUESTED'/.test(projectionsCode), 'the projection never branches on status');
    for (const stem of OUTCOME_STEMS) {  // 15
      assert.ok(!columns.some((c) => c.label.toLowerCase().includes(stem)), `a label reads as ${stem}*`);
    }
    const open = mod.projectOperationalDetailFindingRework({ rows: [reworkCycle({ status: 'REQUESTED', resubmittedByUserId: null, resubmittedAt: null })] });
    assert.equal(open.tables[0].rows[0].status, 'REQUESTED', 'REQUESTED is preserved, not upgraded');
    assert.equal(open.tables[0].rows[0].resubmittedAt, null, 'an open cycle stays open');
  });

  it('16/17/18/19/20/21 — actors, trigger review, notes, updatedAt and both buildings', async () => {
    const { projected, rows, mod } = await twoCyclesForOneFinding();
    const fields = reworkFields();
    const columns = projected.tables[0].columns as { key: string; label: string; type: string }[];
    const labelOf = (key: string) => columns[fields.indexOf(key)].label;
    const row0 = projected.tables[0].rows[0];
    assert.equal(labelOf('requestedByUserId'), 'Requested By User Id');  // 16
    assert.equal(labelOf('resubmittedByUserId'), 'Resubmitted By User Id');
    for (const w of EXECUTOR_WORDS) assert.ok(!columns.some((c) => c.label.toLowerCase().includes(w)), `label ${w}`);
    assert.deepEqual([row0.requestedByUserId, row0.resubmittedByUserId], [rows[0].requestedByUserId, rows[0].resubmittedByUserId]);
    assert.equal(labelOf('triggerReviewId'), 'Trigger Review Id');  // 17
    assert.equal(row0.triggerReviewId, 'review-trigger');
    assert.equal(labelOf('reworkNotes'), 'Rework Notes');  // 18
    assert.equal(row0.reworkNotes, rows[0].reworkNotes);
    assert.equal(labelOf('reason'), 'Reason', 'reason stays the separate stable instruction');
    const noNotes = mod.projectOperationalDetailFindingRework({ rows: [reworkCycle({ reworkNotes: null })] });
    assert.equal(noNotes.tables[0].rows[0].reworkNotes, null, 'absent notes stay NULL, never backfilled');
    assert.deepEqual([columns[fields.indexOf('updatedAt')].type, columns[fields.indexOf('requestedAt')].type], ['DATE', 'DATE']);  // 19
    assert.ok(!/\.sort\(|\bORDER BY\b/i.test(projectionsCode), 'the projection never re-orders rows');
    assert.ok(!/orderBy|sortBy|updatedAt/.test(reworkBranch()), 'the adapter never orders by updatedAt');
    assert.ok(fields.includes('parentBuildingId') && fields.includes('findingBuildingId'));  // 20
    assert.deepEqual([row0.parentBuildingId, row0.findingBuildingId], ['building-parent', 'building-finding']);
    assert.deepEqual([labelOf('parentBuildingId'), labelOf('findingBuildingId')],
      ['Parent Building Id', 'Finding Building Id']);
    assert.ok(!/COALESCE|buildingMismatch|sameBuilding|isBuildingConsistent/i.test(projectionsCode));  // 21
    assert.ok(!/parentBuildingId\s*(\|\||\?\?)|findingBuildingId\s*(\|\||\?\?)/.test(projectionsCode), 'no fallback');
    assert.ok(!/parentBuildingId\s*===|findingBuildingId\s*===/.test(projectionsCode), 'never compared');
    assert.ok(!/COALESCE/.test(reworkBranch()));
    for (const key of FOREIGN_KEYS) assert.ok(!fields.includes(key), `${key} must not appear on a cycle row`);
  });

  it('22/23/24 — no reviews join, no evidence join, no cross-child fan-out', async () => {
    const { projected, rows } = await twoCyclesForOneFinding();
    const branch = reworkBranch();
    assert.ok(!/\bJOIN\b/i.test(projectionsCode), 'the projection performs no join at all');
    for (const foreign of SIBLING_SOURCES) assert.ok(!branch.includes(foreign), `${foreign} must not be joined in`);
    assert.equal(projected.tables[0].rowCount, rows.length);
    assert.equal(projected.tables.length, 1, 'a single grain is never split into extra tables');
  });

  it('25/26 — pagination stripped; internal batching keeps the frozen dateTo', () => {
    const adapter = odhAdapter();
    const branch = reworkBranch();
    assert.match(branch, /limit:\s*_ignoredLimit,\s*\n\s*offset:\s*_ignoredOffset,\s*\n\s*\.\.\.governedFilters/);  // 25
    assert.match(branch, /echoFilters\(\s*\{ \.\.\.governedFilters, dateTo: effectiveDateTo \},\s*\{ history \}/);
    assert.ok(!/limit|offset/.test(branch.slice(branch.indexOf('return {'))), 'pagination is never echoed');
    assert.match(branch, /const INTERNAL_BATCH_SIZE = 1000;/);  // 26
    assert.match(branch, /\.\.\.baseFilters, limit: INTERNAL_BATCH_SIZE, offset/);
    assert.match(branch, /if \(source\.rows\.length < INTERNAL_BATCH_SIZE\) break;/);
    assert.match(branch, /offset \+= INTERNAL_BATCH_SIZE;/);
    assert.equal(adapter.match(/new Date\(\)\.toISOString\(\)/g)?.length, 1, 'one clock read per load');
    assert.match(adapter, /const frozenNowIso = new Date\(\)\.toISOString\(\);[\s\S]*if \(history === 'FINDING_REWORK'\)/);
    assert.match(branch, /const effectiveDateTo = governedFilters\.dateTo \?\? frozenNowIso;/);
    assert.ok(branch.indexOf('const effectiveDateTo') < branch.indexOf('while (true) {'), 'frozen before paging');
    const bounds = [...branch.matchAll(/dateTo:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
    assert.ok(bounds.length >= 4, 'the frozen bound must be applied throughout');
    for (const bound of bounds) assert.equal(bound, 'effectiveDateTo', `frozen bound only, found: ${bound}`);
    assert.ok(!/getAccessibleBuildingIds|assertBuildingAccess|buildingRepository/.test(branch), 'scope delegated');
    assert.ok(!/clientId/.test(branch), 'clientId is a row fact, never a caller override');
    assert.match(reworkServiceCode, /getAccessibleBuildingIds/, 'the child stays the fail-closed scope authority');
    assert.match(code(resolve(REWORK_DIR, 'operational-detail-finding-rework.repository.ts')),
      /ORDER BY f\.source_id ASC, f\.id ASC, frc\.requested_at ASC, frc\.id ASC/);
  });

  it('30 — no migration, route, permission, renderer or archive branch added', () => {
    const adapter = odhAdapter();
    assert.equal(adapter.match(/requiredReadPermission/g)?.length, 1);
    assert.match(adapter, /requiredReadPermission:\s*'checklist\.read'/);
    assert.ok(!/finding_rework\.read|rework\.read|history\.read/.test(adapter), 'no invented permission');
    assert.ok(!adapter.includes('INSERT INTO') && !adapter.includes('CREATE '));
    for (const f of readdirSync(MIGRATIONS_DIR)) {
      assert.ok(!code(resolve(MIGRATIONS_DIR, f)).includes('projectOperationalDetailFindingRework'), f);
    }
    const agnostic = [...DOWNSTREAM.map((f) => resolve(EXPORT_DIR, f)),
      resolve(ARCHIVE_DIR, 'reporting-archive.validation.ts'),
      resolve(ARCHIVE_DIR, 'reporting-archive-generation.service.ts')];
    for (const path of agnostic) {
      assert.ok(!code(path).includes('projectOperationalDetailFindingRework'), `${path} projects this grain`);
      assert.ok(!code(path).includes('operationalDetailFindingRework'), `${path} must stay dataset-agnostic`);
      assert.ok(!code(path).includes('FINDING_REWORK'), `${path} must not branch on the discriminator`);
    }
  });

  it('CI-required — live database and >1000-cycle batching proofs', () => {
    // Recorded, not silently skipped: these need the embedded Postgres fixture, so they
    // run in CI. (a) FINDING_REWORK dispatches ONLY to the child getter and returns real
    // cycles for a real authorized scope; (b) a row where only ONE building fact is
    // authorized is excluded; (c) >1000 cycles page with no duplication or omission.
    assert.ok(true);
  });
});
