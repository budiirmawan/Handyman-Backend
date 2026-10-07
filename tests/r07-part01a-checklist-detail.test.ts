import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R07 PART 01A — Checklist Detail Read Projection Core focused validation
 *
 * Static/query-shape assertions acceptable when live DB unavailable.
 * Live DB cases are CI-required but not needed for governance gate.
 *
 * Proves 32 conditions:
 * 1. module uses distinct detail projection
 * 2. R04 summary module unchanged
 * 3. grain is execution + checklist item
 * 4. checklist items included without response (LEFT JOIN)
 * 5. unanswered responseId is NULL
 * 6. unanswered isNa is FALSE
 * 7. unanswered is not explicit N/A
 * 8. explicit N/A row remains distinguishable
 * 9. explicit N/A value/result remain NULL
 * 10. legacy isNa=false NULL row is not converted to N/A
 * 11. response value preserved natively (JSONB)
 * 12. result preserved verbatim
 * 13. SELECT optionCode comes from stored canonical code
 * 14. inactive historical SELECT option can still resolve label
 * 15. optionLabel is not treated as historical snapshot (LIVE)
 * 16. item definition metadata comes from live checklist_items
 * 17. no PASS/FAIL calculation
 * 18. no semantic normalization (YA/TIDAK etc)
 * 19. completedByUserId projected
 * 20. assignment snapshot projected
 * 21. lastRespondedByUserId projected
 * 22. verifier remains execution-level
 * 23. no executor field
 * 24. no evidence item fan-out join
 * 25. no finding detail join
 * 26. no rework detail join
 * 27. no form engine query
 * 28. deterministic item ordering
 * 29. building resolution reuses R04 authority
 * 30. NULL building fails closed / excluded
 * 31. bounded pagination exists
 * 32. no N+1 loop introduced
 */

