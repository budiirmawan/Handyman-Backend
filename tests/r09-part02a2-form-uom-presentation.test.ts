import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R09 PART 02A2 — Form UOM Presentation focused validation
 *
 * Static source assertions (no DB). Live-DB cases are CI-required.
 *
 * Proves the contract-critical facts:
 * 1. uomName/uomSymbol added as nullable strings
 * 2. exactly TWO units_of_measure LEFT JOIN occurrences (one per UNION branch)
 * 3. each branch anchors on uom.id = ff.uom_id
 * 4. each branch enforces uom.client_id = fi_filtered.client_id
 * 5. both branches select uom.name AS uom_name
 * 6. both branches select uom.symbol AS uom_symbol
 * 7. UNION branch select-list column counts remain identical
 * 8. select order remains identical between branches
 * 9. mapRow copies both directly
 * 10. no fallback / COALESCE / resolution by code/name/symbol
 * 11. uomId unchanged
 * 12. min/max/precision unchanged
 * 13. occurrence expansion unchanged
 * 14. non-repeatable placeholder behavior unchanged
 * 15. grain/order/pagination unchanged
 * 16. building/client predicates unchanged
 * 17. response semantics unchanged
 * 18. latest completed review selector unchanged
 * 19. checklist physical module untouched
 * 20. neutral adapter untouched
 * 21. export projection untouched
 * 22. metadata comments classify both labels as CURRENT LIVE FACT
 * 23. no historical snapshot claim for either label
 * 24. no affirmative uniqueness claim for symbol
 */

const REPO_PATH = resolve(
  __dirname,
  '../src/modules/form-execution-detail/form-execution-detail.repository.ts',
);
const TYPES_PATH = resolve(
  __dirname,
  '../src/modules/form-execution-detail/form-execution-detail.types.ts',
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
const checklistRepo = read(CHECKLIST_REPO_PATH);
const neutralTypes = read(NEUTRAL_TYPES_PATH);
const projections = read(PROJECTIONS_PATH);

const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length;

// Code-only view: block comments and ` * ` comment lines stripped so
// join/select counting cannot be fooled by documentation text.
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\*.*$/gm, '');
const repoCode = stripComments(repo);

// Per-branch select lists (lines between SELECT and FROM fi_filtered).
const branchSelects = [
  ...repoCode.matchAll(/SELECT\n((?:      [^\n]*\n)+)    FROM fi_filtered/g),
].map((m) => m[1]);

const SAFE_JOIN =
  /LEFT JOIN units_of_measure uom\n      ON uom\.id = ff\.uom_id\n     AND uom\.client_id = fi_filtered\.client_id/g;

