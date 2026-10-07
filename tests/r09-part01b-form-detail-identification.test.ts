import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R09 PART 01B — Form Definition & Template Context focused validation
 *
 * Static source assertions (no DB). Live-DB grain/authorization/semantic
 * cases are CI-required.
 *
 * Proves the contract-critical facts:
 * 1. definitionCode comes from the authoritative version-field code
 *    (form_template_version_fields via alias vf — NOT live form_fields)
 * 2. templateCode comes from the proven form template lineage (ft)
 * 3. templateName comes from the proven form template lineage (ft)
 * 4. form grain unchanged (both UNION branches, field_code preserved,
 *    deterministic ORDER BY preserved)
 * 5. repeatable occurrence behavior unchanged (both occurrence joins)
 * 6. metadata joins are 1:1 (no new joins; only pre-existing ft/vf joins;
 *    no GROUP BY / DISTINCT / ROW_NUMBER workaround)
 * 7. single bounded query preserved (one getPool().query; LIMIT/OFFSET)
 * 8. building/client scoping predicates preserved
 * 9. response semantics preserved (non-repeatable IS NULL vs occurrence)
 * 10. latest completed review selector preserved in both branches
 * 11. checklist files untouched by this PART
 * 12. neutral adapter untouched
 * 13. export projection untouched
 * 14. metadata authority comments are truthful
 */

const REPO_PATH = resolve(
  __dirname,
  '../src/modules/form-execution-detail/form-execution-detail.repository.ts',
);
const TYPES_PATH = resolve(
  __dirname,
  '../src/modules/form-execution-detail/form-execution-detail.types.ts',
);
const INDEX_PATH = resolve(
  __dirname,
  '../src/modules/form-execution-detail/index.ts',
);
const NEUTRAL_SERVICE_PATH = resolve(
  __dirname,
  '../src/modules/operational-detail-reporting/operational-detail-reporting.service.ts',
);
const CHECKLIST_REPO_PATH = resolve(
  __dirname,
  '../src/modules/checklist-execution-detail/checklist-execution-detail.repository.ts',
);
const NEUTRAL_TYPES_PATH = resolve(
  __dirname,
  '../src/modules/operational-detail-reporting/operational-detail-reporting.types.ts',
);
const PROJECTIONS_PATH = resolve(
  __dirname,
  '../src/modules/reporting-export/reporting-export.projections.ts',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const repo = read(REPO_PATH);
const types = read(TYPES_PATH);
const index = read(INDEX_PATH);
const neutralService = read(NEUTRAL_SERVICE_PATH);
const checklistRepo = read(CHECKLIST_REPO_PATH);
const neutralTypes = read(NEUTRAL_TYPES_PATH);
const projections = read(PROJECTIONS_PATH);

const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length;

// Code-only view: block comments and ` * ` comment lines stripped so
// join counting cannot be fooled by documentation text.
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\*.*$/gm, '');
const repoCode = stripComments(repo);

