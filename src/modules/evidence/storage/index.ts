import { getAppConfig } from '../../../config';
import { createLocalEvidenceStorage, verifyLocalEvidenceStorageRoot } from './local-evidence-storage';
import {
  evidenceStorageKey,
  type EvidenceStorage,
} from './evidence-storage.types';

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
 * refuses to boot instead of failing evidence operations mid-request. This
 * verifies writability, not persistent-volume attachment.
 */
/**
 * P0-D — runtime storage health probe: writes a probe object through the
 * configured driver, reads it back, verifies byte size and SHA-256, and
 * removes it. Proves read-after-write integrity on the actual backend
 * (e.g. a mounted Railway volume) rather than merely path existence.
 * Throws when bytes are unavailable, truncated or corrupted.
 */
export async function checkEvidenceStorageHealth(
  storage: EvidenceStorage = createEvidenceStorage(),
): Promise<{ driver: string; readAfterWriteVerified: true }> {
  const { randomUUID, createHash } = await import('node:crypto');
  const key = evidenceStorageKey(randomUUID());
  const probe = Buffer.from(`evidence-health-${randomUUID()}`, 'utf8');
  const expectedSha = createHash('sha256').update(probe).digest('hex');
  try {
    await storage.put(key, { buffer: probe, mimeType: 'text/plain' });
    const stored = await storage.get(key);
    const actualSha = createHash('sha256').update(stored.buffer).digest('hex');
    if (stored.size !== probe.byteLength || actualSha !== expectedSha) {
      throw new Error(
        'Evidence storage health check failed: read-after-write checksum mismatch.',
      );
    }
    return {
      driver: getAppConfig().storage.driver,
      readAfterWriteVerified: true,
    };
  } finally {
    await storage.remove(key).catch(() => undefined);
  }
}

export async function verifyEvidenceStorageReady(): Promise<string> {
  const config = getAppConfig().storage;
  switch (config.driver) {
    case 'local':
      return verifyLocalEvidenceStorageRoot(config.dir);
    default:
      throw new Error(`Unsupported evidence storage driver: ${config.driver}`);
  }
}
