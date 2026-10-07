import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R09 PART 02A3 — Neutral UOM Metadata & OPERATIONAL_DETAIL Projection
 * focused validation
 *
 * Static source assertions (no DB). Live-DB/runner cases are CI-required.
 *
 * Proves the contract-critical facts:
 *  1. neutral type adds nullable uomName
 *  2. neutral type adds nullable uomSymbol
 *  3. checklist mapper copies uomName directly
 *  4. checklist mapper copies uomSymbol directly
 *  5. form mapper copies uomName directly
 *  6. form mapper copies uomSymbol directly
 *  7. no fallback / COALESCE / alternate UOM lookup
 *  8. physical checklist repository untouched
 *  9. physical form repository untouched
 * 10. OPERATIONAL_DETAIL adds exactly ONE new column
 * 11. the new export key is uomSymbol
 * 12. uomName is NOT added to export columns
 * 13. UOM Symbol is placed immediately after uomId
 * 14. export maps row.uomSymbol directly
 * 15. previous export count 49 (50 total minus exactly one uomSymbol key)
 * 16. final export count exactly 50
 * 17. PDF renderer cap remains 50 and untouched
 * 18. uomId remains exported
 * 19. dataset key unchanged
 * 20. dataset count unchanged
 * 21. registry/load behavior unchanged
 * 22. permission unchanged
 * 23. engine handling unchanged
 * 24. responseState unchanged
 * 25. table count remains 1
 * 26. metadata comments classify labels CURRENT LIVE FACT
 * 27. comments do not claim historical snapshot
 * 28. comments do not claim symbol uniqueness
 * 29. no actor-display fields added
 * 30. no R08 child flattening
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
const PDF_RENDERER_PATH = resolve(
  __dirname,
  '../src/modules/reporting-export/pdf-renderer.ts',
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
const pdfRenderer = read(PDF_RENDERER_PATH);
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

// Comment-stripped physical repos (for join counting).
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\*.*$/gm, '');

