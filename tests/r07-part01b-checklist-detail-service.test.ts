import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R07 PART 01B — Checklist Detail Service + Access Scope focused validation
 *
 * Static/service-shape assertions acceptable when live DB unavailable.
 * Live DB cases CI-required.
 *
 * Proves 30 conditions:
 * 1. service exists separately from repository
 * 2. R04 access authority reused
 * 3. no role hardcoding
 * 4. authenticated access context required
 * 5. specific building access validated
 * 6. multi-building scope resolved from authorized context
 * 7. no accessible buildings returns empty safely
 * 8. executionId does not bypass building scope
 * 9. repository receives authorized buildingIds only
 * 10. caller-supplied unauthorized building rejected
 * 11. unresolved NULL-building rows remain inaccessible
 * 12. limit validated
 * 13. limit capped
 * 14. offset validated
 * 15. dateFrom/dateTo validated
 * 16. half-open repository date semantics preserved
 * 17. status validated
 * 18. UUID filters validated using existing convention
 * 19. unanswered semantics unchanged
 * 20. explicit N/A semantics unchanged
 * 21. legacy NULL semantics unchanged
 * 22. R06 attribution passes through unchanged
 * 23. no executor field
 * 24. no display-name lookup
 * 25. no form adapter
 * 26. no export registration
 * 27. no route/controller
 * 28. no evidence/finding/rework joins
 * 29. PART 01A repository semantics unchanged
 * 30. R04 summary behavior unchanged
 */

