import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-04F — Space foundation.
 *
 * A Space is a smaller identifiable physical/operational subdivision inside
 * exactly one Room (Building → Floor → Area/Zone → Room → Space), e.g. a
 * workstation cluster, a counter, a server rack bay, a cubicle. Client
 * ownership is derived authoritatively through Space → Room → Area → Floor →
 * Building → Property → Client — no parent ids are duplicated here (single
 * source of truth, matching the rest of the structure chain).
 *
 * `code` is the stable machine-readable identifier (e.g. `WS-01`, `RACK_A`),
 * normalized to uppercase by the service layer; uniqueness is scoped to the
 * Room (`room_id + code`). Inactive Spaces remain persisted — never
 * hard-deleted through normal lifecycle operations.
 *
 * A Space is NOT a Functional Location, Asset, or Equipment — Functional
 * Location arrives in BE-04G; Assets/Equipment are out of BE-04 scope.
 */
export const migration0041CreateSpaces: Migration = {
  id: '0041_create_spaces',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE spaces (
        id          UUID PRIMARY KEY,
        room_id     UUID NOT NULL,
        code        TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        status      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT spaces_room_id_fkey
          FOREIGN KEY (room_id) REFERENCES rooms (id),
        CONSTRAINT spaces_room_code_unique UNIQUE (room_id, code),
        CONSTRAINT spaces_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`CREATE INDEX spaces_room_id_idx ON spaces (room_id)`);
    await client.query(`CREATE INDEX spaces_status_idx ON spaces (status)`);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS spaces');
  },
};
