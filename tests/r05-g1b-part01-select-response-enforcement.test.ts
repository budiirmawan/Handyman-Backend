/**
 * R05-G1B PART 01 — SELECT response membership enforcement (static contract).
 *
 * Static source-level checks only (no PostgreSQL). Live-DB enforcement
 * cases (persistence of accepted SELECT code, rejection of INACTIVE/
 * unknown/cross-item, atomicity, batch semantics, historical
 * readability) run in CI via the embedded-postgres checklist
 * execution suite.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const SVC_SRC = readFileSync(
  'src/modules/checklist-executions/checklist-execution.service.ts',
  'utf8',
);

describe('R05-G1B PART 01 SELECT response enforcement (static)', () => {
  it('SELECT branch exists with per-item + code + ACTIVE membership enforced atomically in INSERT WHERE EXISTS', () => {
    assert.match(SVC_SRC, /itemRow\.item_type === 'SELECT'/);
    // Membership: exact item_id + code + ACTIVE, in a single INSERT...SELECT
    // WHERE EXISTS clause (atomic with the write).
    assert.match(SVC_SRC, /WHERE EXISTS \(/);
    assert.match(SVC_SRC, /checklist_item_id = \$3/);
    assert.match(SVC_SRC, /AND code = \$7/);
    assert.match(SVC_SRC, /AND status = 'ACTIVE'/);
  });

  it('rejects membership failures with a stable bad-request error after INSERT RETURNING 0 rows', () => {
    assert.match(SVC_SRC, /if \(!resp\.rowCount\)/);
    assert.match(SVC_SRC, /Selected option is not valid for this item\./);
  });

  it('SELECT value stored in value column as JSON string (NOT in result); result remains free-form legacy', () => {
    // INSERT uses $4::jsonb for SELECT (stored in value), result is passed as
    // $5 untouched from payload. No code writes into result.
    assert.match(SVC_SRC, /INSERT INTO checklist_item_responses[\s\S]*SELECT \$1, \$2, \$3, \$4::jsonb, \$5, \$6/);
    assert.doesNotMatch(SVC_SRC, /option.*result|result.*option|result\s*=\s*.*ACTIVE/i);
  });

  it('SELECT submitted value is normalized to uppercase-trimmed canonical code', () => {
    assert.match(SVC_SRC, /normalizeOptionCode/);
    assert.match(SVC_SRC, /trimmed\.toUpperCase\(\)/);
  });

  it('non-string or empty SELECT value is rejected before the INSERT', () => {
    // Non-strings rejected by isValidResponseValue (returns false). Empty/
    // whitespace-only rejected by normalizeOptionCode returning null.
    assert.match(SVC_SRC, /if \(!code\)/);
    assert.match(SVC_SRC, /Response value does not match item type\./);
  });

  it('non-SELECT branches remain: CHECK/BOOLEAN boolean, NUMBER number, TEXT string', () => {
    assert.match(SVC_SRC, /type === 'CHECK' \|\| type === 'BOOLEAN'/);
    assert.match(SVC_SRC, /type === 'NUMBER'/);
    // TEXT falls through to the string branch; SELECT also accepts string but
    // is diverted into its INSERT-WHERE-EXISTS branch before the generic INSERT.
    assert.match(SVC_SRC, /typeof value === 'string'/);
  });

  it('existing generic INSERT path for non-SELECT types is preserved unchanged', () => {
    // Non-SELECT branch retains the original simple 6-tuple VALUES upsert
    // (no WHERE EXISTS, no code parameter). The branches are separated by
    // `else { ... }`.
    const elseBlock = SVC_SRC.split(/}\s*else\s*\{/).pop() || '';
    assert.match(elseBlock, /INSERT INTO checklist_item_responses/);
    assert.doesNotMatch(elseBlock, /WHERE EXISTS/);
    assert.doesNotMatch(elseBlock, /checklist_item_options/);
    assert.match(elseBlock, /ON CONFLICT/);
    // The SELECT branch is the one that references checklist_item_options.
    assert.match(SVC_SRC, /FROM checklist_item_options/);
  });

  it('no semantic fields (PASS/FAIL/compliant/score/finding) are referenced in the execution service', () => {
    // NOTE: PART 02C introduces the explicit is_na/na_notes execution state,
    // so `isNa`/`na_notes` are NOT in the forbidden set below. They remain
    // execution-state only — no PASS/FAIL/compliant/score/finding/risk.
    for (const forbidden of ['isPass','isFail','is_compliant','compliant',
      'non_compliant','non-compliant','semanticCategory','finding',
      'score','abnormal','risk']) {
      assert.ok(
        !new RegExp('\\b'+forbidden+'\\b','i').test(SVC_SRC),
        `unexpected reference to ${forbidden}`,
      );
    }
  });

  it('no new transaction wrapper introduced; SELECT membership is enforced within a single SQL statement per item', () => {
    // The existing saveChecklistResponses did not use an explicit transaction;
    // concurrency safety for SELECT comes from the INSERT...WHERE EXISTS being
    // a single atomic statement, not from a client-side BEGIN/COMMIT.
    assert.doesNotMatch(SVC_SRC, /BEGIN|COMMIT|ROLLBACK|pool\.connect/i,
      'saveChecklistResponses must not introduce a new client transaction in PART 01');
  });

  it('SELECT branch continues passing through result and notes alongside value', () => {
    // PART 01 preserved the existing result/notes passthrough for SELECT.
    // PART 02C adds isNa/naNotes, but the normal SELECT path still passes
    // entry.result and entry.notes unchanged.
    assert.ok(SVC_SRC.includes('entry.result ?? null'));
    assert.ok(SVC_SRC.includes('entry.notes ?? null'));
  });
});
