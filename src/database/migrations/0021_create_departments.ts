import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-03A — Department foundation.
 *
 * A Department is an organizational unit scoped to a single Organization.
 * It is NOT a Property, Building, Subscription, Role, or Permission — those
 * domains remain in BE-01/BE-02.
 *
 * Department provides the parent container for Team (BE-03B).
 *
 * `code` is unique per Organization (enforced by a partial unique index on
 * (organization_id, code) WHERE status = 'ACTIVE'). Inactive departments keep
 * their codes reserved for history.
 */
export const migration0021CreateDepartments: Migration = {
  id: '0021_create_departments',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE departments (
        id             UUID PRIMARY KEY,
        organization_id UUID NOT NULL,
        code           TEXT NOT NULL,
        name           TEXT NOT NULL,
        description    TEXT,
        status         TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT departments_organization_id_fkey
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
        CONSTRAINT departments_code_unique
          UNIQUE (organization_id, code),
        CONSTRAINT departments_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX departments_organization_id_idx
        ON departments (organization_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS departments');
  },
};