describe('R09 PART 02A3 — Neutral UOM Metadata & OPERATIONAL_DETAIL Projection', () => {
  // 1./2. neutral contract
  it('01 neutral row exposes nullable uomName', () => {
    assert.match(neutralTypes, /uomName: string \| null;/);
    assert.doesNotMatch(neutralTypes, /uomName: string;/);
  });

  it('02 neutral row exposes nullable uomSymbol', () => {
    assert.match(neutralTypes, /uomSymbol: string \| null;/);
    assert.doesNotMatch(neutralTypes, /uomSymbol: string;/);
  });

  // 3./4. checklist mapper verbatim
  it('03 checklist mapper copies uomName directly', () => {
    assert.match(checklistMapper, /uomName: row\.uomName,/);
  });

  it('04 checklist mapper copies uomSymbol directly', () => {
    assert.match(checklistMapper, /uomSymbol: row\.uomSymbol,/);
  });

  // 5./6. form mapper verbatim
  it('05 form mapper copies uomName directly', () => {
    assert.match(formMapper, /uomName: row\.uomName,/);
  });

  it('06 form mapper copies uomSymbol directly', () => {
    assert.match(formMapper, /uomSymbol: row\.uomSymbol,/);
  });

  // 7. no fallback / COALESCE / alternate lookup
  it('07 no fallback, COALESCE, derivation, or alternate UOM lookup', () => {
    for (const m of [checklistMapper, formMapper]) {
      assert.doesNotMatch(m, /uomName[^\n]*\?\?/);
      assert.doesNotMatch(m, /uomSymbol[^\n]*\?\?/);
      assert.doesNotMatch(m, /uomName[^\n]*\|\|/);
      assert.doesNotMatch(m, /uomSymbol[^\n]*\|\|/);
      assert.doesNotMatch(m, /COALESCE\([^)]*uom/i);
    }
    // no SQL UOM lookup anywhere in the neutral service (no new read authority)
    assert.doesNotMatch(neutralService, /units_of_measure/i);
    // no name<->symbol derivation in the projection
    assert.doesNotMatch(opDetail, /uomName[^\n]*\+|uomSymbol[^\n]*\+|\+\s*row\.uom/i);
  });

  // 8./9. physical repositories untouched
  it('08 physical checklist repository untouched (PART 02A1 intact, no neutral imports)', () => {
    assert.match(checklistRepo, /R09 PART 02A1/);
    assert.equal(count(stripComments(checklistRepo), /LEFT JOIN units_of_measure/g), 1);
    assert.doesNotMatch(checklistRepo, /operational-detail-reporting/);
  });

  it('09 physical form repository untouched (PART 02A2 intact, no neutral imports)', () => {
    assert.match(formRepo, /R09 PART 02A2/);
    assert.equal(count(stripComments(formRepo), /LEFT JOIN units_of_measure/g), 2);
    assert.doesNotMatch(formRepo, /operational-detail-reporting/);
  });

  // 10-16. export column contract
  it('10 exactly one new UOM export column (only uomId and uomSymbol exist in the slice)', () => {
    const uomKeys = opDetail.match(/\{ key: 'uom\w+',/g) ?? [];
    assert.deepEqual(uomKeys.map((k) => k.trim()), [
      "{ key: 'uomId',",
      "{ key: 'uomSymbol',",
    ]);
  });

  it('11 the new export key is uomSymbol with label "UOM Symbol" (STRING)', () => {
    assert.match(opDetail, /\{ key: 'uomSymbol', label: 'UOM Symbol', type: STRING \}/);
  });

  it('12 uomName is NOT an export column', () => {
    assert.doesNotMatch(opDetail, /key: 'uomName'/);
    assert.doesNotMatch(opDetail, /uomName: row\.uomName/);
  });

  it('13 UOM Symbol placed immediately after uomId (before minimumValue)', () => {
    const a = opDetail.indexOf("key: 'uomId'");
    const b = opDetail.indexOf("key: 'uomSymbol'");
    const c = opDetail.indexOf("key: 'minimumValue'");
    assert.ok(a >= 0 && b > a && c > b, 'uomId < uomSymbol < minimumValue');
  });

  it('14 export row mapping copies row.uomSymbol directly', () => {
    assert.match(opDetail, /uomSymbol: row\.uomSymbol,/);
  });

  it('15 previous export count was 49 (50 total minus exactly one uomSymbol key)', () => {
    assert.equal(count(opDetail, /\{ key: 'uomSymbol'/g), 1);
  });

  it('16 final OPERATIONAL_DETAIL export count is exactly 50 (PDF cap reached, not exceeded)', () => {
    assert.equal(count(opDetail, /\{ key: '/g), 50);
  });

  // 17. PDF renderer cap untouched
  it('17 PDF renderer cap remains MAX_COLUMNS = 50', () => {
    assert.match(pdfRenderer, /const MAX_COLUMNS = 50;/);
    assert.match(pdfRenderer, /must not contain more than \$\{MAX_COLUMNS\} columns/);
  });

  // 18. uomId preserved
  it('18 uomId remains exported (stable anchor, not replaced)', () => {
    assert.match(opDetail, /\{ key: 'uomId', label: 'UOM Id', type: STRING \}/);
    assert.match(opDetail, /uomId: row\.uomId,/);
  });

  // 19./20. dataset preservation
  it('19 dataset key unchanged (OPERATIONAL_DETAIL present in the list)', () => {
    const listStart = exportTypes.indexOf('REPORTING_EXPORT_DATASETS = [');
    assert.ok(listStart >= 0, 'REPORTING_EXPORT_DATASETS list must exist');
    const listEnd = exportTypes.indexOf('] as const', listStart);
    const list = exportTypes.slice(listStart, listEnd);
    assert.match(list, /'OPERATIONAL_DETAIL'/);
  });

  it('20 dataset count unchanged (exactly 11 datasets)', () => {
    const listStart = exportTypes.indexOf('REPORTING_EXPORT_DATASETS = [');
    const listEnd = exportTypes.indexOf('] as const', listStart);
    const list = exportTypes.slice(listStart, listEnd);
    assert.equal(count(list, /'\w+'/g), 11);
  });

  // 21./22. registry preservation
  it('21 registry adapter count unchanged and load() has no UOM references', () => {
    assert.equal(count(registry, /datasetLabel: '/g), 11);
    assert.doesNotMatch(registry, /uomName|uomSymbol/);
  });

  it('22 OPERATIONAL_DETAIL permission unchanged (checklist.read)', () => {
    const block = registry.slice(registry.indexOf('OPERATIONAL_DETAIL:'));
    assert.match(block, /requiredReadPermission:\s*['"]checklist\.read['"]/);
  });

  // 23. engine handling unchanged
  it('23 explicit-engine requirement and engine list unchanged', () => {
    assert.match(neutralService, /engine is required/);
    assert.match(neutralTypes, /OPERATIONAL_DETAIL_ENGINES = \['CHECKLIST_EXECUTION', 'FORM_INSTANCE'\] as const/);
  });

  // 24. responseState unchanged
  it('24 responseState derivation unchanged', () => {
    assert.match(projections, /if \(row\.responseId == null\) return 'UNANSWERED';/);
    assert.match(projections, /if \(row\.engine === 'CHECKLIST_EXECUTION' && row\.responseId != null && row\.isNa === true\) return 'EXPLICIT_NA';/);
    assert.match(projections, /if \(row\.responseId != null && row\.value == null\) return 'RESPONDED_NULL';/);
    assert.match(projections, /return 'RESPONDED';/);
  });

  // 25. single table
  it('25 OPERATIONAL_DETAIL remains exactly one table', () => {
    assert.equal(count(opDetail, /\btable\(/g), 1);
  });

  // 26./27./28. truthful metadata documentation
  it('26 both neutral fields documented as CURRENT LIVE FACT', () => {
    for (const field of ['uomName: string | null;', 'uomSymbol: string | null;']) {
      const line = neutralTypes
        .split('\n')
        .find((l) => l.includes(field));
      assert.ok(line, `${field} line present`);
      assert.match(line ?? '', /CURRENT LIVE FACT/);
      assert.match(line ?? '', /NOT a historical snapshot/);
    }
    assert.match(neutralTypes, /R09 PART 02A3 UOM presentation/);
  });

  it('27 no affirmative historical-snapshot classification for either label', () => {
    for (const field of ['uomName: string | null;', 'uomSymbol: string | null;']) {
      const line = neutralTypes
        .split('\n')
        .find((l) => l.includes(field));
      assert.doesNotMatch(line ?? '', /VERSION SNAPSHOT|STABLE snapshot|stable snapshot/);
    }
  });

  it('28 no affirmative uniqueness claim for uomSymbol (truthful "NOT unique" allowed)', () => {
    const symbolLine = neutralTypes
      .split('\n')
      .find((l) => l.includes('uomSymbol: string | null;'));
    assert.ok(symbolLine, 'uomSymbol line present');
    assert.doesNotMatch(symbolLine ?? '', /(?<!NOT )unique/);
  });

  // 29. no actor display fields
  it('29 no actor display-name fields introduced', () => {
    for (const src of [neutralTypes, neutralService, opDetail]) {
      assert.doesNotMatch(src, /completedByName|lastRespondedByName|verificationReviewerName|assignedWorkforceName|assignedTeamName/);
    }
  });

  // 30. no R08 child flattening
  it('30 no R08 child module or table references in the neutral adapter', () => {
    assert.doesNotMatch(neutralService, /operational-detail-evidence|operational-detail-finding|operational-detail-review-history/);
    assert.doesNotMatch(neutralTypes, /evidence_submissions|finding_rework_cycles/);
  });
});
