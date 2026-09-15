import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-04E — Optional Room → Room Type classification reference.
 *
 * `room_type_id` is NULLABLE and defaults to NULL, so every existing Room
 * (and every Room that simply has no classification) remains valid without
 * change. Room Type is never mandatory.
 *
 * Client-context integrity (a Room may only be classified by a Room Type of
 * its own Client, resolved Room → Area → Floor → Building → Property →
 * Client) is a business rule enforced by the service layer, where it also
 * yields the proper API error — the FK here guarantees referential integrity
 * only.
 */
export const migration0040AddRoomTypeReference: Migration = {
  id: '0040_add_room_type_reference',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE rooms
        ADD COLUMN room_type_id UUID,
        ADD CONSTRAINT rooms_room_type_id_fkey
          FOREIGN KEY (room_type_id) REFERENCES room_types (id)
    `);

    await client.query(
      `CREATE INDEX rooms_room_type_id_idx ON rooms (room_type_id)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE rooms
        DROP CONSTRAINT IF EXISTS rooms_room_type_id_fkey,
        DROP COLUMN IF EXISTS room_type_id
    `);
  },
};
