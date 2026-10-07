import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-06H — Vendor License / Certification / Expiry.
 *
 * Structured license and certification records for a Vendor:
 *
 *   Vendor → Vendor License / Certification → validity / expiry status
 *
 * `record_type` distinguishes LICENSE from CERTIFICATION — one table, one
 * lifecycle, no behavioral fork. `document_reference` optionally points at
 * an existing BE-06G `vendor_compliance_documents` row, so document
 * storage (metadata + file pointer) is REUSED, never duplicated here.
 *
 * Status:
 *   ACTIVE   — the record currently stands (expiry, if any, in the future
 *              at write time).
 *   EXPIRED  — the expiry date has passed; kept as a historical record.
 *   INACTIVE — withdrawn/superseded; kept as history.
 *
 * Whether an ACTIVE row is *effectively* expired at a later instant is
 * RESOLVED by the service (`resolveExpiryStatus`) — there is deliberately
 * no automatic renewal, no notification scheduler, and no approval
 * workflow in this PART.
 *
 * Duplicate control follows the BE-06G idiom: at most one ACTIVE row per
 * (vendor, record_type, number); EXPIRED/INACTIVE history is preserved.
 */
export const migration0062CreateVendorLicensesCertifications: Migration = {
  id: '0062_create_vendor_licenses_certifications',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_licenses_certifications (
        id                 UUID PRIMARY KEY,
        vendor_id          UUID NOT NULL,
        record_type        TEXT NOT NULL,
        name               TEXT NOT NULL,
        number             TEXT NOT NULL,
        issuing_authority  TEXT,
        issue_date         TIMESTAMPTZ,
        expiry_date        TIMESTAMPTZ,
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        document_reference UUID,
        notes              TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendor_licenses_certifications_vendor_id_fkey
          FOREIGN KEY (vendor_id) REFERENCES vendors (id),
        CONSTRAINT vendor_licenses_certifications_document_reference_fkey
          FOREIGN KEY (document_reference)
          REFERENCES vendor_compliance_documents (id),
        CONSTRAINT vendor_licenses_certifications_record_type_check
          CHECK (record_type IN ('LICENSE', 'CERTIFICATION')),
        CONSTRAINT vendor_licenses_certifications_status_check
          CHECK (status IN ('ACTIVE', 'EXPIRED', 'INACTIVE')),
        CONSTRAINT vendor_licenses_certifications_date_range_check
          CHECK (
            issue_date IS NULL
            OR expiry_date IS NULL
            OR expiry_date >= issue_date
          )
      )
    `);

    // One ACTIVE record per (vendor, type, number); history is retained.
    await client.query(`
      CREATE UNIQUE INDEX vendor_licenses_certifications_active_unique
        ON vendor_licenses_certifications (vendor_id, record_type, number)
        WHERE status = 'ACTIVE'
    `);

    await client.query(`
      CREATE INDEX vendor_licenses_certifications_vendor_id_idx
        ON vendor_licenses_certifications (vendor_id)
    `);
    await client.query(`
      CREATE INDEX vendor_licenses_certifications_status_idx
        ON vendor_licenses_certifications (status)
    `);
    await client.query(`
      CREATE INDEX vendor_licenses_certifications_expiry_date_idx
        ON vendor_licenses_certifications (expiry_date)
    `);
    await client.query(`
      CREATE INDEX vendor_licenses_certifications_document_reference_idx
        ON vendor_licenses_certifications (document_reference)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_licenses_certifications');
  },
};
