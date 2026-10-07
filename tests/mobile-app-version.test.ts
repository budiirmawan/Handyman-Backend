import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { parseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-25M — App Version Metadata (focused contract tests).
 *
 * Verifies the mobile app version metadata contract:
 *   - platform,
 *   - current supported version,
 *   - minimum supported version,
 *   - update required flag,
 *   - update available flag,
 *   - release metadata where applicable,
 *   - read-only/public contract (no auth, no update delivery).
 */

const DB_PORT = 55451;
const DATA_DIR = '/tmp/asentra-be25m-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

const id = () => randomUUID();

async function insertRow(
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const rowId = id();
  const entries = Object.entries(values);
  const columns = entries.map(([column]) => column).join(', ');
  const placeholders = entries.map((_, index) => `$${index + 2}`).join(', ');
  await q(
    `INSERT INTO ${table} (id, ${columns}) VALUES ($1, ${placeholders})`,
    [rowId, ...entries.map(([, value]) => value)],
  );
  return rowId;
}

async function getMetadata(platform: string, appVersion?: string): Promise<any> {
  let url = `/api/v1/mobile/app-version/${platform}`;
  if (appVersion !== undefined) {
    url += `?appVersion=${encodeURIComponent(appVersion)}`;
  }
  return api().get(url);
}

before(async () => {
  if (EMBEDDED_DATABASE) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: DB_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }

  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  database = db;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE mobile_app_versions CASCADE');

  // Android: current 3.2.0, minimum 2.5.0, with release metadata.
  await insertRow('mobile_app_versions', {
    platform: 'ANDROID',
    current_version: '3.2.0',
    minimum_version: '2.5.0',
    release_notes: 'Fixes and performance',
    release_date: '2026-08-01T00:00:00Z',
    status: 'ACTIVE',
  });
  // iOS: current 3.2.0, minimum 3.0.0, no release metadata.
  await insertRow('mobile_app_versions', {
    platform: 'IOS',
    current_version: '3.2.0',
    minimum_version: '3.0.0',
    release_notes: null,
    release_date: null,
    status: 'ACTIVE',
  });
});

after(async () => {
  try {
    if (pool) {
      await closePool(pool);
    }
    if (pg) {
      await pg.stop();
    }
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pool = null;
  database = null;
  pg = null;
});

describe('BE-25M app version metadata — contract shape', () => {
  it('returns the full metadata contract (platform, versions, flags, release)', async () => {
    const response = await getMetadata('ANDROID', '3.1.0');
    assert.equal(response.status, 200);
    const data = response.body.data;

    assert.deepEqual(Object.keys(data).sort(), [
      'currentVersion',
      'minimumSupportedVersion',
      'platform',
      'release',
      'updateAvailable',
      'updateRequired',
    ]);
    assert.equal(data.platform, 'ANDROID');
    assert.equal(data.currentVersion, '3.2.0');
    assert.equal(data.minimumSupportedVersion, '2.5.0');
    // 3.1.0 < 3.2.0 → update available; 3.1.0 >= 2.5.0 → not required.
    assert.equal(data.updateAvailable, true);
    assert.equal(data.updateRequired, false);
    assert.deepEqual(data.release, {
      version: '3.2.0',
      notes: 'Fixes and performance',
      date: '2026-08-01T00:00:00.000Z',
    });
  });

  it('flags updateRequired for a version below the minimum', async () => {
    const response = await getMetadata('ANDROID', '2.4.9');
    assert.equal(response.status, 200);
    const data = response.body.data;
    assert.equal(data.updateRequired, true, '2.4.9 < 2.5.0');
    assert.equal(data.updateAvailable, true);
  });

  it('flags nothing for the current version', async () => {
    const response = await getMetadata('ANDROID', '3.2.0');
    const data = response.body.data;
    assert.equal(data.updateRequired, false);
    assert.equal(data.updateAvailable, false);
  });

  it('returns metadata with both flags false when appVersion is omitted (public read)', async () => {
    const response = await getMetadata('IOS');
    assert.equal(response.status, 200);
    const data = response.body.data;
    assert.equal(data.platform, 'IOS');
    assert.equal(data.currentVersion, '3.2.0');
    assert.equal(data.minimumSupportedVersion, '3.0.0');
    assert.equal(data.updateAvailable, false);
    assert.equal(data.updateRequired, false);
    assert.deepEqual(data.release, { version: '3.2.0', notes: null, date: null });
  });

  it('compares versions numerically segment-wise (1.10.0 > 1.9.0)', async () => {
    const response = await getMetadata('IOS', '1.10.0');
    const data = response.body.data;
    // 1.10.0 < 3.2.0 (numeric segments) and < 3.0.0 → both flags true.
    assert.equal(data.updateAvailable, true);
    assert.equal(data.updateRequired, true);
  });
});

describe('BE-25M app version metadata — errors and boundaries', () => {
  it('returns 400 for an unknown platform', async () => {
    const response = await getMetadata('WINDOWS');
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field === 'platform',
      ),
    );
  });

  it('returns 400 for an invalid appVersion format', async () => {
    const response = await getMetadata('ANDROID', 'v1.2');
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 with resource reference when no active metadata exists', async () => {
    // Deactivate the ANDROID row to simulate "no active metadata".
    await q(`UPDATE mobile_app_versions SET status = 'INACTIVE' WHERE platform = 'ANDROID'`);
    const response = await getMetadata('ANDROID', '1.0.0');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
    assert.deepEqual(response.body.error.resource, {
      type: 'APP_VERSION',
      id: 'ANDROID',
    });
  });

  it('is a read-only public contract (no auth required, no delivery endpoints)', async () => {
    // No authentication needed (works without a token).
    const anonymous = await api().get('/api/v1/mobile/app-version/IOS?appVersion=3.0.0');
    assert.equal(anonymous.status, 200);

    // No update-delivery endpoints exist.
    const delivery = await api().post('/api/v1/mobile/app-version/ANDROID/update');
    assert.equal(delivery.status, 404);
  });
});
