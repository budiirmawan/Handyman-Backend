import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * R05-G1B PART 02B1 — Explicit N/A schema authority.
 *
 * Adds item-level N/A policy columns and response-level N/A state columns.
 * Defaults are fail-closed for items (is_na_allowed = false) and absent for
 * responses (is_na = false, na_notes = null).
 *
 * Structural only: no DTO, API, execution, or completeness changes in this
 * migration. No CHECK constraints, triggers, indexes, or backfill are
 * introduced. Existing NULL / JSONB null / magic strings are NOT
 * reinterpreted.
 */
export const migration0342AddChecklistNaColumns: Migration = {
  id: '0342_add_checklist_na_columns',

  async up(c: PoolClient): Promise<void> {
    await c.query(`
      ALTER TABLE checklist_items
        ADD COLUMN is_na_allowed BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN na_requires_note BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await c.query(`
      ALTER TABLE checklist_item_responses
        ADD COLUMN is_na BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN na_notes TEXT NULL
    `);
  },

  async down(c: PoolClient): Promise<void> {
    await c.query(`
      ALTER TABLE checklist_item_responses
        DROP COLUMN IF EXISTS na_notes,
        DROP COLUMN IF EXISTS is_na
    `);
    await c.query(`
      ALTER TABLE checklist_items
        DROP COLUMN IF EXISTS na_requires_note,
        DROP COLUMN IF EXISTS is_na_allowed
    `);
  },
};
