import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-02E — Building foundation.
 *
 * A Building is a physical building/facility managed within a Property
 * (Property → Building). It belongs to exactly one Property; Client ownership
 * is derived authoritatively through Building → Property → Client (no client_id
 * duplicated here — avoids multiple sources of truth).
 *
 * `code` is the stable machine-readable identifier, normalized to uppercase by
 * the service layer. Uniqueness is scoped to Property (`property_id + code`).
 * `timezone` stores a validated IANA timezone string (e.g. Asia/Jakarta).
 * Inactive Buildings remain persisted — never hard-deleted through normal
 * lifecycle operations.
 */
export const migration0018CreateBuildings: Migration = {
  id: '0018_create_buildings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE buildings (
        id UUID PRIMARY KEY,
        property_id UUID NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        address_line TEXT,
        city TEXT,
        province TEXT,
        postal_code TEXT,
        country_code TEXT,
        timezone TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT buildings_property_id_fkey
          FOREIGN KEY (property_id) REFERENCES properties (id),
        CONSTRAINT buildings_property_code_unique UNIQUE (property_id, code),
        CONSTRAINT buildings_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
    await client.query(
      `CREATE INDEX buildings_property_id_idx ON buildings (property_id)`,
    );
    await client.query(
      `CREATE INDEX buildings_status_idx ON buildings (status)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS buildings');
  },
};
