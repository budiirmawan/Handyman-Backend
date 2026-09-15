import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R09 PART 02A1 — Checklist UOM Presentation focused validation
 *
 * Static source assertions (no DB). Live-DB cases are CI-required.
 *
 * Proves the contract-critical facts:
 * 1. uomName/uomSymbol added as nullable strings
 * 2. exactly one units_of_measure LEFT JOIN exists in the detail query
 * 3. join uses uom.id = ci.uom_id
 * 4. join uses structural client equality: uom.client_id = ce_filtered.client_id
 * 5. uom.name selected as uom_name
 * 6. uom.symbol selected as uom_symbol
 * 7. mapRow copies both directly
 * 8. no fallback / COALESCE / lookup-by-code or symbol
 * 9. uomId unchanged
 * 10. min/max/precision unchanged
 * 11. checklist grain/order/pagination unchanged
 * 12. building/client predicates unchanged
 * 13. response/N-A/SELECT behavior unchanged
 * 14. verification selector unchanged
 * 15. form physical module untouched
 * 16. neutral adapter untouched
 * 17. export projection untouched
 * 18. metadata comments classify both labels as CURRENT LIVE FACT
 */

const REPO_PATH = resolve(
  __dirname,
  '../src/modules/checklist-execution-detail/checklist-execution-detail.repository.ts',
);
const TYPES_PATH = resolve(
  __dirname,
  '../src/modules/checklist-execution-detail/checklist-execution-detail.types.ts',
);
const FORM_REPO_PATH = resolve(
  __dirname,
  '../src/modules/form-execution-detail/form-execution-detail.repository.ts',
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
const formRepo = read(FORM_REPO_PATH);
const neutralTypes = read(NEUTRAL_TYPES_PATH);
const projections = read(PROJECTIONS_PATH);

const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length;

// Code-only view: block comments and ` * ` comment lines stripped so the
// join/select counting cannot be fooled by documentation text.
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\*.*$/gm, '');
const repoCode = stripComments(repo);

