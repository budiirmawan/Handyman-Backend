import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-04E — Room Type foundation.
 *
 * A Room Type is Client-scoped classification/reference data for Rooms
 * (e.g. OFFICE, MEETING_ROOM, TOILET, PANTRY, ELECTRICAL_ROOM). It is a
 * *master/reference* entity only — it is NOT a hierarchy level: the structure
 * chain remains Building → Floor → Area/Zone → Room, and a Room Type merely
 * classifies a Room.
 *
 * Type codes are DATA, not hardcoded application behavior — no application
 * logic may branch on a specific room type code.
 *
 * Scoping follows the BE-03D1 Skill precedent: every Room Type belongs to
 * exactly one Client, and `code` is unique per Client (`client_id + code`) so
 * two Clients may independently define the same code. Inactive Room Types are
 * retained for history rather than hard-deleted.
 */
export const migration0039CreateRoomTypes: Migration = {
  id: '0039_create_room_types',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE room_types (
        id          UUID PRIMARY KEY,
        client_id   UUID NOT NULL,
        code        TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        status      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT room_types_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT room_types_client_code_unique UNIQUE (client_id, code),
        CONSTRAINT room_types_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(
      `CREATE INDEX room_types_client_id_idx ON room_types (client_id)`,
    );
    await client.query(
      `CREATE INDEX room_types_status_idx ON room_types (status)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS room_types');
  },
};
