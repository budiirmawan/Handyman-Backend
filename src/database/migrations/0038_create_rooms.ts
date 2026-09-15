import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-04D — Room foundation.
 *
 * A Room is a bounded operational unit inside exactly one Area/Zone
 * (Building → Floor → Area/Zone → Room). Client ownership is derived
 * authoritatively through Room → Area → Floor → Building → Property → Client
 * — no parent ids are duplicated here (single source of truth, matching the
 * rest of the structure chain).
 *
 * `code` is the stable machine-readable identifier (e.g. `R101`, `MTG-A`),
 * normalized to uppercase by the service layer; uniqueness is scoped to the
 * Area (`area_id + code`). Inactive Rooms remain persisted — never
 * hard-deleted through normal lifecycle operations.
 *
 * A Room is NOT a Room Type, Space, Functional Location, Asset, or Equipment
 * — those arrive in later BE-04 PARTs (or are out of BE-04 scope entirely).
 * Room Type classification arrives in BE-04E as reference data.
 */
export const migration0038CreateRooms: Migration = {
  id: '0038_create_rooms',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE rooms (
        id          UUID PRIMARY KEY,
        area_id     UUID NOT NULL,
        code        TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        status      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT rooms_area_id_fkey
          FOREIGN KEY (area_id) REFERENCES areas (id),
        CONSTRAINT rooms_area_code_unique UNIQUE (area_id, code),
        CONSTRAINT rooms_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`CREATE INDEX rooms_area_id_idx ON rooms (area_id)`);
    await client.query(`CREATE INDEX rooms_status_idx ON rooms (status)`);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS rooms');
  },
};
