import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** BE-09H — minimal terminal closure metadata on the Finding aggregate. */
export const migration0097AddFindingClosure: Migration = {
  id: '0097_add_finding_closure',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE findings
        ADD COLUMN closed_at TIMESTAMPTZ,
        ADD COLUMN closed_by_user_id UUID REFERENCES users (id),
        ADD COLUMN closure_notes TEXT;

      -- BE-09E exposed state support before controlled closure existed. Any
      -- pre-existing direct CLOSED state is returned to VERIFIED so it must
      -- pass this closure authority path and receive complete closure data.
      UPDATE findings
        SET status = 'VERIFIED', state_changed_at = NOW(), updated_at = NOW()
        WHERE status = 'CLOSED';

      ALTER TABLE findings
        ADD CONSTRAINT finding_closure_complete CHECK (
          (status = 'CLOSED' AND closed_at IS NOT NULL
            AND closed_by_user_id IS NOT NULL)
          OR (status <> 'CLOSED' AND closed_at IS NULL
            AND closed_by_user_id IS NULL AND closure_notes IS NULL)
        );

      CREATE INDEX findings_closed_at_idx
        ON findings (closed_at) WHERE status = 'CLOSED';
      CREATE INDEX findings_closed_by_idx
        ON findings (closed_by_user_id) WHERE closed_by_user_id IS NOT NULL;
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE findings
        DROP CONSTRAINT finding_closure_complete,
        DROP COLUMN IF EXISTS closure_notes,
        DROP COLUMN IF EXISTS closed_by_user_id,
        DROP COLUMN IF EXISTS closed_at
    `);
  },
};
