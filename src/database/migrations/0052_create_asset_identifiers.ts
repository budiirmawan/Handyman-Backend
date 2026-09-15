import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-05H — Asset Identifier foundation.
 *
 * An Identifier is the FIELD-FACING handle for exactly one Asset
 * (Asset → Identifier): the value printed on a QR label, an asset tag, a
 * barcode, or carried over from a legacy register. An Asset may hold several
 * identifiers at once (a QR sticker AND a metal tag AND a legacy number), and
 * retired labels stay as INACTIVE rows, so this is a collection table.
 *
 * `identifier_value` is GLOBALLY unique, not per-Asset: a scanned value must
 * resolve to exactly one Asset across the whole platform, otherwise field
 * resolution would be ambiguous. Uniqueness is enforced over ALL rows —
 * including INACTIVE ones — so a retired label can never be silently reissued
 * to a different Asset and then resolve to the wrong equipment.
 *
 * Client / Building ownership is NOT duplicated: it is derived through
 * Identifier → Asset → Building → Property → Client, exactly as BE-05F/G
 * derive warranty and certification ownership. Nothing about the tenant is
 * encoded in the identifier itself — values are OPAQUE by design, so a label
 * leaks no Client, Building, or security information to whoever reads it.
 *
 * NO QR IMAGE BINARY is stored here. The table holds only the value needed to
 * generate or resolve a QR later; rendering is a presentation concern, and
 * binary storage stays out of PostgreSQL.
 *
 * This migration creates NO scanning, history, work order, PM, breakdown, or
 * checklist structures: each belongs to a later PART or Wave.
 */
export const migration0052CreateAssetIdentifiers: Migration = {
  id: '0052_create_asset_identifiers',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE asset_identifiers (
        id               UUID PRIMARY KEY,
        asset_id         UUID NOT NULL,
        identifier_type  TEXT NOT NULL,
        identifier_value TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT asset_identifiers_asset_id_fkey
          FOREIGN KEY (asset_id) REFERENCES assets (id),
        CONSTRAINT asset_identifiers_type_check
          CHECK (identifier_type IN ('QR', 'TAG', 'BARCODE', 'LEGACY')),
        CONSTRAINT asset_identifiers_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        -- A scanned value must resolve to exactly one Asset, platform-wide.
        CONSTRAINT asset_identifiers_value_unique UNIQUE (identifier_value)
      )
    `);

    // At most ONE active identifier per Asset per type: an Asset carries one
    // current QR label, one current tag, and so on. Retired labels of the
    // same type remain as INACTIVE history.
    await client.query(
      `CREATE UNIQUE INDEX asset_identifiers_one_active_per_type
         ON asset_identifiers (asset_id, identifier_type)
         WHERE status = 'ACTIVE'`,
    );

    await client.query(
      `CREATE INDEX asset_identifiers_asset_id_idx
         ON asset_identifiers (asset_id)`,
    );
    await client.query(
      `CREATE INDEX asset_identifiers_status_idx
         ON asset_identifiers (status)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS asset_identifiers');
  },
};
