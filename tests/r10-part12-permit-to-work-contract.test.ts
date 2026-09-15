import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

/**
 * R10 PART 12 — Permit To Work Register TYPES + REPOSITORY: focused validation.
 *
 * PART 12 creates the bounded read-model contract only. It wires nothing: no service, no index,
 * no Reporting dataset enum, no registry adapter, no projection, no OpenAPI surface, no route, no
 * permission and no migration. Those belong to PART 13 / PART 14.
 *
 * The repository imports `getPool` (`pg`), so it is NOT live-importable in this dependency-free
 * sandbox and is asserted statically against comment-stripped source. The SQL is assembled from
 * module-level constants, so every SQL proof runs against the FULLY EXPANDED text — the same
 * string the driver would receive — rather than a fragment that a nested constant could hide.
 * Live execution against PostgreSQL is therefore CI-required.
 *
 * Proofs: 1 two distinct grains · 2 lifecycle grain is one application row · 3 approval grain is
 * one pab.id row · 4 approval table is permit_approval_bindings · 5 uniqueness not treated as
 * permit-wide 0..1 · 6 no singular current approval selector · 7 no latest approval selector ·
 * 8 no stage precedence invented · 9 lifecycle exposes approvalCount · 10 lifecycle exposes
 * pendingApprovalCount · 11 lifecycle exposes no singular approval identity/status/stage/type ·
 * 12 approvalStage stays free-form · 13 approvalType stays free-form · 14 reviewStatus stays the
 * persisted PENDING/COMPLETED authority · 15 decision stays the persisted authority ·
 * 16 approvalStatus derivation is PENDING review => PENDING else decision · 17 reviewer is
 * exposed only as assigned approver · 18 no decision actor field · 19 notes are current only ·
 * 20 no notes history invented · 21 applicationStatus separate from approvalStatus ·
 * 22 permitStatus separate from approvalStatus · 23 building scope is fail-closed ·
 * 24 structural client/target join equality · 25 lifecycle cannot fan out from approval joins ·
 * 26 approval query supports 1:N · 27 deterministic ordering · 28 no
 * availableActions/readinessBlockers · 29 no service/index/export wiring · 30 no
 * route/OpenAPI/permission/migration change.  */

const ROOT = process.cwd();
const MODULE_DIR = resolve(ROOT, 'src/modules/permit-to-work-register');
const TYPES_PATH = resolve(MODULE_DIR, 'permit-to-work-register.types.ts');
const REPO_PATH = resolve(MODULE_DIR, 'permit-to-work-register.repository.ts');
const EXPORT_DIR = resolve(ROOT, 'src/modules/reporting-export');
const OPENAPI_PATH = resolve(ROOT, 'docs/api/openapi.yaml');
const MIGRATIONS_DIR = resolve(ROOT, 'src/database/migrations');

/** Concepts that would assert a singular approval authority that the schema does not persist. */
const SINGULAR_APPROVAL = ['currentApprovalId', 'currentApprovalStage', 'currentApprovalType',
  'currentApprovalStatus', 'currentApprover', 'latestApproval', 'activeApproval', 'primaryApproval',
  'governingApproval', 'nextApproval', 'decisionActor', 'decisionByUserId', 'approvedByUserId',
  'rejectedByUserId', 'performedBy', 'executedBy', 'originalNotes', 'decisionNotesHistory',
  'approvalNotesHistory', 'availableActions', 'readinessBlockers'];
/** Query parameters this register must never accept. */
const FORBIDDEN_FILTERS = ['currentApproval', 'latestApproval', 'currentStage', 'decisionActor',
  'page', 'limit', 'offset', 'sort', 'search', 'sortBy', 'orderBy', 'pageSize'];

const read = (path: string): string => readFileSync(path, 'utf8');
/** Strips comments, so "must not exist" assertions test the CODE contract, not the prose. */
const code = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const repoCode = code(REPO_PATH);
const typesCode = code(TYPES_PATH);

