import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-06G — Vendor Compliance Documents.
 *
 * Structured compliance document METADATA for a Vendor:
 *
 *   Vendor → Vendor Compliance Document
 *
 * This is deliberately NOT a document management platform. Only metadata
 * and an opaque `file_reference` (a pointer into whatever storage the
 * platform uses — never a binary) are stored; PostgreSQL holds no file
 * content. There is no OCR, no parsing, no approval workflow, and no
 * renewal automation here — and no License/Certification/Expiry engine,
 * which is BE-06H.
 *
 * A Vendor may hold many documents, including historical rows. Duplicate
 * control follows the BE-06 partial-unique idiom: at most one ACTIVE row
 * per (vendor, document_type, document_number); EXPIRED/INACTIVE history
 * is preserved.
 *
 * `issue_date <= expiry_date` is enforced by CHECK whenever both are
 * present. Date/status consistency (an ACTIVE document may not carry an
 * already-past expiry; EXPIRED requires a past expiry) is a service rule,
 * where it yields the proper API error.
 */
export const migration0061CreateVendorComplianceDocuments: Migration = {
  id: '0061_create_vendor_compliance_documents',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_compliance_documents (
        id              UUID PRIMARY KEY,
        vendor_id       UUID NOT NULL,
        document_type   TEXT NOT NULL,
        document_number TEXT NOT NULL,
        document_name   TEXT NOT NULL,
        issue_date      TIMESTAMPTZ,
        expiry_date     TIMESTAMPTZ,
        status          TEXT NOT NULL DEFAULT 'ACTIVE',
        file_reference  TEXT,
        notes           TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendor_compliance_documents_vendor_id_fkey
          FOREIGN KEY (vendor_id) REFERENCES vendors (id),
        CONSTRAINT vendor_compliance_documents_status_check
          CHECK (status IN ('ACTIVE', 'EXPIRED', 'INACTIVE')),
        CONSTRAINT vendor_compliance_documents_date_range_check
          CHECK (
            issue_date IS NULL
            OR expiry_date IS NULL
            OR expiry_date >= issue_date
          )
      )
    `);

    // One ACTIVE document per (vendor, type, number); history is retained.
    await client.query(`
      CREATE UNIQUE INDEX vendor_compliance_documents_active_unique
        ON vendor_compliance_documents (vendor_id, document_type, document_number)
        WHERE status = 'ACTIVE'
    `);

    await client.query(`
      CREATE INDEX vendor_compliance_documents_vendor_id_idx
        ON vendor_compliance_documents (vendor_id)
    `);
    await client.query(`
      CREATE INDEX vendor_compliance_documents_status_idx
        ON vendor_compliance_documents (status)
    `);
    await client.query(`
      CREATE INDEX vendor_compliance_documents_expiry_date_idx
        ON vendor_compliance_documents (expiry_date)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_compliance_documents');
  },
};
