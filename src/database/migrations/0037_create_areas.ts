import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-04C — Area / Zone foundation.
 *
 * An Area (or Zone) is an operational grouping inside exactly one Floor
 * (Building → Floor → Area/Zone). Client ownership is derived
 * authoritatively through Area → Floor → Building → Property → Client — no
 * parent ids are duplicated here (single source of truth, matching the rest
 * of the structure chain).
 *
 * `type` is a lightweight classification only (`AREA` or `ZONE`) — it is NOT
 * a generic spatial taxonomy. `code` is the stable machine-readable
 * identifier (e.g. `LOBBY`, `WING_A`), normalized to uppercase by the
 * service layer; uniqueness is scoped to the Floor (`floor_id + code`).
 * Inactive Areas remain persisted — never hard-deleted through normal
 * lifecycle operations.
 *
 * An Area is NOT a Room, Room Type, Space, Functional Location, Asset, or
 * Equipment — those arrive in later BE-04 PARTs (or are out of BE-04 scope).
 */
export const migration0037CreateAreas: Migration = {
  id: '0037_create_areas',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE areas (
        id          UUID PRIMARY KEY,
        floor_id    UUID NOT NULL,
        code        TEXT NOT NULL,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL DEFAULT 'AREA',
        description TEXT,
        status      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT areas_floor_id_fkey
          FOREIGN KEY (floor_id) REFERENCES floors (id),
        CONSTRAINT areas_floor_code_unique UNIQUE (floor_id, code),
        CONSTRAINT areas_type_check
          CHECK (type IN ('AREA', 'ZONE')),
        CONSTRAINT areas_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`CREATE INDEX areas_floor_id_idx ON areas (floor_id)`);
    await client.query(`CREATE INDEX areas_status_idx ON areas (status)`);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS areas');
  },
};
