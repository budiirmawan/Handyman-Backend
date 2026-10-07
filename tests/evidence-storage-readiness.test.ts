import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ConfigError, parseConfig, resetAppConfigCache } from '../src/config';
import {
  createEvidenceStorage,
  verifyEvidenceStorageReady,
  verifyLocalEvidenceStorageRoot,
} from '../src/modules/evidence/storage';
import { createLocalEvidenceStorage } from '../src/modules/evidence/storage/local-evidence-storage';
import { AppError, ERROR_CODES } from '../src/shared/errors';

// Hermetic sandboxes under the OS temp dir — never inside the repo, no DB.
const sandboxes: string[] = [];

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'handyman-evidence-'));
  sandboxes.push(dir);
  return dir;
}

after(async () => {
  for (const dir of sandboxes) {
    await chmod(dir, 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
  sandboxes.length = 0;
});

async function withConfiguredStorageDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.EVIDENCE_STORAGE_DIR;
  process.env.EVIDENCE_STORAGE_DIR = dir;
  resetAppConfigCache();
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.EVIDENCE_STORAGE_DIR;
    } else {
      process.env.EVIDENCE_STORAGE_DIR = previous;
    }
    resetAppConfigCache();
  }
}

function evidenceKey(): string {
  return `evidence/${randomUUID()}`;
}

describe('evidence storage config', () => {
  it('defaults to the local driver and .data/evidence', () => {
    const config = parseConfig({});
    assert.equal(config.storage.driver, 'local');
    assert.equal(config.storage.dir, '.data/evidence');
  });

  it('honors EVIDENCE_STORAGE_DIR and trims whitespace', () => {
    const config = parseConfig({ EVIDENCE_STORAGE_DIR: '  /var/lib/handyman/evidence  ' });
    assert.equal(config.storage.driver, 'local');
    assert.equal(config.storage.dir, '/var/lib/handyman/evidence');
  });

  it('falls back to the default dir when EVIDENCE_STORAGE_DIR is blank', () => {
    const config = parseConfig({ EVIDENCE_STORAGE_DIR: '   ' });
    assert.equal(config.storage.dir, '.data/evidence');
  });

  it('rejects any non-local driver at config load', () => {
    assert.throws(
      () => parseConfig({ EVIDENCE_STORAGE_DRIVER: 's3' }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /EVIDENCE_STORAGE_DRIVER must be 'local'/);
        return true;
      },
    );
  });
});

describe('local evidence storage driver', () => {
  it('round-trips put/get/remove on an absolute dir (volume-mount shape)', async () => {
    const dir = await sandbox();
    const storage = createLocalEvidenceStorage(dir);
    const key = evidenceKey();
    const bytes = Buffer.from('evidence-bytes');

    await storage.put(key, { buffer: bytes, mimeType: 'image/png' });

    // Bytes land under <dir>/evidence/<uuid>, i.e. inside the mounted volume.
    const onDisk = await stat(join(dir, key));
    assert.ok(onDisk.isFile());

    const stored = await storage.get(key);
    assert.deepEqual(stored.buffer, bytes);
    assert.equal(stored.size, bytes.length);
    assert.equal(stored.mimeType, null);

    await storage.remove(key);
    await assert.rejects(
      storage.get(key),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, ERROR_CODES.EVIDENCE_FILE_NOT_FOUND);
        assert.equal(error.statusCode, 404);
        return true;
      },
    );
  });

  it('creates a missing nested root on put', async () => {
    const dir = await sandbox();
    const nested = join(dir, 'nested', 'root');
    const storage = createLocalEvidenceStorage(nested);
    await storage.put(evidenceKey(), { buffer: Buffer.from('x'), mimeType: null });
    assert.ok((await stat(nested)).isDirectory());
  });

  it('get on a missing key rejects 404 and remove is a no-op', async () => {
    const storage = createLocalEvidenceStorage(await sandbox());
    const key = evidenceKey();
    await assert.rejects(
      storage.get(key),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, ERROR_CODES.EVIDENCE_FILE_NOT_FOUND);
        assert.equal(error.statusCode, 404);
        return true;
      },
    );
    await storage.remove(key);
  });

  it('rejects unmanaged keys on put/get/remove (interface preserved)', async () => {
    const storage = createLocalEvidenceStorage(await sandbox());
    for (const op of [
      () => storage.put('../escape', { buffer: Buffer.from('x'), mimeType: null }),
      () => storage.get('../escape'),
      () => storage.remove('reports/not-a-uuid'),
    ]) {
      await assert.rejects(op(), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, ERROR_CODES.INVALID_STORAGE_KEY);
        assert.equal(error.statusCode, 400);
        return true;
      });
    }
  });
});

describe('verifyLocalEvidenceStorageRoot', () => {
  it('creates the root and resolves with the absolute path', async () => {
    const nested = join(await sandbox(), 'deep', 'dir');
    const resolved = await verifyLocalEvidenceStorageRoot(nested);
    assert.equal(resolved, nested);
    assert.ok((await stat(nested)).isDirectory());
  });

  it('fails fast with ConfigError when the path is blocked by a file', async () => {
    const dir = await sandbox();
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not-a-dir');
    await assert.rejects(
      verifyLocalEvidenceStorageRoot(join(blocker, 'child')),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /EVIDENCE_STORAGE_DIR is not writable/);
        assert.ok(error.message.includes(join(blocker, 'child')));
        return true;
      },
    );
  });

  it('fails fast with ConfigError on a read-only directory', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // Root bypasses permission bits, so the probe cannot fail there.
      return;
    }
    const dir = await sandbox();
    await chmod(dir, 0o555);
    try {
      await assert.rejects(
        verifyLocalEvidenceStorageRoot(dir),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /EVIDENCE_STORAGE_DIR is not writable/);
          return true;
        },
      );
    } finally {
      await chmod(dir, 0o755);
    }
  });
});

describe('configured storage backend', () => {
  it('readiness gate resolves for a writable configured dir', async () => {
    const dir = await sandbox();
    const resolved = await withConfiguredStorageDir(dir, () => verifyEvidenceStorageReady());
    assert.equal(resolved, dir);
  });

  it('readiness gate fails fast for an unwritable configured dir', async () => {
    const dir = await sandbox();
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not-a-dir');
    await withConfiguredStorageDir(join(blocker, 'child'), () =>
      assert.rejects(verifyEvidenceStorageReady(), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /EVIDENCE_STORAGE_DIR is not writable/);
        return true;
      }),
    );
  });

  it('factory round-trips through the configured absolute dir', async () => {
    const dir = await sandbox();
    await withConfiguredStorageDir(dir, async () => {
      const storage = createEvidenceStorage();
      const key = evidenceKey();
      await storage.put(key, { buffer: Buffer.from('via-factory'), mimeType: null });
      assert.ok((await stat(join(dir, key))).isFile());
      assert.equal((await storage.get(key)).buffer.toString(), 'via-factory');
      await storage.remove(key);
    });
  });
});
