import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-05 PART 04 — Readiness history semantics (FROZEN F2/F8).
 *
 * Additive-nullable ONLY; ZERO rewrites of existing rows/columns and
 * ZERO generic history tables. The immutable readiness rows remain the
 * lifecycle history authority (operational events stay audit history
 * only, never current-state authority): each supersession now records
 * its explicit row-level link (`supersedes_readiness_id`, nullable —
 * first row of a chain has none), so history is deterministically
 * reconstructable from the rows alone, in server-insertion order.
 *
 * PART A additionally allows ONE bounded optional free-text
 * `change_reason` on the scheduling-readiness row (scheduling-owned;
 * no reason taxonomy is invented).
 */
export const migration0390HandymanReadinessHistoryLinks: Migration = {
  id: '0390_handyman_readiness_history_links',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_scheduling_readiness
        ADD COLUMN supersedes_readiness_id UUID
          REFERENCES handyman_scheduling_readiness (id),
        ADD COLUMN change_reason TEXT NULL,
        ADD CONSTRAINT handyman_sched_readiness_reason_length_check
          CHECK (change_reason IS NULL
                 OR char_length(change_reason) BETWEEN 1 AND 500)
    `);
    await client.query(`
      ALTER TABLE handyman_unit_access_readiness
        ADD COLUMN supersedes_readiness_id UUID
          REFERENCES handyman_unit_access_readiness (id)
    `);
    await client.query(`
      ALTER TABLE handyman_permit_readiness
        ADD COLUMN supersedes_readiness_id UUID
          REFERENCES handyman_permit_readiness (id)
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_scheduling_readiness
        DROP CONSTRAINT IF EXISTS handyman_sched_readiness_reason_length_check,
        DROP COLUMN IF EXISTS change_reason,
        DROP COLUMN IF EXISTS supersedes_readiness_id
    `);
    await client.query(`
      ALTER TABLE handyman_unit_access_readiness
        DROP COLUMN IF EXISTS supersedes_readiness_id
    `);
    await client.query(`
      ALTER TABLE handyman_permit_readiness
        DROP COLUMN IF EXISTS supersedes_readiness_id
    `);
  },
};
