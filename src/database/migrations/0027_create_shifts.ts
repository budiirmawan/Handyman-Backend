import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-03E — Shift foundation.
 *
 * A Shift is a named working window (e.g. MORNING 07:00–15:00) operated at a
 * specific Building. It is a definition only: no attendance, payroll, overtime,
 * leave, timesheet, roster generation, or automatic scheduling is implied.
 *
 * `client_id` is stored alongside `building_id` even though Building already
 * resolves a Client through Building → Property → Client. Unlike `buildings`,
 * a Shift is Client-scoped in its own right and every isolation check and
 * listing filters on it, so denormalizing avoids a two-hop join on the hot
 * read path. The service layer is responsible for keeping the two consistent:
 * it rejects any Shift whose Building does not resolve to the given Client.
 *
 * `start_time` / `end_time` are TIME (wall-clock, no date, no zone) — the
 * Building's `timezone` supplies the zone. Overnight shifts are legitimate and
 * deliberately allowed: `end_time < start_time` simply means the window crosses
 * midnight. Only a zero-length shift is rejected.
 */
export const migration0027CreateShifts: Migration = {
  id: '0027_create_shifts',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE shifts (
        id          UUID PRIMARY KEY,
        client_id   UUID NOT NULL,
        building_id UUID NOT NULL,
        code        TEXT NOT NULL,
        name        TEXT NOT NULL,
        start_time  TIME NOT NULL,
        end_time    TIME NOT NULL,
        status      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT shifts_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT shifts_building_id_fkey
          FOREIGN KEY (building_id) REFERENCES buildings (id),
        CONSTRAINT shifts_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        -- A shift must span a non-zero window. end_time < start_time is valid
        -- and denotes an overnight shift.
        CONSTRAINT shifts_time_window_check
          CHECK (end_time <> start_time),
        -- Scoped to the Building: two Buildings under the same Client may each
        -- run their own MORNING shift, which is the normal operating pattern.
        CONSTRAINT shifts_building_code_unique UNIQUE (building_id, code)
      )
    `);

    await client.query(
      `CREATE INDEX shifts_client_id_idx ON shifts (client_id)`,
    );
    await client.query(
      `CREATE INDEX shifts_building_id_idx ON shifts (building_id)`,
    );
    await client.query(`CREATE INDEX shifts_status_idx ON shifts (status)`);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS shifts');
  },
};
