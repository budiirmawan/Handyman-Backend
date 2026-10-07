import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-13E — Visitor Photo / OCR Readiness.
 *
 * Photo-evidence and OCR-readiness rows attached to the shared BE-13A
 * visitor identity. Follows the BE-07 evidence-submission convention:
 * the row stores a SAFE FILE REFERENCE (`file_reference`) plus
 * metadata (mime, size ≤ 50 MB, captured_at) — NEVER the image binary
 * itself. No custom OCR/AI engine is built here; the table only holds
 * OCR request/result METADATA supplied by an external processor:
 *
 *   ocr_status: NOT_REQUESTED → PENDING → PROCESSED | FAILED
 *
 * Extracted identity fields (full name / identity type / identity
 * number) are staged on this row and are NEVER silently applied to the
 * authoritative visitor master: a separate explicit review action
 * (APPLY / REJECT, recorded with reviewer + timestamp) is required, and
 * APPLY routes through the BE-13A visitor service so all identity
 * rules (per-Client duplicate documents, etc.) still hold.
 */
export const migration0137CreateVisitorPhotos: Migration = {
  id: '0137_create_visitor_photos',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE visitor_photos (
        id                       UUID PRIMARY KEY,
        client_id                UUID NOT NULL REFERENCES clients (id),
        visitor_id               UUID NOT NULL REFERENCES visitors (id),
        photo_type               TEXT NOT NULL,
        file_reference           TEXT NOT NULL,
        original_file_name       TEXT NOT NULL,
        mime_type                TEXT NOT NULL,
        file_size                BIGINT NOT NULL,
        captured_at              TIMESTAMPTZ,
        ocr_status               TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
        ocr_provider             TEXT,
        ocr_error                TEXT,
        ocr_processed_at         TIMESTAMPTZ,
        extracted_full_name      TEXT,
        extracted_identity_type  TEXT,
        extracted_identity_number TEXT,
        review_status            TEXT NOT NULL DEFAULT 'UNREVIEWED',
        reviewed_by_user_id      UUID REFERENCES users (id),
        reviewed_at              TIMESTAMPTZ,
        status                   TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id       UUID NOT NULL REFERENCES users (id),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT visitor_photos_type_check
          CHECK (photo_type IN ('VISITOR_PHOTO', 'IDENTITY_DOCUMENT')),
        CONSTRAINT visitor_photos_ocr_status_check
          CHECK (ocr_status IN (
            'NOT_REQUESTED', 'PENDING', 'PROCESSED', 'FAILED'
          )),
        CONSTRAINT visitor_photos_review_status_check
          CHECK (review_status IN ('UNREVIEWED', 'APPLIED', 'REJECTED')),
        CONSTRAINT visitor_photos_status_check
          CHECK (status IN ('ACTIVE', 'REMOVED')),
        CONSTRAINT visitor_photos_extracted_identity_type_check
          CHECK (extracted_identity_type IS NULL OR extracted_identity_type IN (
            'NATIONAL_ID', 'PASSPORT', 'DRIVER_LICENSE',
            'EMPLOYEE_BADGE', 'OTHER', 'NONE'
          )),
        CONSTRAINT visitor_photos_file_size_check
          CHECK (file_size >= 0 AND file_size <= 52428800)
      )
    `);

    await client.query(`
      CREATE INDEX visitor_photos_visitor_idx
        ON visitor_photos (visitor_id, status);
      CREATE INDEX visitor_photos_client_idx
        ON visitor_photos (client_id, status);
      CREATE INDEX visitor_photos_ocr_status_idx
        ON visitor_photos (ocr_status, review_status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS visitor_photos');
  },
};
