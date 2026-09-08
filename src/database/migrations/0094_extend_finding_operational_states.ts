import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** BE-09E — generic, backend-authoritative Finding operational states. */
export const migration0094ExtendFindingOperationalStates: Migration = {
  id: '0094_extend_finding_operational_states',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE findings
        DROP CONSTRAINT finding_status,
        ADD COLUMN state_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD CONSTRAINT finding_status CHECK (
          status IN (
            'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW',
            'REWORK_REQUIRED', 'RESUBMITTED', 'VERIFIED', 'CLOSED',
            'CANCELLED'
          )
        );

      CREATE INDEX findings_state_changed_idx
        ON findings (status, state_changed_at);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      UPDATE findings SET status = 'OPEN'
        WHERE status NOT IN ('OPEN', 'CANCELLED');
      ALTER TABLE findings
        DROP CONSTRAINT finding_status,
        DROP COLUMN IF EXISTS state_changed_at,
        ADD CONSTRAINT finding_status CHECK (status IN ('OPEN', 'CANCELLED'))
    `);
  },
};
