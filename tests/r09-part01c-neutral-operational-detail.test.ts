import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R09 PART 01C — Neutral Adapter & OPERATIONAL_DETAIL Projection focused validation
 *
 * Static source assertions (no DB). Live-DB/runner cases are CI-required.
 *
 * Proves the contract-critical facts:
 * 1. neutral type contains definitionCode/templateCode/templateName (non-null)
 * 2. checklist mapper copies all 3 directly (verbatim, no transformation)
 * 3. form mapper copies all 3 directly (verbatim, no transformation)
 * 4. no fallback / default / inference / cross-engine read in either mapper
 * 5. physical repositories untouched (PART 01A/01B markers intact, no neutral imports)
 * 6. OPERATIONAL_DETAIL projection gains exactly the 3 new columns (46 -> 49)
 * 7. export dataset key / dataset list unchanged (still 11 datasets)
 * 8. registry load() unchanged (no new-field references)
 * 9. registry adapter count / key behavior unchanged
 * 10. permission unchanged (checklist.read for OPERATIONAL_DETAIL)
 * 11. engine handling unchanged (explicit engine required)
 * 12. responseState derivation unchanged
 * 13. no UOM-name fields added
 * 14. no actor-display-name fields added
 * 15. no R08 child flattening (no R08 module references in neutral service)
 * 16. definitionCode authority distinction (checklist vs form) preserved in docs
 * 17. templateName documented as current/live metadata
 */

