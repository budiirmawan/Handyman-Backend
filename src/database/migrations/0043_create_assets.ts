import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-05A — Asset Registry foundation.
 *
 * An Asset is a MANAGED PHYSICAL OBJECT owned by exactly one Client and
 * operated within exactly one Building
 * (Client → Property → Building → Asset).
 *
 * `client_id` is stored denormalized alongside `building_id` — unlike the
 * BE-04 structure levels — because asset codes are a CLIENT-WIDE registry
 * identifier: an asset keeps its code across the Client's estate, so the
 * uniqueness scope is `client_id + asset_code` rather than per Building. The
 * service layer derives `client_id` authoritatively through
 * Building → Property → Client and never trusts a caller-supplied value, so
 * the denormalization can never contradict BE-02 ownership.
 *
 * Serial numbers, when provided, are unique per Client (partial unique index
 * — NULL serials stay unconstrained) so the same manufacturer serial is not
 * registered twice inside one Client's registry.
 *
 * Status stays intentionally minimal (`ACTIVE` / `INACTIVE`). Detailed
 * lifecycle states arrive in BE-05E. This migration carries NO classification,
 * location binding, equipment profile, warranty, certification, QR identifier,
 * or history — each is a later BE-05 PART. Inactive Assets remain persisted;
 * they are never hard-deleted through normal lifecycle operations.
 */
export const migration0043CreateAssets: Migration = {
  id: '0043_create_assets',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE assets (
        id            UUID PRIMARY KEY,
        client_id     UUID NOT NULL,
        building_id   UUID NOT NULL,
        asset_code    TEXT NOT NULL,
        asset_name    TEXT NOT NULL,
        description   TEXT,
        manufacturer  TEXT,
        model         TEXT,
        serial_number TEXT,
        status        TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT assets_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT assets_building_id_fkey
          FOREIGN KEY (building_id) REFERENCES buildings (id),
        CONSTRAINT assets_client_asset_code_unique
          UNIQUE (client_id, asset_code),
        CONSTRAINT assets_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(
      `CREATE INDEX assets_client_id_idx ON assets (client_id)`,
    );
    await client.query(
      `CREATE INDEX assets_building_id_idx ON assets (building_id)`,
    );
    await client.query(`CREATE INDEX assets_status_idx ON assets (status)`);
    await client.query(
      `CREATE UNIQUE INDEX assets_client_serial_number_unique
         ON assets (client_id, serial_number)
         WHERE serial_number IS NOT NULL`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS assets');
  },
};
