import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { recordOperationalEvent } from '../operational-events';
import { createEvidenceStorage, isEvidenceStorageKey } from './storage';
import type { EvidenceStorage } from './storage';
import {
  computeEvidenceSha256,
  EVIDENCE_HASH_ALGORITHM,
} from './evidence-integrity';

/**
 * CR-BE-DOC-CONTROL-01 PART 02 — reusable evidence integrity verification
 * seam (START GOVERNANCE §4, §8).
 *
 * Compares the CURRENTLY stored binary against the authoritative persisted
 * `content_sha256` recorded at upload time (PART 01) and persists the
 * outcome (`last_integrity_status` + `last_integrity_checked_at`).
 *
 * Outcomes:
 *   - NOT_HASHED        no authoritative hash exists (legacy row or
 *                       metadata-contract submission) — no storage read.
 *   - FILE_UNAVAILABLE  hash exists but the stored object cannot be read
 *                       (missing key, non-storage reference, storage error).
 *   - MISMATCH          stored bytes hash differently than the recorded
 *                       upload-time hash — tamper evidence.
 *   - VERIFIED          recomputed SHA-256 equals the recorded hash.
 *
 * Verification NEVER mutates, quarantines, or deletes the evidence row, its
 * stored file, its status, or (future) retention state — MISMATCH and
 * FILE_UNAVAILABLE are auditable facts for humans to act on. Every outcome
 * persists the last-verification fields and records an append-only
 * operational event (success → EVIDENCE_INTEGRITY_VERIFIED, any
 * non-VERIFIED outcome → EVIDENCE_INTEGRITY_FAILED). No binary data,
 * secrets, signed URLs, or storage credentials enter event metadata — only
 * the opaque backend-generated key and hash digests (public integrity
 * metadata).
 *
 * Callable by the scoped manual API (this PART) and reusable by any future
 * governed sweep. No scheduler work is wired here.
 */

export type EvidenceIntegrityOutcome =
  | 'VERIFIED'
  | 'MISMATCH'
  | 'NOT_HASHED'
  | 'FILE_UNAVAILABLE';

export type EvidenceIntegrityVerification = {
  evidenceId: string;
  outcome: EvidenceIntegrityOutcome;
  algorithm: typeof EVIDENCE_HASH_ALGORITHM | null;
  /** Authoritative upload-time hash (null when NOT_HASHED). */
  expectedSha256: string | null;
  /** Hash recomputed from the currently stored bytes (null unless readable). */
  computedSha256: string | null;
  checkedAt: Date;
};

/** Minimal row shape the verification seam needs. */
type EvidenceIntegrityRow = {
  id: string;
  client_id: string;
  building_id?: string | null;
  file_reference: string | null;
  content_sha256: string | null;
  /**
   * CR-BE-DOC-CONTROL-01 PART 04: verification is not applicable to purged
   * tombstones — the binary was intentionally disposed by retention, which
   * is not a FILE_UNAVAILABLE integrity fact (START GOVERNANCE §4).
   */
  retention_state?: string;
};

/**
 * Verifies one evidence submission against its persisted integrity hash.
 *
 * The caller is responsible for access control (the API route reuses the
 * existing evidence Client/Building isolation before invoking this seam).
 * `actorUserId` is null for system-initiated verification.
 */
export async function verifyEvidenceIntegrity(
  row: EvidenceIntegrityRow,
  actorUserId: string | null,
  storage: EvidenceStorage = createEvidenceStorage(),
): Promise<EvidenceIntegrityVerification> {
  const evidenceId = row.id;
  if (row.retention_state === 'PURGED') {
    throw AppError.badRequest(
      'Purged evidence cannot be integrity-verified; its binary was disposed by retention.',
    );
  }
  const expectedSha256 = row.content_sha256;

  let outcome: EvidenceIntegrityOutcome;
  let computedSha256: string | null = null;

  if (!expectedSha256) {
    outcome = 'NOT_HASHED';
  } else if (!row.file_reference || !isEvidenceStorageKey(row.file_reference)) {
    // Hash exists but the reference is not a backend storage key (should not
    // happen through the authoritative flows) — the binary is unreachable.
    outcome = 'FILE_UNAVAILABLE';
  } else {
    try {
      const stored = await storage.get(row.file_reference);
      computedSha256 = computeEvidenceSha256(stored.buffer);
      outcome = computedSha256 === expectedSha256 ? 'VERIFIED' : 'MISMATCH';
    } catch {
      // storage.get throws EVIDENCE_FILE_NOT_FOUND when absent; any storage
      // failure means the binary cannot be compared right now.
      outcome = 'FILE_UNAVAILABLE';
    }
  }

  // Persist the last-verification outcome. Never touches file metadata,
  // hash fields, status, or the stored object.
  const persisted = await getPool().query<{ last_integrity_checked_at: Date }>(
    `UPDATE evidence_submissions
        SET last_integrity_status = $2,
            last_integrity_checked_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING last_integrity_checked_at`,
    [evidenceId, outcome],
  );
  if (persisted.rowCount === 0) {
    throw AppError.notFound('Evidence not found.');
  }
  const checkedAt = persisted.rows[0].last_integrity_checked_at;

  const verified = outcome === 'VERIFIED';
  await recordOperationalEvent({
    clientId: row.client_id,
    buildingId: row.building_id ?? null,
    eventType: verified
      ? 'EVIDENCE_INTEGRITY_VERIFIED'
      : 'EVIDENCE_INTEGRITY_FAILED',
    entityType: 'EVIDENCE_SUBMISSION',
    entityId: evidenceId,
    actorUserId,
    summary: verified
      ? 'Evidence integrity verified'
      : `Evidence integrity verification failed: ${outcome}`,
    metadata: {
      evidenceId,
      outcome,
      algorithm: expectedSha256 ? EVIDENCE_HASH_ALGORITHM : null,
      expectedSha256,
      // Only meaningful on MISMATCH/VERIFIED; null when unreadable/unhashed.
      computedSha256,
      checkedAt: checkedAt.toISOString(),
    },
  });

  return {
    evidenceId,
    outcome,
    algorithm: expectedSha256 ? EVIDENCE_HASH_ALGORITHM : null,
    expectedSha256,
    computedSha256,
    checkedAt,
  };
}
