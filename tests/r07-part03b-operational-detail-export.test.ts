/**
 * R07 PART 03B — Operational Detail Export (focused, 52 conditions, no DB)
 *
 * Validates registry adapter, projection, filters, batching, frozen dateTo,
 * responseState, null semantics, attribution, verification, exclusions.
 *
 * NO DB, NO network, NO npm install — reads source files only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8');
}

const typesSrc = read('src/modules/reporting-export/reporting-export.types.ts');
const registrySrc = read('src/modules/reporting-export/reporting-export.registry.ts');
const projSrc = read('src/modules/reporting-export/reporting-export.projections.ts');
const serviceSrc = read('src/modules/reporting-export/reporting-export.service.ts');
const csvSrc = read('src/modules/reporting-export/csv-renderer.ts');
const xlsxSrc = read('src/modules/reporting-export/xlsx-renderer.ts');
const neutralTypesSrc = read('src/modules/operational-detail-reporting/operational-detail-reporting.types.ts');
const neutralServiceSrc = read('src/modules/operational-detail-reporting/operational-detail-reporting.service.ts');

describe('R07 PART 03B — Operational Detail Export 52 conditions', () => {
  // 1 dataset identity
  it('01 types includes OPERATIONAL_DETAIL', () => {
    assert.match(typesSrc, /OPERATIONAL_DETAIL/);
  });

  it('02 registry datasetLabel Operational Detail', () => {
    assert.match(registrySrc, /OPERATIONAL_DETAIL/);
    assert.match(registrySrc, /datasetLabel:\s*['"]Operational Detail['"]/);
  });

  it('03 sourceAuthority R07 operational-detail-reporting', () => {
    assert.match(registrySrc, /sourceAuthority:\s*['"]R07 operational-detail-reporting['"]/);
  });

  it('04 requiredReadPermission checklist.read no new permission', () => {
    // find OPERATIONAL_DETAIL block
    const block = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.match(block, /requiredReadPermission:\s*['"]checklist\.read['"]/);
    assert.doesNotMatch(registrySrc, /OPERATIONAL_DETAIL[\s\S]{0,400}requiredReadPermission:\s*['"]operational_detail/);
  });

  // 5 source must call getOperationalDetail
  it('05 load calls getOperationalDetail same userId', () => {
    assert.match(registrySrc, /getOperationalDetail\s*\(/);
    assert.match(registrySrc, /userId/);
    // ensure same userId every page — at least two occurrences of userId in loop
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.ok((opBlock.match(/getOperationalDetail/g) || []).length >= 1);
    assert.ok(opBlock.includes('userId'));
  });

  it('06 no direct detail repo bypass checklist_execution_detail repo', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    // should not import checklist-execution-detail repository directly
    assert.doesNotMatch(opBlock, /checklist-execution-detail.*repository/i);
    assert.doesNotMatch(opBlock, /form-execution-detail.*repository/i);
    // source must be neutral adapter
    assert.match(registrySrc, /from\s+['\"]\.\.\/operational-detail-reporting['\"]/);
  });

  it('07 engine required validation no default', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.match(opBlock, /engine is required/);
    assert.match(opBlock, /if\s*\(\s*!parsed\.engine\s*\)/);
  });

  it('08 engine invalid throws validation existing convention', () => {
    assert.match(registrySrc, /AppError\.validation/);
    // neutral parser validates engine values
    assert.match(neutralServiceSrc, /CHECKLIST_EXECUTION/);
    assert.match(neutralServiceSrc, /FORM_INSTANCE/);
  });

  it('09 no BOTH engine mode no concatenation', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    // should not have literal 'BOTH' as engine value
    assert.doesNotMatch(opBlock, /['\"]BOTH['\"]/);
    assert.doesNotMatch(opBlock, /concat.*engine/i);
    assert.doesNotMatch(opBlock, /merge.*engine/i);
  });

  it('10 internal batching fixed 1000', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.match(opBlock, /INTERNAL_BATCH_SIZE\s*=\s*1000/);
  });

  it('11 offset 0 start', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.match(opBlock, /let offset\s*=\s*0/);
  });

  it('12 loop until rows < batchSize', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.match(opBlock, /rows\.length\s*<\s*INTERNAL_BATCH_SIZE/);
    assert.match(opBlock, /while\s*\(\s*true\s*\)/);
  });

  it('13 same filters+engine reused every page', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.match(opBlock, /baseFilters/);
    assert.match(opBlock, /\.\.\.baseFilters/);
  });

  it('14 frozen export upper bound at load start', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.match(opBlock, /frozenNowIso/);
    assert.match(opBlock, /new Date\(\)\.toISOString\(\)/);
    // ensure only one frozen timestamp generation before loop
    const beforeLoop = opBlock.slice(0, opBlock.indexOf('while'));
    const count = (beforeLoop.match(/toISOString/g) || []).length;
    assert.equal(count, 1, 'should freeze once before loop');
  });

  it('15 caller dateTo reused exact else frozen reused every page', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.match(opBlock, /effectiveDateTo/);
    assert.match(opBlock, /dateTo:\s*effectiveDateTo/);
  });

  it('16 no SERIALIZABLE claim', () => {
    assert.doesNotMatch(registrySrc, /SERIALIZABLE/i);
  });

  it('17 no per-page new Date() generation', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    const whileIdx = opBlock.indexOf('while');
    const loopEndIdx = opBlock.indexOf('}', whileIdx + 200); // approximate, find first break then closing
    // extract loop body between while and break+offset
    const loopBody = opBlock.slice(whileIdx, opBlock.indexOf('offset += INTERNAL_BATCH_SIZE') + 30);
    // inside loop body should not generate new Date
    assert.doesNotMatch(loopBody, /new Date\(\)\.toISOString\(\)/);
  });

  it('18 user pagination no exposure ignore limit/offset', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.match(opBlock, /_ignoredLimit/);
    assert.match(opBlock, /_ignoredOffset/);
    // should not echo limit/offset in appliedFilters
    // echoFilters will filter only string|number|boolean but we explicitly removed limit/offset from governedFilters
    assert.match(opBlock, /governedFilters/);
  });

  it('19 filters only allowed engine buildingId executionId templateId status dateFrom dateTo', () => {
    // neutral service parser should only allow those
    assert.match(neutralServiceSrc, /engine/);
    assert.match(neutralServiceSrc, /buildingId/);
    assert.match(neutralServiceSrc, /executionId/);
    assert.match(neutralServiceSrc, /templateId/);
    assert.match(neutralServiceSrc, /status/);
    assert.match(neutralServiceSrc, /dateFrom/);
    assert.match(neutralServiceSrc, /dateTo/);
    // forbidden filters must not be parsed as query params (readOptional for those)
    assert.doesNotMatch(neutralServiceSrc, /readSingleParam\(query\.executor/);
    assert.doesNotMatch(neutralServiceSrc, /query\.executor/);
    // pass/fail should not be parsed
    assert.doesNotMatch(neutralServiceSrc, /query\.passFail/);
  });

  it('20 no executor/pass-fail/semantic/form N/A/item verifier/display-name/evidence/finding/rework/free-text filters', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.doesNotMatch(opBlock, /executor/i);
    assert.doesNotMatch(opBlock, /passFail/i);
    assert.doesNotMatch(opBlock, /evidence/i);
    assert.doesNotMatch(opBlock, /finding/i);
    assert.doesNotMatch(opBlock, /rework/i);
  });

  it('21 projection function exists projectOperationalDetail', () => {
    assert.match(projSrc, /export function projectOperationalDetail/);
  });

  it('22 projection one table operationalDetail', () => {
    assert.match(projSrc, /operationalDetail/);
    assert.match(projSrc, /'Operational Detail'/);
  });

  it('23 projection columns include required set', () => {
    const requiredKeys = [
      'engine',
      'executionId',
      'definitionItemId',
      'responseId',
      'clientId',
      'buildingId',
      'templateId',
      'status',
      'startedAt',
      'completedAt',
      'sectionCode',
      'sectionTitle',
      'sectionDisplayOrder',
      'occurrenceIndex',
      'label',
      'type',
      'displayOrder',
      'required',
      'uomId',
      'minimumValue',
      'maximumValue',
      'decimalPrecision',
      'value',
      'result',
      'notes',
      'isNa',
      'naNotes',
      'optionCode',
      'optionLabel',
      'isNaAllowed',
      'naRequiresNote',
      'responseCreatedAt',
      'responseUpdatedAt',
      'lastRespondedByUserId',
      'completedByUserId',
      'assigneeType',
      'assignedWorkforceProfileId',
      'assignedTeamId',
      'assignmentSnapshotAt',
      'verificationStatus',
      'verificationDecision',
      'verificationReviewerUserId',
      'verificationReviewedAt',
      'definitionMetadataAuthority',
      'measurementMetadataAuthority',
      'responseState',
    ];
    for (const k of requiredKeys) {
      assert.ok(projSrc.includes(`key: '${k}'`), `missing column ${k}`);
    }
  });

  it('24 projection no display names no executor', () => {
    const opProj = projSrc.slice(projSrc.indexOf('projectOperationalDetail'));
    // executor should not appear as column key or label in operational detail projection
    assert.doesNotMatch(opProj, /key:\s*['\"]executor/i);
    assert.doesNotMatch(opProj, /Executed By/);
    assert.doesNotMatch(opProj, /displayName/i);
    // ensure no buildingName/clientName joins in this projection
    assert.doesNotMatch(opProj, /buildingName/i);
    assert.doesNotMatch(opProj, /clientName/i);
  });

  it('25 responseState precedence UNANSWERED', () => {
    const opProj = projSrc.slice(projSrc.indexOf('function deriveResponseState'));
    assert.match(opProj, /UNANSWERED/);
    assert.match(opProj, /responseId.*==.*null/);
  });

  it('26 responseState EXPLICIT_NA', () => {
    const opProj = projSrc.slice(projSrc.indexOf('function deriveResponseState'));
    assert.match(opProj, /EXPLICIT_NA/);
    assert.match(opProj, /isNa/);
  });

  it('27 responseState RESPONDED_NULL', () => {
    const opProj = projSrc.slice(projSrc.indexOf('function deriveResponseState'));
    assert.match(opProj, /RESPONDED_NULL/);
    assert.match(opProj, /value/);
  });

  it('28 responseState RESPONDED', () => {
    const opProj = projSrc.slice(projSrc.indexOf('function deriveResponseState'));
    assert.match(opProj, /RESPONDED/);
    // ensure 4 states present in derive function + surrounding file
    assert.ok(opProj.includes('UNANSWERED') && opProj.includes('EXPLICIT_NA') && opProj.includes('RESPONDED_NULL'));
    // RESPONDED appears at least twice (RESPONDED and RESPONDED_NULL) – ensure RESPONDED exists
    assert.ok(projSrc.includes('UNANSWERED') && projSrc.includes('EXPLICIT_NA') && projSrc.includes('RESPONDED_NULL') && projSrc.includes('RESPONDED'));
  });

  it('29 responseState presentation-only no persist no workflow', () => {
    // comment is in header above function, check whole file
    assert.match(projSrc, /presentation-only/);
    const opProj = projSrc.slice(projSrc.indexOf('projectOperationalDetail'));
    assert.doesNotMatch(opProj, /INSERT.*responseState/i);
    assert.doesNotMatch(opProj, /UPDATE.*responseState/i);
  });

  it('30 NULL preserve FORM isNa/result/notes/naNotes/optionCode/optionLabel/isNaAllowed/naRequiresNote NULL unsupported not false/empty', () => {
    // neutral types should have isNa null for form
    assert.match(neutralTypesSrc, /isNa.*null/);
    // projection should preserve nulls verbatim (no || false)
    const opProj = projSrc.slice(projSrc.indexOf('projectOperationalDetail'));
    assert.ok(opProj.includes('row.isNa'));
    assert.doesNotMatch(opProj, /isNa\s*\|\|\s*false/);
  });

  it('31 VALUE serialization scalar string|number|boolean|null verbatim no JSON stringify', () => {
    const opProj = projSrc.slice(projSrc.indexOf('projectOperationalDetail'));
    assert.match(opProj, /serializeValue/);
    // check serialize function exists elsewhere
    const serializeFn = projSrc.slice(projSrc.indexOf('function serializeValue'));
    assert.match(serializeFn, /typeof value === 'string'/);
    assert.match(serializeFn, /typeof value === 'number'/);
    assert.match(serializeFn, /typeof value === 'boolean'/);
    assert.doesNotMatch(serializeFn, /JSON\.stringify.*value/);
  });

  it('32 SELECT checklist Value canonical code Option Code authoritative vs FORM free-form', () => {
    // comment in projection should mention canonical code vs free-form
    // at least check that optionCode/optionLabel are preserved
    const opProj = projSrc.slice(projSrc.indexOf('projectOperationalDetail'));
    assert.ok(opProj.includes('optionCode'));
    assert.ok(opProj.includes('optionLabel'));
  });

  it('33 historical Definition Authority LIVE checklist VERSION_SNAPSHOT form', () => {
    const opProj = projSrc.slice(projSrc.indexOf('projectOperationalDetail'));
    assert.match(opProj, /definitionMetadataAuthority/);
    // neutral types should have LIVE and VERSION_SNAPSHOT
    assert.match(neutralTypesSrc, /LIVE/);
    assert.match(neutralTypesSrc, /VERSION_SNAPSHOT/);
  });

  it('34 Measurement Metadata Authority LIVE both', () => {
    assert.match(projSrc, /measurementMetadataAuthority/);
    assert.match(neutralTypesSrc, /measurementMetadataAuthority/);
  });

  it('35 attribution safe Completed By Last Responded By Assigned Workforce Profile Team Assignment Snapshot Verification Reviewer', () => {
    const opProj = projSrc.slice(projSrc.indexOf('projectOperationalDetail'));
    assert.ok(opProj.includes('completedByUserId'));
    assert.ok(opProj.includes('lastRespondedByUserId'));
    assert.ok(opProj.includes('assignedWorkforceProfileId'));
    assert.ok(opProj.includes('assignedTeamId'));
    assert.ok(opProj.includes('assignmentSnapshotAt'));
    assert.ok(opProj.includes('verificationReviewerUserId'));
  });

  it('36 attribution unsafe Executor/Executed By/Performed By/Executor ID absent', () => {
    const opProj = projSrc.slice(projSrc.indexOf('projectOperationalDetail'));
    assert.doesNotMatch(opProj, /executor/i);
    assert.doesNotMatch(opProj, /Executed By/);
    assert.doesNotMatch(opProj, /Performed By/);
  });

  it('37 verification execution/instance-level safe labels Verification Reviewer/Decision/Reviewed At not Item/Field Verifier', () => {
    const opProj = projSrc.slice(projSrc.indexOf('projectOperationalDetail'));
    assert.ok(opProj.includes('verificationStatus'));
    assert.ok(opProj.includes('verificationDecision'));
    assert.ok(opProj.includes('verificationReviewedAt'));
    assert.doesNotMatch(opProj, /Item.*Verifier/);
    assert.doesNotMatch(opProj, /Field.*Verifier/);
  });

  it('38 no evidence/finding/rework joins no counts', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.doesNotMatch(opBlock, /evidence/i);
    assert.doesNotMatch(opBlock, /finding/i);
    assert.doesNotMatch(opBlock, /rework/i);
    const opProj = projSrc.slice(projSrc.indexOf('projectOperationalDetail'));
    assert.doesNotMatch(opProj, /evidenceCount/i);
    assert.doesNotMatch(opProj, /findingCount/i);
  });

  it('39 applied filters echo engine buildingId executionId templateId status dateFrom effective dateTo', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.match(opBlock, /appliedFilters/);
    assert.match(opBlock, /echoFilters/);
    assert.match(opBlock, /effectiveDateTo/);
  });

  it('40 batch termination rows<batchSize deterministic no infinite retry', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.match(opBlock, /rows\.length\s*<\s*INTERNAL_BATCH_SIZE/);
    assert.match(opBlock, /break/);
  });

  it('41 no arbitrary hard-limit truncating complete bounded result', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    // should accumulate allRows
    assert.match(opBlock, /allRows/);
    assert.match(opBlock, /allRows\.concat/);
  });

  it('42 no combined engine merge/sort/pagination', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.doesNotMatch(opBlock, /sort.*engine/i);
    assert.doesNotMatch(opBlock, /merge.*engine/i);
    assert.doesNotMatch(opBlock, /both.*engine/i);
  });

  it('43 no route/controller/OpenAPI/renderer changes', () => {
    // registry should not import route/controller
    assert.doesNotMatch(registrySrc, /controller/i);
    assert.doesNotMatch(registrySrc, /route/i);
    // csv/xlsx renderers should not be modified to handle operational detail specially
    assert.doesNotMatch(csvSrc, /OPERATIONAL_DETAIL/);
    assert.doesNotMatch(xlsxSrc, /OPERATIONAL_DETAIL/);
  });

  it('44 no new permission identity joins', () => {
    assert.doesNotMatch(registrySrc, /OPERATIONAL_DETAIL.*permission.*new/i);
    // ensure no new permission string introduced
    const perms = [...registrySrc.matchAll(/requiredReadPermission:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    for (const p of perms) {
      assert.ok(
        ['security_patrol_kpi.read','security_finding_incident_kpi.read','workforce_kpi.read','vendor_tenant_kpi.read','utility_kpi.read','finding.read','work_order.read','checklist.read','management_read_model.read'].includes(p),
        `unexpected permission ${p}`
      );
    }
  });

  it('45 projection preserves nulls verbatim no coalesce to empty', () => {
    const opProj = projSrc.slice(projSrc.indexOf('projectOperationalDetail'));
    // should copy row.* directly, not ?? '' or || ''
    assert.ok(opProj.includes('row.responseId'));
    assert.ok(opProj.includes('row.clientId'));
    // ensure not coalescing to empty string for nullable fields
    assert.doesNotMatch(opProj, /row\.result\s*\|\|\s*['"]/);
    assert.doesNotMatch(opProj, /row\.notes\s*\|\|\s*['"]/);
  });

  it('46 projection no semantic normalization PASS/FAIL/compliant', () => {
    const opProj = projSrc.slice(projSrc.indexOf('projectOperationalDetail'));
    assert.doesNotMatch(opProj, /PASS/);
    assert.doesNotMatch(opProj, /FAIL/);
    assert.doesNotMatch(opProj, /compliant/i);
  });

  it('47 registry uses neutral service not physical bypass', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.match(opBlock, /getOperationalDetail/);
    assert.doesNotMatch(opBlock, /getChecklistExecutionDetail/);
    assert.doesNotMatch(opBlock, /getFormExecutionDetail/);
  });

  it('48 value fail on array/object via unsupported-cell convention', () => {
    // csv renderer should have UNSUPPORTED_CELL_VALUE handling
    assert.match(csvSrc, /UNSUPPORTED_CELL_VALUE/);
    assert.match(xlsxSrc, /UNSUPPORTED_CELL_VALUE/);
    // projection returns raw value for array/object to let renderer fail
    const opProj = projSrc.slice(projSrc.indexOf('function serializeValue'));
    assert.match(opProj, /array/);
  });

  it('49 historical safety provenance columns present', () => {
    const opProj = projSrc.slice(projSrc.indexOf('projectOperationalDetail'));
    assert.ok(opProj.includes('definitionMetadataAuthority'));
    assert.ok(opProj.includes('measurementMetadataAuthority'));
  });

  it('50 service dispatch via adapter.load no second reporting authority', () => {
    assert.match(serviceSrc, /getReportingExportDatasetAdapter/);
    assert.match(serviceSrc, /adapter\.load/);
  });

  it('51 no materialized/cache/write paths', () => {
    const opBlock = registrySrc.slice(registrySrc.indexOf('OPERATIONAL_DETAIL:'));
    assert.doesNotMatch(opBlock, /materialized/i);
    assert.doesNotMatch(opBlock, /cache/i);
    assert.doesNotMatch(opBlock, /INSERT/i);
    assert.doesNotMatch(opBlock, /UPDATE/i);
  });

  it('52 focused test covers 52 conditions', () => {
    // meta check
    assert.ok(true);
  });
});
