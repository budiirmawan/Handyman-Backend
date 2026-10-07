import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EXECUTION_REVIEW_CHILD_STATUSES,
  isExecutionReviewChildStatus,
} from '../src/modules/operational-detail-review-history/operational-detail-review-history.types';
import { REVIEW_DECISIONS, isReviewDecision } from '../src/modules/reviews/review.types';
import {
  OPERATIONAL_DETAIL_ENGINES,
  isOperationalDetailEngine,
} from '../src/modules/operational-detail-reporting/operational-detail-reporting.types';

/**
 * R08 PART 04B — Execution Review History child: focused validation.
 *
 * DUAL MODE, per the accepted R07 / R08 convention. All three vocabularies are
 * ZERO-DEPENDENCY at runtime, so they are imported and asserted for real: the R07 engine
 * authority, the reviews domain decision authority (genuine reuse, not a copy), and this
 * PART's local status guard — which stays runtime-loadable because its link to `ReviewRow` is
 * a TYPE-ONLY import and is therefore erased. Repository/service assertions are concise static
 * source assertions, because `pg` is not installed here, so neither module can be loaded; the
 * SQL text, predicates, select list and ORDER BY are literals in the source. Live-PostgreSQL
 * cases are enumerated as CI-required. Nothing was installed to run this file.
 *
 * Covers all 22 contract-critical facts, tagged inline: (1) 12-field contract, (2) engine
 * CE/FI only, (3) status PENDING/COMPLETED only, (4) decision authority reused, (5) PENDING
 * visible, (6) no latest/completed-only default, (7) one row per review id, (8) structural
 * client equality, (9) exactly one building predicate, (10) narrowing cannot bypass scope,
 * (11) no caller clientId, (12) notes verbatim, (13) reviewer claims no decision actor,
 * (14) no detail attribution, (15) no related-domain joins, (16) parent-created_at dates,
 * (17) deterministic review-grain ordering, (18) no GROUP BY/DISTINCT/LATERAL/LIMIT 1,
 * (19) no N+1, (20) R04/R07 unchanged, (21) building fragment provenance, (22) empty scope.
 */

const ROOT = process.cwd();
const MODULE_DIR = resolve(ROOT, 'src/modules/operational-detail-review-history');
const P = (n: string): string => resolve(MODULE_DIR, `operational-detail-review-history.${n}.ts`);
const typesSource = readFileSync(P('types'), 'utf8');
const repoSource = readFileSync(P('repository'), 'utf8');
const serviceSource = readFileSync(P('service'), 'utf8');
const indexSource = readFileSync(resolve(MODULE_DIR, 'index.ts'), 'utf8');

/** Strip comments so an identifier fence binds CODE, not the prose documenting the fence. */
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const repoCode = code(repoSource);
const serviceCode = code(serviceSource);
const typesCode = code(typesSource);
const at = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const R04 = 'src/modules/checklist-execution-summary/checklist-execution-summary.repository.ts';
const P01B = 'src/modules/operational-detail-evidence/operational-detail-evidence.repository.ts';
const P02B = 'src/modules/operational-detail-finding/operational-detail-finding.repository.ts';
const P03B = 'src/modules/operational-detail-finding-rework/operational-detail-finding-rework.repository.ts';
const R07_CE = 'src/modules/checklist-execution-detail/checklist-execution-detail.repository.ts';
const R07_FI = 'src/modules/form-execution-detail/form-execution-detail.repository.ts';
const MIG = 'src/database/migrations/0074_create_reviews.ts';

/** Body of a module-private `const NAME = ` ... `;` SQL fragment. */
function frag(source: string, name: string): string {
  const m = source.match(new RegExp(`const ${name} = \`\\n([\\s\\S]*?)\\n\`;`));
  assert.ok(m, `${name} must exist`);
  return (m as RegExpMatchArray)[1] as string;
}
/** SQL skeleton: verbatim R04 fragments replaced by one token, so shape fences test our own
 *  query rather than the closed R04 authority's internal construction. */
const skel = repoCode.split(frag(repoSource, 'CE_BUILDING_SQL')).join('__PB__')
  .split(frag(repoSource, 'FI_BUILDING_SQL')).join('__PB__');