/** One top-level `const NAME = \`...\`;` template literal, raw (interpolations unexpanded). */
function constSql(name: string): string {
  const marker = `const ${name} = \``;
  const at = repoCode.indexOf(marker);
  assert.ok(at >= 0, `${name} must exist`);
  const start = at + marker.length;
  const end = repoCode.indexOf('`;', start);
  assert.ok(end > start, `${name} must be closed`);
  return repoCode.slice(start, end);
}
/** Recursively expands `${NAME}` so assertions see the exact SQL the driver receives. */
function expand(text: string): string {
  return text.replace(/\$\{([A-Z_][A-Z_0-9]*)\}/g, (_m, name: string) => expand(constSql(name)));
}
/** One exported function body, so a helper can never satisfy another function's proof. */
function fnBody(signature: string): string {
  const at = repoCode.indexOf(signature);
  assert.ok(at >= 0, `${signature} must exist`);
  const end = repoCode.indexOf('\n}', at);
  assert.ok(end > at, `${signature} must be closed`);
  return repoCode.slice(at, end);
}
/** One `export type NAME = { ... };` member list, in declaration order. */
function typeFields(source: string, name: string): string[] {
  const marker = `export type ${name} = {`;
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `${name} must exist`);
  const body = source.slice(at + marker.length);
  return [...body.slice(0, body.indexOf('\n};')).matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
}

const lifecycleSelect = () => expand(constSql('LIFECYCLE_SELECT'));
const lifecycleFrom = () => expand(constSql('LIFECYCLE_FROM'));
const approvalSelect = () => expand(constSql('APPROVAL_SELECT'));
const approvalFrom = () => expand(constSql('APPROVAL_FROM'));
const lifecycleFn = () => fnBody('export async function getPermitToWorkLifecycleRows(');
const approvalFn = () => fnBody('export async function getPermitToWorkApprovalRows(');