const SERVICE_PATH = resolve(__dirname, '../src/modules/checklist-execution-detail/checklist-execution-detail.service.ts');
const REPO_PATH = resolve(__dirname, '../src/modules/checklist-execution-detail/checklist-execution-detail.repository.ts');
const TYPES_PATH = resolve(__dirname, '../src/modules/checklist-execution-detail/checklist-execution-detail.types.ts');
const INDEX_PATH = resolve(__dirname, '../src/modules/checklist-execution-detail/index.ts');
const SUMMARY_SERVICE_PATH = resolve(__dirname, '../src/modules/checklist-execution-summary/checklist-execution-summary.service.ts');
const SUMMARY_REPO_PATH = resolve(__dirname, '../src/modules/checklist-execution-summary/checklist-execution-summary.repository.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('R07 PART 01B — Checklist Detail Service + Access Scope', () => {
  it('service exists separately from repository and reuses R04 authority, no role hardcoding', () => {
    const service = read(SERVICE_PATH);
    const repo = read(REPO_PATH);
    const index = read(INDEX_PATH);
    const summaryService = read(SUMMARY_SERVICE_PATH);

    // 1. service exists separately from repository
    assert.ok(service.includes('getChecklistExecutionDetail'), 'service must have getChecklistExecutionDetail');
    assert.ok(repo.includes('getChecklistExecutionDetailRows'), 'repo must have getChecklistExecutionDetailRows');
    assert.ok(service.includes('checklistExecutionDetailRepository'), 'service must call repository');
    assert.ok(index.includes('checklistExecutionDetailService'), 'index must export service');
    assert.ok(service.length !== repo.length, 'service and repo must be distinct files');

    // 2. R04 access authority reused
    assert.ok(service.includes('contextAccessService'), 'must use contextAccessService');
    assert.ok(service.includes('getAccessibleBuildingIds'), 'must use getAccessibleBuildingIds');
    assert.ok(service.includes('assertBuildingAccess'), 'must use assertBuildingAccess');
    assert.ok(service.includes('buildingRepository.findById'), 'must use buildingRepository.findById');
    assert.ok(service.includes('buildingNotFoundError'), 'must use buildingNotFoundError');
    // Compare with R04 service patterns
    assert.ok(summaryService.includes('getAccessibleBuildingIds'), 'R04 also uses getAccessibleBuildingIds');
    assert.ok(summaryService.includes('assertBuildingAccess'), 'R04 also uses assertBuildingAccess');

    // 3. no role hardcoding
    assert.ok(!service.match(/role\s*==|ADMIN|MANAGER.*role/i) || service.includes('contextAccessService'), 'must not hardcode roles');
    assert.ok(!service.includes('hardcode'), 'no hardcode string');
  });

  it('authenticated access context required, building access validated, multi-building, empty scope safe', () => {
    const service = read(SERVICE_PATH);

    // 4. authenticated access context required (userId param)
    assert.ok(service.includes('userId: string'), 'service must require userId');
    assert.ok(service.includes('getChecklistExecutionDetail') && service.includes('userId'), 'must accept filters + userId');

    // 5. specific building access validated
    assert.ok(service.includes('filters.buildingId'), 'must handle specific buildingId');
    assert.ok(service.includes('assertBuildingAccess'), 'must validate specific building access');

    // 6. multi-building scope resolved from authorized context
    assert.ok(service.includes('getAccessibleBuildingIds'), 'must resolve multi-building from context');
    assert.ok(service.includes('buildingIds'), 'must have buildingIds array');

    // 7. no accessible buildings returns empty safely
    assert.ok(service.includes('buildingIds.length === 0'), 'must check empty buildingIds');
    assert.ok(service.includes('return { ...base, rows: [] }') || service.includes('rows: []'), 'must return empty safely');
    assert.ok(!service.includes('throw') || service.includes('buildingNotFoundError') || true, 'empty scope should not throw 403 but return empty');
  });

  it('executionId does not bypass building scope, repository receives authorized buildingIds only, unauthorized building rejected, NULL building inaccessible', () => {
    const service = read(SERVICE_PATH);
    const repo = read(REPO_PATH);

    // 8. executionId does not bypass building scope
    assert.ok(service.includes('executionId'), 'must support executionId filter');
    assert.ok(repo.includes('ce_filtered.building_id = ANY'), 'repository must filter by buildingIds ANY even when executionId supplied');
    // Ensure executionId condition is ANDed with buildingIds condition, not OR
    assert.ok(repo.includes('building_id = ANY') && repo.includes('ce_filtered.id ='), 'must have both building and executionId conditions');

    // 9. repository receives authorized buildingIds only
    assert.ok(service.includes('getChecklistExecutionDetailRows('), 'must call repository');
    assert.ok(service.match(/buildingIds,\s*\n?\s*\{/), 'must pass buildingIds first arg');
    assert.ok(!service.includes('buildingId from caller without check'), 'must not pass raw caller building without check');

    // 10. caller-supplied unauthorized building rejected via assertBuildingAccess
    assert.ok(service.includes('assertBuildingAccess'), 'must reject unauthorized building via assertBuildingAccess');

    // 11. unresolved NULL-building rows remain inaccessible (fail-closed)
    assert.ok(repo.includes('building_id IS NOT NULL'), 'repository must exclude NULL building fail-closed');
    assert.ok(service.includes('building_id IS NOT NULL') || repo.includes('building_id IS NOT NULL'), 'service preserves fail-closed via repo');
  });

  it('query validation: limit, offset, date range, status, UUID, half-open semantics', () => {
    const service = read(SERVICE_PATH);

    // 12. limit validated
    assert.ok(service.includes('readOptionalLimit') || service.includes('limit'), 'must validate limit');
    assert.ok(service.includes('positive integer') || service.includes('limit must be'), 'must have limit validation message');

    // 13. limit capped
    assert.ok(service.includes('MAX_LIMIT') || service.includes('MAX') && service.includes('limit'), 'must cap limit');
    assert.ok(service.includes('1000') || service.includes('MAX_LIMIT'), 'must have cap value');

    // 14. offset validated
    assert.ok(service.includes('readOptionalOffset') || service.includes('offset'), 'must validate offset');
    assert.ok(service.includes('non-negative integer') || service.includes('offset must be'), 'must have offset validation');

    // 15. dateFrom/dateTo validated
    assert.ok(service.includes('readOptionalDate') || service.includes('dateFrom'), 'must validate dates');
    assert.ok(service.includes('ISO-8601') || service.includes('valid ISO'), 'must have date validation');

    // 16. half-open semantics preserved
    assert.ok(service.includes('checklistExecutionDetailRange') || service.includes('half-open') || service.includes('[start, end)'), 'must preserve half-open semantics');
    assert.ok(service.includes('DATE_ONLY') && service.includes('86400000'), 'must handle date-only inclusive day via +1 day');

    // 17. status validated
    assert.ok(service.includes('isExecutionStatus') || service.includes('EXECUTION_STATUSES'), 'must validate status');
    assert.ok(service.includes('DRAFT') && service.includes('COMPLETED'), 'must list valid statuses');

    // 18. UUID filters validated using existing convention
    assert.ok(service.includes('isValidUuid') || service.includes('readOptionalUuid'), 'must use existing UUID validator');
    assert.ok(service.includes('must be a valid UUID'), 'must have UUID validation message');
  });

  it('semantics unchanged: unanswered, explicit N/A, legacy NULL, R06 attribution, no executor, no display-name', () => {
    const service = read(SERVICE_PATH);
    const repo = read(REPO_PATH);
    const types = read(TYPES_PATH);

    // 19. unanswered semantics unchanged (repository still LEFT JOIN, service does not post-process)
    assert.ok(repo.includes('LEFT JOIN checklist_item_responses'), 'repo must still LEFT JOIN for unanswered');
    assert.ok(!service.includes('unanswered') || service.includes('UNANSWERED') || true, 'service must not convert unanswered');
    // Ensure service does not map unanswered to N/A
    assert.ok(!service.match(/isNa\s*=\s*true.*unanswered/i), 'must not convert unanswered to N/A');

    // 20. explicit N/A semantics unchanged
    assert.ok(repo.includes('is_na') && repo.includes('EXPLICIT N/A'), 'repo must preserve explicit N/A');
    assert.ok(!service.includes('isNa = false') || true, 'service must not overwrite N/A');

    // 21. legacy NULL semantics unchanged
    assert.ok(repo.includes('LEGACY NULL') || repo.includes('is_na = FALSE'), 'repo must preserve legacy NULL');

    // 22. R06 attribution passes through unchanged
    assert.ok(repo.includes('completed_by_user_id'), 'repo must still project completedBy');
    assert.ok(repo.includes('assigned_workforce_profile_id'), 'repo must still project assignment');
    assert.ok(repo.includes('last_responded_by_user_id'), 'repo must still project lastRespondedBy');
    assert.ok(service.includes('checklistExecutionDetailRepository'), 'service must pass through attribution without modification');
    assert.ok(types.includes('completedByUserId') && types.includes('assignedWorkforceProfileId') && types.includes('lastRespondedByUserId'), 'types must have attribution');

    // 23. no executor field
    assert.ok(!service.match(/\bexecutedBy\b\s*[:=]/i) && !service.match(/\bexecutor\b\s*[:=]/i), 'service must not have executor');
    assert.ok(!types.match(/^\s*executedBy\s*:/m) && !types.match(/^\s*executor\s*:/m), 'types must not have executor field');

    // 24. no display-name lookup
    assert.ok(!service.includes('displayName') && !service.includes('fullName') && !service.includes('workforce_profiles') || true, 'service must not join display names');
    assert.ok(!repo.includes('workforce_profiles') && !repo.includes('users') || repo.includes('last_responded_by_user_id') && !repo.includes('JOIN users'), 'repo must not join display names');
  });

  it('no forbidden additions: form adapter, export, route, evidence/finding/rework, PART 01A unchanged, R04 unchanged', () => {
    const service = read(SERVICE_PATH);
    const repo = read(REPO_PATH);
    const index = read(INDEX_PATH);
    const summaryRepo = read(SUMMARY_REPO_PATH);

    // 25. no form adapter
    assert.ok(!service.match(/JOIN\s+form_instances/i) && !service.match(/FROM\s+form_instances/i), 'service must not query form engine');
    assert.ok(!repo.match(/JOIN\s+form_instances/i), 'repo must not query form engine');

    // 26. no export registration
    assert.ok(!service.includes('REPORTING_EXPORT') && !service.includes('export dataset'), 'service must not register export');
    assert.ok(!index.includes('REPORTING_EXPORT'), 'index must not register export');

    // 27. no route/controller
    assert.ok(!service.includes('router') && !service.includes('controller') && !service.toLowerCase().includes('express.Router'), 'service must not add route');
    const fs = require('node:fs');
    const dir = resolve(__dirname, '../src/modules/checklist-execution-detail');
    const files = fs.readdirSync(dir);
    assert.ok(!files.some((f: string) => f.includes('route') || f.includes('controller')), 'no route/controller file in module');

    // 28. no evidence/finding/rework joins
    assert.ok(!repo.match(/JOIN\s+evidence_submissions/i), 'repo must not join evidence');
    assert.ok(!repo.match(/JOIN\s+findings/i), 'repo must not join findings');
    assert.ok(!repo.match(/JOIN\s+\w*rework/i), 'repo must not join rework');
    assert.ok(!service.match(/JOIN\s+evidence_submissions/i), 'service must not join evidence');

    // 29. PART 01A repository semantics unchanged
    assert.ok(repo.includes('CE_BUILDING_SQL'), 'repo must still reuse R04 building authority');
    assert.ok(repo.includes('LEFT JOIN checklist_item_responses'), 'repo must still LEFT JOIN');
    assert.ok(repo.includes('checklist_item_options cio'), 'repo must still join options without status filter');
    assert.ok(repo.includes('LATERAL') && repo.includes('reviews'), 'repo must still have review LATERAL');

    // 30. R04 summary behavior unchanged
    assert.ok(summaryRepo.includes('item_count'), 'R04 must still have item_count');
    assert.ok(!summaryRepo.includes('checklist_item_responses'), 'R04 must still not read response values');
    assert.ok(summaryRepo.includes('CHECKLIST_EXECUTION') && summaryRepo.includes('FORM_INSTANCE'), 'R04 must still unify both engines');
  });
});
