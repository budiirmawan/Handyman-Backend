/**
 * CR-BE-API-01 PART 03 / CR-BE-EXP-01 PART 05 — shared file storage boundary.
 *
 * Single storage boundary for evidence and report-artifact file bytes. The
 * rest of the codebase (routes, services, future domains) depends on this
 * interface only, never on a concrete filesystem/object-store implementation —
 * the abstraction exists so local, cloud, hybrid, or on-premise deployment can
 * be added later without touching callers (see docs/GOVERNANCE.md storage
 * principle).
 */

/** A file stored by the backend. */
export type StoredEvidenceFile = {
  buffer: Buffer;
  mimeType: string | null;
  size: number;
};

/** Input for persisting a file. */
export type EvidenceFileInput = {
  buffer: Buffer;
  mimeType: string | null;
};

/**
 * Storage keys are backend-generated and namespaced:
 *   evidence/<uuid> or reports/<uuid>
 * They are never derived from client-supplied paths, which prevents
 * arbitrary filesystem/path access.
 */
export const EVIDENCE_STORAGE_KEY_PATTERN = /^evidence\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REPORT_ARCHIVE_STORAGE_KEY_PATTERN = /^reports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isEvidenceStorageKey(key: string): boolean {
  return EVIDENCE_STORAGE_KEY_PATTERN.test(key);
}

export function isReportArchiveStorageKey(key: string): boolean {
  return REPORT_ARCHIVE_STORAGE_KEY_PATTERN.test(key);
}

/** True for any backend-generated key accepted by the shared storage boundary. */
export function isManagedStorageKey(key: string): boolean {
  return isEvidenceStorageKey(key) || isReportArchiveStorageKey(key);
}

export function evidenceStorageKey(evidenceId: string): string {
  return `evidence/${evidenceId}`;
}

export function reportArchiveStorageKey(archiveId: string): string {
  return `reports/${archiveId}`;
}

export interface EvidenceStorage {
  /** Persists the file bytes under the given backend-generated key. */
  put(key: string, input: EvidenceFileInput): Promise<void>;
  /** Reads the stored file bytes. Throws NOT_FOUND when absent. */
  get(key: string): Promise<StoredEvidenceFile>;
  /** Removes the stored file (no-op when absent). */
  remove(key: string): Promise<void>;
}
