/**
 * R05-G1A PART 01 — Checklist fixed-option structural authority.
 *
 * Static (non-DB) contract test verifying:
 *   1. The SELECT item type is accepted by the authoritative backend
 *      item-type constant (ADMIN_CHECKLIST_ITEM_TYPES) and the shared
 *      mobile contract type surface.
 *   2. Existing CHECK / BOOLEAN / TEXT / NUMBER types remain unchanged.
 *   3. Migration 0341 registers checklist_item_options with the
 *      expected columns, FK, UNIQUE, CHECK, and index.
 *   4. The checklist_items item_type CHECK is extended to include SELECT.
 *   5. No semantic-category / evaluation / scoring / finding-policy
 *      columns exist on checklist_item_options (strict-exclusion guard).
 *
 * Does not require PostgreSQL; CI will exercise the migration against a
 * live database via the normal migration test path.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ADMIN_CHECKLIST_ITEM_TYPES } from '../src/modules/checklist-administration/checklist-administration.types';

const MIGRATION_PATH = 'src/database/migrations/0341_create_checklist_item_options.ts';
const MIGRATION_INDEX_PATH = 'src/database/migrations/index.ts';

describe('R05-G1A PART 01 structural authority', () => {
  const mig = readFileSync(MIGRATION_PATH, 'utf8');
  const idx = readFileSync(MIGRATION_INDEX_PATH, 'utf8');

  it('authoritative checklist item-type constant includes SELECT and preserves prior types', () => {
    assert.deepEqual(
      [...ADMIN_CHECKLIST_ITEM_TYPES],
      ['CHECK', 'BOOLEAN', 'TEXT', 'NUMBER', 'SELECT'],
    );
  });

  it('migration 0341 is registered in the migration index', () => {
    assert.match(idx, /migration0341CreateChecklistItemOptions/);
    assert.match(idx, /\.\/0341_create_checklist_item_options/);
  });

  it('migration creates checklist_item_options with required columns', () => {
    assert.match(mig, /CREATE TABLE checklist_item_options/);
    for (const pat of [
      /\bid\s+UUID\s+PRIMARY\s+KEY/,
      /\bchecklist_item_id\s+UUID\s+NOT\s+NULL\b/,
      /\bcode\s+TEXT\s+NOT\s+NULL\b/,
      /\blabel\s+TEXT\s+NOT\s+NULL\b/,
      /\bdisplay_order\s+INTEGER\s+NOT\s+NULL\b/,
      /\bstatus\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'ACTIVE'/,
      /\bcreated_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
      /\bupdated_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    ]) {
      assert.ok(pat.test(mig), `missing column/DDL fragment: ${pat}`);
    }
  });

  it('migration defines per-item code uniqueness, ACTIVE/INACTIVE status, non-negative display_order', () => {
    assert.match(mig, /CONSTRAINT checklist_item_options_code_unique\s+UNIQUE \(checklist_item_id, code\)/);
    assert.match(mig, /CONSTRAINT checklist_item_options_order_check\s+CHECK \(display_order >= 0\)/);
    assert.match(mig, /CONSTRAINT checklist_item_options_status_check\s+CHECK \(status IN \('ACTIVE', 'INACTIVE'\)\)/);
  });

  it('migration defines checklist_item_options index on (checklist_item_id, display_order)', () => {
    assert.match(mig, /CREATE INDEX checklist_item_options_item_order_idx\s+ON checklist_item_options \(checklist_item_id, display_order\)/);
  });

  it('migration uses ON DELETE CASCADE on checklist_item_id FK (matches form_fields precedent)', () => {
    assert.match(mig, /REFERENCES checklist_items \(id\) ON DELETE CASCADE/);
  });

  it('migration extends checklist_items.item_type CHECK to include SELECT', () => {
    assert.match(mig, /ALTER TABLE checklist_items[\s\S]*DROP CONSTRAINT checklist_items_type/);
    assert.match(mig, /ADD CONSTRAINT checklist_items_type[\s\S]*CHECK\s*\(item_type\s+IN\s*\('CHECK','BOOLEAN','TEXT','NUMBER','SELECT'\)\)/);
    assert.match(mig, /DROP TABLE IF EXISTS checklist_item_options/);
    // down() restores prior CHECK so the migration is reversible.
    assert.match(mig, /CHECK\s*\(item_type\s+IN\s*\('CHECK','BOOLEAN','TEXT','NUMBER'\)\)/);
  });

  it('no semantic-category / evaluation / scoring / finding-policy columns exist on checklist_item_options', () => {
    for (const forbidden of [
      'semantic_category',
      'is_pass',
      'is_fail',
      'is_compliant',
      'evaluation',
      'finding_policy',
      'evidence_policy',
      'score',
      'is_na',
      'n_a_reason',
      'is_default',
      'color',
      'icon',
    ]) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(mig), `forbidden column present: ${forbidden}`);
    }
  });
});
