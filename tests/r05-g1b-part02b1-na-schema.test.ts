/**
 * R05-G1B PART 02B1 — Explicit N/A schema authority (structural).
 *
 * Static tests only — verifies migration DDL shape, registration, and
 * absence of backfills/constraints/indexes that are intentionally
 * deferred to later PARTs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const MIG_PATH = 'src/database/migrations/0342_add_checklist_na_columns.ts';
const IDX_PATH = 'src/database/migrations/index.ts';

describe('R05-G1B PART 02B1 N/A schema authority (static)', () => {
  const mig = readFileSync(MIG_PATH, 'utf8');
  const idx = readFileSync(IDX_PATH, 'utf8');

  it('migration 0342 is registered in the migration index', () => {
    assert.match(idx, /migration0342AddChecklistNaColumns/);
    assert.match(idx, /\.\/0342_add_checklist_na_columns/);
    assert.match(idx, /migration0342AddChecklistNaColumns,/);
  });

  it('migration id is 0342_add_checklist_na_columns', () => {
    assert.match(mig, /id:\s*'0342_add_checklist_na_columns'/);
  });

  it('adds is_na_allowed BOOLEAN NOT NULL DEFAULT FALSE to checklist_items', () => {
    assert.match(mig, /ALTER TABLE checklist_items[\s\S]*is_na_allowed\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/);
  });

  it('adds na_requires_note BOOLEAN NOT NULL DEFAULT FALSE to checklist_items', () => {
    assert.match(mig, /na_requires_note\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/);
  });

  it('adds is_na BOOLEAN NOT NULL DEFAULT FALSE to checklist_item_responses', () => {
    assert.match(mig, /ALTER TABLE checklist_item_responses[\s\S]*is_na\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/);
  });

  it('adds na_notes TEXT NULL to checklist_item_responses', () => {
    assert.match(mig, /na_notes\s+TEXT\s+NULL/);
  });

  it('does NOT introduce new CHECK constraints, triggers, or indexes', () => {
    assert.doesNotMatch(mig, /ADD\s+CONSTRAINT/i);
    assert.doesNotMatch(mig, /CREATE\s+(UNIQUE\s+)?INDEX/i);
    assert.doesNotMatch(mig, /CREATE\s+TRIGGER/i);
    assert.doesNotMatch(mig, /CREATE\s+FUNCTION/i);
  });

  it('does NOT add semantic columns (pass/fail/compliant/score/finding/evidence)', () => {
    for (const forbidden of ['is_pass','is_fail','is_compliant','is_abnormal',
      'semantic_category','evaluation','score','finding_policy',
      'evidence_policy','result_evaluation']) {
      assert.ok(!new RegExp('\\b'+forbidden+'\\b','i').test(mig),
        `unexpected column ${forbidden} in migration`);
    }
  });

  it('does NOT perform any UPDATE/backfill on existing rows (no value/result/notes reinterpretation)', () => {
    // The migration must contain only ALTER TABLE ADD COLUMN statements.
    // No UPDATE, no INSERT, no DELETE, no data scanning.
    assert.doesNotMatch(mig, /\bUPDATE\s/i);
    assert.doesNotMatch(mig, /\bINSERT\s/i);
    assert.doesNotMatch(mig, /\bDELETE\s/i);
    assert.doesNotMatch(mig, /SELECT\s.+FROM\s+checklist_item_responses/i);
  });

  it('does NOT contain magic N/A string literals ("NA", "N/A", "NOT_APPLICABLE", "-")', () => {
    for (const lit of ["'NA'", "'N/A'", "'NOT_APPLICABLE'", "'-'", "'n/a'"]) {
      assert.ok(!mig.includes(lit), `unexpected magic literal ${lit}`);
    }
  });

  it('down() drops exactly the four added columns and nothing else', () => {
    // Each column dropped via IF EXISTS; both ALTERs present.
    assert.match(mig, /ALTER TABLE checklist_item_responses[\s\S]*na_notes[\s\S]*is_na/);
    assert.match(mig, /ALTER TABLE checklist_items[\s\S]*na_requires_note[\s\S]*is_na_allowed/);
    // No DROP TABLE.
    assert.doesNotMatch(mig, /DROP\s+TABLE/i);
  });

  it('existing SELECT option schema (checklist_item_options) is not modified', () => {
    assert.doesNotMatch(mig, /checklist_item_options/);
  });
});
