import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-DOC-CONTROL-01 PART 01 — Evidence integrity metadata foundation.
 *
 * Additive nullable columns on the single shared BE-07 evidence engine
 * (`evidence_submissions`) — no new table, no parallel evidence platform
 * (docs/CR-BE-DOC-CONTROL-01_START_GOVERNANCE.md §2).
 *
 *   - content_sha256            lowercase hex SHA-256 of the EXACT stored
 *                               bytes handed to the storage abstraction.
 *                               NULL = not hashed (legacy rows and
 *                               metadata-contract submissions that never
 *                               passed bytes through the server).
 *   - content_hashed_at         instant the hash was computed/persisted.
 *   - hash_algorithm            constant 'SHA-256' (CHECK-constrained).
 *   - last_integrity_status     outcome of the most recent verification
 *                               (PART 02 seam); NULL = never verified.
 *   - last_integrity_checked_at instant of the most recent verification.
 *
 * The three hash fields are set together or not at all (consistency CHECK).
 * NO data backfill: every pre-existing row keeps content_sha256 = NULL —
 * historical evidence is never silently assigned a fabricated hash (§3, §11).
 *
 * The evidence_submission_execution CHECK constraint (authoritative union
 * restored by migration 0281) is NOT touched by this migration.
 */
export const migration0303AddEvidenceIntegrityMetadata: Migration = {
  id: '0303_add_evidence_integrity_metadata',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE evidence_submissions
        ADD COLUMN content_sha256 TEXT,
        ADD COLUMN content_hashed_at TIMESTAMPTZ,
        ADD COLUMN hash_algorithm TEXT,
        ADD COLUMN last_integrity_status TEXT,
        ADD COLUMN last_integrity_checked_at TIMESTAMPTZ,
        ADD CONSTRAINT evidence_content_sha256_format CHECK (
          content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'
        ),
        ADD CONSTRAINT evidence_hash_algorithm CHECK (
          hash_algorithm IS NULL OR hash_algorithm = 'SHA-256'
        ),
        ADD CONSTRAINT evidence_hash_consistency CHECK (
          (content_sha256 IS NULL AND content_hashed_at IS NULL AND hash_algorithm IS NULL)
          OR
          (content_sha256 IS NOT NULL AND content_hashed_at IS NOT NULL AND hash_algorithm IS NOT NULL)
        ),
        ADD CONSTRAINT evidence_last_integrity_status CHECK (
          last_integrity_status IS NULL OR last_integrity_status IN
            ('VERIFIED', 'MISMATCH', 'NOT_HASHED', 'FILE_UNAVAILABLE')
        )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE evidence_submissions
        DROP CONSTRAINT IF EXISTS evidence_last_integrity_status,
        DROP CONSTRAINT IF EXISTS evidence_hash_consistency,
        DROP CONSTRAINT IF EXISTS evidence_hash_algorithm,
        DROP CONSTRAINT IF EXISTS evidence_content_sha256_format,
        DROP COLUMN IF EXISTS last_integrity_checked_at,
        DROP COLUMN IF EXISTS last_integrity_status,
        DROP COLUMN IF EXISTS hash_algorithm,
        DROP COLUMN IF EXISTS content_hashed_at,
        DROP COLUMN IF EXISTS content_sha256
    `);
  },
};
