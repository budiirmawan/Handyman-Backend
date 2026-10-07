import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ConfigError } from '../../../config';
import { AppError, ERROR_CODES } from '../../../shared/errors';
import {
  isManagedStorageKey,
  type EvidenceFileInput,
  type EvidenceStorage,
  type StoredEvidenceFile,
} from './evidence-storage.types';

/**
 * Local-disk shared storage backend (default driver).
 *
 * - Evidence and report keys are validated before any filesystem access; no
 *   client-supplied path ever reaches the filesystem.
 * - The configured directory is resolved once and files are addressed via
 *   `join(baseDir, key)` where `key` is already constrained to a managed
 *   namespace, so traversal outside the directory is impossible.
 */
export function createLocalEvidenceStorage(baseDir: string): EvidenceStorage {
  const root = resolve(baseDir);

  async function ensureRoot(): Promise<void> {
    await mkdir(root, { recursive: true });
  }

  function assertKey(key: string): void {
    if (!isManagedStorageKey(key)) {
      throw new AppError({
        code: ERROR_CODES.INVALID_STORAGE_KEY,
        message: 'Invalid evidence storage key.',
        statusCode: 400,
      });
    }
  }

  function filePath(key: string): string {
    assertKey(key);
    return join(root, key);
  }

  return {
    async put(key: string, input: EvidenceFileInput): Promise<void> {
      await ensureRoot();
      const target = filePath(key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, input.buffer);
    },

    async get(key: string): Promise<StoredEvidenceFile> {
      const target = filePath(key);
      const info = await stat(target).catch(() => null);
      if (!info || !info.isFile()) {
        throw new AppError({
          code: ERROR_CODES.EVIDENCE_FILE_NOT_FOUND,
          message: 'Stored evidence file not found.',
          statusCode: 404,
        });
      }
      const buffer = await readFile(target);
      return { buffer, mimeType: null, size: info.size };
    },

    async remove(key: string): Promise<void> {
      const target = filePath(key);
      await unlink(target).catch(() => undefined);
    },
  };
}

/**
 * D03 — boot-time readiness probe for the local driver.
 *
 * Additive only: the `EvidenceStorage` interface and the factory above are
 * unchanged. Resolves `baseDir`, creates it (recursive), then proves
 * writability by writing and removing a probe file. Resolves with the
 * absolute root path. Throws `ConfigError` (fail fast) when the directory
 * cannot be created or written — e.g. a missing persistent-volume mount or
 * wrong directory ownership in the container.
 */
export async function verifyLocalEvidenceStorageRoot(baseDir: string): Promise<string> {
  const root = resolve(baseDir);
  const probe = join(root, `.write-probe-${process.pid}`);
  try {
    await mkdir(root, { recursive: true });
    await writeFile(probe, 'ok');
    await unlink(probe);
  } catch (error) {
    await unlink(probe).catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `Invalid configuration: EVIDENCE_STORAGE_DIR is not writable (${root}): ${detail}`,
    );
  }
  return root;
}
