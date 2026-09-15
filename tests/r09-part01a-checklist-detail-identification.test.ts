import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R09 PART 01A — Checklist Definition & Template Context focused validation
 *
 * Static source assertions (no DB). Live-DB grain/authorization/semantic
 * cases are CI-required.
 *
 * Proves the contract-critical facts:
 * 1. definitionCode selected from the checklist item authority
 *    (checklist_items.code — column of the already-joined items row)
 * 2. templateCode selected from the authoritative template relation
 * 3. templateName selected from the authoritative template relation
 * 4. template join is a single 1:1 inner join on the persisted PK FK
 *    (cannot multiply rows; execution FK is NOT NULL — cannot drop rows)
 * 5. no display-name / UOM / form / export additions in this PART
 * 6. no propagation into neutral adapter or export projection yet
 * 7. query remains a single bounded query (one getPool().query;
 *    LIMIT/OFFSET and deterministic ORDER BY preserved)
 * 8. no grain multiplication (exactly one new join; no text-matching joins)
 * 9. existing building/client scoping predicates preserved
 * 10. existing response / N/A / SELECT / verification semantics preserved
 * 11. metadata semantics documented truthfully (current master facts,
 *     templateName = CURRENT LIVE FACT; nothing described as a snapshot)
 */

const REPO_PATH = resolve(
  __dirname,
  '../src/modules/checklist-execution-detail/checklist-execution-detail.repository.ts',
);
const TYPES_PATH = resolve(
  __dirname,
  '../src/modules/checklist-execution-detail/checklist-execution-detail.types.ts',
);
const SERVICE_PATH = resolve(
  __dirname,
  '../src/modules/checklist-execution-detail/checklist-execution-detail.service.ts',
);
const FORM_TYPES_PATH = resolve(
  __dirname,
  '../src/modules/form-execution-detail/form-execution-detail.types.ts',
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
const service = read(SERVICE_PATH);
const formTypes = read(FORM_TYPES_PATH);
const neutralTypes = read(NEUTRAL_TYPES_PATH);
const projections = read(PROJECTIONS_PATH);

const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length;

// Code-only view: block comments and ` * ` comment lines stripped, so
// join-counting cannot be fooled by documentation text.
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\*.*$/gm, '');
const repoCode = stripComments(repo);

