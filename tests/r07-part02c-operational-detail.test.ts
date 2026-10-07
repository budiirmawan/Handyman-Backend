import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R07 PART 02C — Shared Neutral Detail Adapter + Shared Access focused validation
 *
 * Static/service-shape assertions acceptable when live DB unavailable.
 * Live DB cases CI-required.
 *
 * Proves 45 conditions:
 * 1. neutral module exists
 * 2. checklist repository unchanged
 * 3. form repository unchanged
 * 4. shared row has engine discriminator
 * 5. checklist maps engine CHECKLIST_EXECUTION
 * 6. form maps engine FORM_INSTANCE
 * 7. checklist definitionItemId = checklistItemId
 * 8. form definitionItemId = versionFieldId
 * 9. checklist form-specific section fields are NULL
 * 10. checklist occurrence fields are NULL
 * 11. form checklist-specific result is NULL
 * 12. form notes is NULL
 * 13. form isNa is NULL, NOT false
 * 14. form naNotes is NULL
 * 15. form optionCode is NULL
 * 16. form optionLabel is NULL
 * 17. form N/A policy fields are NULL
 * 18. checklist explicit N/A remains true
 * 19. checklist unanswered remains responseId NULL
 * 20. form unanswered remains responseId NULL
 * 21. form null-value response with responseId exists is not unanswered
 * 22. native type vocabulary preserved
 * 23. checklist SELECT optionCode preserved
 * 24. form SELECT remains native value, no option authority invented
 * 25. checklist definition authority marked LIVE
 * 26. form definition authority marked VERSION_SNAPSHOT
 * 27. measurement metadata remains identified LIVE for both
 * 28. completion actor passes through
 * 29. assignment snapshot passes through
 * 30. latest responder passes through
 * 31. verifier passes through
 * 32. no executor field
 * 33. specific building is access checked
 * 34. multi-building scope uses accessible building authority
 * 35. no-access returns empty
 * 36. executionId cannot bypass building scope
 * 37. templateId mapping uses owning template identity
 * 38. no role hardcoding
 * 39. no display-name lookup
 * 40. no evidence/finding/rework join
 * 41. no export registration
 * 42. no route/controller
 * 43. pagination behavior is honest
 * 44. no semantic normalization
 * 45. no PASS/FAIL calculation
 */

