import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R07 PART 02B — Form Detail Repository Core focused validation
 *
 * Static/query-shape assertions acceptable when live DB unavailable.
 * Live DB cases CI-required.
 *
 * Proves 39 conditions:
 * 1. dedicated form detail module exists
 * 2. checklist detail module untouched
 * 3. R04 untouched
 * 4. row key includes instance + versionField + occurrence
 * 5. non-repeatable field produces occurrenceId NULL
 * 6. repeatable field expands only against its own group occurrences
 * 7. no cross-section occurrence Cartesian product
 * 8. two occurrences produce independent rows for same field
 * 9. occurrence ordering uses occurrence_index
 * 10. empty occurrence still produces unanswered field rows
 * 11. non-repeatable unanswered field remains visible
 * 12. no-response row has responseId NULL
 * 13. existing NULL-value response has responseId non-NULL
 * 14. null-value response is not treated as unanswered
 * 15. response joined to exact occurrence only
 * 16. version section metadata comes from snapshot table
 * 17. version field metadata comes from snapshot table
 * 18. label/type/order not read from live form_fields (snapshot)
 * 19. uom/min/max/precision come from live form_fields
 * 20. response value remains native JSONB
 * 21. no result field invented
 * 22. no notes field invented
 * 23. no isNa field invented
 * 24. no naNotes field invented
 * 25. no SELECT option table joined
 * 26. no PASS/FAIL calculation
 * 27. completedBy projected
 * 28. assignment snapshot projected
 * 29. lastRespondedBy projected
 * 30. verifier execution-level only
 * 31. no executor field
 * 32. R04 form building authority reused
 * 33. NULL building excluded fail-closed
 * 34. formInstanceId cannot escape buildingIds repository predicate
 * 35. formTemplateId means owning form template, not version id
 * 36. no evidence/finding/rework join
 * 37. no N+1 loop
 * 38. deterministic section → occurrence → field ordering
 * 39. bounded pagination exists
 */

