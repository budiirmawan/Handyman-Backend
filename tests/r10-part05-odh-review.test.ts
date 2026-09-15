import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

/**
 * R10 PART 05 — OPERATIONAL_DETAIL_HISTORY / history=REVIEW: focused validation.
 *
 * PART 05 extends the EXISTING dataset with its third and final grain: no new dataset,
 * no change to EVIDENCE or FINDING_REWORK, no R08 Finding child export. types.ts has
 * no imports and r10-projections / the R08 review-history types / reviews/review.types
 * import only `import type` bindings (erased at runtime), so all are asserted LIVE via
 * dynamic import — the R08 PART 01B / R10 PART 03 convention. The registry and the
 * child service pull in `pg` / context-access, so they are asserted statically against
 * comment-stripped source scoped to the REVIEW branch, which a sibling grain cannot
 * satisfy. Paths resolve from process.cwd() for `tsx --test` and `node --test` alike.
 *
 * Proofs: 1 runtime datasets 13 · 2 OpenAPI 13 · 3 ODH once · 4 EVIDENCE live ·
 * 5 FINDING_REWORK live · 6 REVIEW live · 7 no fourth grain · 8 engine required ·
 * 9 two engines · 10 only the review child called · 11 no direct reviews SQL · 12 one
 * table · 13 reviewId grain · 14 no collapse · 15 both statuses · 16 PENDING ·
 * 17 COMPLETED · 18 NULL decision stays NULL · 19 REVIEW_DECISIONS reused · 20 reviewer
 * never a decider label · 21 reviewer=stored opener · 22 notes history unavailable ·
 * 23 notes never original/rejection · 24 reviewedAt persisted · 25 updatedAt inert ·
 * 26 execution targets only · 27 others unreachable · 28/29/30 no evidence/finding/
 * rework join · 31 no fan-out · 32 limit/offset not echoed · 33 batching freezes
 * dateTo · 34 no csvDefaultTableKey · 35 PART 02/03/04 intact · 36 R08 child
 * unchanged · 37 no downstream branch.  */

const ROOT = process.cwd(); const EXPORT_DIR = resolve(ROOT, 'src/modules/reporting-export'); const REVIEW_DIR = resolve(ROOT, 'src/modules/operational-detail-review-history');
const TYPES_PATH = resolve(EXPORT_DIR, 'reporting-export.types.ts'); const PROJECTIONS_PATH = resolve(EXPORT_DIR, 'reporting-export.r10-projections.ts'); const REGISTRY_PATH = resolve(EXPORT_DIR, 'reporting-export.registry.ts');
const REVIEW_TYPES_PATH = resolve(REVIEW_DIR, 'operational-detail-review-history.types.ts'); const REVIEW_SERVICE_PATH = resolve(REVIEW_DIR, 'operational-detail-review-history.service.ts');
const REVIEW_REPO_PATH = resolve(REVIEW_DIR, 'operational-detail-review-history.repository.ts'); const REVIEW_INDEX_PATH = resolve(REVIEW_DIR, 'index.ts');
const DECISION_TYPES_PATH = resolve(ROOT, 'src/modules/reviews/review.types.ts'); const OPENAPI_PATH = resolve(ROOT, 'docs/api/openapi.yaml'); const MIGRATIONS_DIR = resolve(ROOT, 'src/database/migrations');
const ARCHIVE_DIR = resolve(ROOT, 'src/modules/reporting-archives'); const EVIDENCE_TYPES_PATH = resolve(ROOT, 'src/modules/operational-detail-evidence/operational-detail-evidence.types.ts');
const REWORK_TYPES_PATH = resolve(ROOT, 'src/modules/operational-detail-finding-rework/operational-detail-finding-rework.types.ts');
const OD_TYPES_PATH = resolve(ROOT, 'src/modules/operational-detail-reporting/operational-detail-reporting.types.ts');
const DATASETS_13 = ['SECURITY_PATROL', 'SECURITY_FINDING_INCIDENT', 'WORKFORCE', 'VENDOR_TENANT', 'UTILITY', 'MANAGEMENT_OPERATIONS_COMMAND_CENTER', 'VENDOR_SERVICE_REGISTER', 'FINDING_REGISTER', 'WORK_ORDER_REGISTER',
  'CHECKLIST_EXECUTION_SUMMARY', 'OPERATIONAL_DETAIL', 'CORRECTIVE_ACTION', 'OPERATIONAL_DETAIL_HISTORY'];