describe('R09 PART 01A — Checklist Definition & Template Context', () => {
  // 1. definitionCode from checklist item authority
  it('01 definitionCode selected from checklist_items.code (existing join, no new lookup)', () => {
    assert.match(repo, /ci\.code AS definition_code/);
    // still selected from the already-joined items table, not a subquery
    assert.doesNotMatch(repo, /definition_code[^\n]*\(SELECT/i);
  });

  // 2./3. templateCode + templateName from the authoritative template relation
  it('02 templateCode + templateName selected from checklist_templates', () => {
    assert.match(repo, /ct\.code AS template_code/);
    assert.match(repo, /ct\.name AS template_name/);
  });

  it('03 template join is the persisted PK foreign-key relation (inner, on ct.id)', () => {
    assert.match(repo, /JOIN checklist_templates ct\s+ON ct\.id = ce_filtered\.checklist_template_id/);
    // no derivation from codes/labels/text matching
    assert.doesNotMatch(repo, /JOIN checklist_templates[^\n]*code/i);
    assert.doesNotMatch(repo, /JOIN checklist_templates[^\n]*name/i);
  });

  // 8. grain safety — exactly one new join, on the PK
  it('04 exactly one checklist_templates join in code (no 1:N fan-out path introduced)', () => {
    assert.equal(count(repoCode, /JOIN checklist_templates/g), 1);
    // the join key is the template primary key
    assert.match(repo, /ON ct\.id = ce_filtered\.checklist_template_id/);
  });

  it('05 grain contract unchanged: one row per (execution, item), deterministic ordering preserved', () => {
    assert.match(repo, /ORDER BY ce_filtered\.created_at DESC, ce_filtered\.id ASC, ci\.display_order ASC, ci\.id ASC/);
  });

  // 7. single bounded query
  it('06 query remains a single bounded query with LIMIT/OFFSET intact', () => {
    assert.equal(count(repoCode, /getPool\(\)\.query/g), 1);
    assert.match(repo, /\$\{limitClause\}/);
    assert.match(repo, /\$\{offsetClause\}/);
  });

  // 9. authorization preservation
  it('07 building/client scoping predicates preserved verbatim', () => {
    assert.match(repo, /ce_filtered\.building_id = ANY\(\$1::uuid\[\]\)/);
    assert.match(repo, /SELECT \* FROM ce_base WHERE building_id IS NOT NULL/);
    assert.match(repo, /ce_filtered\.id = \$\$\{paramIndex\}::uuid/);
    assert.match(repo, /ce_filtered\.checklist_template_id = \$\$\{paramIndex\}::uuid/);
    assert.match(repo, /ce_filtered\.created_at >= \$\$\{paramIndex\}/);
    assert.match(repo, /ce_filtered\.created_at < \$\$\{paramIndex\}/);
  });

  // 10. response / N/A / SELECT / verification semantics preserved
  it('08 response LEFT JOIN, option resolution and latest-COMPLETED-review semantics intact', () => {
    assert.match(repo, /LEFT JOIN checklist_item_responses r/);
    assert.match(repo, /LEFT JOIN checklist_item_options cio/);
    assert.match(repo, /WHEN ci\.item_type = 'SELECT' AND r\.id IS NOT NULL AND COALESCE\(r\.is_na, false\) = false AND r\.value IS NOT NULL/);
    assert.match(repo, /FROM reviews/);
    assert.match(repo, /status = 'COMPLETED'/);
    assert.match(repo, /LIMIT 1/);
  });

  it('09 isNa / N-A / value / result mapping semantics in mapRow unchanged', () => {
    assert.match(repo, /const isNa = row\.is_na === true;/);
    assert.match(repo, /const optionCode = isNa \? null : row\.option_code;/);
    assert.match(repo, /const value = isNa \? null : row\.value;/);
    assert.match(repo, /const result = isNa \? null : row\.result;/);
  });

  // 5./6. scope boundaries
  it('10 no display-name, UOM label, or actor presentation sources introduced', () => {
    for (const src of [repo, types, service]) {
      assert.doesNotMatch(src, /display_name|full_name|uom_name|uom_symbol/);
      assert.doesNotMatch(src, /JOIN users|JOIN teams|JOIN workforce_profiles|JOIN units_of_measure/);
    }
  });

  it('11 form engine untouched in this PART', () => {
    assert.doesNotMatch(formTypes, /definitionCode|templateCode|templateName/);
  });

  it('12 neutral adapter not propagated yet (belongs to a later PART)', () => {
    assert.doesNotMatch(neutralTypes, /definitionCode|templateName/);
  });

  it('13 OPERATIONAL_DETAIL export projection not extended yet (belongs to a later PART)', () => {
    // Scope to the operational-detail projection only — other datasets
    // (e.g. R04 summary) legitimately pre-date R09 and are untouched.
    const start = projections.indexOf('export function projectOperationalDetail(');
    assert.ok(start >= 0, 'projectOperationalDetail present');
    const opDetail = projections.slice(start);
    assert.doesNotMatch(opDetail, /definitionCode|templateCode|templateName/);
  });

  it('14 service remains a pure pass-through (no application-side enrichment)', () => {
    assert.doesNotMatch(service, /definitionCode|templateCode|templateName/);
  });

  // types contract
  it('15 types add exactly three non-null identification fields with truthful docs', () => {
    assert.match(types, /definitionCode: string;/);
    assert.match(types, /templateCode: string;/);
    assert.match(types, /templateName: string;/);
    // schema facts: all three source columns are NOT NULL (inner join on NOT NULL FK)
    assert.doesNotMatch(types, /definitionCode: string \| null/);
    assert.doesNotMatch(types, /templateCode: string \| null/);
    assert.doesNotMatch(types, /templateName: string \| null/);
  });

  it('16 repository row contract declares the three columns as non-null', () => {
    assert.match(repo, /definition_code: string;/);
    assert.match(repo, /template_code: string;/);
    assert.match(repo, /template_name: string;/);
    assert.match(repo, /definitionCode: row\.definition_code,/);
    assert.match(repo, /templateCode: row\.template_code,/);
    assert.match(repo, /templateName: row\.template_name,/);
  });

  // 11. truthful metadata semantics
  it('17 templateName documented as CURRENT LIVE FACT, not a historical snapshot', () => {
    const line = types
      .split('\n')
      .find((l) => l.includes('templateName: string;'));
    assert.ok(line, 'templateName field line present');
    assert.match(line ?? '', /CURRENT LIVE FACT/);
    assert.match(line ?? '', /NOT a historical snapshot/);
  });

  it('18 definitionCode documented as current authoritative code, not a version snapshot', () => {
    const line = types
      .split('\n')
      .find((l) => l.includes('definitionCode: string;'));
    assert.ok(line, 'definitionCode field line present');
    assert.match(line ?? '', /NOT a version snapshot/);
    // no affirmative snapshot-classification token (codebase vocabulary is VERSION_SNAPSHOT)
    assert.doesNotMatch(line ?? '', /VERSION_SNAPSHOT/);
  });

  it('19 repository documents the R09 PART 01A joins as current master facts', () => {
    assert.match(repo, /R09 PART 01A/);
    assert.match(repo, /NOT snapshots/);
  });
});