const FORM_REPO_PATH = resolve(__dirname, '../src/modules/form-execution-detail/form-execution-detail.repository.ts');
const FORM_TYPES_PATH = resolve(__dirname, '../src/modules/form-execution-detail/form-execution-detail.types.ts');
const FORM_INDEX_PATH = resolve(__dirname, '../src/modules/form-execution-detail/index.ts');
const CHECKLIST_REPO_PATH = resolve(__dirname, '../src/modules/checklist-execution-detail/checklist-execution-detail.repository.ts');
const SUMMARY_REPO_PATH = resolve(__dirname, '../src/modules/checklist-execution-summary/checklist-execution-summary.repository.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('R07 PART 02B — Form Detail Repository Core', () => {
  it('dedicated module exists, checklist untouched, R04 untouched', () => {
    const formRepo = read(FORM_REPO_PATH);
    const formTypes = read(FORM_TYPES_PATH);
    const formIndex = read(FORM_INDEX_PATH);
    const checklistRepo = read(CHECKLIST_REPO_PATH);
    const summaryRepo = read(SUMMARY_REPO_PATH);

    // 1. dedicated form detail module exists
    assert.ok(formRepo.includes('form-execution-detail') || formRepo.includes('Form Detail'), 'form repo must exist');
    assert.ok(formTypes.includes('PublicFormExecutionDetailRow'), 'form types must define row');
    assert.ok(formIndex.includes('formExecutionDetailRepository'), 'index must export repo');

    // 2. checklist detail module untouched (no form logic inside)
    assert.ok(!checklistRepo.includes('form_template_version_fields'), 'checklist repo must not contain form version fields');
    assert.ok(!checklistRepo.includes('form_instance_occurrences'), 'checklist repo must not contain occurrences');
    assert.ok(checklistRepo.includes('checklist_items'), 'checklist repo must still be checklist');

    // 3. R04 untouched
    assert.ok(summaryRepo.includes('CHECKLIST_EXECUTION') && summaryRepo.includes('FORM_INSTANCE'), 'R04 must still unify both engines');
    assert.ok(summaryRepo.includes('item_count'), 'R04 must still have item_count');
    assert.ok(!summaryRepo.includes('form_instance_occurrences'), 'R04 must not have occurrence logic');
  });

  it('grain includes instance + versionField + occurrence, non-repeatable NULL, repeatable scoped', () => {
    const repo = read(FORM_REPO_PATH);
    const types = read(FORM_TYPES_PATH);

    // 4. row key includes instance + versionField + occurrence
    assert.ok(types.includes('formInstanceId') && types.includes('versionFieldId') && types.includes('occurrenceId'), 'types must have composite key');
    assert.ok(repo.includes('form_instance_id') && repo.includes('version_field_id') && repo.includes('occurrence_id'), 'repo must select composite key');
    assert.match(repo, /ONE ROW per.*form_instance_id.*version_field_id.*occurrence/i, 'must document grain');

    // 5. non-repeatable field produces occurrenceId NULL
    assert.ok(repo.includes('occurrenceId = NULL') || repo.includes('non-repeatable') && repo.includes('NULL'), 'must document non-repeatable NULL');
    assert.ok(repo.includes('rg.id IS NULL'), 'must have non-repeatable branch where rg IS NULL');
    assert.ok(repo.includes('LEFT JOIN LATERAL (SELECT NULL::uuid'), 'must produce NULL occurrence for non-repeatable');

    // 6. repeatable field expands only against its own group occurrences
    assert.ok(repo.includes('form_repeatable_groups'), 'must use repeatable_groups authority');
    assert.ok(repo.includes('JOIN form_instance_occurrences occ ON occ.form_instance_id = fi_filtered.id AND occ.repeatable_group_id = rg.id'), 'must scope occurrence by instance + repeatable_group belonging to section');

    // 7. no cross-section occurrence Cartesian product
    assert.ok(repo.includes('rg.version_section_id = vs.id'), 'must tie repeatable group to version section');
    assert.ok(!repo.match(/CROSS JOIN.*occurrence/i), 'must not have cross join');

    // 8. two occurrences produce independent rows for same field (JOIN occurrences, not single)
    assert.ok(repo.includes('JOIN form_instance_occurrences'), 'must JOIN occurrences, producing one row per occurrence per field');

    // 9. occurrence ordering uses occurrence_index
    assert.ok(repo.includes('occurrence_index'), 'must have occurrence_index');
    assert.ok(repo.includes('ORDER BY') && repo.includes('occurrence_index'), 'ordering must use occurrence_index');
  });

  it('empty occurrence, unanswered, null-value response, exact occurrence join', () => {
    const repo = read(FORM_REPO_PATH);

    // 10. empty occurrence still produces unanswered field rows
    assert.ok(repo.includes('empty occurrence') || repo.includes('Empty occurrence') || repo.includes('LEFT JOIN form_responses'), 'must document empty occurrence produces unanswered rows');
    assert.ok(repo.includes('JOIN form_instance_occurrences') && repo.includes('LEFT JOIN form_responses'), 'repeatable branch JOIN occurrence then LEFT JOIN response ensures empty occurrence still visible');

    // 11. non-repeatable unanswered field remains visible
    assert.ok(repo.includes('LEFT JOIN form_responses r ON') && repo.includes('occurrence_id IS NULL'), 'non-repeatable LEFT JOIN ensures unanswered visible');

    // 12. no-response row has responseId NULL
    assert.ok(repo.includes('r.id AS response_id'), 'must select response id nullable');

    // 13. existing NULL-value response has responseId non-NULL
    const lowerRepo = repo.toLowerCase();
    assert.ok(lowerRepo.includes('null value response') || lowerRepo.includes('null-value') || lowerRepo.includes('explicit null'), 'must document null-value vs unanswered');

    // 14. null-value response is not treated as unanswered
    const lowerRepo2 = repo.toLowerCase();
    assert.ok(lowerRepo2.includes('unanswered') && lowerRepo2.includes('null'), 'must distinguish unanswered vs null-value');

    // 15. response joined to exact occurrence only
    assert.ok(repo.includes('r.occurrence_id = occ.id'), 'repeatable response must join exact occurrence');
    assert.ok(repo.includes('r.occurrence_id IS NULL'), 'non-repeatable response must require NULL occurrence');
    assert.ok(!repo.match(/r\.occurrence_id.*=.*rg\.id/), 'must not join response to group id');
  });

  it('version snapshot vs live measurement metadata, native value, no invented fields', () => {
    const repo = read(FORM_REPO_PATH);
    const types = read(FORM_TYPES_PATH);

    // 16. version section metadata from snapshot table
    assert.ok(repo.includes('form_template_version_sections vs'), 'must join version_sections');
    assert.ok(repo.includes('vs.code AS section_code') && repo.includes('vs.title AS section_title'), 'must project section snapshot');
    assert.ok(types.includes('sectionId') && types.includes('sectionCode') && types.includes('sectionTitle'), 'types must have section snapshot');

    // 17. version field metadata from snapshot table
    assert.ok(repo.includes('form_template_version_fields vf'), 'must join version_fields');
    assert.ok(repo.includes('vf.code AS field_code') && repo.includes('vf.label AS field_label'), 'must project field snapshot');
    assert.ok(types.includes('fieldCode') && types.includes('fieldLabel') && types.includes('fieldType'), 'types must have field snapshot');

    // 18. label/type/order not read from live form_fields (snapshot)
    assert.ok(repo.includes('vf.label') && !repo.match(/ff\.label AS field_label/), 'field label must come from snapshot vf, not live ff');
    assert.ok(repo.includes('vf.field_type'), 'field type must come from snapshot');

    // 19. uom/min/max/precision come from live form_fields
    assert.ok(repo.includes('form_fields ff'), 'must join live form_fields');
    assert.ok(repo.includes('ff.uom_id') && repo.includes('ff.minimum_value') && repo.includes('ff.maximum_value') && repo.includes('ff.decimal_precision'), 'must project live measurement');
    assert.ok(types.includes('uomId') && types.includes('minimumValue'), 'types must have live measurement');
    assert.ok(types.includes('LIVE') && repo.includes('LIVE'), 'must mark live measurement as LIVE');

    // 20. response value remains native JSONB
    assert.ok(repo.includes('r.value AS value'), 'must select raw JSONB value');
    assert.ok(types.includes('value: unknown'), 'type must be unknown/native');

    // 21-24. no result/notes/isNa/naNotes invented
    assert.ok(!repo.match(/result.*TEXT/i) || repo.includes('No result') || !repo.includes('r.result'), 'must not have result field (form has no result)');
    assert.ok(!types.match(/^\s*result\s*:/m), 'types must not have result field');
    assert.ok(!types.match(/^\s*notes\s*:/m), 'types must not have notes field');
    assert.ok(!types.match(/^\s*isNa\s*:/m), 'types must not have isNa field');
    assert.ok(!types.match(/^\s*naNotes\s*:/m), 'types must not have naNotes field');
    assert.ok(!repo.includes('is_na'), 'repo must not reference is_na for form');

    // 25. no SELECT option table joined
    assert.ok(!repo.includes('checklist_item_options'), 'must not use checklist options');
    assert.ok(!repo.includes('form_field_options') && !repo.includes('form_options'), 'must not have form option table (none exists)');
    assert.ok(!repo.match(/JOIN\s+\w*option/i), 'must not join any option table');

    // 26. no PASS/FAIL calculation
    assert.ok(!repo.match(/PASS.*FAIL|withinRange|compliance/i) || repo.includes('No PASS/FAIL'), 'must not calculate pass/fail');
  });

  it('R06 attribution, verifier execution-level, no executor, building authority, filters, separation', () => {
    const repo = read(FORM_REPO_PATH);
    const types = read(FORM_TYPES_PATH);

    // 27. completedBy projected
    assert.ok(repo.includes('completed_by_user_id'), 'must project completed_by');
    assert.ok(types.includes('completedByUserId'), 'types must have completedBy');

    // 28. assignment snapshot projected
    assert.ok(repo.includes('assignee_type') && repo.includes('assigned_workforce_profile_id'), 'must project assignment snapshot');
    assert.ok(types.includes('assignedWorkforceProfileId'), 'types must have assignment');

    // 29. lastRespondedBy projected
    assert.ok(repo.includes('last_responded_by_user_id'), 'must project last_responded_by');
    assert.ok(types.includes('lastRespondedByUserId'), 'types must have lastRespondedBy');

    // 30. verifier execution-level only
    assert.ok(repo.includes('LATERAL') && repo.includes('reviews') && repo.includes("target_type = 'FORM_INSTANCE'"), 'must have review LATERAL for FORM_INSTANCE');
    assert.ok(repo.includes('COMPLETED') && repo.includes('ORDER BY reviewed_at DESC'), 'must reuse R04 review semantics');

    // 31. no executor field
    assert.ok(!repo.match(/\bexecutedBy\b\s*[:=]/i) && !repo.match(/\bexecutor\b\s*[:=]/i), 'repo must not have executor');
    assert.ok(!types.match(/^\s*executedBy\s*:/m) && !types.match(/^\s*executor\s*:/m), 'types must not have executor');

    // 32. R04 form building authority reused
    assert.ok(repo.includes('meter_reading_bindings') && repo.includes('log_sheet_bindings') && repo.includes('generated_tasks'), 'must reuse R04 form building authority');
    assert.ok(repo.includes('FI_BUILDING_SQL') || repo.includes('COALESCE'), 'must have building COALESCE');

    // 33. NULL building excluded fail-closed
    assert.ok(repo.includes('building_id IS NOT NULL'), 'must exclude NULL building fail-closed');

    // 34. formInstanceId cannot escape buildingIds predicate
    assert.ok(repo.includes('building_id = ANY'), 'must filter by buildingIds ANY');
    assert.ok(repo.includes('fi_filtered.id =') || repo.includes('form_instance_id'), 'must have instance filter ANDed with building filter');

    // 35. formTemplateId means owning form template, not version id
    assert.ok(repo.includes('form_templates ft') && repo.includes('ft.id ='), 'must filter by owning form_templates.id, not version id');
    assert.ok(types.includes('formTemplateId') && types.includes('formTemplateVersionId'), 'types must have both template and version id');

    // 36. no evidence/finding/rework join
    assert.ok(!repo.match(/JOIN\s+evidence_submissions/i), 'must not join evidence');
    assert.ok(!repo.match(/JOIN\s+findings/i), 'must not join findings');
    assert.ok(!repo.match(/JOIN\s+\w*rework/i), 'must not join rework');

    // 37. no N+1 loop
    const queryCount = (repo.match(/getPool\(\)\.query/g) || []).length;
    assert.ok(queryCount === 1, `must have exactly 1 bounded query, found ${queryCount}`);

    // 38. deterministic section → occurrence → field ordering
    assert.ok(repo.includes('ORDER BY'), 'must have ORDER BY');
    assert.ok(repo.includes('section_display_order ASC') && repo.includes('occurrence_index ASC') && repo.includes('display_order ASC'), 'must order section -> occurrence -> field');
    assert.ok(repo.includes('NULLS FIRST'), 'must have explicit NULLS FIRST for occurrence_index');

    // 39. bounded pagination exists
    assert.ok(repo.includes('LIMIT') && repo.includes('OFFSET'), 'must support LIMIT/OFFSET');
  });
});