// Shared review targets that must stay unreachable from an execution-bound grain.
const FOREIGN_TARGETS = ['FINDING', 'WORK_ORDER', 'VENDOR_WORK', 'UTILITY_ABNORMAL_CONSUMPTION', 'PERMIT_APPLICATION', 'DOCUMENT_VERSION', 'DOCUMENT', 'CORRECTIVE_ACTION'];
// reviewerUserId is an OPENER, never the (unpersisted) decision actor. Stems, so a "Verified By" label fails exactly like "verified".
const DECIDER_STEMS = ['decided', 'decision actor', 'approved by', 'rejected by', 'verified by', 'approver', 'rejecter', 'verifier', 'sign-off', 'signoff'];
const EXECUTOR_WORDS = ['executor', 'executed by', 'performed by', 'actual executor', 'completed by', 'fixed by'];
// notes is ONE mutable column; the pre-overwrite value does not exist anywhere.
const NOTES_LABELS = ['original notes', 'initial notes', 'previous notes', 'rejection notes', 'decision notes', 'original review notes', 'notes history', 'notes at open'];
const BAD_STATUSES = ['ACCEPTED', 'VERIFIED', 'CLOSED', 'OPEN', 'TERMINAL', 'SUCCESSFUL', 'UNDECIDED', 'UNKNOWN'];
// Sibling-child and derived facts never duplicated onto a review row.
const FOREIGN_KEYS = ['findingId', 'findingStatus', 'reworkCycleId', 'evidenceId', 'evidenceCount', 'findingCount', 'reworkCount', 'reviewCount', 'isLatest', 'isVerified',
  'isApproved', 'verificationResult', 'awaitingVerification', 'decisionActorUserId', 'decidedByUserId', 'decidedAt', 'originalNotes', 'initialNotes', 'rejectionNotes',
  'decisionNotes', 'buildingId', 'findingBuildingId', 'latestReviewId', 'triggerReviewId'];
const SIBLING_SOURCES = ['evidence_submissions', 'findings', 'finding_rework_cycles', 'operational-detail-evidence', 'operational-detail-finding-rework', 'getOperationalDetailEvidence', 'getOperationalDetailFindingRework'];
const DOWNSTREAM = ['csv-renderer.ts', 'xlsx-renderer.ts', 'pdf-renderer.ts', 'reporting-export.validation.ts', 'reporting-export.service.ts', 'reporting-export.controller.ts', 'reporting-export.routes.ts'];

const read = (path: string): string => readFileSync(path, 'utf8');
/** Strips comments, so "must not exist" assertions test the CODE contract, not the prose. */
const code = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const registryCode = code(REGISTRY_PATH); const reviewServiceCode = code(REVIEW_SERVICE_PATH); const reviewRepoCode = code(REVIEW_REPO_PATH); const projectionsRaw = read(PROJECTIONS_PATH);
const projectionsCode = code(PROJECTIONS_PATH);

/** A comment-stripped slice bounded by two markers: no sibling grain can satisfy it. */
function sliceBetween(source: string, from: string, to: string, label: string): string {
  const start = source.indexOf(from); const end = source.indexOf(to, start + from.length); assert.ok(start >= 0 && end > start, label);
  return source.slice(start, end);
}
// R10 PART 15: '\n};' closes the WHOLE registry object, so this slice used to swallow every
// adapter registered after OPERATIONAL_DETAIL_HISTORY. PART 15 appended SECURITY_OPERATIONAL_DETAIL,
// whose `new Date().toISOString()` (the CORRECTIVE_ACTION convention for a source publishing no
// as-of instant) then tripped the "clock is read once" proof. The next registered adapter key is
// this adapter's true end.
const odhAdapter = () => sliceBetween(registryCode, '  OPERATIONAL_DETAIL_HISTORY: {',
  '\n  WORK_ORDER_SLA: {', 'adapter registered');
