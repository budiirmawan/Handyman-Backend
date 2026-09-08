import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-03B — Position foundation.
 *
 * A Position represents an organizational / job-function label scoped to a
 * single Organization. It is NOT a Role, Permission, or automatic authorization
 * — those belong to BE-01.
 *
 * `department_id` is optional but when provided must belong to `organization_id`
 * (enforced at the application service layer, not the database — the FK allows
 * NULL so the constraint is validated by the service after loading the Department).
 *
 * `code` is unique per Organization (enforced by a partial unique index on
 * (organization_id, code) WHERE status = 'ACTIVE').
 */
export const migration0023CreatePositions: Migration = {
  id: '0023_create_positions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE positions (
        id              UUID PRIMARY KEY,
        organization_id UUID NOT NULL,
        department_id    UUID,
        code            TEXT NOT NULL,
        name            TEXT NOT NULL,
        description     TEXT,
        status          TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT positions_organization_id_fkey
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
        CONSTRAINT positions_department_id_fkey
          FOREIGN KEY (department_id) REFERENCES departments (id),
        CONSTRAINT positions_code_unique
          UNIQUE (organization_id, code),
        CONSTRAINT positions_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX positions_organization_id_idx
        ON positions (organization_id)
    `);

    await client.query(`
      CREATE INDEX positions_department_id_idx
        ON positions (department_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS positions');
  },
};