describe('R09 PART 02A2 — Form UOM Presentation', () => {
  // 1. nullable string contract
  it('01 types expose uomName/uomSymbol as nullable strings', () => {
    assert.match(types, /uomName: string \| null;/);
    assert.match(types, /uomSymbol: string \| null;/);
    assert.doesNotMatch(types, /uomName: string;/);
    assert.doesNotMatch(types, /uomSymbol: string;/);
  });

  // 2. exactly one safe LEFT JOIN per UNION branch
  it('02 exactly TWO units_of_measure LEFT JOINs (one per UNION branch)', () => {
    assert.equal(count(repoCode, /LEFT JOIN units_of_measure/g), 2);
    assert.doesNotMatch(repoCode, /\bINNER JOIN units_of_measure/);
    assert.doesNotMatch(repoCode, /\bJOIN units_of_measure\b(?! uom)/);
  });

  // 3./4. frozen safe join in both branches
  it('03 both branches anchor the join on uom.id = ff.uom_id', () => {
    assert.equal(count(repoCode, /uom\.id = ff\.uom_id/g), 2);
    assert.equal(count(repoCode, SAFE_JOIN), 2);
  });

  it('04 both branches enforce structural client equality (frozen R09 PART 02A-S rule)', () => {
    assert.equal(count(repoCode, /AND uom\.client_id = fi_filtered\.client_id/g), 2);
  });

  // 5./6. selects in both branches
  it('05 both branches select uom.name AS uom_name', () => {
    assert.equal(count(repoCode, /uom\.name AS uom_name/g), 2);
  });

  it('06 both branches select uom.symbol AS uom_symbol', () => {
    assert.equal(count(repoCode, /uom\.symbol AS uom_symbol/g), 2);
  });

  // 7./8. UNION alignment
  it('07 UNION branch select lists keep identical column counts', () => {
    assert.equal(branchSelects.length, 2, 'two UNION branches detected');
    const [a, b] = branchSelects.map((s) => s.trim().split('\n'));
    assert.ok(a.length > 0 && b.length > 0);
    assert.equal(a.length, b.length);
  });

  it('08 select order identical between branches (full select-list parity)', () => {
    assert.equal(branchSelects[0], branchSelects[1]);
  });

  // 9. direct mapping
  it('09 mapRow copies both labels directly', () => {
    assert.match(repo, /uomName: row\.uom_name,/);
    assert.match(repo, /uomSymbol: row\.uom_symbol,/);
    assert.match(repo, /uom_name: string \| null;/);
    assert.match(repo, /uom_symbol: string \| null;/);
  });

  // 10. no fallback / COALESCE / resolution by code/name/symbol
  it('10 no fallback, COALESCE, or lookup-by-code for UOM labels', () => {
    assert.doesNotMatch(repoCode, /COALESCE\([^)]*uom\./g);
    assert.doesNotMatch(repoCode, /uom\.code/g);
    assert.doesNotMatch(repoCode, /units_of_measure\s+WHERE/gi);
    assert.doesNotMatch(repoCode, /FROM units_of_measure/gi);
  });

  // 11./12. existing measurement facts unchanged
  it('11 uomId selection and mapping unchanged', () => {
    assert.equal(count(repoCode, /ff\.uom_id,/g), 2);
    assert.match(repo, /uomId: row\.uom_id,/);
    assert.match(types, /uomId: string \| null; \/\/ LIVE/);
  });

  it('12 min/max/precision selection and mapping unchanged', () => {
    assert.equal(count(repoCode, /ff\.minimum_value::text AS minimum_value/g), 2);
    assert.equal(count(repoCode, /ff\.maximum_value::text AS maximum_value/g), 2);
    assert.equal(count(repoCode, /ff\.decimal_precision,/g), 2);
    assert.match(repo, /minimumValue: row\.minimum_value,/);
    assert.match(repo, /maximumValue: row\.maximum_value,/);
    assert.match(repo, /decimalPrecision: row\.decimal_precision,/);
  });

  // 13./14. occurrence behavior unchanged
  it('13 repeatable occurrence expansion unchanged', () => {
    assert.match(repo, /JOIN form_instance_occurrences occ ON occ\.form_instance_id = fi_filtered\.id AND occ\.repeatable_group_id = rg\.id/);
  });

  it('14 non-repeatable placeholder and branch guard unchanged', () => {
    assert.match(repo, /LEFT JOIN LATERAL \(SELECT NULL::uuid AS id, NULL::int AS occurrence_index\) occ ON rg\.id IS NULL/);
    assert.match(repo, /WHERE rg\.id IS NULL AND \$\{conditions\.join\(' AND '\)\}/);
  });

  // 15. grain/order/pagination
  it('15 form grain, deterministic order, and pagination unchanged', () => {
    assert.match(
      repo,
      /ORDER BY instance_created_at DESC, form_instance_id ASC, section_display_order ASC, section_id ASC, occurrence_index ASC NULLS FIRST, display_order ASC, version_field_id ASC/,
    );
    assert.equal(count(repoCode, /getPool\(\)\.query/g), 1);
    assert.match(repo, /\$\{limitClause\}/);
    assert.match(repo, /\$\{offsetClause\}/);
    assert.doesNotMatch(repoCode, /GROUP BY|DISTINCT|ROW_NUMBER/);
  });

  // 16. authorization preserved
  it('16 building/client scoping predicates unchanged', () => {
    assert.match(repo, /fi_filtered\.building_id = ANY\(\$1::uuid\[\]\)/);
    assert.match(repo, /SELECT \* FROM fi_base WHERE building_id IS NOT NULL/);
    assert.match(repo, /fi_filtered\.id = \$\$\{paramIndex\}::uuid/);
    assert.match(repo, /ft\.id = \$\$\{paramIndex\}::uuid/);
    assert.match(repo, /fi_filtered\.created_at >= \$\$\{paramIndex\}/);
    assert.match(repo, /fi_filtered\.created_at < \$\$\{paramIndex\}/);
  });

  // 17. response semantics unchanged
  it('17 response join semantics unchanged in both branches', () => {
    assert.equal(count(repoCode, /AND r\.occurrence_id IS NULL/g), 1);
    assert.equal(count(repoCode, /AND r\.occurrence_id = occ\.id/g), 1);
  });

  // 18. verification selector unchanged
  it('18 latest-COMPLETED-review LATERAL selector unchanged in both branches', () => {
    assert.equal(count(repoCode, /target_type = 'FORM_INSTANCE'/g), 2);
    assert.equal(count(repoCode, /status = 'COMPLETED'/g), 2);
    assert.equal(count(repoCode, /LIMIT 1/g), 2);
  });

  // 19. checklist physical module untouched
  it('19 checklist physical module untouched (its PART 02A1 join intact, nothing form-side added)', () => {
    assert.match(checklistRepo, /R09 PART 02A1/);
    assert.equal(count(stripComments(checklistRepo), /LEFT JOIN units_of_measure/g), 1);
    assert.doesNotMatch(checklistRepo, /uom\.id = ff\.uom_id/);
  });

  // 20. neutral adapter untouched
  it('20 neutral adapter not propagated yet (belongs to PART 02A3)', () => {
    assert.doesNotMatch(neutralTypes, /uomName|uomSymbol/);
  });

  // 21. export projection untouched
  it('21 OPERATIONAL_DETAIL projection not extended yet (belongs to PART 02A3)', () => {
    const start = projections.indexOf('export function projectOperationalDetail(');
    assert.ok(start >= 0, 'projectOperationalDetail present');
    assert.doesNotMatch(projections.slice(start), /uomName|uomSymbol/);
  });

  // 22./23./24. truthful metadata documentation
  it('22 both labels documented as CURRENT LIVE FACT', () => {
    for (const field of ['uomName: string | null;', 'uomSymbol: string | null;']) {
      const line = types
        .split('\n')
        .find((l) => l.includes(field));
      assert.ok(line, `${field} line present`);
      assert.match(line ?? '', /CURRENT LIVE FACT/);
      assert.match(line ?? '', /NOT a historical snapshot/);
    }
  });

  it('23 no affirmative historical-snapshot classification for either label', () => {
    for (const field of ['uomName: string | null;', 'uomSymbol: string | null;']) {
      const line = types
        .split('\n')
        .find((l) => l.includes(field));
      assert.doesNotMatch(line ?? '', /VERSION SNAPSHOT|STABLE snapshot|stable snapshot/);
    }
  });

  it('24 no affirmative uniqueness claim for symbol (truthful "NOT unique" allowed)', () => {
    const symbolLine = types
      .split('\n')
      .find((l) => l.includes('uomSymbol: string | null;'));
    assert.ok(symbolLine, 'uomSymbol line present');
    assert.doesNotMatch(symbolLine ?? '', /(?<!NOT )unique/);
  });
});
