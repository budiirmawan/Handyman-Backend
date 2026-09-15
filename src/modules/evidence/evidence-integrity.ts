import { createHash } from 'node:crypto';

/**
 * CR-BE-DOC-CONTROL-01 PART 01 — shared evidence integrity hash helper.
 *
 * ONE hashing seam used by BOTH authoritative byte-upload flows
 * (`POST /evidence/:evidenceId/file` and the single-call
 * `POST /mobile/evidence`) so the hash implementation can never drift
 * between paths (START GOVERNANCE §3).
 *
 * The hash MUST be computed from the exact buffer handed to
 * `storage.put(...)` — it represents the stored binary content only,
 * never the filename or any metadata. It is always calculated
 * server-side; no caller-supplied hash is ever trusted or accepted.
 *
 * Rows created without bytes passing through the server (the BE-07
 * metadata-contract path and all legacy/historical evidence) legitimately
 * remain unhashed (`content_sha256 IS NULL`) until a file is attached
 * through an authoritative upload flow. They are never assigned a
 * fabricated hash.
 */

/** The only integrity hash algorithm in this foundation. */
export const EVIDENCE_HASH_ALGORITHM = 'SHA-256' as const;

/** Lowercase-hex SHA-256 of the exact stored evidence bytes. */
export function computeEvidenceSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
