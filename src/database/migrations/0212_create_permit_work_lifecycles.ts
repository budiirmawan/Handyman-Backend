import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** BE-20K — backend-authoritative Permit Work Start / Close lifecycle. */
export const migration0212CreatePermitWorkLifecycles: Migration = {
  id: '0212_create_permit_work_lifecycles',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE permit_work_lifecycles (
        id                    UUID PRIMARY KEY,
        permit_application_id UUID NOT NULL REFERENCES permit_applications (id),
        status                TEXT NOT NULL DEFAULT 'READY',
        started_at            TIMESTAMPTZ,
        started_by_user_id    UUID REFERENCES users (id),
        start_notes           TEXT,
        closed_at             TIMESTAMPTZ,
        closed_by_user_id     UUID REFERENCES users (id),
        close_notes           TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT permit_work_lifecycle_application_unique
          UNIQUE (permit_application_id),
        CONSTRAINT permit_work_lifecycle_status_check
          CHECK (status IN ('READY', 'IN_PROGRESS', 'CLOSED', 'CANCELLED')),
        CONSTRAINT permit_work_lifecycle_state_check CHECK (
          (status = 'READY'
            AND started_at IS NULL AND started_by_user_id IS NULL
            AND closed_at IS NULL AND closed_by_user_id IS NULL)
          OR
          (status = 'IN_PROGRESS'
            AND started_at IS NOT NULL AND started_by_user_id IS NOT NULL
            AND closed_at IS NULL AND closed_by_user_id IS NULL)
          OR
          (status = 'CLOSED'
            AND started_at IS NOT NULL AND started_by_user_id IS NOT NULL
            AND closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL)
          OR status = 'CANCELLED'
        )
      )
    `);
    await client.query(`
      CREATE INDEX permit_work_lifecycle_status_idx
        ON permit_work_lifecycles (status, started_at);
      CREATE INDEX permit_work_lifecycle_started_by_idx
        ON permit_work_lifecycles (started_by_user_id, started_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS permit_work_lifecycles');
  },
};
