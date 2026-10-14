import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-FIELD-AUTHORITY-01 P0-D — Genuine Evidence Upload
 *
 * Persists binary-verified field evidence uploads for:
 *   - VARIATION_FINDING
 *   - MATERIAL_RECEIPT
 *   - INSPECTION_EVIDENCE
 *   - BEFORE_AFTER_WORK
 *   - QC_EVIDENCE
 *
 * Enforces that only byte-verified uploads (`upload_status = 'VERIFIED'`)
 * receive a non-null `attachment_reference`, preventing metadata-only rows
 * from being treated as completed file-byte uploads.
 */
export const migration0437CreateHandymanFieldEvidenceUploads: Migration = {
  id: '0437_create_handyman_field_evidence_uploads',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_field_evidence_uploads (
        id                           UUID PRIMARY KEY,
        client_id                    UUID NOT NULL REFERENCES clients (id),
        tenant_company_id            UUID NOT NULL REFERENCES tenant_companies (id),
        building_id                  UUID NOT NULL REFERENCES buildings (id),
        handyman_request_id          UUID NOT NULL,
        execution_scope_id           UUID REFERENCES handyman_execution_scopes (id),
        variation_id                 UUID REFERENCES handyman_scope_variations (id),
        material_purchase_record_id  UUID REFERENCES handyman_material_purchase_records (id),
        purpose                      TEXT NOT NULL
          CHECK (purpose IN (
            'VARIATION_FINDING',
            'MATERIAL_RECEIPT',
            'INSPECTION_EVIDENCE',
            'BEFORE_AFTER_WORK',
            'QC_EVIDENCE'
          )),
        upload_status                TEXT NOT NULL
          CHECK (upload_status IN ('PENDING_BYTES', 'STAGED_BYTES', 'VERIFIED')),
        original_file_name           TEXT NOT NULL
          CHECK (char_length(btrim(original_file_name)) BETWEEN 1 AND 255),
        mime_type                    TEXT NOT NULL
          CHECK (mime_type IN (
            'image/jpeg',
            'image/png',
            'image/webp',
            'application/pdf'
          )),
        storage_key                  TEXT NOT NULL UNIQUE,
        declared_byte_size           INTEGER
          CHECK (declared_byte_size IS NULL OR (declared_byte_size > 0 AND declared_byte_size <= 15728640)),
        verified_byte_size           INTEGER NOT NULL DEFAULT 0
          CHECK (verified_byte_size >= 0 AND verified_byte_size <= 15728640),
        sha256_checksum              VARCHAR(64),
        attachment_reference         TEXT UNIQUE,
        uploaded_by_user_id          UUID NOT NULL REFERENCES users (id),
        uploaded_by_role             TEXT NOT NULL
          CHECK (uploaded_by_role IN (
            'PIC_PEKERJAAN',
            'INSPECTOR',
            'OPERATIONS_MANAGER'
          )),
        notes                        TEXT,
        idempotency_key              TEXT NOT NULL
          CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        verified_at                  TIMESTAMPTZ,
        created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_field_evidence_uploads_idem_unique
          UNIQUE (client_id, uploaded_by_user_id, idempotency_key),
        CONSTRAINT handyman_field_evidence_verified_bytes_check
          CHECK (
            upload_status <> 'VERIFIED'
            OR (
              verified_byte_size > 0
              AND sha256_checksum IS NOT NULL
              AND char_length(sha256_checksum) = 64
              AND attachment_reference IS NOT NULL
              AND verified_at IS NOT NULL
            )
          ),
        CONSTRAINT handyman_field_evidence_unverified_no_ref_check
          CHECK (
            upload_status = 'VERIFIED'
            OR attachment_reference IS NULL
          )
      );

      CREATE INDEX handyman_field_evidence_uploads_scope_idx
        ON handyman_field_evidence_uploads (execution_scope_id, created_at ASC, id ASC);
      CREATE INDEX handyman_field_evidence_uploads_request_idx
        ON handyman_field_evidence_uploads (handyman_request_id, created_at ASC, id ASC);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TABLE IF EXISTS handyman_field_evidence_uploads;
    `);
  },
};
