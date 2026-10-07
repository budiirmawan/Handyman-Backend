import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * R05-G1A PART 01 — Checklist fixed-option structural authority.
 *
 * Adds the `checklist_item_options` definition table and extends the
 * `checklist_items.item_type` CHECK constraint to include 'SELECT'.
 *
 * Structural only: no CRUD, no response validation, no semantics.
 * Application rules (immutable codes, no hard delete, ACTIVE/INACTIVE
 * lifecycle semantics for new selections) are enforced in later PARTs
 * when admin endpoints and response validation are introduced.
 */
export const migration0341CreateChecklistItemOptions: Migration = {
  id: '0341_create_checklist_item_options',

  async up(c: PoolClient): Promise<void> {
    await c.query(`
      CREATE TABLE checklist_item_options (
        id              UUID PRIMARY KEY,
        checklist_item_id UUID NOT NULL
          REFERENCES checklist_items (id) ON DELETE CASCADE,
        code            TEXT NOT NULL,
        label           TEXT NOT NULL,
        display_order   INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT checklist_item_options_code_unique
          UNIQUE (checklist_item_id, code),
        CONSTRAINT checklist_item_options_order_check
          CHECK (display_order >= 0),
        CONSTRAINT checklist_item_options_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
    await c.query(`
      CREATE INDEX checklist_item_options_item_order_idx
        ON checklist_item_options (checklist_item_id, display_order)
    `);

    // Extend item_type to include SELECT. Constraint is dropped by name
    // then re-added; the original name from migration 0069 is
    // `checklist_items_type`.
    await c.query(`
      ALTER TABLE checklist_items
        DROP CONSTRAINT checklist_items_type
    `);
    await c.query(`
      ALTER TABLE checklist_items
        ADD CONSTRAINT checklist_items_type
          CHECK (item_type IN ('CHECK','BOOLEAN','TEXT','NUMBER','SELECT'))
    `);
  },

  async down(c: PoolClient): Promise<void> {
    await c.query('DROP INDEX IF EXISTS checklist_item_options_item_order_idx');
    await c.query('DROP TABLE IF EXISTS checklist_item_options');
    await c.query(`
      ALTER TABLE checklist_items
        DROP CONSTRAINT checklist_items_type
    `);
    await c.query(`
      ALTER TABLE checklist_items
        ADD CONSTRAINT checklist_items_type
          CHECK (item_type IN ('CHECK','BOOLEAN','TEXT','NUMBER'))
    `);
  },
};
