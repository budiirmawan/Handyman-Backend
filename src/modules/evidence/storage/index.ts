import { getAppConfig } from '../../../config';
import { createLocalEvidenceStorage, verifyLocalEvidenceStorageRoot } from './local-evidence-storage';
import type { EvidenceStorage } from './evidence-storage.types';

export type { EvidenceStorage, StoredEvidenceFile } from './evidence-storage.types';
export {
  EVIDENCE_STORAGE_KEY_PATTERN,
  REPORT_ARCHIVE_STORAGE_KEY_PATTERN,
  evidenceStorageKey,
  isEvidenceStorageKey,
  isManagedStorageKey,
  isReportArchiveStorageKey,
  reportArchiveStorageKey,
} from './evidence-storage.types';
export { verifyLocalEvidenceStorageRoot } from './local-evidence-storage';

/**
 * Creates the configured evidence storage backend (single storage boundary).
 * The driver is selected from validated configuration; 'local' is the only
 * driver in this foundation (see docs/api/CR_BE_API_01_GOVERNANCE.md §6).
 */
export function createEvidenceStorage(): EvidenceStorage {
  const config = getAppConfig().storage;
  switch (config.driver) {
    case 'local':
      return createLocalEvidenceStorage(config.dir);
    default:
      throw new Error(`Unsupported evidence storage driver: ${config.driver}`);
  }
}

/**
 * D03 — fail-fast boot gate for the configured storage backend.
 *
 * Mirrors the driver selection of `createEvidenceStorage()` (additive; the
 * factory and the `EvidenceStorage` interface are unchanged). Resolves with
 * the absolute storage root when the backend is ready; throws `ConfigError`
 * when the configured directory cannot be created or written, so the server
 * refuses to boot instead of failing evidence operations mid-request.
 */
export async function verifyEvidenceStorageReady(): Promise<string> {
  const config = getAppConfig().storage;
  switch (config.driver) {
    case 'local':
      return verifyLocalEvidenceStorageRoot(config.dir);
    default:
      throw new Error(`Unsupported evidence storage driver: ${config.driver}`);
  }
}