describe('R09 PART 02A1 — Checklist UOM Presentation', () => {
  // 1. nullable string contract
  it('01 types expose uomName/uomSymbol as nullable strings', () => {
    assert.match(types, /uomName: string \| null;/);
    assert.match(types, /uomSymbol: string \| null;/);
    assert.doesNotMatch(types, /uomName: string;/);
    assert.doesNotMatch(types, /uomSymbol: string;/);
  });

  // 2. exactly one UOM LEFT JOIN
  it('02 exactly one units_of_measure LEFT JOIN in the detail query', () => {
    assert.equal(count(repoCode, /LEFT JOIN units_of_measure/g), 1);
    assert.doesNotMatch(repoCode, /\bINNER JOIN units_of_measure/);
    assert.doesNotMatch(repoCode, /\bJOIN units_of_measure\b(?! uom)/);
  });

  // 3./4. frozen safe join: PK + structural client equality
  it('03 join anchored on uom.id = ci.uom_id', () => {
    assert.match(repoCode, /LEFT JOIN units_of_measure uom\s+ON uom\.id = ci\.uom_id/);
  });

  it('04 join enforces structural client equality (frozen R09 PART 02A-S rule)', () => {
    assert.match(repoCode, /AND uom\.client_id = ce_filtered\.client_id/);
    // no PK-only form: the client-equality conjunct must be part of the ON clause
    const join = repoCode.slice(
      repoCode.indexOf('LEFT JOIN units_of_measure uom'),
      repoCode.indexOf('LEFT JOIN checklist_item_options'),
    );
    assert.match(join, /uom\.id = ci\.uom_id/);
    assert.match(join, /uom\.client_id = ce_filtered\.client_id/);
  });

  // 5./6. selects
  it('05 uom.name selected as uom_name', () => {
    assert.equal(count(repoCode, /uom\.name AS uom_name/g), 1);
  });

  it('06 uom.symbol selected as uom_symbol', () => {
    assert.equal(count(repoCode, /uom\.symbol AS uom_symbol/g), 1);
  });

  // 7. direct mapping
  it('07 mapRow copies both labels directly', () => {
    assert.match(repo, /uomName: row\.uom_name,/);
    assert.match(repo, /uomSymbol: row\.uom_symbol,/);
    assert.match(repo, /uom_name: string \| null;/);
    assert.match(repo, /uom_symbol: string \| null;/);
  });

  // 8. no fallback / COALESCE / lookup-by-code or symbol
  it('08 no fallback, COALESCE, or lookup-by-code/symbol for UOM labels', () => {
    assert.doesNotMatch(repoCode, /COALESCE\([^)]*uom\./g);
    assert.doesNotMatch(repoCode, /uom\.code/g);
    assert.doesNotMatch(repoCode, /units_of_measure\s+WHERE/gi);
    assert.doesNotMatch(repoCode, /FROM units_of_measure/gi);
  });

  // 9./10. existing measurement facts unchanged
  it('09 uomId selection and mapping unchanged', () => {
    assert.equal(count(repoCode, /ci\.uom_id,/g), 1);
    assert.match(repo, /uomId: row\.uom_id,/);
    assert.match(types, /uomId: string \| null; \/\/ LIVE/);
  });

  it('10 min/max/precision selection and mapping unchanged', () => {
    assert.match(repoCode, /ci\.minimum_value::text AS minimum_value/);
    assert.match(repoCode, /ci\.maximum_value::text AS maximum_value/);
    assert.match(repoCode, /ci\.decimal_precision,/);
    assert.match(repo, /minimumValue: row\.minimum_value,/);
    assert.match(repo, /maximumValue: row\.maximum_value,/);
    assert.match(repo, /decimalPrecision: row\.decimal_precision,/);
  });

  // 11. grain/order/pagination unchanged
  it('11 checklist grain, deterministic order, and pagination unchanged', () => {
    assert.match(
      repo,
      /ORDER BY ce_filtered\.created_at DESC, ce_filtered\.id ASC, ci\.display_order ASC, ci\.id ASC/,
    );
    assert.equal(count(repoCode, /getPool\(\)\.query/g), 1);
    assert.match(repo, /\$\{limitClause\}/);
    assert.match(repo, /\$\{offsetClause\}/);
    assert.doesNotMatch(repoCode, /GROUP BY|DISTINCT|ROW_NUMBER/);
  });

  // 12. authorization preserved
  it('12 building/client scoping predicates unchanged', () => {
    assert.match(repo, /ce_filtered\.building_id = ANY\(\$1::uuid\[\]\)/);
    assert.match(repo, /SELECT \* FROM ce_base WHERE building_id IS NOT NULL/);
    assert.match(repo, /ce_filtered\.created_at >= \$\$\{paramIndex\}/);
    assert.match(repo, /ce_filtered\.created_at < \$\$\{paramIndex\}/);
  });

  // 13. response/N-A/SELECT semantics unchanged
  it('13 response, explicit N/A, and SELECT option semantics unchanged', () => {
    assert.match(repoCode, /LEFT JOIN checklist_item_responses r\s+ON r\.checklist_execution_id = ce_filtered\.id\s+AND r\.checklist_item_id = ci\.id/);
    assert.match(repo, /r\.is_na AS is_na/);
    assert.match(repo, /WHEN ci\.item_type = 'SELECT' AND r\.id IS NOT NULL AND COALESCE\(r\.is_na, false\) = false AND r\.value IS NOT NULL/);
    assert.match(repo, /END AS option_code/);
  });

  // 14. verification selector unchanged
  it('14 latest-COMPLETED-review LATERAL selector unchanged', () => {
    assert.match(repoCode, /target_type = 'CHECKLIST_EXECUTION'/);
    assert.match(repoCode, /status = 'COMPLETED'/);
    assert.match(repo, /ORDER BY reviewed_at DESC, created_at DESC, id DESC\s+LIMIT 1/);
  });

  // 15. form physical module untouched
  it('15 form physical module untouched (no UOM join yet; PART 01B marker intact)', () => {
    assert.doesNotMatch(stripComments(formRepo), /units_of_measure/);
    assert.match(formRepo, /R09 PART 01B/);
  });

  // 16. neutral adapter untouched
  it('16 neutral adapter not propagated yet (belongs to PART 02A3)', () => {
    assert.doesNotMatch(neutralTypes, /uomName|uomSymbol/);
  });

  // 17. export projection untouched
  it('17 OPERATIONAL_DETAIL projection not extended yet (belongs to PART 02A3)', () => {
    const start = projections.indexOf('export function projectOperationalDetail(');
    assert.ok(start >= 0, 'projectOperationalDetail present');
    assert.doesNotMatch(projections.slice(start), /uomName|uomSymbol/);
  });

  // 18. truthful metadata documentation
  it('18 both labels documented as CURRENT LIVE FACT, not snapshots', () => {
    for (const field of ['uomName: string | null;', 'uomSymbol: string | null;']) {
      const line = types
        .split('\n')
        .find((l) => l.includes(field));
      assert.ok(line, `${field} line present`);
      assert.match(line ?? '', /CURRENT LIVE FACT/);
      assert.match(line ?? '', /NOT a historical snapshot|NOT a historical snapshot\)/);
      assert.doesNotMatch(line ?? '', /VERSION SNAPSHOT|stable historical/);
    }
    // no affirmative uniqueness claim for symbol (the truthful "NOT unique" note is allowed)
    const symbolLine = types
      .split('\n')
      .find((l) => l.includes('uomSymbol: string | null;'));
    assert.doesNotMatch(symbolLine ?? '', /(?<!NOT )unique/);
  });
});