describe('R10 PART 12 — Permit To Work Register types and repository', () => {
  it('1-4 — two distinct grains over their own base tables', () => {
    const exported = [...repoCode.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
    assert.deepEqual(exported.sort(), ['getPermitToWorkApprovalRows', 'getPermitToWorkLifecycleRows'],
      'exactly two repository queries, one per grain');  // 1
    assert.deepEqual(typeFields(typesCode, 'PublicPermitToWorkLifecycleRow').length > 0
      && typeFields(typesCode, 'PublicPermitToWorkApprovalRow').length > 0, true,
      'two separate row contracts are declared');  // 1
    assert.ok(!/PublicPermitToWorkRow\b|UniversalPermitRow/.test(typesCode),
      'the two grains are never flattened into one universal row');  // 1

    assert.match(lifecycleFrom(), /FROM permit_applications pa\s*\n\s*JOIN permits p\s*\n\s*ON p\.id = pa\.permit_id/,
      'LIFECYCLE base table is permit_applications, scoped through permits');  // 2
    assert.match(lifecycleSelect(), /pa\.id\s+AS permit_application_id/, 'its identity is pa.id');  // 2
    assert.ok(!/GROUP BY|DISTINCT/.test(lifecycleSelect() + lifecycleFrom()),
      'the lifecycle grain is neither grouped nor deduplicated');  // 2

    assert.match(approvalFrom(), /FROM permit_approval_bindings pab/,
      'APPROVAL base table is permit_approval_bindings');  // 3
    assert.match(approvalSelect(), /pab\.id\s+AS approval_id/, 'its identity is pab.id');  // 3
    assert.match(approvalFn(), /ORDER BY pab\.created_at ASC, pab\.id ASC/, 'ordered by approval identity');  // 3

    assert.ok(/permit_approval_bindings/.test(approvalFrom()) && /permit_approval_bindings/.test(repoCode),
      'the approval binding table is named permit_approval_bindings');  // 4
    assert.ok(!/\bpermit_approvals\b/.test(repoCode) && !/\bpermit_approvals\b/.test(typesCode),
      'never the non-authoritative permit_approvals table');  // 4
  });

  it('5-8 — no singular, latest or precedence-bearing approval selector exists', () => {
    // 5 — permit_approval_context_unique is on (application, stage, type), so MANY approvals per
    // application are valid. Nothing may treat that uniqueness as a permit-wide 0..1.
    assert.ok(!/DISTINCT ON/i.test(repoCode), 'no DISTINCT ON anywhere');  // 5
    assert.ok(!/UNIQUE \(permit_application_id\)/.test(repoCode),
      'no permit-wide approval uniqueness is assumed in SQL');  // 5
    assert.ok(!/LIMIT/i.test(repoCode), 'no LIMIT selector of any kind');  // 5, 7
    // 6 — no singular current/active/primary approval concept.
    for (const name of SINGULAR_APPROVAL) {
      assert.ok(!repoCode.includes(name), `repository never mentions ${name}`);
      assert.ok(!typesCode.includes(name), `types never mention ${name}`);
    }  // 6, 18, 20, 28
    // 7 — no latest/newest selector and no aggregate-over-time election.
    assert.ok(!/MAX\s*\(\s*(pab\.|r\.)?(created_at|reviewed_at|updated_at)/i.test(repoCode),
      'no MAX(timestamp) approval election');  // 7
    assert.ok(!/ROW_NUMBER\s*\(/i.test(repoCode), 'no ROW_NUMBER() window election');  // 7
    assert.ok(!/RANK\s*\(|DENSE_RANK\s*\(/i.test(repoCode), 'no ranking window election');  // 7
    // 8 — stage/type are free-form TEXT with no ordering authority, so they are never ranked.
    assert.ok(!/ORDER BY[^;]*approval_stage/i.test(repoCode) && !/ORDER BY[^;]*approval_type/i.test(repoCode),
      'never ordered by approval stage or type');  // 8
    assert.ok(!/STAGE_PRECEDENCE|APPROVAL_STAGES|APPROVAL_TYPES|stageOrder|typeOrder/i.test(repoCode + typesCode),
      'no stage/type vocabulary, precedence or ordering constant is invented');  // 8, 12, 13
  });

  it('9-11 — lifecycle exposes bounded counts and no approval identity', () => {
    const fields = typeFields(typesCode, 'PublicPermitToWorkLifecycleRow');
    assert.ok(fields.includes('approvalCount'), 'approvalCount is exposed');  // 9
    assert.ok(fields.includes('pendingApprovalCount'), 'pendingApprovalCount is exposed');  // 10
    assert.match(lifecycleSelect(), /SELECT COUNT\(\*\)::int/, 'counts are raw COUNT(*)::int aggregates');  // 9
    assert.match(lifecycleSelect(), /rp\.status = 'PENDING'/, 'the pending count filters on persisted review status');  // 10
    assert.ok(!/COUNT\(\*\)(?!::int)/.test(lifecycleSelect()),
      'every count is cast to int4 so the driver returns a number, not a bigint string');  // 9
    // 11 — the lifecycle row carries NO approval identity, status, stage or type.
    for (const forbidden of ['approvalId', 'approvalStage', 'approvalType', 'approvalStatus', 'reviewId',
      'reviewStatus', 'decision', 'assignedApproverUserId', 'reviewedAt']) {
      assert.ok(!fields.includes(forbidden), `lifecycle row has no ${forbidden}`);
    }  // 11
    assert.deepEqual(fields.filter((f) => /[Aa]pproval/.test(f)).sort(),
      ['approvalCount', 'pendingApprovalCount'].sort(),
      'the only approval-bearing lifecycle fields are the two raw counts');  // 11
    assert.equal(fields.length, 19, 'the lifecycle row contract is exactly 19 fields');  // 11
  });

  it('12-16 — free-form stage/type, persisted review authority, derived approvalStatus', () => {
    const approval = typeFields(typesCode, 'PublicPermitToWorkApprovalRow');
    assert.match(typesCode, /approvalStage: string;/, 'approvalStage is a plain string, not an enum');  // 12
    assert.match(typesCode, /approvalType: string;/, 'approvalType is a plain string, not an enum');  // 12
    const filters = typeFields(typesCode, 'PermitToWorkApprovalFilters');
    assert.ok(filters.includes('approvalStage') && filters.includes('approvalType'),
      'stage/type are filterable by exact persisted value');  // 12, 13
    assert.match(repoCode, /pab\.approval_stage = \$\$\{values\.length\}/, 'stage filtered by equality only');  // 12
    assert.match(repoCode, /pab\.approval_type = \$\$\{values\.length\}/, 'type filtered by equality only');  // 13

    assert.match(typesCode, /export type PermitReviewStatus = 'PENDING' \| 'COMPLETED';/,
      'reviewStatus restates the persisted reviews.review_status CHECK union');  // 14
    assert.match(approvalSelect(), /r\.status\s+AS review_status/, 'reviewStatus comes from reviews.status');  // 14
    assert.match(typesCode, /decision: ReviewDecision \| null;/,
      'decision reuses the shared reviews authority and stays nullable');  // 15
    assert.match(typesCode, /from '\.\.\/reviews\/review\.types'/, 'ReviewDecision is imported, not redeclared');  // 15
    assert.match(approvalSelect(), /r\.decision\s+AS decision/, 'decision comes from reviews.decision');  // 15

    // 16 — the derivation is the owning domain's exact two-branch shape, expressed once and used
    // for BOTH projection and filtering so the two can never drift.
    assert.match(constSql('APPROVAL_STATUS_SQL'),
      /^CASE WHEN r\.status = 'PENDING' THEN 'PENDING' ELSE r\.decision END$/,
      'PENDING review => PENDING, otherwise the decision');  // 16
    assert.match(approvalSelect(), /CASE WHEN r\.status = 'PENDING' THEN 'PENDING' ELSE r\.decision END\s+AS approval_status/,
      'the derivation is projected');  // 16
    // The filter interpolates the SAME constant the SELECT projects, so the two cannot drift:
    // there is exactly one definition and exactly two interpolations, projection and filter.
    assert.match(approvalFn(), /\$\{APPROVAL_STATUS_SQL\} = \$\$\{values\.length\}/,
      'the filter is expressed through the shared derivation constant');  // 16
    assert.equal([...repoCode.matchAll(/const APPROVAL_STATUS_SQL = /g)].length, 1,
      'the derivation is defined exactly once');  // 16
    assert.equal([...repoCode.matchAll(/\$\{APPROVAL_STATUS_SQL\}/g)].length, 2,
      'and interpolated exactly twice: once to project, once to filter');  // 16
    assert.match(typesCode, /approvalStatus: PermitApprovalStatus;/,
      'the derived vocabulary is the domain PERMIT_APPROVAL_STATUSES, reused not reinvented');  // 16
    for (const invented of ['CANCELLED', 'EXPIRED', 'WAITING', 'SKIPPED', 'IN_PROGRESS']) {
      assert.ok(!new RegExp(`approvalStatus[^;]*${invented}`).test(typesCode),
        `no invented ${invented} approval status`);
    }  // 16
    assert.ok(approval.includes('approvalStatus') && approval.includes('reviewStatus') && approval.includes('decision'),
      'the derived value never hides the persisted facts it came from');  // 16
  });

  it('17-22 — assigned approver semantics, current notes, separate parent states', () => {
    const approval = typeFields(typesCode, 'PublicPermitToWorkApprovalRow');
    assert.match(approvalSelect(), /r\.reviewer_user_id\s+AS assigned_approver_user_id/,
      'reviews.reviewer_user_id is exposed ONLY as the assigned approver');  // 17
    assert.ok(approval.includes('assignedApproverUserId'), 'the safe field name is used');  // 17
    assert.ok(!approval.includes('approverUserId'), 'never the bare approverUserId label');  // 17
    assert.match(approvalFn(), /r\.reviewer_user_id = \$\$\{values\.length\}/,
      'filtering narrows on the ASSIGNED approver and asserts no decision actor');  // 17
    assert.ok(!/decisionBy|approvedBy|rejectedBy|decidedBy|verifiedBy/i.test(repoCode + typesCode),
      'no decision actor field exists anywhere');  // 18

    assert.match(approvalSelect(), /r\.notes\s+AS notes/, 'notes come from reviews.notes');  // 19
    assert.match(typesCode, /\bnotes: string \| null;/, 'notes is the current mutable value only');  // 19
    assert.ok(approval.includes('notes'), 'the row exposes notes');  // 19
    assert.ok(!/notes_history|note_history|previous_notes|original_notes/i.test(repoCode),
      'no notes history is queried or reconstructed');  // 20

    // 21/22 — three independent status dimensions, each from its own persisted source.
    assert.ok(approval.includes('applicationStatus') && approval.includes('permitStatus')
      && approval.includes('approvalStatus'), 'all three statuses coexist as separate fields');  // 21, 22
    assert.match(approvalSelect(), /pa\.status\s+AS application_status/, 'applicationStatus from pa.status');  // 21
    assert.match(approvalSelect(), /p\.status\s+AS permit_status/, 'permitStatus from p.status');  // 22
    assert.match(typesCode, /applicationStatus: PermitApplicationStatus;/, 'application status reuses its own authority');  // 21
    assert.match(typesCode, /permitStatus: PermitStatus;/, 'permit status reuses its own authority');  // 22
    assert.equal(approval.length, 19, 'the approval row contract is exactly 19 fields');  // 22
  });

  it('23-27 — fail-closed scope, structural pins, no fan-out, 1:N, ordering', () => {
    for (const [name, body] of [['lifecycle', lifecycleFn()], ['approval', approvalFn()]] as const) {
      assert.match(body, /const conditions: string\[\] = \['p\.building_id = ANY\(\$1::uuid\[\]\)'\];/,
        `${name}: building scope is the seeded first condition`);  // 23
      assert.match(body, /const values: unknown\[\] = \[buildingIds\];/,
        `${name}: $1 is always the authorized scope`);  // 23
      assert.match(body, /if \(buildingIds\.length === 0\) return \[\];/,
        `${name}: empty authorized scope returns an empty list without querying`);  // 23
      assert.ok(!/clientId/.test(body), `${name}: no caller clientId scope override`);  // 23
      assert.match(body, /ORDER BY [a-z]+\.[a-z_]+ ASC, [a-z]+\.id ASC/,
        `${name}: deterministic ordering on persisted time plus stable identity`);  // 27
    }
    assert.match(lifecycleFn(), /ORDER BY pa\.requested_work_at ASC, pa\.id ASC/,
      'lifecycle ordered by its own date authority + identity');  // 27
    // 24 — reviews persists client_id, so it is pinned structurally rather than trusted on UUID
    // uniqueness; the target pins are guaranteed by the owning domain's own write path.
    assert.match(approvalFrom(), /JOIN reviews r\s*\n\s*ON r\.id = pab\.review_id\s*\n\s*AND r\.client_id = p\.client_id\s*\n\s*AND r\.target_type = 'PERMIT_APPLICATION'\s*\n\s*AND r\.target_id = pab\.permit_application_id/,
      'the approval grain pins reviews by client, target type and target id');  // 24
    const counts = lifecycleSelect();
    assert.equal([...counts.matchAll(/rc\.client_id = p\.client_id|rp\.client_id = p\.client_id/g)].length, 2,
      'both lifecycle count subqueries pin the review client structurally');  // 24
    assert.equal([...counts.matchAll(/target_type = 'PERMIT_APPLICATION'/g)].length, 2,
      'both count subqueries pin the review target');  // 24
    // 25 — the 1:N approval table must never appear in the lifecycle FROM clause.
    assert.ok(!/permit_approval_bindings/.test(lifecycleFrom()),
      'permit_approval_bindings is absent from the lifecycle FROM clause');  // 25
    assert.equal([...counts.matchAll(/\(\s*\n\s*SELECT COUNT\(\*\)::int/g)].length, 2,
      'approvals enter the lifecycle grain only as correlated scalar subqueries');  // 25
    assert.ok(!/JOIN permit_approval_bindings/.test(lifecycleFrom()),
      'no approval join can fan the lifecycle grain out');  // 25
    assert.match(lifecycleFrom(), /LEFT JOIN permit_work_lifecycles pwl\s*\n\s*ON pwl\.permit_application_id = pa\.id\s*\n/,
      'work lifecycle is a plain 0..1 LEFT JOIN, proven by UNIQUE(permit_application_id)');  // 25
    assert.match(lifecycleFrom(), /LEFT JOIN permit_validities pv\s*\n\s*ON pv\.permit_application_id = pa\.id\s*\n\s*AND pv\.status IN \('PENDING', 'VALID'\)/,
      'current validity is 0..1 via the partial unique index predicate, not a LIMIT');  // 25
    // 26 — the approval grain intentionally keeps 1:N rows per permit.
    const approvalSql = approvalSelect() + approvalFrom() + approvalFn();
    assert.ok(!/GROUP BY|DISTINCT|LIMIT/i.test(approvalSql),
      'the approval query never collapses its 1:N rows');  // 26
    assert.match(approvalFrom(), /FROM permit_approval_bindings pab/, 'pab is the driving table');  // 26
  });

  it('28-30 — nothing is exported, wired or migrated in PART 12', () => {
    for (const name of ['availableActions', 'readinessBlockers']) {
      assert.ok(!repoCode.includes(name) && !typesCode.includes(name), `${name} is not exported`);  // 28
    }
    for (const filter of FORBIDDEN_FILTERS) {
      assert.ok(!typesCode.includes(`${filter}?:`), `no forbidden filter ${filter}`);  // 28
    }
    // 29 — the module holds exactly the two PART 12 files: no service, no index, no wiring.
    assert.deepEqual(readdirSync(MODULE_DIR).sort(),
      ['permit-to-work-register.repository.ts', 'permit-to-work-register.types.ts'],
      'exactly two production files, no service.ts and no index.ts');  // 29
    // R10 PART 14 UPDATE — PART 12 itself wired nothing, and that intent is preserved here.
    // PART 14 then OWNED the Reporting integration, so reporting-export.types.ts,
    // reporting-export.registry.ts and reporting-export.r10-projections.ts legitimately
    // reference the dataset now. Re-scoped to the Reporting files PART 14 did not touch.
    const wiring = ['reporting-export.projections.ts',
      'reporting-export.management-projections.ts', 'reporting-export.routes.ts',
      'reporting-export.controller.ts', 'reporting-export.service.ts',
      'reporting-export.validation.ts', 'csv-renderer.ts', 'xlsx-renderer.ts',
      'pdf-renderer.ts'];
    for (const file of wiring) {
      const source = read(resolve(EXPORT_DIR, file));
      assert.ok(!source.includes('PERMIT_TO_WORK') && !source.includes('permit-to-work-register'),
        `${file} is untouched by PART 12 and by PART 14`);
    }  // 29, 30
    for (const file of ['reporting-export.types.ts', 'reporting-export.registry.ts',
      'reporting-export.r10-projections.ts']) {
      assert.ok(read(resolve(EXPORT_DIR, file)).includes('PERMIT_TO_WORK'),
        `${file} carries the PART 14 wiring, which PART 12 deliberately did not add`);
    }
    // R10 PART 14 UPDATE — PART 14 added the single PERMIT_TO_WORK OpenAPI dataset enum entry.
    assert.ok(read(OPENAPI_PATH).includes('PERMIT_TO_WORK'), 'PART 14 added the OpenAPI dataset');  // 30
    const newMigrations = readdirSync(MIGRATIONS_DIR).filter((f) => /permit_to_work/i.test(f));
    assert.deepEqual(newMigrations, [], 'no migration was added');  // 30
    assert.ok(!read(resolve(ROOT, 'src/database/seeds/foundation-access.seed.ts')).includes('permit_to_work'),
      'no new permission was seeded');  // 30
    // The types file declares no runtime vocabulary of its own, so it cannot leak a competing enum.
    assert.deepEqual([...typesCode.matchAll(/export const (\w+)/g)].map((m) => m[1]), [],
      'types.ts exports no runtime constant');  // 30
  });

  it('live — types.ts is runtime-free and imports only existing authorities', async () => {
    const mod = await import(pathToFileURL(TYPES_PATH).href);
    assert.deepEqual(Object.keys(mod).filter((k) => k !== 'default'), [],
      'types.ts has zero runtime exports: every import is type-only');
    for (const specifier of [...read(TYPES_PATH).matchAll(/from '(\.\.[^']+)'/g)].map((m) => m[1])) {
      assert.ok(readFileSync(resolve(MODULE_DIR, `${specifier}.ts`), 'utf8').length > 0,
        `${specifier} resolves to a real source file`);
    }
    // The reused authorities really do carry the vocabularies this contract claims.
    const approvals = read(resolve(ROOT, 'src/modules/permit-approvals/permit-approval.types.ts'));
    assert.match(approvals, /'PENDING',\s*\n\s*'APPROVED',\s*\n\s*'REJECTED',\s*\n\s*'REWORK_REQUIRED',/,
      'PERMIT_APPROVAL_STATUSES is the reused derived vocabulary');
    const reviews = read(resolve(ROOT, 'src/modules/reviews/review.types.ts'));
    assert.match(reviews, /REVIEW_DECISIONS = \[\s*\n\s*'APPROVED',\s*\n\s*'REJECTED',\s*\n\s*'REWORK_REQUIRED',/,
      'REVIEW_DECISIONS is the reused decision authority');
  });
});
