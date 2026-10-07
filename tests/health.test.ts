import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { closePool, initDatabase } from '../src/database';
import { api } from './helpers/http';
import { skipIfNoTestDatabase } from './helpers/postgres';

describe('GET /api/v1/health', () => {
  it('returns a JSON success payload', async () => {
    const response = await api().get('/api/v1/health');

    assert.equal(response.status, 200);
    assert.match(String(response.headers['content-type']), /json/);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.status, 'ok');
  });
});

describe('GET /api/v1/health/database', () => {
  it('returns connected when the test PostgreSQL database is available', async (t) => {
    const database = await skipIfNoTestDatabase(t);
    if (!database) {
      return;
    }

    const pool = await initDatabase(database);

    try {
      const response = await api().get('/api/v1/health/database');

      assert.equal(response.status, 200);
      assert.equal(response.body.success, true);
      assert.equal(response.body.data.status, 'ok');
      assert.equal(response.body.data.database, 'connected');
    } finally {
      await closePool(pool);
    }
  });

  it('returns DATABASE_UNAVAILABLE without exposing credentials', async () => {
    try {
      await closePool();
    } catch {
      // Pool was not initialized.
    }

    const response = await api().get('/api/v1/health/database');

    assert.equal(response.status, 503);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'DATABASE_UNAVAILABLE');
    assert.match(response.body.error.message, /unavailable/i);
    assert.doesNotMatch(JSON.stringify(response.body), /password/i);
    assert.doesNotMatch(JSON.stringify(response.body), /postgres/);
  });
});

describe('unknown API route', () => {
  it('returns JSON NOT_FOUND', async () => {
    const response = await api().get('/api/v1/does-not-exist');

    assert.equal(response.status, 404);
    assert.match(String(response.headers['content-type']), /json/);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });
});