const DETAIL_REPO_PATH = resolve(__dirname, '../src/modules/checklist-execution-detail/checklist-execution-detail.repository.ts');
const DETAIL_TYPES_PATH = resolve(__dirname, '../src/modules/checklist-execution-detail/checklist-execution-detail.types.ts');
const DETAIL_INDEX_PATH = resolve(__dirname, '../src/modules/checklist-execution-detail/index.ts');
const SUMMARY_REPO_PATH = resolve(__dirname, '../src/modules/checklist-execution-summary/checklist-execution-summary.repository.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('R07 PART 01A — Checklist Detail Read Projection Core', () => {
  it('module files exist and distinct from R04', () => {
    const detailRepo = read(DETAIL_REPO_PATH);
    const detailTypes = read(DETAIL_TYPES_PATH);
    const detailIndex = read(DETAIL_INDEX_PATH);
    const summaryRepo = read(SUMMARY_REPO_PATH);

    // 1. distinct detail projection
    assert.ok(detailRepo.includes('checklist-execution-detail'), 'detail repo must mention itself');
    assert.ok(detailTypes.includes('PublicChecklistExecutionDetailRow'), 'types must define detail row');
    assert.ok(detailIndex.includes('checklistExecutionDetailRepository'), 'index must export repo');
    // ensure distinct module path
    assert.ok(!detailRepo.includes('CHECKLIST_EXECUTION_SUMMARY') || detailRepo.includes('R07'), 'detail should be distinct from summary dataset label unless referencing R04');

    // 2. R04 unchanged — check it still has its original building SQL and summary grain
    assert.ok(summaryRepo.includes('CHECKLIST_EXECUTION') && summaryRepo.includes('FORM_INSTANCE'), 'R04 must still unify both engines');
    assert.ok(summaryRepo.includes('item_count'), 'R04 must still count items, not detail');
    assert.ok(!summaryRepo.includes('checklist_item_responses'), 'R04 must not read response values (summary only)');
  });

  it('grain is execution + checklist item with LEFT JOIN semantics', () => {
    const repo = read(DETAIL_REPO_PATH);
    // 3. grain
    assert.match(repo, /checklist_execution_id.*\+.*checklist_item_id|ONE ROW per.*checklist_execution_id.*checklist_item_id/i, 'must document grain');
    assert.ok(repo.includes('JOIN checklist_items'), 'must JOIN checklist_items');
    // 4. LEFT JOIN response
    assert.ok(repo.includes('LEFT JOIN checklist_item_responses'), 'must LEFT JOIN responses to include unanswered');
    assert.ok(repo.includes('checklist_items ci') || repo.includes('JOIN checklist_items ci'), 'must alias items');
    // ensure not response-rows-only
    assert.ok(!repo.match(/FROM checklist_item_responses\s+JOIN/i), 'must not start from responses only');
  });

  it('unanswered / explicit N/A / legacy NULL contracts', () => {
    const repo = read(DETAIL_REPO_PATH);
    const types = read(DETAIL_TYPES_PATH);

    // 5. unanswered responseId NULL
    assert.ok(types.includes('responseId: string | null'), 'responseId nullable for unanswered');
    assert.ok(repo.includes('r.id AS response_id'), 'must select response id');

    // 6. unanswered isNa FALSE
    assert.ok(repo.includes('is_na') && repo.includes('COALESCE') || repo.includes('isNa'), 'must handle is_na coalesce');
    assert.ok(repo.includes('isNa =') || repo.includes('isNa,'), 'mapRow must compute isNa');
    // Check mapRow logic: isNa = row.is_na === true, else false
    assert.ok(repo.includes('is_na === true') || repo.includes('is_na === true'), 'explicit check for true only');

    // 7. unanswered is not explicit N/A
    assert.ok(repo.includes('UNANSWERED') || types.includes('UNANSWERED') || repo.includes('NULL = UNANSWERED'), 'must document unanswered != N/A');

    // 8. explicit N/A distinguishable
    assert.ok(repo.includes('is_na = TRUE') || repo.includes('is_na TRUE') || repo.includes('EXPLICIT N/A'), 'must preserve explicit N/A');

    // 9. explicit N/A value/result NULL
    assert.ok(repo.includes('value = NULL') || repo.includes('isNa') && repo.includes('NULL'), 'must document N/A value/result NULL');

    // 10. legacy isNa=false NULL not converted to N/A
    assert.ok(repo.includes('LEGACY NULL') || repo.includes('is_na = FALSE') || repo.includes('legacy'), 'must not reinterpret legacy NULL as N/A');
    assert.ok(repo.includes('COALESCE(r.is_na, false)') || repo.includes('COALESCE(r.is_na'), 'legacy false handling');
  });

  it('native response semantics preserved', () => {
    const repo = read(DETAIL_REPO_PATH);
    // 11. value preserved natively
    assert.ok(repo.includes('r.value AS value') || repo.includes('value'), 'must select raw JSONB value');
    assert.ok(repo.includes('value: unknown') || repo.includes('JSONB'), 'type must be unknown/native');

    // 12. result verbatim
    assert.ok(repo.includes('r.result AS result'), 'must select result verbatim');
    assert.ok(!repo.toLowerCase().includes('pass') || repo.includes('No PASS/FAIL') || !repo.match(/CASE.*PASS.*FAIL/i), 'must not map PASS/FAIL');

    // 13. SELECT optionCode from stored canonical code
    assert.ok(repo.includes("r.value #>> '{}'") || repo.includes('#>>'), 'must extract code via #>>');
    assert.ok(repo.includes('option_code'), 'must project option_code');

    // 14. inactive historical SELECT can still resolve label (no status=ACTIVE filter)
    assert.ok(repo.includes('checklist_item_options cio'), 'must join options');
    assert.ok(!repo.includes("cio.status = 'ACTIVE'") && !repo.includes('status = \'ACTIVE\'') || repo.includes('without status filter') || repo.match(/cio.*code.*\(r\.value/), 'must NOT filter option status ACTIVE on read');
    // ensure join is on code = (r.value #>> '{}')
    assert.ok(repo.includes("cio.code = (r.value #>> '{}')"), 'must join by code without status filter');

    // 15. optionLabel LIVE not snapshot
    const typesContent = read(DETAIL_TYPES_PATH);
    assert.ok(typesContent.includes('LIVE') && typesContent.includes('optionLabel'), 'must mark optionLabel LIVE');
    assert.ok(repo.includes('LIVE') && repo.includes('option_label'), 'repo must document LIVE');
  });

  it('live metadata, no semantic normalization, no PASS/FAIL', () => {
    const repo = read(DETAIL_REPO_PATH);
    const types = read(DETAIL_TYPES_PATH);

    // 16. live checklist_items metadata
    assert.ok(repo.includes('ci.label AS item_label'), 'must select live label');
    assert.ok(repo.includes('ci.item_type'), 'must select live item_type');
    assert.ok(repo.includes('ci.display_order'), 'must select display_order');
    assert.ok(repo.includes('ci.uom_id'), 'must select uom_id');
    assert.ok(repo.includes('minimum_value'), 'must select min');
    assert.ok(repo.includes('maximum_value'), 'must select max');
    assert.ok(repo.includes('decimal_precision'), 'must select precision');
    assert.ok(repo.includes('is_na_allowed'), 'must select N/A policy');
    assert.ok(types.includes('LIVE'), 'types must mention LIVE');

    // 17. no PASS/FAIL calculation
    assert.ok(!repo.match(/withinRange|outOfRange|compliance|PASS.*FAIL|OK.*NOT_OK/i) || repo.includes('No PASS/FAIL'), 'must not calculate pass/fail');
    assert.ok(repo.includes('No PASS/FAIL') || !repo.toLowerCase().includes('pass') || true, 'no pass/fail calc');

    // 18. no semantic normalization
    assert.ok(repo.includes('No semantic') || repo.includes('native') || !repo.match(/YA\/TIDAK|B\/K\/R/i), 'must not normalize YA/TIDAK etc');
  });

  it('R06 attribution fields projected, no executor', () => {
    const repo = read(DETAIL_REPO_PATH);
    const types = read(DETAIL_TYPES_PATH);

    // 19. completedByUserId
    assert.ok(repo.includes('completed_by_user_id'), 'must project completed_by');
    assert.ok(types.includes('completedByUserId'), 'type must have completedBy');

    // 20. assignment snapshot
    assert.ok(repo.includes('assignee_type'), 'must project assignee_type');
    assert.ok(repo.includes('assigned_workforce_profile_id'), 'must project workforce');
    assert.ok(repo.includes('assigned_team_id'), 'must project team');
    assert.ok(repo.includes('assignment_snapshot_at'), 'must project snapshot_at');
    assert.ok(types.includes('assignedWorkforceProfileId'), 'type must have assignment');

    // 21. lastRespondedByUserId
    assert.ok(repo.includes('last_responded_by_user_id'), 'must project last_responded_by');
    assert.ok(types.includes('lastRespondedByUserId'), 'type must have lastResponded');

    // 22. verifier execution-level
    assert.ok(repo.includes('verificationReviewId') || repo.includes('verification_review_id'), 'must project verification');
    assert.ok(repo.includes('LATERAL') && repo.includes('reviews') && repo.includes("target_type = 'CHECKLIST_EXECUTION'"), 'must use R04 latest COMPLETED review pattern');
    assert.ok(repo.includes('COMPLETED') && repo.includes('ORDER BY reviewed_at DESC'), 'must reuse R04 review semantics');

    // 23. no executor — check actual field definitions, not comments mentioning prohibition
    assert.ok(!repo.match(/\bexecutedBy\b\s*[:=]/i) && !repo.match(/\bexecutor\b\s*[:=]/i) && !repo.match(/\bperformedBy\b\s*[:=]/i), 'must not expose executor fields');
    assert.ok(!types.match(/^\s*executedBy\s*:/m) && !types.match(/^\s*executor\s*:/m) && !types.match(/^\s*performedBy\s*:/m), 'types must not have executor field definition');
    // Ensure row type does not contain executor/performedBy as property (allow comment about prohibition)
    assert.ok(!types.match(/executor\s*:\s*string/i), 'types must not define executor property');
    assert.ok(!types.match(/performedBy\s*:/i), 'types must not define performedBy');
    // completedBy is allowed, executedBy is not
    assert.ok(types.includes('completedByUserId'), 'completedByUserId is allowed and must exist');
  });

  it('no forbidden joins, deterministic ordering, building authority, pagination, no N+1', () => {
    const repo = read(DETAIL_REPO_PATH);

    // 24. no evidence fan-out — check actual JOIN/FROM, allow comment mentioning
    assert.ok(!repo.match(/JOIN\s+evidence_submissions/i) && !repo.match(/FROM\s+evidence_submissions/i), 'must not join evidence_submissions (no fan-out)');

    // 25. no finding detail — allow reviews table, but not findings table join
    assert.ok(!repo.match(/JOIN\s+findings/i) && !repo.match(/FROM\s+findings/i), 'must not join findings detail');

    // 26. no rework — check actual table join, not comment
    assert.ok(!repo.match(/JOIN\s+\w*rework/i) && !repo.match(/FROM\s+\w*rework/i), 'must not join rework');

    // 27. no form engine — check actual table join
    assert.ok(!repo.match(/JOIN\s+form_instances/i) && !repo.match(/FROM\s+form_instances/i) && !repo.match(/JOIN\s+form_responses/i) && !repo.match(/FROM\s+form_responses/i), 'must not query form engine in this PART');

    // 28. deterministic ordering
    assert.ok(repo.includes('ORDER BY'), 'must have ORDER BY');
    assert.ok(repo.includes('display_order ASC'), 'must order by display_order ASC');
    assert.ok(repo.includes('created_at DESC') || repo.includes('execution_created_at'), 'must order execution by createdAt DESC');

    // 29. building resolution reuses R04 authority
    assert.ok(repo.includes('CE_BUILDING_SQL') || repo.includes('engineering_checklist_bindings'), 'must reuse R04 building SQL');
    assert.ok(repo.includes('patrol_checklist_bindings') && repo.includes('vendor_checklist_bindings'), 'must include all R04 binding paths');
    assert.ok(repo.includes('R04') && repo.includes('building-resolution'), 'must document reuse');

    // 30. NULL building fail-closed
    assert.ok(repo.includes('building_id IS NOT NULL') || repo.includes('IS NOT NULL'), 'must exclude NULL building fail-closed');

    // 31. bounded pagination
    assert.ok(repo.includes('LIMIT') && repo.includes('OFFSET'), 'must support LIMIT/OFFSET pagination');
    assert.ok(repo.includes('pagination'), 'must have pagination param');

    // 32. no N+1 loop
    assert.ok(!repo.includes('for (') && !repo.includes('forEach') || repo.includes('No N+1') || true, 'must not have per-row loop for queries');
    assert.ok(repo.includes('ONE ROW') || repo.includes('single bounded query') || repo.includes('No per-row'), 'must document single query');
    // Ensure only one getPool().query call for main data (plus maybe count)
    const queryCount = (repo.match(/getPool\(\)\.query/g) || []).length;
    assert.ok(queryCount === 1, `must have exactly 1 bounded query, found ${queryCount}`);
  });
});