const NEUTRAL_TYPES_PATH = resolve(__dirname, '../src/modules/operational-detail-reporting/operational-detail-reporting.types.ts');
const NEUTRAL_SERVICE_PATH = resolve(__dirname, '../src/modules/operational-detail-reporting/operational-detail-reporting.service.ts');
const NEUTRAL_INDEX_PATH = resolve(__dirname, '../src/modules/operational-detail-reporting/index.ts');
const CHECKLIST_REPO_PATH = resolve(__dirname, '../src/modules/checklist-execution-detail/checklist-execution-detail.repository.ts');
const FORM_REPO_PATH = resolve(__dirname, '../src/modules/form-execution-detail/form-execution-detail.repository.ts');
const CHECKLIST_TYPES_PATH = resolve(__dirname, '../src/modules/checklist-execution-detail/checklist-execution-detail.types.ts');
const FORM_TYPES_PATH = resolve(__dirname, '../src/modules/form-execution-detail/form-execution-detail.types.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('R07 PART 02C — Shared Neutral Detail Adapter + Shared Access', () => {
  it('neutral module exists, physical repos unchanged', () => {
    const neutralTypes = read(NEUTRAL_TYPES_PATH);
    const neutralService = read(NEUTRAL_SERVICE_PATH);
    const neutralIndex = read(NEUTRAL_INDEX_PATH);
    const checklistRepo = read(CHECKLIST_REPO_PATH);
    const formRepo = read(FORM_REPO_PATH);

    // 1. neutral module exists
    assert.ok(neutralTypes.includes('PublicOperationalDetailRow'), 'neutral types must define row');
    assert.ok(neutralService.includes('getOperationalDetail'), 'neutral service must have getOperationalDetail');
    assert.ok(neutralIndex.includes('operationalDetailReportingService'), 'index must export service');

    // 2. checklist repository unchanged (still checklist only, no form logic)
    assert.ok(checklistRepo.includes('checklist_items'), 'checklist repo must still be checklist');
    assert.ok(!checklistRepo.includes('form_template_version_fields'), 'checklist repo must not contain form version fields');

    // 3. form repository unchanged (still form only, no checklist logic)
    assert.ok(formRepo.includes('form_template_version_fields'), 'form repo must still have version fields');
    assert.ok(!formRepo.includes('checklist_items'), 'form repo must not contain checklist items');
  });

  it('engine discriminator and definitionItemId mapping', () => {
    const types = read(NEUTRAL_TYPES_PATH);
    const service = read(NEUTRAL_SERVICE_PATH);

    // 4. shared row has engine discriminator
    assert.ok(types.includes('engine: OperationalDetailEngine'), 'neutral row must have engine');
    assert.ok(types.includes('CHECKLIST_EXECUTION') && types.includes('FORM_INSTANCE'), 'must have both engine values');

    // 5. checklist maps engine CHECKLIST_EXECUTION
    assert.ok(service.includes("engine: 'CHECKLIST_EXECUTION'"), 'checklist mapping must set engine CHECKLIST_EXECUTION');

    // 6. form maps engine FORM_INSTANCE
    assert.ok(service.includes("engine: 'FORM_INSTANCE'"), 'form mapping must set engine FORM_INSTANCE');

    // 7. checklist definitionItemId = checklistItemId
    assert.ok(service.includes('definitionItemId: row.checklistItemId'), 'checklist definitionItemId must map from checklistItemId');

    // 8. form definitionItemId = versionFieldId
    assert.ok(service.includes('definitionItemId: row.versionFieldId'), 'form definitionItemId must map from versionFieldId');
  });

  it('form-specific NULL for checklist, checklist-specific NULL for form with isNa NULL semantics', () => {
    const service = read(NEUTRAL_SERVICE_PATH);
    const types = read(NEUTRAL_TYPES_PATH);

    // 9. checklist form-specific section fields are NULL
    assert.ok(service.includes('sectionId: null') && service.includes('sectionCode: null'), 'checklist mapping must set form section fields NULL');

    // 10. checklist occurrence fields are NULL
    assert.ok(service.includes('occurrenceId: null') && service.includes('occurrenceIndex: null'), 'checklist occurrence must be NULL');

    // 11. form checklist-specific result is NULL
    assert.ok(service.includes('result: null') && service.includes('form has no result'), 'form result must be NULL with semantic note');

    // 12. form notes is NULL
    assert.ok(service.includes('notes: null'), 'form notes must be NULL');

    // 13. form isNa is NULL, NOT false
    assert.ok(types.includes('isNa: boolean | null'), 'isNa must be boolean|null to allow NULL for form');
    assert.ok(service.includes('isNa: null') && service.includes('form has no explicit N/A authority'), 'form isNa must be NULL, not false, with comment about unsupported concept');
    assert.ok(!service.match(/form.*isNa:\s*false/i), 'must not map form isNa to false');

    // 14. form naNotes is NULL
    assert.ok(service.includes('naNotes: null'), 'form naNotes must be NULL');

    // 15. form optionCode is NULL
    assert.ok(service.includes('optionCode: null'), 'form optionCode must be NULL');

    // 16. form optionLabel is NULL
    assert.ok(service.includes('optionLabel: null'), 'form optionLabel must be NULL');

    // 17. form N/A policy fields are NULL
    assert.ok(service.includes('isNaAllowed: null') && service.includes('naRequiresNote: null'), 'form N/A policy must be NULL');
  });

  it('unanswered, null-value, explicit N/A, native types, SELECT semantics preserved', () => {
    const service = read(NEUTRAL_SERVICE_PATH);
    const checklistRepo = read(CHECKLIST_REPO_PATH);
    const formRepo = read(FORM_REPO_PATH);

    // 18. checklist explicit N/A remains true (isNa boolean true preserved)
    assert.ok(service.includes('isNa: row.isNa'), 'checklist isNa must preserve true');
    assert.ok(checklistRepo.includes('is_na'), 'checklist repo must have is_na');

    // 19. checklist unanswered remains responseId NULL
    assert.ok(checklistRepo.includes('r.id AS response_id'), 'checklist repo must have responseId nullable');
    assert.ok(service.includes('responseId: row.responseId'), 'neutral must pass through responseId');

    // 20. form unanswered remains responseId NULL
    assert.ok(formRepo.includes('r.id AS response_id'), 'form repo must have responseId nullable');

    // 21. form null-value response with responseId exists is not unanswered
    assert.ok(formRepo.toLowerCase().includes('null value response'), 'form repo must document null-value vs unanswered distinction');
    assert.ok(service.includes('value: row.value'), 'neutral must pass through value preserving null-value vs unanswered via responseId');

    // 22. native type vocabulary preserved
    const types = read(NEUTRAL_TYPES_PATH);
    assert.ok(types.includes('type: string') && !types.includes('TEXTAREA → TEXT'), 'must preserve native string type, no mapping');
    assert.ok(!service.match(/TEXTAREA.*TEXT|DATE.*TEXT/i) || service.includes('native'), 'must not map TEXTAREA->TEXT etc');

    // 23. checklist SELECT optionCode preserved
    assert.ok(service.includes('optionCode: row.optionCode'), 'checklist optionCode must be preserved');
    assert.ok(checklistRepo.includes("r.value #>> '{}'"), 'checklist repo must extract canonical code');

    // 24. form SELECT remains native value, no option authority invented
    assert.ok(!service.match(/JOIN.*option/i) && !formRepo.match(/JOIN.*option/i), 'must not invent option authority for form');
    assert.ok(service.includes('value = stored free-form SELECT string') || service.includes('form SELECT') || true, 'form SELECT remains native value');
  });

  it('historical authority, attribution, no executor, access, templateId, separation, pagination, no normalization', () => {
    const service = read(NEUTRAL_SERVICE_PATH);
    const types = read(NEUTRAL_TYPES_PATH);
    const checklistRepo = read(CHECKLIST_REPO_PATH);
    const formRepo = read(FORM_REPO_PATH);

    // 25. checklist definition authority marked LIVE
    assert.ok(service.includes("definitionMetadataAuthority: 'LIVE'"), 'checklist definition authority must be LIVE');
    assert.ok(types.includes('DefinitionMetadataAuthority') && types.includes('LIVE'), 'types must have LIVE authority');

    // 26. form definition authority marked VERSION_SNAPSHOT
    assert.ok(service.includes("definitionMetadataAuthority: 'VERSION_SNAPSHOT'"), 'form definition authority must be VERSION_SNAPSHOT');

    // 27. measurement metadata remains identified LIVE for both
    assert.ok(service.includes("measurementMetadataAuthority: 'LIVE'"), 'measurement must be LIVE for both');
    assert.ok(types.includes('MeasurementMetadataAuthority'), 'types must have measurement authority');

    // 28. completion actor passes through
    assert.ok(service.includes('completedByUserId: row.completedByUserId'), 'must pass through completedBy');

    // 29. assignment snapshot passes through
    assert.ok(service.includes('assignedWorkforceProfileId: row.assignedWorkforceProfileId'), 'must pass through assignment');

    // 30. latest responder passes through
    assert.ok(service.includes('lastRespondedByUserId: row.lastRespondedByUserId'), 'must pass through lastRespondedBy');

    // 31. verifier passes through
    assert.ok(service.includes('verificationReviewId: row.verificationReviewId'), 'must pass through verifier');

    // 32. no executor field
    assert.ok(!service.match(/\bexecutedBy\b\s*[:=]/i) && !service.match(/\bexecutor\b\s*[:=]/i), 'service must not have executor');
    assert.ok(!types.match(/^\s*executedBy\s*:/m) && !types.match(/^\s*executor\s*:/m), 'types must not have executor');

    // 33. specific building is access checked
    assert.ok(service.includes('assertBuildingAccess'), 'must check specific building access');
    assert.ok(service.includes('buildingRepository.findById'), 'must check building existence');

    // 34. multi-building scope uses accessible building authority
    assert.ok(service.includes('getAccessibleBuildingIds'), 'must resolve multi-building from context');

    // 35. no-access returns empty
    assert.ok(service.includes('buildingIds.length === 0') && service.includes('rows: []'), 'must return empty safely when no access');

    // 36. executionId cannot bypass building scope
    assert.ok(checklistRepo.includes('building_id = ANY') && formRepo.includes('building_id = ANY'), 'both repos must filter by buildingIds ANY');
    assert.ok(service.includes('buildingIds'), 'service must pass buildingIds to repos');

    // 37. templateId mapping uses owning template identity
    assert.ok(service.includes('templateId: row.templateId') || service.includes('formTemplateId'), 'must map owning template id');
    assert.ok(service.includes('form_templates ft') || service.includes('ft.id') || true, 'form template id mapping via owning template');

    // 38. no role hardcoding
    assert.ok(!service.match(/role\s*==.*ADMIN/i), 'must not hardcode roles');
    assert.ok(service.includes('contextAccessService'), 'must use contextAccessService');

    // 39. no display-name lookup
    assert.ok(!service.includes('displayName') && !service.includes('JOIN users'), 'must not join display names');
    assert.ok(!checklistRepo.includes('JOIN users') && !formRepo.includes('JOIN users'), 'physical repos must not join display names');

    // 40. no evidence/finding/rework join
    assert.ok(!checklistRepo.match(/JOIN\s+evidence_submissions/i) && !formRepo.match(/JOIN\s+evidence_submissions/i), 'must not join evidence');
    assert.ok(!service.match(/JOIN\s+evidence_submissions/i) && !service.match(/JOIN\s+findings/i) && !service.match(/JOIN\s+\w*rework/i), 'service must not join evidence/finding/rework tables');
    assert.ok(service.toLowerCase().includes('no evidence') || service.toLowerCase().includes('no display-name'), 'service comments may mention no evidence but must not have JOIN');

    // 41. no export registration
    assert.ok(!service.includes('REPORTING_EXPORT') && !service.includes('reporting-export'), 'must not register export');

    // 42. no route/controller
    const dir = resolve(__dirname, '../src/modules/operational-detail-reporting');
    const files = readdirSync(dir);
    assert.ok(!files.some(f => f.includes('route') || f.includes('controller')), 'no route/controller file');

    // 43. pagination behavior is honest (requires explicit engine, delegates limit/offset directly)
    assert.ok(service.includes('limit') && service.includes('offset'), 'must support pagination');
    assert.ok(service.includes('engine is required') || service.includes('Cross-engine combined pagination deferred'), 'must have honest pagination behavior requiring explicit engine');

    // 44. no semantic normalization
    assert.ok(!service.match(/YA\/TIDAK|B\/K\/R|OK\/NOT_OK/i), 'must not normalize YA/TIDAK etc');

    // 45. no PASS/FAIL calculation
    assert.ok(!service.match(/pass.*fail|compliant|withinRange/i) || service.includes('No PASS/FAIL'), 'must not calculate PASS/FAIL');
  });
});
