import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** BE-09G — lightweight, append-preserving Finding rework cycles. */
export const migration0096AddFindingReworkCycles: Migration = {
  id: '0096_add_finding_rework_cycles',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE findings DROP CONSTRAINT finding_status;
      ALTER TABLE findings ADD CONSTRAINT finding_status CHECK (
        status IN (
          'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW', 'REJECTED',
          'REWORK_REQUIRED', 'RESUBMITTED', 'VERIFIED', 'CLOSED', 'CANCELLED'
        )
      );

      CREATE TABLE finding_rework_cycles (
        id UUID PRIMARY KEY,
        finding_id UUID NOT NULL REFERENCES findings (id),
        review_id UUID NOT NULL REFERENCES reviews (id),
        requested_by_user_id UUID NOT NULL REFERENCES users (id),
        reason TEXT NOT NULL,
        rework_notes TEXT,
        resubmitted_by_user_id UUID REFERENCES users (id),
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resubmitted_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'REQUESTED',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT finding_rework_status
          CHECK (status IN ('REQUESTED', 'RESUBMITTED')),
        CONSTRAINT finding_rework_resubmission_complete CHECK (
          (status = 'REQUESTED' AND resubmitted_by_user_id IS NULL
            AND resubmitted_at IS NULL)
          OR (status = 'RESUBMITTED' AND resubmitted_by_user_id IS NOT NULL
            AND resubmitted_at IS NOT NULL)
        ),
        CONSTRAINT finding_rework_review_unique UNIQUE (review_id)
      );

      CREATE UNIQUE INDEX finding_current_rework_unique
        ON finding_rework_cycles (finding_id) WHERE status = 'REQUESTED';
      CREATE INDEX finding_rework_finding_idx
        ON finding_rework_cycles (finding_id, requested_at);
      CREATE INDEX finding_rework_requester_idx
        ON finding_rework_cycles (requested_by_user_id, requested_at);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TABLE IF EXISTS finding_rework_cycles;
      UPDATE findings SET status = 'PENDING_REVIEW' WHERE status = 'REJECTED';
      ALTER TABLE findings DROP CONSTRAINT finding_status;
      ALTER TABLE findings ADD CONSTRAINT finding_status CHECK (
        status IN (
          'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW',
          'REWORK_REQUIRED', 'RESUBMITTED', 'VERIFIED', 'CLOSED', 'CANCELLED'
        )
      );
    `);
  },
};
