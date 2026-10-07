import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-05E — Asset lifecycle / status foundation.
 *
 * Widens the Asset status domain from the BE-05A minimum
 * (`ACTIVE` / `INACTIVE`) to the controlled lifecycle
 * `ACTIVE | INACTIVE | UNDER_MAINTENANCE | RETIRED`, and adds the minimum
 * structured traceability the transition needs.
 *
 * HISTORY READINESS — deliberately fields, NOT a table.
 * `previous_status`, `status_changed_at`, and `status_reason` make every
 * status change non-destructive at the record level: the state it came from,
 * when it moved, and why are all preserved rather than silently overwritten.
 * That is enough for BE-05I to backfill a real Asset History, while leaving
 * BE-05I free to own the append-only history table itself. Creating that
 * table here would pre-empt a later PART.
 *
 * `UNDER_MAINTENANCE` is a lifecycle STATE only — this migration creates no
 * PM, breakdown, work order, checklist, warranty, certification, or QR
 * structures, and no workflow engine.
 *
 * Existing rows keep their status untouched; `previous_status` stays NULL for
 * assets that have never transitioned, and `status_changed_at` defaults to
 * NOW() only for rows created from here on.
 */
export const migration0049AddAssetLifecycleStatus: Migration = {
  id: '0049_add_asset_lifecycle_status',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE assets
        DROP CONSTRAINT IF EXISTS assets_status_check
    `);

    await client.query(`
      ALTER TABLE assets
        ADD CONSTRAINT assets_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE', 'UNDER_MAINTENANCE', 'RETIRED'))
    `);

    await client.query(`
      ALTER TABLE assets
        ADD COLUMN previous_status   TEXT,
        ADD COLUMN status_changed_at TIMESTAMPTZ,
        ADD COLUMN status_reason     TEXT,
        ADD CONSTRAINT assets_previous_status_check
          CHECK (
            previous_status IS NULL
            OR previous_status IN
              ('ACTIVE', 'INACTIVE', 'UNDER_MAINTENANCE', 'RETIRED')
          )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // Rows carrying a lifecycle-only status cannot be represented by the
    // narrower BE-05A domain, so fold them back to the nearest valid state
    // before restoring the original constraint.
    await client.query(`
      UPDATE assets
         SET status = 'INACTIVE'
       WHERE status IN ('UNDER_MAINTENANCE', 'RETIRED')
    `);

    await client.query(`
      ALTER TABLE assets
        DROP CONSTRAINT IF EXISTS assets_previous_status_check,
        DROP COLUMN IF EXISTS status_reason,
        DROP COLUMN IF EXISTS status_changed_at,
        DROP COLUMN IF EXISTS previous_status
    `);

    await client.query(`
      ALTER TABLE assets
        DROP CONSTRAINT IF EXISTS assets_status_check
    `);

    await client.query(`
      ALTER TABLE assets
        ADD CONSTRAINT assets_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
    `);
  },
};