const NEUTRAL_TYPES_PATH = resolve(
  __dirname,
  '../src/modules/operational-detail-reporting/operational-detail-reporting.types.ts',
);
const NEUTRAL_SERVICE_PATH = resolve(
  __dirname,
  '../src/modules/operational-detail-reporting/operational-detail-reporting.service.ts',
);
const PROJECTIONS_PATH = resolve(
  __dirname,
  '../src/modules/reporting-export/reporting-export.projections.ts',
);
const REGISTRY_PATH = resolve(
  __dirname,
  '../src/modules/reporting-export/reporting-export.registry.ts',
);
const EXPORT_TYPES_PATH = resolve(
  __dirname,
  '../src/modules/reporting-export/reporting-export.types.ts',
);
const CHECKLIST_REPO_PATH = resolve(
  __dirname,
  '../src/modules/checklist-execution-detail/checklist-execution-detail.repository.ts',
);
const FORM_REPO_PATH = resolve(
  __dirname,
  '../src/modules/form-execution-detail/form-execution-detail.repository.ts',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const neutralTypes = read(NEUTRAL_TYPES_PATH);
const neutralService = read(NEUTRAL_SERVICE_PATH);
const projections = read(PROJECTIONS_PATH);
const registry = read(REGISTRY_PATH);
const exportTypes = read(EXPORT_TYPES_PATH);
const checklistRepo = read(CHECKLIST_REPO_PATH);
const formRepo = read(FORM_REPO_PATH);

const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length;

// The operational-detail projection slice (last function in the file).
const opDetailStart = projections.indexOf('export function projectOperationalDetail(');
assert.ok(opDetailStart >= 0, 'projectOperationalDetail must exist');
const opDetail = projections.slice(opDetailStart);

// Mapper slices: each mapper function body, bounded by the next declaration.
function mapperSlice(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  assert.ok(start >= 0, `${startMarker} must exist`);
  assert.ok(end > start, `${endMarker} must follow ${startMarker}`);
  return src.slice(start, end);
}
const checklistMapper = mapperSlice(
  neutralService,
  'function mapChecklistRowToNeutral(',
  'function mapFormRowToNeutral(',
);
const formMapper = mapperSlice(
  neutralService,
  'function mapFormRowToNeutral(',
  'export async function getOperationalDetail(',
);

describe('R09 PART 01C — Neutral Adapter & OPERATIONAL_DETAIL Projection', () => {
  // 1. neutral contract
  it('01 neutral row exposes exactly the three identification fields, non-null', () => {
    assert.match(neutralTypes, /definitionCode: string;/);
    assert.match(neutralTypes, /templateCode: string;/);
    assert.match(neutralTypes, /templateName: string;/);
    assert.doesNotMatch(neutralTypes, /definitionCode: string \| null/);
    assert.doesNotMatch(neutralTypes, /templateCode: string \| null/);
    assert.doesNotMatch(neutralTypes, /templateName: string \| null/);
  });

  // 2./3. direct verbatim copies in both mappers
  it('02 checklist mapper copies all three fields verbatim', () => {
    assert.match(checklistMapper, /definitionCode: row\.definitionCode,/);
    assert.match(checklistMapper, /templateCode: row\.templateCode,/);
    assert.match(checklistMapper, /templateName: row\.templateName,/);
  });

  it('03 form mapper copies all three fields verbatim', () => {
    assert.match(formMapper, /definitionCode: row\.definitionCode,/);
    assert.match(formMapper, /templateCode: row\.templateCode,/);
    assert.match(formMapper, /templateName: row\.templateName,/);
  });

  // 4. no fallback / default / inference
  it('04 no fallback, default, or cross-engine inference in either mapper', () => {
    for (const m of [checklistMapper, formMapper]) {
      assert.doesNotMatch(m, /definitionCode[^\n]*\?\?/);
      assert.doesNotMatch(m, /templateCode[^\n]*\?\?/);
      assert.doesNotMatch(m, /templateName[^\n]*\?\?/);
      assert.doesNotMatch(m, /definitionCode[^\n]*\|\|/);
      // mappers never touch the other engine's physical field names
      assert.doesNotMatch(checklistMapper, /formInstanceId|versionFieldId|fieldLabel/);
      assert.doesNotMatch(formMapper, /checklistItemId|itemLabel/);
    }
  });

  // 5. physical repositories untouched
  it('05 physical repositories untouched: PART 01A/01B markers intact, no neutral imports', () => {
    assert.match(checklistRepo, /R09 PART 01A/);
    assert.match(formRepo, /R09 PART 01B/);
    assert.doesNotMatch(checklistRepo, /operational-detail-reporting/);
    assert.doesNotMatch(formRepo, /operational-detail-reporting/);
    // their identification selects are still the sole source of the fields
    assert.equal(count(checklistRepo, /ct\.name AS template_name/g), 1);
    assert.equal(count(formRepo, /ft\.name AS template_name/g), 2);
  });

  // 6. exactly three new export columns (46 -> 49; still under the PDF 50-column cap)
  it('06 OPERATIONAL_DETAIL projection contains exactly the three new columns (49 total)', () => {
    assert.match(opDetail, /key: 'definitionCode', label: 'Definition Code'/);
    assert.match(opDetail, /key: 'templateCode', label: 'Template Code'/);
    assert.match(opDetail, /key: 'templateName', label: 'Template Name'/);
    assert.equal(count(opDetail, /\{ key: '/g), 49);
    // stable logical positions: definitionCode after definitionItemId before responseId
    const di = opDetail.indexOf("key: 'definitionItemId'");
    const dc = opDetail.indexOf("key: 'definitionCode'");
    const ri = opDetail.indexOf("key: 'responseId'");
    assert.ok(di < dc && dc < ri, 'definitionCode positioned between definitionItemId and responseId');
    // templateCode/templateName after templateId before status
    const ti = opDetail.indexOf("key: 'templateId'");
    const tc = opDetail.indexOf("key: 'templateCode'");
    const tn = opDetail.indexOf("key: 'templateName'");
    const st = opDetail.indexOf("key: 'status'");
    assert.ok(ti < tc && tc < tn && tn < st, 'templateCode/templateName positioned after templateId before status');
    // row mapping carries the three fields
    assert.match(opDetail, /definitionCode: row\.definitionCode,/);
    assert.match(opDetail, /templateCode: row\.templateCode,/);
    assert.match(opDetail, /templateName: row\.templateName,/);
  });

  // 7./9. dataset key and registry count unchanged
  it('07 dataset list unchanged: still exactly 11 datasets, OPERATIONAL_DETAIL present', () => {
    const listStart = exportTypes.indexOf('REPORTING_EXPORT_DATASETS = [');
    assert.ok(listStart >= 0, 'REPORTING_EXPORT_DATASETS list must exist');
    const listEnd = exportTypes.indexOf('] as const', listStart);
    const list = exportTypes.slice(listStart, listEnd);
    assert.equal(count(list, /'\w+'/g), 11);
    assert.match(list, /'OPERATIONAL_DETAIL'/);
  });

  it('08 registry adapter count unchanged (11 datasets) and load() has no new-field references', () => {
    assert.equal(count(registry, /datasetLabel: '/g), 11); // 11 adapters (the type member 'datasetLabel: string' is excluded by requiring the quoted literal)
    assert.doesNotMatch(registry, /definitionCode|templateCode|templateName/);
  });

  // 10. permission unchanged
  it('10 OPERATIONAL_DETAIL permission unchanged (checklist.read, no new permission)', () => {
    const block = registry.slice(registry.indexOf('OPERATIONAL_DETAIL:'));
    assert.match(block, /requiredReadPermission:\s*['"]checklist\.read['"]/);
  });

  // 11. engine handling unchanged
  it('11 explicit-engine requirement unchanged in the neutral service', () => {
    assert.match(neutralService, /engine is required/);
    assert.match(neutralTypes, /OPERATIONAL_DETAIL_ENGINES = \['CHECKLIST_EXECUTION', 'FORM_INSTANCE'\] as const/);
  });

  // 12. responseState unchanged
  it('12 responseState derivation unchanged', () => {
    assert.match(projections, /if \(row\.responseId == null\) return 'UNANSWERED';/);
    assert.match(projections, /if \(row\.engine === 'CHECKLIST_EXECUTION' && row\.responseId != null && row\.isNa === true\) return 'EXPLICIT_NA';/);
    assert.match(projections, /if \(row\.responseId != null && row\.value == null\) return 'RESPONDED_NULL';/);
    assert.match(projections, /return 'RESPONDED';/);
  });

  // 13./14. no UOM-name or actor-display fields anywhere in this PART's surface
  it('13 no UOM name/symbol fields introduced', () => {
    for (const src of [neutralTypes, neutralService, opDetail]) {
      assert.doesNotMatch(src, /uomName|uomSymbol|uom_name|uom_symbol/);
    }
  });

  it('14 no actor display-name fields introduced', () => {
    for (const src of [neutralTypes, neutralService, opDetail]) {
      assert.doesNotMatch(src, /completedByName|lastRespondedByName|verificationReviewerName|assignedWorkforceName|assignedTeamName/);
    }
  });

  // 15. no R08 child flattening
  it('15 no R08 child module or table references in the neutral adapter', () => {
    assert.doesNotMatch(neutralService, /operational-detail-evidence|operational-detail-finding|operational-detail-review-history/);
    assert.doesNotMatch(neutralTypes, /evidence_submissions|finding_rework_cycles/);
  });

  // 16. engine-specific definitionCode authority distinction preserved
  it('16 neutral contract documents the checklist-vs-form definitionCode distinction', () => {
    const line = neutralTypes
      .split('\n')
      .find((l) => l.includes('definitionCode: string;'));
    assert.ok(line, 'definitionCode field line present');
    assert.match(line ?? '', /CHECKLIST_EXECUTION/);
    assert.match(line ?? '', /NOT a version snapshot/);
    assert.match(line ?? '', /FORM_INSTANCE/);
    assert.match(line ?? '', /VERSION SNAPSHOT/);
    // header keeps the engine-specific block too
    assert.match(neutralTypes, /ENGINE-SPECIFIC authority, not flattened/);
  });

  // 17. templateName documented as current/live
  it('17 templateName documented as CURRENT LIVE FACT, not a historical snapshot', () => {
    const line = neutralTypes
      .split('\n')
      .find((l) => l.includes('templateName: string;'));
    assert.ok(line, 'templateName field line present');
    assert.match(line ?? '', /CURRENT LIVE FACT/);
    assert.match(line ?? '', /NOT a historical snapshot/);
  });

  it('18 no new dataset / permission identifiers introduced by this PART', () => {
    assert.doesNotMatch(opDetail, /CHECKLIST_DETAIL|FORM_DETAIL_DATASET/);
    // no operational-detail-specific permission string anywhere in the registry
    assert.doesNotMatch(registry, /operational_detail[._]read/);
  });
});
