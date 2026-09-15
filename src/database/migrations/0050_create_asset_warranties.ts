import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-05F — Asset Warranty foundation.
 *
 * A Warranty records COMMERCIAL / SERVICE COVERAGE for exactly one Asset
 * (Asset → Warranty). An Asset may accumulate MANY warranty records over its
 * life — renewals, extensions, superseded coverage — so this is a history
 * table, not a singleton like the BE-05D Equipment Profile.
 *
 * Client / Building ownership is NOT duplicated: it is derived through
 * Warranty → Asset → Building → Property → Client, exactly as BE-05C derives
 * location and BE-05D derives profile ownership. No `client_id`, no
 * `building_id`, no location columns here.
 *
 * DUPLICATE ACTIVE COVERAGE is controlled by a PARTIAL UNIQUE INDEX on
 * `(asset_id) WHERE status = 'ACTIVE'`: at most one ACTIVE warranty per
 * Asset at any time, while any number of EXPIRED / INACTIVE records remain
 * for history. The service additionally rejects overlapping date ranges
 * against non-active records, where it can also return the proper API error.
 *
 * `provider_name` + `warranty_number` are the coverage identity as issued by
 * the provider; the number is unique per Asset so the same document is not
 * registered twice.
 *
 * Status is `ACTIVE | EXPIRED | INACTIVE` — coverage state only. This
 * migration creates NO vendor contract, claim workflow, maintenance,
 * certification, QR / identifier, or asset history structures: each belongs
 * to a later PART or Wave.
 */
export const migration0050CreateAssetWarranties: Migration = {
  id: '0050_create_asset_warranties',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE asset_warranties (
        id                   UUID PRIMARY KEY,
        asset_id             UUID NOT NULL,
        provider_name        TEXT NOT NULL,
        warranty_number      TEXT NOT NULL,
        start_date           DATE NOT NULL,
        end_date             DATE NOT NULL,
        coverage_description TEXT,
        status               TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT asset_warranties_asset_id_fkey
          FOREIGN KEY (asset_id) REFERENCES assets (id),
        CONSTRAINT asset_warranties_status_check
          CHECK (status IN ('ACTIVE', 'EXPIRED', 'INACTIVE')),
        -- Coverage cannot end before it begins.
        CONSTRAINT asset_warranties_date_range_check
          CHECK (end_date >= start_date),
        CONSTRAINT asset_warranties_asset_number_unique
          UNIQUE (asset_id, warranty_number)
      )
    `);

    // At most ONE active coverage per Asset; history rows are unconstrained.
    await client.query(
      `CREATE UNIQUE INDEX asset_warranties_one_active_per_asset
         ON asset_warranties (asset_id)
         WHERE status = 'ACTIVE'`,
    );

    await client.query(
      `CREATE INDEX asset_warranties_asset_id_idx
         ON asset_warranties (asset_id)`,
    );
    await client.query(
      `CREATE INDEX asset_warranties_status_idx
         ON asset_warranties (status)`,
    );
    await client.query(
      `CREATE INDEX asset_warranties_end_date_idx
         ON asset_warranties (end_date)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS asset_warranties');
  },
};
