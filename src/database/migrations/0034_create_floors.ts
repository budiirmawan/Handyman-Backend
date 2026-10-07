import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-04A — Floor foundation.
 *
 * A Floor is a digital structure level inside exactly one Building
 * (Property → Building → Floor). Client ownership is derived authoritatively
 * through Floor → Building → Property → Client — no client_id or property_id
 * is duplicated here (single source of truth, matching Building's own design).
 *
 * `code` is the stable machine-readable identifier (e.g. `L01`, `B1`, `GF`),
 * normalized to uppercase by the service layer. Uniqueness is scoped to the
 * Building (`building_id + code`). `level_number` is the ordinal vertical
 * position (negative for basements); it is deliberately NOT unique — mezzanine
 * or split levels may legitimately share one. Inactive Floors remain persisted
 * — never hard-deleted through normal lifecycle operations.
 *
 * Floor is NOT a Campus, Area, Room, Space, Functional Location, Asset, or
 * Equipment — those arrive in later BE-04 PARTs (or are out of BE-04 scope).
 */
export const migration0034CreateFloors: Migration = {
  id: '0034_create_floors',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE floors (
        id           UUID PRIMARY KEY,
        building_id  UUID NOT NULL,
        code         TEXT NOT NULL,
        name         TEXT NOT NULL,
        level_number INTEGER NOT NULL,
        description  TEXT,
        status       TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT floors_building_id_fkey
          FOREIGN KEY (building_id) REFERENCES buildings (id),
        CONSTRAINT floors_building_code_unique UNIQUE (building_id, code),
        CONSTRAINT floors_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(
      `CREATE INDEX floors_building_id_idx ON floors (building_id)`,
    );
    await client.query(`CREATE INDEX floors_status_idx ON floors (status)`);
    await client.query(
      `CREATE INDEX floors_building_level_idx
         ON floors (building_id, level_number)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS floors');
  },
};
