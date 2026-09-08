import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-25M — Mobile app version metadata.
 *
 * Read-only contract data: per-platform supported version metadata. The
 * backend reports the current/minimum supported versions and flags; it does
 * NOT build app distribution/update delivery and does not hardcode Flutter
 * UI behavior. Version strings are free-form (e.g. "1.2.3"), compared
 * lexicographically by the client or by this API's ordered rows.
 */
export const migration0236CreateMobileAppVersions: Migration = {
  id: '0236_create_mobile_app_versions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE mobile_app_versions (
        id               UUID PRIMARY KEY,
        platform         TEXT NOT NULL,
        current_version  TEXT NOT NULL,
        minimum_version  TEXT NOT NULL,
        release_notes    TEXT,
        release_date     TIMESTAMPTZ,
        status           TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT mobile_app_versions_platform_unique
          UNIQUE (platform),
        CONSTRAINT mobile_app_versions_platform_check
          CHECK (platform IN ('ANDROID', 'IOS')),
        CONSTRAINT mobile_app_versions_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS mobile_app_versions');
  },
};