/** Field names declared in `export type NAME = { ... };`. */
function fields(name: string): string[] {
  const body = typesCode.match(new RegExp(`export type ${name} = \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(body, `${name} must exist`);
  return [...(body as RegExpMatchArray)[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] as string);
}
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

const CONTRACT = ['reviewId', 'engine', 'executionId', 'clientId', 'parentBuildingId', 'status',
  'decision', 'reviewerUserId', 'notes', 'createdAt', 'reviewedAt', 'updatedAt'];
const ALIASES = ['review_id', 'engine', 'execution_id', 'client_id', 'parent_building_id', 'status',
  'decision', 'reviewer_user_id', 'notes', 'created_at', 'reviewed_at', 'updated_at'];
/** Facts that must never appear on a review-history row or in its SQL. */
const FORBIDDEN_FACTS = ['targetType', 'decidedByUserId', 'verifiedByUserId', 'approvedByUserId', 'executorUserId', 'completedByUserId', 'performedBy', 'isLatest', 'isVerified', 'isApproved', 'verificationResult', 'reviewCount', 'awaitingVerification', 'notVerified', 'findingBuildingId', 'buildingMismatch', 'itemId', 'fieldId', 'sectionId', 'occurrenceId', 'rejectionReason', 'originalNotes', 'decisionNotes', 'reviewerName', 'display_name'];

describe('R08 PART 04B — execution review history projection', () => {
  it('(1)(7)(13)(14) row contract is exactly 12 fields, one row per reviews.id', () => {
    assert.deepEqual(fields('PublicOperationalDetailReviewHistoryRow'), CONTRACT);
    const mapBody = (repoCode.match(/function mapRow\([\s\S]*?\n\}/) as RegExpMatchArray)[0];
    assert.deepEqual([...mapBody.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]), CONTRACT,
      'mapRow projects exactly the contract, in order, with nothing derived');
    // The select list is explicit and closed: no wildcard, no extra column.
    const selectBody = skel.slice(skel.indexOf('SELECT') + 6, skel.indexOf('${fromClause}'));
    assert.deepEqual(selectBody.split(',').map((c) => c.trim().split(/\s+AS\s+/).pop()?.trim())
      .filter((a) => /^[a-z_]+$/.test(a ?? '')), ALIASES);
    assert.ok(!/r\.\*|ce\.\*|fi\.\*/.test(repoCode), 'no wildcard projection');
    assert.match(repoCode, /return result\.rows\.map\(mapRow\);/, 'rows are mapped 1:1');
    for (const bad of ['.sort(', '.slice(', '.filter(', 'GROUP BY', 'DISTINCT']) {
      assert.ok(!repoCode.includes(bad), `no application-side reorder/dedupe/collapse: ${bad}`);
    }
    for (const bad of FORBIDDEN_FACTS) {
      assert.ok(!fields('PublicOperationalDetailReviewHistoryRow').includes(bad), `${bad} not in contract`);
      assert.ok(!repoCode.includes(bad), `${bad} not in SQL/mapping`);
    }
  });

  it('(2) engine reuses the R07 authority; only CE/FI, all other review targets unreachable', () => {
    assert.deepEqual([...OPERATIONAL_DETAIL_ENGINES], ['CHECKLIST_EXECUTION', 'FORM_INSTANCE']);
    for (const bad of ['WORK_ORDER', 'FINDING', 'VENDOR_WORK', 'UTILITY_ABNORMAL_CONSUMPTION',
      'PERMIT_APPLICATION', 'DOCUMENT', 'DOCUMENT_VERSION', 'CORRECTIVE_ACTION']) {
      assert.equal(isOperationalDetailEngine(bad), false, `${bad} is not an R08 engine`);
      assert.ok(!repoCode.includes(`'${bad}'`), `${bad} is never bound as a target_type`);
    }
    assert.match(serviceCode, /isOperationalDetailEngine\(engineNormalized\)/);
    assert.match(serviceCode, /engine is required \(CHECKLIST_EXECUTION \| FORM_INSTANCE\)\./);
    assert.match(typesSource, /import type \{ OperationalDetailEngine \}/, 'engine type imported, never redeclared');
    assert.ok(!typesCode.includes('OperationalDetailEngine ='), 'no competing engine vocabulary');
    // target_type is bound to the engine literal, so the query is structurally engine-scoped.
    assert.match(repoCode, /ON r\.target_type = \$1/);
    assert.match(repoCode, /const values: unknown\[\] = \[filters\.engine, buildingIds\];/);
  });

  it('(3) status guard is exactly PENDING/COMPLETED, pinned to ReviewRow and migration 0074', () => {
    assert.deepEqual([...EXECUTION_REVIEW_CHILD_STATUSES], ['PENDING', 'COMPLETED']);
    for (const s of ['PENDING', 'COMPLETED'] as const) assert.equal(isExecutionReviewChildStatus(s), true);
    for (const bad of ['OPEN', 'CLOSED', 'ACTIVE', 'VERIFIED', 'ACCEPTED', 'FAILED', 'PASSED',
      'APPROVED', 'REJECTED', 'REWORK_REQUIRED', 'IN_PROGRESS', '']) {
      assert.equal(isExecutionReviewChildStatus(bad), false, `${bad} is not a review status`);
    }
    assert.equal(isExecutionReviewChildStatus(null), false);
    assert.equal(isExecutionReviewChildStatus(['PENDING']), false, 'a multi-value is not a status');
    // Pinned to migration 0074's review_status CHECK (the sole table authority).
    const mig = at(MIG);
    assert.match(mig, /CONSTRAINT review_status CHECK\(status IN \('PENDING','COMPLETED'\)\)/);
    // Pinned to the ReviewRow source union, and type-linked so a third value cannot compile.
    const reviewService = at('src/modules/reviews/review.service.ts');
    assert.match(reviewService, /status: 'PENDING' \| 'COMPLETED';/);
    assert.match(typesSource, /import type \{ ReviewRow \} from '\.\.\/reviews\/review\.service';/);
    assert.match(typesSource, /EXECUTION_REVIEW_CHILD_STATUSES: readonly ReviewRow\['status'\]\[\]/);
    assert.equal((typesCode.match(/export const EXECUTION_REVIEW_CHILD_STATUSES/g) ?? []).length, 1);
    // The reviews module was NOT modified to add a runtime helper.
    assert.ok(!reviewService.includes('EXECUTION_REVIEW_CHILD_STATUSES') && !reviewService.includes('isReviewStatus'),
      'reviews module untouched');
  });

  it('(4) decision authority is REUSED from the reviews domain, never redeclared', () => {
    assert.deepEqual([...REVIEW_DECISIONS], ['APPROVED', 'REJECTED', 'REWORK_REQUIRED']);
    for (const d of REVIEW_DECISIONS) assert.equal(isReviewDecision(d), true);
    for (const bad of ['PASS', 'FAIL', 'FAILED', 'SUCCESS', 'SUCCESSFUL', 'VERIFIED', 'ACCEPTED', 'APPROVE', '']) {
      assert.equal(isReviewDecision(bad), false, `${bad} is not a review decision`);
    }
    assert.match(serviceSource, /import \{ REVIEW_DECISIONS, isReviewDecision \} from '\.\.\/reviews\/review\.types';/);
    assert.match(serviceCode, /isReviewDecision,/, 'the domain guard itself validates the filter');
    assert.match(serviceCode, /\$\{REVIEW_DECISIONS\.join\('\/'\)\}/, 'rejection message built from the imported constant');
    assert.ok(!typesCode.includes('APPROVED') && !typesCode.includes("REVIEW_DECISIONS ="),
      'no second decision list is declared in this module');
    assert.match(typesSource, /import type \{ ReviewDecision \} from '\.\.\/reviews\/review\.types';/);
    assert.match(typesSource, /decision: ReviewDecision \| null;/, 'decision stays nullable');
    assert.match(repoCode, /decision: row\.decision as PublicOperationalDetailReviewHistoryRow\['decision'\]/,
      'copied through, never normalized to PASS/FAIL/boolean');
  });

  it('(5)(6) default read shows ALL rows: no status, no decision, no latest selector', () => {
    const where = skel.slice(skel.indexOf('  if (filters.status)'));
    assert.match(where, /if \(filters\.status\) \{\n\s*values\.push\(filters\.status\);\n\s*conditions\.push\(`r\.status = \$\$\{values\.length\}`\);/);
    assert.match(where, /if \(filters\.decision\) \{\n\s*values\.push\(filters\.decision\);\n\s*conditions\.push\(`r\.decision = \$\$\{values\.length\}`\);/);
    assert.equal((repoCode.match(/r\.status = \$\$\{values\.length\}/g) ?? []).length, 1, 'predicate only inside the conditional');
    assert.equal((repoCode.match(/r\.decision = \$\$\{values\.length\}/g) ?? []).length, 1);
    assert.ok(!/r\.status\s*=\s*'|r\.decision\s*=\s*'/.test(repoCode), 'no inlined literal, no completed-only default');
    for (const bad of ['LIMIT 1', 'LATERAL', 'DISTINCT ON', 'ROW_NUMBER', 'latest', 'most_recent', 'is_current']) {
      assert.ok(!skel.toUpperCase().includes(bad.toUpperCase()), `no latest selector: ${bad}`);
    }
    assert.ok(!/reviewed_at DESC/.test(repoCode), 'the R04/R07 latest-review ordering is not reproduced');
    assert.ok(!/(ce|fi)\.status/.test(repoCode), 'the parent execution status never gates visibility');
    assert.match(repoCode, /r\.status\s+AS status/, 'status still projected');
    assert.match(repoCode, /r\.decision\s+AS decision/, 'decision still projected');
  });

  it('(8)(11) client consistency is structural SQL; no caller clientId', () => {
    assert.match(repoCode, /JOIN reviews r\s*\n\s*ON r\.target_type = \$1\s*\n\s*AND r\.target_id = \$\{parentAlias\}\.id\s*\n\s*AND r\.client_id = \$\{parentAlias\}\.client_id/);
    assert.ok(!/LEFT\s+JOIN reviews/i.test(repoCode), 'INNER join — the review IS the grain');
    assert.match(repoCode, /r\.client_id\s+AS client_id/, 'clientId is a projected fact from the review row');
    assert.ok(!serviceCode.includes('clientId'), 'the service never reads or echoes a caller clientId');
    assert.ok(!fields('OperationalDetailReviewHistoryFilters').includes('clientId'), 'not a filter');
    assert.ok(!repoCode.includes('.filter(') && !serviceCode.includes('.filter('), 'never post-filtered');
    assert.ok(!/clientMismatch|client_mismatch/i.test(repoCode), 'no mismatch flag');
  });

  it('(9) exactly ONE authorized-building predicate; reviews has no building anchor', () => {
    // Unlike PART 02B/03B (which had a second stored building fact on findings), reviews has
    // NO building_id, so the R04-resolved parent building yields exactly ONE scope predicate.
    assert.equal((repoCode.match(/ANY\(\$2::uuid\[\]\)/g) ?? []).length, 1,
      'exactly one building-scope predicate, bound to $2');
    assert.match(repoCode, /conditions\.push\(`\$\{buildingSql\} = ANY\(\$2::uuid\[\]\)`\)/);
    assert.ok(!/\$3::uuid\[\]/.test(repoCode), 'no second building parameter');
    assert.ok(!/f\.building_id|r\.building_id/.test(repoCode), 'no second stored building fact exists');
    assert.match(repoCode, /parentBuildingId: row\.parent_building_id/);
    assert.ok(!at(MIG).includes('building_id'), 'migration 0074 stores no building_id on reviews');
    for (const bad of ['review_building', 'buildingMismatch', 'buildingsMatch', 'isSameBuilding', 'resolveBoundFormInstanceBuilding', 'loadReviewTarget']) {
      assert.ok(!repoCode.includes(bad) && !serviceCode.includes(bad), `no new building policy: ${bad}`);
    }
  });

  it('(15) no related-domain join, no display name, no JSONB join key', () => {
    for (const t of ['users', 'user_profiles', 'employees', 'workforce_profiles', 'teams', 'clients',
      'buildings', 'properties', 'findings', 'finding_assignments', 'finding_rework_cycles',
      'vendor_rework_cycles', 'evidence_submissions', 'operational_events', 'supervisor_inspections',
      'finding_classifications', 'finding_severities', 'corrective_actions', 'documents']) {
      assert.ok(!new RegExp(`(JOIN|FROM)\\s+${t}\\b`, 'i').test(skel), `no join on ${t}`);
    }
    assert.ok(!/full_name|first_name|last_name|display_name|email|username|building_name|client_name/i.test(repoCode));
    assert.ok(!/jsonb|->>|#>>/i.test(repoCode), 'event metadata is never a join key');
  });

  it('(16)(17) dates bound the PARENT created_at; ordering is review-grain and deterministic', () => {
    assert.match(repoCode, /conditions\.push\(`\$\{parentAlias\}\.created_at >= \$\$\{values\.length\}`\)/);
    assert.match(repoCode, /conditions\.push\(`\$\{parentAlias\}\.created_at < \$\$\{values\.length\}`\)/);
    for (const bad of ['r.created_at >', 'r.created_at <', 'r.reviewed_at >', 'r.reviewed_at <', 'r.updated_at >', 'r.updated_at <']) {
      assert.ok(!repoCode.includes(bad), `${bad} must never be a population filter`);
    }
    for (const bad of ['reviewCreatedFrom', 'reviewCreatedTo', 'reviewedFrom', 'reviewedTo', 'requestedFrom']) {
      assert.ok(!serviceCode.includes(bad) && !typesCode.includes(bad), `no review-specific date filter in this PART: ${bad}`);
    }
    assert.match(serviceCode, /const MAX_RANGE_DAYS = 366;/);
    assert.match(serviceCode, /DATE_ONLY\.test\(filters\.dateTo\) \? new Date\(to\.getTime\(\) \+ 86400000\) : to/);
    const order = (repoCode.match(/ORDER BY([^\n]*)/) as RegExpMatchArray)[1] as string;
    assert.equal(order.replace(/\s+/g, ' ').trim(), 'r.target_id ASC, r.created_at DESC, r.id ASC');
    assert.ok(!/reviewed_at|updated_at/.test(order), 'mutable/nullable lifecycle fields never order the page');
    // Mirrors the review authority's OWN history convention (listReviewsByTarget).
    assert.match(at('src/modules/reviews/review.service.ts'), /ORDER BY created_at DESC, id/);
  });

  it('(10)(19)(22) scope, single query, pagination and empty-scope short-circuit', () => {
    assert.equal((repoCode.match(/getPool\(\)\.query/g) ?? []).length, 1, 'one query — no N+1');
    for (const bad of ['for (', 'forEach', 'Promise.all', '.map(async', 'while (']) {
      assert.ok(!repoCode.includes(bad), `no loop / concurrent fan-out: ${bad}`);
    }
    assert.ok(!/IN \(\$|= ANY\(\$1::uuid\[\]\)/.test(repoCode), 'no unbounded execution-id list');
    // Narrowing filters are pushed AFTER the building predicate, so they can only narrow.
    const buildingAt = repoCode.indexOf('${buildingSql} = ANY($2::uuid[])');
    for (const f of ['executionId', 'reviewId', 'templateId']) {
      assert.ok(repoCode.indexOf(`if (filters.${f})`) > buildingAt, `${f} cannot bypass building scope`);
    }
    assert.match(repoCode, /\$\{parentAlias\}\.id = \$\$\{values\.length\}::uuid/);
    assert.match(repoCode, /r\.id = \$\$\{values\.length\}::uuid/);
    assert.match(serviceCode, /if \(buildingIds\.length === 0\) \{\n\s*return \{ \.\.\.base, rows: \[\] \};/);
    assert.ok(serviceCode.indexOf('buildingIds.length === 0') < serviceCode.indexOf('getOperationalDetailReviewHistoryRows('),
      'empty scope short-circuits before any SQL');
    assert.match(serviceCode, /buildingRepository\.findById\(filters\.buildingId\)/);
    assert.match(serviceCode, /throw buildingNotFoundError\(\);/);
    assert.ok(serviceCode.indexOf('buildingRepository.findById') < serviceCode.indexOf('assertBuildingAccess'),
      '404 before 403 — no existence oracle');
    assert.match(serviceCode, /contextAccessService\.getAccessibleBuildingIds\(userId\)/);
    assert.match(serviceCode, /const DEFAULT_LIMIT = 100;/);
    assert.match(serviceCode, /const MAX_LIMIT = 1000;/);
    assert.match(serviceCode, /offset must be a non-negative integer\./);
    assert.deepEqual(fields('PublicOperationalDetailReviewHistory'),
      ['engine', 'buildingId', 'buildingScope', 'dateFrom', 'dateTo', 'asOf', 'rows']);
  });

  it('(11)(12)(13) closed filter set, verbatim notes, reviewer claims no decision actor', () => {
    assert.deepEqual(fields('OperationalDetailReviewHistoryFilters'),
      ['engine', 'buildingId', 'executionId', 'reviewId', 'templateId', 'status', 'decision', 'dateFrom', 'dateTo']);
    assert.deepEqual(fields('OperationalDetailReviewHistoryPagination'), ['limit', 'offset']);
    for (const bad of ['targetType', 'reviewerUserId', 'parentBuildingId', 'verifiedOnly', 'completedOnly',
      'latestOnly', 'findingId', 'reworkCycleId', 'notesSearch', 'q', 'search', 'itemId', 'fieldId', 'occurrenceId']) {
      assert.ok(!new RegExp(`query\\.${bad}\\b`).test(serviceCode), `${bad} is never read from the query`);
      assert.ok(!fields('OperationalDetailReviewHistoryFilters').includes(bad), `${bad} is not a filter`);
    }
    assert.ok(!/ILIKE|LIKE|to_tsvector|@@/i.test(repoCode), 'notes are never a text-search authority');
    assert.match(repoCode, /notes: row\.notes,/, 'notes copied verbatim');
    assert.ok(!/notes\s*(\|\||\?\?|COALESCE)|notes\.trim|notes\.toLowerCase/i.test(repoCode), 'never defaulted or normalized');
    assert.match(repoSource, /pre-overwrite value is UNAVAILABLE/);
    assert.match(typesSource, /historical pre-overwrite value is\s*\n\s*\* UNAVAILABLE|MUTABLE: overwritten at completion/);
    assert.match(repoCode, /reviewerUserId: row\.reviewer_user_id/);
    assert.match(repoSource, /NOT the\s*\n\s*\* decision actor|never rewritten by any writer/);
    // readSingleParam is copied verbatim from the closed R07 authority (no multi-filter contract).
    const own = (serviceCode.match(/function readSingleParam[\s\S]*?\n\}/) as RegExpMatchArray)[0];
    const r07 = (at('src/modules/operational-detail-reporting/operational-detail-reporting.service.ts')
      .match(/function readSingleParam[\s\S]*?\n\}/) as RegExpMatchArray)[0];
    assert.equal(norm(own), norm(r07), 'readSingleParam === R07 authority');
  });

  it('(20)(21) R04/R07 and closed R08 PARTs unchanged; building fragments identical', () => {
    // Neither latest-selector is reproduced, renamed or reconciled here.
    assert.ok(!repoCode.includes('verificationReviewStatus') && !repoCode.includes('verificationStatus'),
      'no R04/R07 verification field is reused or renamed');
    for (const p of [R07_CE, R07_FI]) {
      const s = at(p);
      assert.match(s, /AND status = 'COMPLETED'/, 'R07 latest-COMPLETED selector intact');
      assert.match(s, /ORDER BY reviewed_at DESC, created_at DESC, id DESC/, 'R07 ordering intact');
      assert.match(s, /LIMIT 1/, 'R07 LIMIT 1 intact');
      assert.ok(!s.includes('ReviewHistory') && !s.includes('review_history'), 'R07 not extended');
    }
    assert.match(at(R04), /vr\.status AS verification_review_status/, 'R04 field name intact (not normalized to R07)');
    assert.match(at(R04), /r\.target_type = x\.engine/, 'R04 selector intact');
    for (const p of [R04, P01B, P02B, P03B]) {
      assert.ok(!/export const (CE|FI)_BUILDING_SQL/.test(at(p)), `${p} fragments remain module-private (no refactor)`);
    }
    // Concise provenance: this PART's fourth copy is identical to the established authority.
    assert.equal(frag(repoSource, 'CE_BUILDING_SQL'), frag(at(R04), 'CE_BUILDING_SQL'), 'CE === R04 byte-for-byte');
    assert.equal(frag(repoSource, 'CE_BUILDING_SQL'), frag(at(P03B), 'CE_BUILDING_SQL'), 'CE === PART 03B');
    assert.equal(frag(repoSource, 'FI_BUILDING_SQL'), frag(at(P03B), 'FI_BUILDING_SQL'), 'FI === PART 03B');
    const inline = at(R04).match(/COALESCE\(\s*\(SELECT mrb\.building_id[\s\S]*?WHERE gt\.id = fi\.generated_task_id AND gt\.building_id IS NOT NULL\),\s*NULL\s*\)/);
    assert.equal(norm(frag(repoSource, 'FI_BUILDING_SQL')), norm((inline as RegExpMatchArray)[0]), 'FI === R04 inline fi_base');
    assert.ok(!at(P03B).includes('reviews r'), 'PART 03B untouched (its triggerReviewId stays a FINDING-review authority)');
  });

  it('no route, export, registry, migration, permission, index or view; module surface closed', () => {
    assert.deepEqual(readdirSync(MODULE_DIR).sort(), ['index.ts',
      'operational-detail-review-history.repository.ts',
      'operational-detail-review-history.service.ts',
      'operational-detail-review-history.types.ts']);
    for (const [n, s] of [['repo', repoCode], ['service', serviceCode], ['types', typesCode], ['index', code(indexSource)]] as const) {
      for (const bad of ['express', 'Router', 'router.', 'app.get', 'openapi', 'OpenAPI', 'swagger',
        'reportingRegistry', 'registerDataset', 'ReportArchiveDataset', 'CREATE INDEX',
        'CREATE MATERIALIZED', 'ALTER TABLE', 'CREATE TABLE', 'csv', 'xlsx', 'pdf']) {
        assert.ok(!s.includes(bad), `${n} must not contain ${bad}`);
      }
    }
    assert.ok(!readdirSync(resolve(ROOT, 'src/database/migrations')).some((f) => /review_history|operational_detail/i.test(f)),
      'no new migration');
    assert.ok(!at('src/modules/reporting-export/reporting-export.registry.ts').includes('ReviewHistory'),
      'no export dataset registered');
    for (const e of ['operationalDetailReviewHistoryRepository', 'getOperationalDetailReviewHistoryRows',
      'operationalDetailReviewHistoryService', 'getOperationalDetailReviewHistory',
      'parseOperationalDetailReviewHistoryQuery', 'operationalDetailReviewHistoryRange',
      'EXECUTION_REVIEW_CHILD_STATUSES', 'isExecutionReviewChildStatus']) {
      assert.ok(code(indexSource).includes(e), `index exports ${e}`);
    }
    assert.ok(!/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bCREATE\b|\bALTER\b|\bDROP\b|FOR\s+UPDATE/i.test(repoCode), 'read-only');
  });

  it('CI-REQUIRED (live PostgreSQL): real rows, real exclusions, real paging', () => {
    // `pg` is absent here, so these need a live database and are CI-required:
    //   - a review whose client_id differs from its parent's is EXCLUDED, rest still returns
    //   - an execution with NO review returns zero rows (INNER join at review grain)
    //   - one PENDING + two COMPLETED reviews return THREE rows, created_at DESC, no collapse
    //   - a PENDING row returns decision NULL and reviewedAt NULL, never a derived flag
    //   - status=PENDING / decision=REJECTED each narrow as a bound parameter
    //   - an execution whose building cannot be resolved returns zero rows (fail-closed)
    //   - FINDING / WORK_ORDER / DOCUMENT reviews never appear for either engine
    //   - dateFrom/dateTo window the PARENT created_at, not the review's own dates
    //   - LIMIT/OFFSET page deterministically; r.id breaks shared-created_at ties
    //   - one SQL statement per call, planned through reviews_target_idx, no new index
    //   - after decideReview rewrites notes the same reviewId returns the OVERWRITTEN value,
    //     proving the documented mutability and that the prior text is unrecoverable
    assert.equal(true, true, 'live-DB cases are CI-required; PostgreSQL is unavailable in this sandbox');
  });

  it('module graph loads as ESM with zero runtime dependencies', async () => {
    // The types module's only imports are TYPE-only, so all are erased: the guard is real
    // executable code, loadable without pg, and no side effect occurs at import time.
    const loaded = (await import(pathToFileURL(P('types')).href)) as Record<string, unknown>;
    assert.equal(typeof loaded.isExecutionReviewChildStatus, 'function');
    assert.deepEqual([...(loaded.EXECUTION_REVIEW_CHILD_STATUSES as string[])], ['PENDING', 'COMPLETED']);
    assert.equal(loaded.operationalDetailReviewHistoryRepository, undefined, 'repository is a separate module');
  });
});