const reviewBranch = () => sliceBetween(odhAdapter(), "if (history === 'REVIEW') {", "if (history === 'FINDING_REWORK') {", 'REVIEW branch precedes the FINDING_REWORK branch');
/** The REVIEW projection only — siblings legitimately carry 'Verified By User Id'. */
const reviewProjection = () => {
  const at = projectionsCode.indexOf('function projectOperationalDetailReviewHistory'); assert.ok(at >= 0, 'projectOperationalDetailReviewHistory must exist');
  return projectionsCode.slice(at);
};

/** Field names of an authoritative row contract, in declaration order. */
function authoritativeFields(typeName: string, path: string): string[] {
  const body = code(path).slice(code(path).indexOf(typeName)); assert.ok(body.length > 0, `${typeName} must exist`); const inner = body.slice(body.indexOf('{') + 1, body.indexOf('\n}'));
  assert.ok(inner.length > 0, `${typeName} must be a closed type`);
  return [...inner.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
}
const reviewFields = () => authoritativeFields('PublicOperationalDetailReviewHistoryRow', REVIEW_TYPES_PATH);

/** One execution review as the R08 child returns it — PENDING by default, the state where every boundary is most exposed. */
const review = (overrides: Record<string, unknown> = {}) => ({
  reviewId: 'review-1', engine: 'CHECKLIST_EXECUTION', executionId: 'execution-1', clientId: 'client-1', parentBuildingId: 'building-parent', status: 'PENDING', decision: null, reviewerUserId: 'user-opener',
  notes: 'Please check the photos.', createdAt: '2026-01-05T08:00:00.000Z', reviewedAt: null, updatedAt: '2026-01-05T08:00:00.000Z', ...overrides });

const typesModule = async () => import(pathToFileURL(TYPES_PATH).href); const projectionsModule = async () => import(pathToFileURL(PROJECTIONS_PATH).href);
const reviewTypesModule = async () => import(pathToFileURL(REVIEW_TYPES_PATH).href); const decisionModule = async () => import(pathToFileURL(DECISION_TYPES_PATH).href);

/** Projects two reviews of ONE execution — the collapse / fan-out probe. */
async function twoReviewsForOneExecution() {
  const rows = [review({ reviewId: 'review-1' }), review({ reviewId: 'review-2', status: 'COMPLETED', decision: 'REWORK_REQUIRED', reviewedAt: '2026-01-07T09:00:00.000Z', updatedAt: '2026-01-07T09:00:00.000Z' })];
  const mod = await projectionsModule();
  return { projected: mod.projectOperationalDetailReviewHistory({ rows }), rows, mod };
}

describe('R10 PART 05 — OPERATIONAL_DETAIL_HISTORY history=REVIEW', () => {
  it('1/2/3/34/35 — dataset surface stays 13; prior grains intact', async () => {
    const mod = await typesModule();
    assert.deepEqual([...mod.REPORTING_EXPORT_DATASETS], DATASETS_13);  // 1
    assert.equal(mod.REPORTING_EXPORT_DATASETS.length, 13); const openapi = read(OPENAPI_PATH); const body = openapi.slice(openapi.indexOf('    ReportArchiveDataset:') + '    ReportArchiveDataset:'.length);
    const enumBody = /enum:\s*\[([\s\S]*?)\]/.exec(body)[1]; const documented = enumBody.split(',').map((v) => v.trim()).filter(Boolean);
    assert.equal(documented.length, 13);  // 2
    assert.deepEqual(documented, [...mod.REPORTING_EXPORT_DATASETS], 'runtime and OpenAPI agree');
    assert.equal(documented.filter((v) => v === 'OPERATIONAL_DETAIL_HISTORY').length, 1, 'ODH declared once');  // 3
    assert.equal([...mod.REPORTING_EXPORT_DATASETS].filter((v) => v === 'OPERATIONAL_DETAIL_HISTORY').length, 1);
    assert.ok(!registryCode.includes('csvDefaultTableKey'), 'no dataset-specific CSV default anywhere');  // 34
    assert.ok(!code(PROJECTIONS_PATH).includes('csvDefaultTableKey')); const proj = await projectionsModule();
    assert.equal(typeof proj.projectCorrectiveAction, 'function');  // 35
    assert.equal(proj.projectCorrectiveAction([]).tables[0].key, 'correctiveAction'); assert.equal(proj.projectOperationalDetailEvidence({ rows: [] }).tables[0].key, 'operationalDetailEvidence');
    assert.equal(proj.projectOperationalDetailFindingRework({ rows: [] }).tables[0].key, 'operationalDetailFindingRework');
    assert.equal(proj.projectOperationalDetailReviewHistory({ rows: [] }).tables[0].key, 'operationalDetailReviewHistory');
    // Scoped to the adapter: `checklist.read` also belongs to OPERATIONAL_DETAIL, so a whole-registry match would not notice this dataset losing its authority.
    assert.match(odhAdapter(), /requiredReadPermission:\s*'checklist\.read'/, 'ODH keeps the PART 03 authority');
    assert.equal((odhAdapter().match(/requiredReadPermission/g) || []).length, 1, 'one permission, never per-grain');
    assert.ok(!/requiredReadPermission:\s*'(?!checklist\.read')/.test(odhAdapter()), 'no other authority, none invented');
  });

  it('4/5/6/7 — all three grains implemented; no fourth exists', async () => {
    const mod = await typesModule(); const adapter = odhAdapter();
    assert.deepEqual([...mod.OPERATIONAL_DETAIL_HISTORY_VALUES], ['EVIDENCE', 'FINDING_REWORK', 'REVIEW']); assert.equal(mod.OPERATIONAL_DETAIL_HISTORY_VALUES.length, 3, 'the frozen vocabulary is unchanged');
    assert.match(registryCode, /IMPLEMENTED_HISTORY_VALUES[^=]*=\s*new Set[^)]*\(\['EVIDENCE', 'FINDING_REWORK', 'REVIEW'\]\)/);
    assert.match(adapter, /projectOperationalDetailEvidence\(fullSource\)/);  // 4
    assert.match(adapter, /projectOperationalDetailFindingRework\(fullSource\)/);  // 5
    assert.match(adapter, /projectOperationalDetailReviewHistory\(fullSource\)/);  // 6
    assert.match(adapter, /if \(!IMPLEMENTED_HISTORY_VALUES\.has\(history\)\)/, 'the fail-closed gate is kept'); assert.match(adapter, /is not implemented yet; supported:/);
    assert.match(registryCode, /OPERATIONAL_DETAIL_HISTORY_VALUES\.join\(', '\)/, 'the error names the vocabulary');
    // 7. Three explicit branches, three vocab values: no undeclared fourth grain can be dispatched, and nothing outside the vocabulary reaches a child.
    assert.deepEqual([...adapter.matchAll(/if \(history === '([A-Z_]+)'\)/g)].map((m) => m[1]).sort(), ['FINDING_REWORK', 'REVIEW'], 'exactly the two early-return branches; EVIDENCE is the fall-through');
    assert.equal(odhAdapter().split('projectOperationalDetail').length - 1, 3); const gateAt = adapter.indexOf('readHistoryDiscriminator(passThrough.history)');
    assert.ok(gateAt >= 0 && gateAt < adapter.indexOf("if (history === 'REVIEW')"), 'gated before any grain');
  });

  it('8/9/26/27 — engine required and owned by the child; execution targets only', async () => {
    const adapter = odhAdapter(); const branch = reviewBranch(); const odTypes = code(OD_TYPES_PATH);
    assert.match(odTypes, /OPERATIONAL_DETAIL_ENGINES = \['CHECKLIST_EXECUTION', 'FORM_INSTANCE'\]/, 'exactly two engines, from the R07 authority');  // 9
    assert.equal((odTypes.match(/'(CHECKLIST_EXECUTION|FORM_INSTANCE)'/g) || []).length, 2, 'no third engine');
    // 8/9. Reporting declares no engine vocabulary and applies no default: the child parser owns the requirement, so BOTH / ALL / omitted are all rejected there.
    assert.ok(!/CHECKLIST_EXECUTION|FORM_INSTANCE/.test(adapter), 'engines never redeclared in Reporting'); assert.ok(!/engine\s*[:=]\s*(engine\s*\?\?|'CHECKLIST_EXECUTION')/.test(branch), 'no engine default');
    assert.match(branch, /parseOperationalDetailReviewHistoryQuery\(passThrough\)/, 'the child parser owns engine'); assert.match(reviewServiceCode, /engine/i, 'engine stays a child contract');
    // 26/27. The child binds reviews.target_type to the engine literal, so the eight other shared review targets are structurally unreachable — and Reporting never duplicates or widens that predicate.
    assert.match(reviewRepoCode, /target_type\s*=\s*\$1/, 'the child binds target_type to the engine parameter'); assert.ok(!/target_type/.test(adapter), 'Reporting never restates or widens the target predicate');
    assert.ok(!/targetType/.test(branch));
    for (const target of FOREIGN_TARGETS) {
      assert.ok(!new RegExp(`'${target}'`).test(branch), `${target} stays unreachable from the REVIEW grain`);
    }
    assert.ok(!/REVIEW_TARGET_TYPES|targetTypes/.test(registryCode), 'no Reporting-local target vocabulary');
  });

  it('10/11/36 — only the R08 review child is called; no direct reviews SQL', async () => {
    const branch = reviewBranch();
    assert.match(branch, /await getOperationalDetailReviewHistory\(/);  // 10
    assert.match(registryCode, /from '\.\.\/operational-detail-review-history'/, 'reached via the published surface'); const indexCode = read(REVIEW_INDEX_PATH);
    for (const name of ['getOperationalDetailReviewHistory', 'parseOperationalDetailReviewHistoryQuery']) {
      assert.ok(indexCode.includes(name), `${name} is published by the child`);
    }
    // 11. No Reporting-local review read model: no reviews SQL, no second repository.
    for (const forbidden of ['FROM reviews', 'from reviews', 'JOIN reviews', 'reviewRepository', 'reviewHistoryRepository', 'SELECT']) {
      assert.ok(!registryCode.includes(forbidden), `Reporting must not contain ${forbidden}`);
    }
    assert.ok(!SIBLING_SOURCES.some((s) => branch.includes(s)), 'the REVIEW branch touches no sibling child');
    // 36. The child's own authority is intact — Reporting adapted to it, not vice versa.
    assert.match(reviewServiceCode, /const MAX_LIMIT = 1000;/); assert.match(reviewServiceCode, /const DEFAULT_LIMIT = 100;/);
    assert.match(reviewServiceCode, /assertBuildingAccess|getAccessibleBuildingIds/, 'fail-closed scope retained'); assert.match(reviewRepoCode, /ORDER BY r\.target_id ASC, r\.created_at DESC, r\.id ASC/, 'deterministic order');
    const childTypes = await reviewTypesModule(); assert.deepEqual([...childTypes.EXECUTION_REVIEW_CHILD_STATUSES], ['PENDING', 'COMPLETED']); assert.equal(childTypes.isExecutionReviewChildStatus('PENDING'), true);
    assert.equal(childTypes.isExecutionReviewChildStatus('COMPLETED'), true); assert.equal(childTypes.isExecutionReviewChildStatus('ACCEPTED'), false, 'no Reporting-local status leaks in');
  });

  it('12/13/14/31 — one table, one row per reviewId, never collapsed', async () => {
    const { projected, rows } = await twoReviewsForOneExecution();
    assert.equal(projected.tables.length, 1, 'exactly one table');  // 12
    assert.equal(projected.tables[0].key, 'operationalDetailReviewHistory'); assert.equal(projected.tables[0].rowCount, 2);
    assert.deepEqual(projected.tables[0].columns.map((c) => c.key), reviewFields(), 'columns are the authoritative row, field for field and in order');  // 13
    assert.equal(projected.tables[0].rows.length, rows.length, 'one row per review, no dedup');  // 14
    assert.deepEqual(projected.tables[0].rows.map((r) => r.reviewId), ['review-1', 'review-2']); assert.equal(new Set(projected.tables[0].rows.map((r) => r.executionId)).size, 1, 'two reviews of ONE execution stay two rows');
    // 31. No cross-child fan-out: no count, no sibling id, nothing aggregated.
    const keys = projected.tables[0].columns.map((c) => c.key);
    for (const foreign of FOREIGN_KEYS) assert.ok(!keys.includes(foreign), `${foreign} must not be added`);
    assert.equal(projected.kpis.length, 0, 'a history grain calculates no headline figure'); assert.ok(!/COUNT\(|GROUP BY|DISTINCT/.test(projectionsCode), 'the projection runs no SQL');
    assert.ok(!/\breduce\(|\bfind\(|latest|filter\(/i.test(reviewProjection()), 'no latest/narrowing logic');
  });

  it('15/16/17/18/19 — both statuses included; NULL decision preserved', async () => {
    const childTypes = await reviewTypesModule(); const decisions = await decisionModule(); const { projected } = await twoReviewsForOneExecution(); const rows = projected.tables[0].rows;
    // 15/16/17. PENDING and COMPLETED are the two stored literals and BOTH survive.
    assert.deepEqual([...childTypes.EXECUTION_REVIEW_CHILD_STATUSES].sort(), ['COMPLETED', 'PENDING']); assert.deepEqual(rows.map((r) => r.status), ['PENDING', 'COMPLETED'], 'both statuses present, verbatim');
    assert.equal(rows[0].status, 'PENDING', 'PENDING is never filtered out');  // 16
    assert.equal(rows[1].status, 'COMPLETED');  // 17
    assert.ok(!/status\s*[!=]==?\s*'COMPLETED'/.test(reviewBranch()), 'no COMPLETED-only narrowing in Reporting');
    for (const bad of BAD_STATUSES) {
      assert.ok(!rows.some((r) => r.status === bad), `${bad} is not a review status`);
    }
    // 18. NULL decision stays NULL — never coerced, normalized or bucketed.
    assert.equal(rows[0].decision, null, 'a PENDING review keeps its meaningful NULL'); assert.equal(rows[1].decision, 'REWORK_REQUIRED');
    assert.ok(!rows.some((r) => ['PENDING', 'UNDECIDED', 'NONE', 'UNKNOWN', 'N/A', 'N-A'].includes(r.decision)), 'NULL is never coerced to a placeholder');
    assert.ok(!/decision\s*\?\?|decision\s*\|\||decision:\s*'/.test(reviewBranch()), 'no decision coercion');
    // 19. REVIEW_DECISIONS is the reused shared authority, never redeclared.
    assert.deepEqual([...decisions.REVIEW_DECISIONS], ['APPROVED', 'REJECTED', 'REWORK_REQUIRED']); assert.equal(decisions.isReviewDecision('APPROVED'), true);
    assert.equal(decisions.isReviewDecision('ACCEPTED'), false); assert.match(code(REVIEW_TYPES_PATH), /from '\.\.\/reviews\/review\.types'/, 'the child imports the authority');
    assert.ok(!/APPROVED|REJECTED|REWORK_REQUIRED/.test(registryCode), 'Reporting never redeclares decisions'); assert.ok(!/REVIEW_DECISIONS\s*=/.test(projectionsCode), 'nor does the projection');
  });

  it('20/21/22/23/24/25 — reviewer is an opener; notes history absent; updatedAt inert', async () => {
    const { projected } = await twoReviewsForOneExecution(); const columns = projected.tables[0].columns;
    const labels = columns.map((c) => c.label).map((l) => l.toLowerCase());
    // 20. No label may present reviewerUserId as the deciding user.
    for (const stem of DECIDER_STEMS.concat(EXECUTOR_WORDS)) {
      assert.ok(!labels.some((l) => l.includes(stem)), `no "${stem}" label on a review row`);
    }
    assert.equal(columns.find((c) => c.key === 'reviewerUserId').label, 'Reviewer User Id', 'reviewer, not decider');
    // 21. Documented as the user stored WHEN OPENED, because no decision actor is persisted.
    assert.match(projectionsRaw, /stored when\s*\n?\s*\*?\s*the review was OPENED/i, 'opener semantics documented');
    assert.match(read(resolve(ROOT, 'docs/api/openapi.yaml')), /reviewerUserId is the user stored when the review was OPENED/, 'and published in the contract');
    assert.ok(!/decisionActor|decidedByUserId/.test(registryCode + projectionsCode), 'no invented decision actor');
    // 22/23. notes is one mutable column: the pre-overwrite value is unavailable and is never labelled as an
    // original, initial, rejection or decision note. The projection doc NAMES these labels only to exclude them, so
    // this scans the comment-stripped code and the published labels — the contract, not the prose.
    const reviewProj = reviewProjection().toLowerCase();
    for (const bad of NOTES_LABELS) {
      assert.ok(!labels.some((l) => l.includes(bad)), `no "${bad}" label`);  // 23
      assert.ok(!reviewProj.includes(bad), `no "${bad}" column`);
    }
    for (const stem of DECIDER_STEMS) {
      assert.ok(!reviewProj.includes(stem), `no "${stem}" in the review projection`);  // 20
    }
    assert.equal(columns.find((c) => c.key === 'notes').label, 'Notes', 'notes stays notes'); assert.match(projectionsRaw, /UNAVAILABLE/, 'the missing notes history is documented, not hidden');
    assert.equal(projected.tables[0].rows[0].notes, 'Please check the photos.', 'current value verbatim'); assert.equal(columns.filter((c) => /notes/i.test(c.key)).length, 1, 'exactly one notes column');
    // 24/25. reviewedAt is the persisted completion time; updatedAt is a record fact.
    assert.equal(projected.tables[0].rows[0].reviewedAt, null, 'NULL until completion'); assert.equal(projected.tables[0].rows[1].reviewedAt, '2026-01-07T09:00:00.000Z');
    assert.equal(columns.find((c) => c.key === 'reviewedAt').type, 'DATE'); assert.ok(!/ORDER BY|\.sort\(/.test(projectionsCode), 'the projection never re-orders rows');
    assert.match(reviewRepoCode, /r\.created_at DESC/, 'ordering uses the immutable timestamp'); assert.ok(!/ORDER BY[\s\S]*updated_at/.test(reviewRepoCode), 'updatedAt is never an ordering authority');
    assert.equal((reviewBranch().match(/updatedAt/g) || []).length, 0, 'Reporting never branches on, rewrites or promotes updatedAt');
    assert.ok(!/decisionTime|decidedAt|completedAt/.test(registryCode + projectionsCode), 'no inferred decision time');
  });

  it('28/29/30 — no evidence, finding or rework join', async () => {
    const branch = reviewBranch();
    assert.ok(!/getOperationalDetailEvidence/.test(branch), 'no evidence child call');  // 28
    assert.ok(!/getOperationalDetailFindingRework/.test(branch), 'no rework child call');  // 30
    assert.ok(!/getFindingRegister|findingRepository|findings\b/.test(branch), 'no finding join');  // 29
    assert.ok(!SIBLING_SOURCES.some((s) => branch.includes(s)), 'no sibling source in the REVIEW branch'); assert.ok(!/JOIN/.test(branch), 'the branch issues no SQL at all');
    assert.ok(!/evidenceCount|findingCount|reworkCount/.test(registryCode), 'no cross-child counts');
    // Each sibling grain keeps its own branch and its own child — no shared read.
    assert.equal(odhAdapter().split('getOperationalDetailReviewHistory(').length - 1, 1); assert.equal(odhAdapter().split('getOperationalDetailFindingRework(').length - 1, 1);
    assert.equal(odhAdapter().split('getOperationalDetailEvidence(').length - 1, 1);
  });

  it('32/33 — caller pagination stripped; internal batching freezes dateTo', async () => {
    const branch = reviewBranch();
    assert.match(branch, /limit:\s*_ignoredLimit/, 'caller limit is discarded');  // 32
    assert.match(branch, /offset:\s*_ignoredOffset/, 'caller offset is discarded'); assert.ok(!/echoFilters\([\s\S]*?limit/.test(branch.slice(branch.indexOf('return {'))), 'never echoed as a filter');
    assert.match(branch, /echoFilters\(\s*\{ \.\.\.governedFilters, dateTo: effectiveDateTo \},\s*\{ history \}/);
    assert.match(branch, /const INTERNAL_BATCH_SIZE = 1000;/, 'batched at the child MAX_LIMIT');  // 33
    assert.match(branch, /while \(true\)/); assert.match(branch, /if \(source\.rows\.length < INTERNAL_BATCH_SIZE\) break;/, 'a short page ends the loop'); assert.match(branch, /offset \+= INTERNAL_BATCH_SIZE;/);
    // 33. The upper bound is frozen ONCE for the whole load and reused on every page: one clock read for the entire adapter, never one per grain or per page.
    assert.equal((odhAdapter().match(/new Date\(\)\.toISOString\(\)/g) || []).length, 1, 'a single frozen clock'); assert.match(odhAdapter(), /const frozenNowIso = new Date\(\)\.toISOString\(\);/);
    assert.match(branch, /governedFilters\.dateTo \?\? frozenNowIso/, 'the REVIEW grain reuses that frozen bound');
    for (const assigned of [...branch.matchAll(/dateTo:\s*([^,\n}]+)/g)].map((m) => m[1].trim())) {
      assert.equal(assigned, 'effectiveDateTo', 'every dateTo write is the frozen bound');
    }
    assert.ok(!/new Date\(\)/.test(branch), 'the branch never reads the clock again'); assert.match(branch, /buildingScope: commonSource\.buildingScope/, 'the child scope is passed through');
    assert.match(reviewServiceCode, /MAX_RANGE_DAYS/, 'the child range guard is untouched');
  });

  it('37 — no migration, route, permission, renderer or archive branch added', () => {
    assert.ok(!readdirSync(MIGRATIONS_DIR).some((f) => /review_history|operational_detail_review/i.test(f)), 'no PART 05 migration');
    for (const file of DOWNSTREAM) {
      const source = code(resolve(EXPORT_DIR, file));
      assert.ok(!/operationalDetailReviewHistory|OPERATIONAL_DETAIL_HISTORY/.test(source), `${file} gains no dataset-specific branch`); assert.ok(!/history\s*===/.test(source), `${file} never switches on history`);
    }
    for (const file of readdirSync(ARCHIVE_DIR)) {
      assert.ok(!/operationalDetailReviewHistory/.test(code(resolve(ARCHIVE_DIR, file))), `${file} gains no review branch`);
    }
    const typesCode = code(resolve(EXPORT_DIR, 'reporting-export.types.ts')); const declared = /OPERATIONAL_DETAIL_HISTORY_VALUES = \[([\s\S]*?)\]/.exec(typesCode)[1];
    assert.deepEqual([...declared.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]), ['EVIDENCE', 'FINDING_REWORK', 'REVIEW'], 'types.ts keeps the PART 00 frozen vocabulary unchanged');
    assert.equal(authoritativeFields('PublicOperationalDetailEvidenceRow', EVIDENCE_TYPES_PATH).length, 26, 'the PART 03 evidence row is untouched');
    assert.equal(authoritativeFields('PublicOperationalDetailFindingReworkRow', REWORK_TYPES_PATH).length, 17, 'the PART 04 rework row is untouched'); assert.equal(reviewFields().length, 12, 'the R08 review row is untouched');
  });

  it('CI-required — live database and >1000-review batching proofs', async () => {
    // Executed only where a database and dependencies exist; the contract proofs above are not.
    const needs = ['a live >1000-review load pages through the child without duplication or omission', 'buildingId asserts access and fails closed',
      'an empty authorized scope yields a well-formed zero-row source', 'reviewId / executionId / templateId narrow only and never bypass scope',
      'a PENDING review with a NULL decision survives an end-to-end CSV render'];
    assert.equal(needs.length, 5); const { projected } = await twoReviewsForOneExecution(); assert.equal(projected.tables[0].rowCount, 2, 'the projection half of these proofs is covered above');
  });
});