describe('R09 PART 01B — Form Definition & Template Context', () => {
  // 1. definitionCode from the authoritative version-field code
  it('01 definitionCode selected from version-field snapshot (vf.code), in both UNION branches', () => {
    assert.equal(count(repoCode, /vf\.code AS definition_code/g), 2);
    // never from the live form_fields master
    assert.doesNotMatch(repoCode, /ff\.code AS definition_code/);
  });

  // 2./3. templateCode + templateName from the proven template lineage
  it('02 templateCode + templateName selected from form_templates (ft), in both UNION branches', () => {
    assert.equal(count(repoCode, /ft\.code AS template_code/g), 2);
    assert.equal(count(repoCode, /ft\.name AS template_name/g), 2);
  });

  it('03 template lineage join path preserved (instance -> version PK -> template PK)', () => {
    assert.match(repo, /JOIN form_template_versions v ON v\.id = fi_filtered\.form_template_version_id/);
    assert.match(repo, /JOIN form_templates ft ON ft\.id = v\.form_template_id/);
  });

  // 6. metadata joins are 1:1 — nothing new
  it('04 no new joins introduced: only the pre-existing per-branch ft and v joins', () => {
    assert.equal(count(repoCode, /JOIN form_templates ft/g), 2);
    assert.equal(count(repoCode, /JOIN form_template_versions v ON/g), 2);
    assert.doesNotMatch(
      repoCode,
      /JOIN (users|teams|workforce_profiles|units_of_measure|checklist_templates|checklist_items|checklist_executions)\b/,
    );
  });

  it('05 no GROUP BY / DISTINCT / ROW_NUMBER deduplication workaround', () => {
    assert.doesNotMatch(repoCode, /GROUP BY|DISTINCT|ROW_NUMBER/);
  });

  // 4. form grain unchanged
  it('06 form grain unchanged: both UNION branches, field_code preserved, deterministic order', () => {
    assert.equal(count(repoCode, /UNION ALL/g), 1);
    assert.equal(count(repoCode, /vf\.code AS field_code/g), 2);
    assert.match(
      repo,
      /ORDER BY instance_created_at DESC, form_instance_id ASC, section_display_order ASC, section_id ASC, occurrence_index ASC NULLS FIRST, display_order ASC, version_field_id ASC/,
    );
  });

  // 5. repeatable occurrence behavior unchanged
  it('07 repeatable occurrence expansion and non-repeatable placeholder unchanged', () => {
    assert.match(repo, /JOIN form_instance_occurrences occ ON occ\.form_instance_id = fi_filtered\.id AND occ\.repeatable_group_id = rg\.id/);
    assert.match(repo, /LEFT JOIN LATERAL \(SELECT NULL::uuid AS id, NULL::int AS occurrence_index\) occ ON rg\.id IS NULL/);
    assert.match(repo, /WHERE rg\.id IS NULL AND \$\{conditions\.join\(' AND '\)\}/);
  });

  // 7. single bounded query
  it('08 query remains a single bounded query with LIMIT/OFFSET intact', () => {
    assert.equal(count(repoCode, /getPool\(\)\.query/g), 1);
    assert.match(repo, /\$\{limitClause\}/);
    assert.match(repo, /\$\{offsetClause\}/);
  });

  // 8. authorization preservation
  it('09 building/client scoping predicates preserved verbatim', () => {
    assert.match(repo, /fi_filtered\.building_id = ANY\(\$1::uuid\[\]\)/);
    assert.match(repo, /SELECT \* FROM fi_base WHERE building_id IS NOT NULL/);
    assert.match(repo, /fi_filtered\.id = \$\$\{paramIndex\}::uuid/);
    assert.match(repo, /ft\.id = \$\$\{paramIndex\}::uuid/);
    assert.match(repo, /fi_filtered\.created_at >= \$\$\{paramIndex\}/);
    assert.match(repo, /fi_filtered\.created_at < \$\$\{paramIndex\}/);
  });

  // 9. response semantics preserved
  it('10 response join semantics preserved in both branches', () => {
    assert.equal(count(repoCode, /AND r\.occurrence_id IS NULL/g), 1);
    assert.equal(count(repoCode, /AND r\.occurrence_id = occ\.id/g), 1);
  });

  // 10. latest completed review selector preserved
  it('11 latest-COMPLETED-review LATERAL selector preserved in both branches', () => {
    assert.equal(count(repoCode, /target_type = 'FORM_INSTANCE'/g), 2);
    assert.equal(count(repoCode, /status = 'COMPLETED'/g), 2);
    assert.equal(count(repoCode, /LIMIT 1/g), 2);
  });

  // 11. checklist files untouched
  it('12 checklist module untouched: no form-engine references, its own join structure intact', () => {
    assert.doesNotMatch(checklistRepo, /form_template|form_instances|form_fields|form_responses/);
    assert.equal(count(stripComments(checklistRepo), /JOIN checklist_templates/g), 1);
  });

  // 12. neutral adapter untouched
  it('13 neutral adapter not propagated yet (belongs to PART 01C)', () => {
    assert.doesNotMatch(neutralTypes, /definitionCode|templateCode|templateName/);
  });

  // 13. export projection untouched
  it('14 OPERATIONAL_DETAIL export projection not extended yet (belongs to PART 01C)', () => {
    const start = projections.indexOf('export function projectOperationalDetail(');
    assert.ok(start >= 0, 'projectOperationalDetail present');
    assert.doesNotMatch(projections.slice(start), /definitionCode|templateCode|templateName/);
  });

  it('15 no application-side enrichment: module exports and neutral mapper untouched', () => {
    // form module shape: repository + types only (no service layer to enrich)
    assert.doesNotMatch(index, /definitionCode|templateCode|templateName/);
    // neutral mapper (PART 01C territory) must not reference the new fields yet
    assert.doesNotMatch(neutralService, /definitionCode|templateCode|templateName/);
  });

  // 14. truthful metadata authority documentation
  it('16 types: three non-null identification fields present', () => {
    assert.match(types, /definitionCode: string;/);
    assert.match(types, /templateCode: string;/);
    assert.match(types, /templateName: string;/);
    assert.doesNotMatch(types, /definitionCode: string \| null/);
    assert.doesNotMatch(types, /templateCode: string \| null/);
    assert.doesNotMatch(types, /templateName: string \| null/);
  });

  it('17 repository row contract and mapRow carry the three non-null columns', () => {
    assert.match(repo, /definition_code: string;/);
    assert.match(repo, /template_code: string;/);
    assert.match(repo, /template_name: string;/);
    assert.match(repo, /definitionCode: row\.definition_code,/);
    assert.match(repo, /templateCode: row\.template_code,/);
    assert.match(repo, /templateName: row\.template_name,/);
  });

  it('18 definitionCode documented as STABLE VERSION SNAPSHOT (not a live value)', () => {
    const line = types
      .split('\n')
      .find((l) => l.includes('definitionCode: string;'));
    assert.ok(line, 'definitionCode field line present');
    assert.match(line ?? '', /STABLE VERSION SNAPSHOT/);
    assert.match(line ?? '', /fieldCode/);
    assert.doesNotMatch(line ?? '', /LIVE/);
  });

  it('19 templateCode documented as current master fact (no invented snapshot claim)', () => {
    const line = types
      .split('\n')
      .find((l) => l.includes('templateCode: string;'));
    assert.ok(line, 'templateCode field line present');
    assert.match(line ?? '', /CURRENT template master fact/);
    assert.doesNotMatch(line ?? '', /STABLE VERSION SNAPSHOT/);
  });

  it('20 templateName documented as CURRENT LIVE FACT, not a historical snapshot', () => {
    const line = types
      .split('\n')
      .find((l) => l.includes('templateName: string;'));
    assert.ok(line, 'templateName field line present');
    assert.match(line ?? '', /CURRENT LIVE FACT/);
    assert.match(line ?? '', /NOT a historical snapshot/);
  });

  it('21 repository documents the R09 PART 01B additions as SELECT-only, no new joins', () => {
    assert.match(repo, /R09 PART 01B/);
    assert.match(repo, /SELECT-only/);
    assert.match(repo, /NO new joins/);
  });
});
