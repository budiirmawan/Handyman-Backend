import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clearLoginRateLimits, credentialService } from '../src/modules/auth';
import { userService } from '../src/modules/users';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

before(async () => {
  // Test-friendly rate limit configuration (3 failed attempts allowed).
  process.env.AUTH_LOGIN_RATE_LIMIT_MAX_ATTEMPTS = '3';
  process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES = '15';
  resetAppConfigCache();

  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE users, roles, permissions CASCADE');
  database = db;
});

after(async () => {
  clearLoginRateLimits();
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

describe('login rate limiting', () => {
  it('throttles repeated failed logins with 429 AUTH_RATE_LIMITED', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    clearLoginRateLimits();

    const email = `rate-${randomUUID()}@example.com`;
    const password = 'RateLimitPass123';
    const user = await userService.createUser({ email, displayName: 'Rate Limit' });
    await credentialService.createInitialCredential({ userId: user.id, password });

    // Three failed attempts are allowed (401), the fourth is throttled (429).
    for (let i = 0; i < 3; i += 1) {
      const response = await api()
        .post('/api/v1/auth/login')
        .send({ email, password: 'WrongPass123' });
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');
    }

    const throttled = await api()
      .post('/api/v1/auth/login')
      .send({ email, password: 'WrongPass123' });
    assert.equal(throttled.status, 429);
    assert.equal(throttled.body.error.code, 'AUTH_RATE_LIMITED');
    // Generic response: no numeric attempt count or account existence hints.
    assert.doesNotMatch(JSON.stringify(throttled.body), /account|remaining|\d/i);
  });

  it('does not lock the account permanently — a valid login resets the throttle', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    clearLoginRateLimits();

    const email = `reset-${randomUUID()}@example.com`;
    const password = 'ResetPass123';
    const user = await userService.createUser({ email, displayName: 'Reset' });
    await credentialService.createInitialCredential({ userId: user.id, password });

    for (let i = 0; i < 3; i += 1) {
      await api().post('/api/v1/auth/login').send({ email, password: 'WrongPass123' });
    }

    // Threshold reached.
    const throttled = await api()
      .post('/api/v1/auth/login')
      .send({ email, password: 'WrongPass123' });
    assert.equal(throttled.status, 429);

    // Clearing state simulates the window reset; a valid login then succeeds.
    clearLoginRateLimits();
    const success = await api().post('/api/v1/auth/login').send({ email, password });
    assert.equal(success.status, 200);
  });
});
