import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-20C — Permit Application.
 *
 * An Application references one BE-20A Permit and stores only application
 * state that does not already belong to the Permit: requested work date/time,
 * notes, lifecycle timestamps, and actors. Applicant, Contractor, work
 * description, Client, and Building remain authoritative on the Permit and
 * are resolved through BE-20A/BE-20B rather than copied here.
 *
 * The lifecycle is intentionally minimal: DRAFT → SUBMITTED or CANCELLED,
 * and SUBMITTED → CANCELLED. Updates are service-restricted to DRAFT. Action
 * history is recorded in the shared BE-07 operational_events timeline.
 */
export const migration0204CreatePermitApplications: Migration = {
  id: '0204_create_permit_applications',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE permit_applications (
        id                   UUID PRIMARY KEY,
        permit_id            UUID NOT NULL REFERENCES permits (id),
        requested_work_at    TIMESTAMPTZ NOT NULL,
        status               TEXT NOT NULL DEFAULT 'DRAFT',
        submitted_at         TIMESTAMPTZ,
        submitted_by_user_id UUID REFERENCES users (id),
        notes                TEXT,
        created_by_user_id   UUID NOT NULL REFERENCES users (id),
        cancelled_at         TIMESTAMPTZ,
        cancelled_by_user_id UUID REFERENCES users (id),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT permit_applications_permit_unique UNIQUE (permit_id),
        CONSTRAINT permit_applications_status_check
          CHECK (status IN ('DRAFT', 'SUBMITTED', 'CANCELLED')),
        CONSTRAINT permit_applications_submission_pair_check
          CHECK (
            (submitted_at IS NULL AND submitted_by_user_id IS NULL)
            OR
            (submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL)
          ),
        CONSTRAINT permit_applications_state_check
          CHECK (
            (status = 'DRAFT'
              AND submitted_at IS NULL
              AND cancelled_at IS NULL
              AND cancelled_by_user_id IS NULL)
            OR
            (status = 'SUBMITTED'
              AND submitted_at IS NOT NULL
              AND submitted_by_user_id IS NOT NULL
              AND cancelled_at IS NULL
              AND cancelled_by_user_id IS NULL)
            OR
            (status = 'CANCELLED'
              AND cancelled_at IS NOT NULL
              AND cancelled_by_user_id IS NOT NULL)
          )
      )
    `);

    await client.query(`
      CREATE INDEX permit_applications_status_idx
        ON permit_applications (status, requested_work_at);
      CREATE INDEX permit_applications_requested_work_idx
        ON permit_applications (requested_work_at);
      CREATE INDEX permit_applications_created_by_idx
        ON permit_applications (created_by_user_id, created_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS permit_applications');
  },
};
