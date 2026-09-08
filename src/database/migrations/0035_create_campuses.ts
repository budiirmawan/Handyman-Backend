import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-04B — Campus foundation.
 *
 * A Campus is an OPTIONAL higher grouping of Buildings inside one Property
 * (Property → Campus → Building where applicable). Properties that do not use
 * campuses keep the plain Property → Building chain untouched — nothing about
 * a Building requires a Campus.
 *
 * Client ownership is derived authoritatively through Campus → Property →
 * Client (no client_id duplicated here — single source of truth, matching
 * Building's own design).
 *
 * `code` is the stable machine-readable identifier (e.g. `EAST_CAMPUS`),
 * normalized to uppercase by the service layer. Uniqueness is scoped to the
 * Property (`property_id + code`). Inactive Campuses remain persisted — never
 * hard-deleted through normal lifecycle operations.
 *
 * Campus is NOT an Area, Room, Space, Functional Location, Asset, or
 * Equipment — those arrive in later BE-04 PARTs (or are out of BE-04 scope).
 */
export const migration0035CreateCampuses: Migration = {
  id: '0035_create_campuses',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE campuses (
        id          UUID PRIMARY KEY,
        property_id UUID NOT NULL,
        code        TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        status      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT campuses_property_id_fkey
          FOREIGN KEY (property_id) REFERENCES properties (id),
        CONSTRAINT campuses_property_code_unique UNIQUE (property_id, code),
        CONSTRAINT campuses_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(
      `CREATE INDEX campuses_property_id_idx ON campuses (property_id)`,
    );
    await client.query(`CREATE INDEX campuses_status_idx ON campuses (status)`);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS campuses');
  },
};
