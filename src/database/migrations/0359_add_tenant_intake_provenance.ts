import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-ASSISTED-INTAKE-01 PART 01 — assisted-intake provenance foundation.
 *
 * Adds the canonical provenance fields for staff-assisted intake to BOTH
 * tenant intake records:
 *
 *   tenant_service_requests
 *     intake_channel       TEXT NULL       intake channel vocabulary
 *     created_by_user_id   UUID NULL       authenticated intake actor
 *     reporter_name        TEXT NULL       actual reporter (free text)
 *     reporter_phone       TEXT NULL       actual reporter phone
 *     reporter_email       TEXT NULL       actual reporter email
 *
 *   tenant_complaints     (identical five columns)
 *
 * Semantics:
 *   - `intake_channel` vocabulary is exactly the shared assisted-intake
 *     enumeration (PORTAL, MOBILE, PHONE, WHATSAPP, EMAIL, WALK_IN,
 *     FRONT_DESK, OTHER). It is NULLABLE so historical rows that predate
 *     intake provenance remain representable; LEGACY NULL means "provenance
 *     was not recorded before this CR" and is never backfilled or guessed.
 *   - `created_by_user_id` is internal provenance: the authenticated user
 *     who entered the record. UUID NULL (no fabricated actor for legacy
 *     rows). Referential integrity only, matching the platform operational-
 *     reference convention (e.g. 0347): a non-null value must reference an
 *     existing user, NO ACTION, no cascade.
 *   - `reporter_*` are the optional actual person/contact who made the
 *     report when different from the canonical `tenant_pic_id`. They never
 *     replace or duplicate `tenant_pic_id` and are NULLABLE/NULL by default.
 *
 * No destructive change: new nullable columns only; no row rewrite, no
 * backfill, no index beyond what the FK convention requires.
 */
export const migration0359AddTenantIntakeProvenance: Migration = {
  id: '0359_add_tenant_intake_provenance',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE tenant_service_requests
        ADD COLUMN intake_channel TEXT,
        ADD COLUMN created_by_user_id UUID,
        ADD COLUMN reporter_name TEXT,
        ADD COLUMN reporter_phone TEXT,
        ADD COLUMN reporter_email TEXT,
        ADD CONSTRAINT tenant_service_requests_created_by_user_id_fkey
          FOREIGN KEY (created_by_user_id) REFERENCES users (id),
        ADD CONSTRAINT tenant_service_requests_intake_channel_check
          CHECK (intake_channel IS NULL OR intake_channel IN (
            'PORTAL', 'MOBILE', 'PHONE', 'WHATSAPP', 'EMAIL',
            'WALK_IN', 'FRONT_DESK', 'OTHER'
          ))
    `);

    await client.query(`
      ALTER TABLE tenant_complaints
        ADD COLUMN intake_channel TEXT,
        ADD COLUMN created_by_user_id UUID,
        ADD COLUMN reporter_name TEXT,
        ADD COLUMN reporter_phone TEXT,
        ADD COLUMN reporter_email TEXT,
        ADD CONSTRAINT tenant_complaints_created_by_user_id_fkey
          FOREIGN KEY (created_by_user_id) REFERENCES users (id),
        ADD CONSTRAINT tenant_complaints_intake_channel_check
          CHECK (intake_channel IS NULL OR intake_channel IN (
            'PORTAL', 'MOBILE', 'PHONE', 'WHATSAPP', 'EMAIL',
            'WALK_IN', 'FRONT_DESK', 'OTHER'
          ))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE tenant_service_requests
        DROP CONSTRAINT IF EXISTS tenant_service_requests_intake_channel_check,
        DROP CONSTRAINT IF EXISTS tenant_service_requests_created_by_user_id_fkey,
        DROP COLUMN IF EXISTS reporter_email,
        DROP COLUMN IF EXISTS reporter_phone,
        DROP COLUMN IF EXISTS reporter_name,
        DROP COLUMN IF EXISTS created_by_user_id,
        DROP COLUMN IF EXISTS intake_channel
    `);

    await client.query(`
      ALTER TABLE tenant_complaints
        DROP CONSTRAINT IF EXISTS tenant_complaints_intake_channel_check,
        DROP CONSTRAINT IF EXISTS tenant_complaints_created_by_user_id_fkey,
        DROP COLUMN IF EXISTS reporter_email,
        DROP COLUMN IF EXISTS reporter_phone,
        DROP COLUMN IF EXISTS reporter_name,
        DROP COLUMN IF EXISTS created_by_user_id,
        DROP COLUMN IF EXISTS intake_channel
    `);
  },
};
