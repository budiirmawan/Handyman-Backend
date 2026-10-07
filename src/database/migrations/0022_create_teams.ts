import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-03B — Team foundation.
 *
 * A Team is an operational / organizational grouping scoped to a single
 * Department. It is NOT a Role, Permission, or workforce membership — those
 * belong to BE-01 and BE-03C respectively.
 *
 * `code` is unique per Department (enforced by a partial unique index on
 * (department_id, code) WHERE status = 'ACTIVE'). Inactive teams keep their
 * codes reserved for history.
 */
export const migration0022CreateTeams: Migration = {
  id: '0022_create_teams',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE teams (
        id             UUID PRIMARY KEY,
        department_id   UUID NOT NULL,
        code           TEXT NOT NULL,
        name           TEXT NOT NULL,
        description    TEXT,
        status         TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT teams_department_id_fkey
          FOREIGN KEY (department_id) REFERENCES departments (id),
        CONSTRAINT teams_code_unique
          UNIQUE (department_id, code),
        CONSTRAINT teams_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX teams_department_id_idx
        ON teams (department_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS teams');
  },
};
