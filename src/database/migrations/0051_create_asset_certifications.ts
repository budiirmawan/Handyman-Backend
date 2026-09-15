import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-05G — Asset Certification foundation.
 *
 * A Certification records STATUTORY / TECHNICAL / INSPECTION / COMPLIANCE
 * certification for exactly one Asset (Asset → Certification). An Asset
 * accumulates MANY certification records over its life — renewals,
 * re-inspections, superseded certificates, and several DIFFERENT types held
 * at once (e.g. a lift holding both a statutory operating permit and a load
 * test certificate) — so this is a history table.
 *
 * Client / Building ownership is NOT duplicated: it is derived through
 * Certification → Asset → Building → Property → Client, exactly as BE-05F
 * derives warranty ownership.
 *
 * DUPLICATE ACTIVE CERTIFICATION is controlled PER TYPE by a partial unique
 * index on `(asset_id, certification_type) WHERE status = 'ACTIVE'`: an Asset
 * may hold several concurrent ACTIVE certifications of DIFFERENT types, but
 * never two of the SAME type. Any number of EXPIRED / INACTIVE records
 * remain for history. The service additionally rejects overlapping validity
 * windows within the same type, where it can also return the proper API
 * error.
 *
 * `expiry_date` is NULLABLE: some certifications are perpetual (no renewal
 * date). The date CHECK therefore only applies when an expiry exists.
 *
 * Status is `ACTIVE | EXPIRED | INACTIVE` — certification state only. This
 * migration creates NO inspection execution, renewal workflow, document
 * repository, QR / identifier, or asset history structures: each belongs to
 * a later PART or Wave.
 */
export const migration0051CreateAssetCertifications: Migration = {
  id: '0051_create_asset_certifications',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE asset_certifications (
        id                 UUID PRIMARY KEY,
        asset_id           UUID NOT NULL,
        certification_type TEXT NOT NULL,
        certificate_number TEXT NOT NULL,
        issuing_authority  TEXT NOT NULL,
        issue_date         DATE NOT NULL,
        expiry_date        DATE,
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        notes              TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT asset_certifications_asset_id_fkey
          FOREIGN KEY (asset_id) REFERENCES assets (id),
        CONSTRAINT asset_certifications_status_check
          CHECK (status IN ('ACTIVE', 'EXPIRED', 'INACTIVE')),
        -- A perpetual certification has no expiry; when one exists it can
        -- never precede the issue date.
        CONSTRAINT asset_certifications_date_range_check
          CHECK (expiry_date IS NULL OR expiry_date >= issue_date),
        CONSTRAINT asset_certifications_asset_number_unique
          UNIQUE (asset_id, certificate_number)
      )
    `);

    // At most ONE active certification per Asset PER TYPE; different types
    // may be active concurrently, and history rows are unconstrained.
    await client.query(
      `CREATE UNIQUE INDEX asset_certifications_one_active_per_type
         ON asset_certifications (asset_id, certification_type)
         WHERE status = 'ACTIVE'`,
    );

    await client.query(
      `CREATE INDEX asset_certifications_asset_id_idx
         ON asset_certifications (asset_id)`,
    );
    await client.query(
      `CREATE INDEX asset_certifications_type_idx
         ON asset_certifications (certification_type)`,
    );
    await client.query(
      `CREATE INDEX asset_certifications_status_idx
         ON asset_certifications (status)`,
    );
    await client.query(
      `CREATE INDEX asset_certifications_expiry_date_idx
         ON asset_certifications (expiry_date)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS asset_certifications');
  },
};
