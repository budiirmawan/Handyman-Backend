import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-13H — Check-Out.
 *
 * Check-In and Check-Out form ONE controlled visit lifecycle (BE-13
 * boundary), so Check-Out extends the BE-13G `visit_check_ins` row
 * instead of creating a second lifecycle table:
 *
 *   CHECKED_IN → CHECKED_OUT   (closes the active visit)
 *   CHECKED_IN → CANCELLED     (BE-13G mistake reversal, unchanged)
 *
 * The original Check-In history (checked_in_at / checked_in_by /
 * entry_notes) is PRESERVED on the same row — check-out only adds
 * checked_out_at / checked_out_by_user_id / exit_notes. A consistency
 * CHECK guarantees check-out fields exist exactly when the row is
 * CHECKED_OUT.
 *
 * Duplicate check-out is impossible: the transition is applied with an
 * atomic `WHERE status = 'CHECKED_IN'` guard, and the BE-13G partial
 * unique "active" indexes only cover CHECKED_IN rows, so a completed
 * visit no longer occupies the active slot.
 */
export const migration0140AddVisitCheckOut: Migration = {
  id: '0140_add_visit_check_out',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE visit_check_ins
        ADD COLUMN checked_out_at TIMESTAMPTZ,
        ADD COLUMN checked_out_by_user_id UUID REFERENCES users (id),
        ADD COLUMN exit_notes TEXT;

      ALTER TABLE visit_check_ins
        DROP CONSTRAINT visit_check_ins_status_check;
      ALTER TABLE visit_check_ins
        ADD CONSTRAINT visit_check_ins_status_check
          CHECK (status IN ('CHECKED_IN', 'CHECKED_OUT', 'CANCELLED'));

      ALTER TABLE visit_check_ins
        ADD CONSTRAINT visit_check_ins_check_out_consistency
          CHECK (
            (status = 'CHECKED_OUT'
              AND checked_out_at IS NOT NULL
              AND checked_out_by_user_id IS NOT NULL)
            OR (status <> 'CHECKED_OUT'
              AND checked_out_at IS NULL
              AND checked_out_by_user_id IS NULL)
          );

      CREATE INDEX visit_check_ins_checked_out_idx
        ON visit_check_ins (building_id, status, checked_out_at);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS visit_check_ins_checked_out_idx;
      DELETE FROM visit_check_ins WHERE status = 'CHECKED_OUT';
      ALTER TABLE visit_check_ins
        DROP CONSTRAINT IF EXISTS visit_check_ins_check_out_consistency;
      ALTER TABLE visit_check_ins
        DROP CONSTRAINT IF EXISTS visit_check_ins_status_check;
      ALTER TABLE visit_check_ins
        ADD CONSTRAINT visit_check_ins_status_check
          CHECK (status IN ('CHECKED_IN', 'CANCELLED'));
      ALTER TABLE visit_check_ins
        DROP COLUMN IF EXISTS checked_out_at,
        DROP COLUMN IF EXISTS checked_out_by_user_id,
        DROP COLUMN IF EXISTS exit_notes;
    `);
  },
};
