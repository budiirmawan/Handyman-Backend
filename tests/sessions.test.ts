import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  credentialService,
  generateSessionToken,
  hashSessionToken,
  sessionRepository,
} from '../src/modules/auth';
import { userService, type UserStatus } from '../src/modules/users';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, permissions, clients, subscriptions, licenses, modules,
       module_entitlements, properties, buildings, user_building_assignments,
       organizations, departments, teams, positions, workforce_profiles,
       workforce_building_assignments, external_workforce_links
     CASCADE`,
  );
  database = db;
});

after(async () => {
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

const PUBLIC_USER_KEYS = [
  'createdAt',
  'displayName',
  'email',
  'id',
  'status',
  'updatedAt',
];

async function provisionUser(
  email: string,
  options: { status?: UserStatus; password?: string } = {},
) {
  const user = await userService.createUser({
    email,
    displayName: 'Session Tester',
    status: options.status,
  });

  if (options.password !== undefined) {
    await credentialService.createInitialCredential({
      userId: user.id,
      password: options.password,
    });
  }

  return user;
}

async function login(email: string, password: string) {
  return api().post('/api/v1/auth/login').send({ email, password });
}

async function getSessionRow(userId: string) {
  const result = await pool!.query<{ token_hash: string; status: string; revoked_at: Date | null }>(
    `SELECT token_hash, status, revoked_at FROM user_sessions WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

describe('POST /api/v1/auth/login', () => {
  it('logs in an ACTIVE user with valid credentials', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await provisionUser('login@example.com', {
      password: 'CorrectPass123',
    });

    const response = await login('login@example.com', 'CorrectPass123');

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);

    const { sessionToken, expiresAt, user: responseUser } = response.body.data;
    assert.ok(typeof sessionToken === 'string' && sessionToken.length > 0);
    assert.ok(Date.parse(expiresAt) > Date.now());

    assert.equal(responseUser.id, user.id);
    assert.equal(responseUser.email, 'login@example.com');
    assert.equal(responseUser.displayName, 'Session Tester');
    assert.equal(responseUser.status, 'ACTIVE');
    assert.deepEqual(Object.keys(responseUser).sort(), PUBLIC_USER_KEYS);

    const row = await getSessionRow(user.id);
    assert.ok(row, 'expected a session row');
    assert.notEqual(row.token_hash, sessionToken);
    assert.equal(row.status, 'ACTIVE');
  });

  it('normalizes the email consistently during login', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await provisionUser('MiXeD@Example.com', { password: 'Normalized123' });

    const response = await login('  MIXED@example.COM ', 'Normalized123');

    assert.equal(response.status, 200);
    assert.equal(response.body.data.user.email, 'mixed@example.com');
  });

  it('returns 401 INVALID_CREDENTIALS for an unknown email', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await login('unknown@example.com', 'Whatever123');

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');
    assert.doesNotMatch(JSON.stringify(response.body), /USER_NOT_FOUND/);
    assert.doesNotMatch(JSON.stringify(response.body), /not found/i);
  });

  it('returns the same 401 for a wrong password as for an unknown email', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await provisionUser('wrong-pass@example.com', {
      password: 'CorrectPass123',
    });

    const response = await login('wrong-pass@example.com', 'WrongPass1234');

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');
  });

  it('denies login for an INACTIVE user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await provisionUser('inactive@example.com', {
      status: 'INACTIVE',
      password: 'InactivePass123',
    });

    const response = await login('inactive@example.com', 'InactivePass123');

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');
  });

  it('denies login for a SUSPENDED user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await provisionUser('suspended@example.com', {
      status: 'SUSPENDED',
      password: 'SuspendedPass123',
    });

    const response = await login('suspended@example.com', 'SuspendedPass123');

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');
  });

  it('denies login for a user without a credential', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await provisionUser('no-credential@example.com');

    const response = await login('no-credential@example.com', 'AnyPass123');

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');
  });

  it('rejects a login body missing the password', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'login@example.com' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an invalid email format', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await login('not-an-email', 'CorrectPass123');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('session token security', () => {
  it('stores only the token hash, never the raw token', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await provisionUser('token-hash@example.com', {
      password: 'TokenHash123',
    });
    const response = await login('token-hash@example.com', 'TokenHash123');
    const rawToken = response.body.data.sessionToken as string;

    const row = await getSessionRow(user.id);
    assert.ok(row);
    assert.notEqual(row.token_hash, rawToken);
    assert.equal(row.token_hash, hashSessionToken(rawToken));
  });

  it('returns a distinct token for each login', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await provisionUser('distinct@example.com', { password: 'Distinct123' });

    const first = await login('distinct@example.com', 'Distinct123');
    const second = await login('distinct@example.com', 'Distinct123');

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(first.body.data.sessionToken, second.body.data.sessionToken);
  });

  it('never returns the token hash in the login response', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await provisionUser('no-hash@example.com', { password: 'NoHash123' });

    const response = await login('no-hash@example.com', 'NoHash123');

    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(response.body), /token_hash|tokenHash/);
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns safe identity for a valid session', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await provisionUser('me@example.com', { password: 'MePass123' });
    const loginResponse = await login('me@example.com', 'MePass123');
    const token = loginResponse.body.data.sessionToken as string;

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.user.email, 'me@example.com');
    assert.deepEqual(Object.keys(response.body.data.user).sort(), PUBLIC_USER_KEYS);
    assert.deepEqual(Object.keys(response.body.data).sort(), [
      'access',
      'context',
      'entitlements',
      'scope',
      'user',
    ]);
    assert.deepEqual(response.body.data.access.roles, []);
    assert.deepEqual(response.body.data.access.permissions, []);
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /"password|"passwordHash|"tokenHash|"sessionToken|"credential/i,
    );
  });

  it('returns 401 AUTHENTICATION_REQUIRED without an Authorization header', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get('/api/v1/auth/me');

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });

  it('returns 401 AUTHENTICATION_REQUIRED for a non-Bearer header', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', 'Basic dXNlcjpwYXNz');

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });

  it('returns 401 INVALID_SESSION for an unknown token', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${generateSessionToken(32)}`);

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'INVALID_SESSION');
    assert.doesNotMatch(JSON.stringify(response.body), /token/i);
  });

  it('returns 401 SESSION_EXPIRED for an expired session', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await provisionUser('expired@example.com', {
      password: 'Expired123',
    });
    const rawToken = generateSessionToken(32);
    await sessionRepository.createSession({
      userId: user.id,
      tokenHash: hashSessionToken(rawToken),
      expiresAt: new Date(Date.now() - 60_000),
    });

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${rawToken}`);

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'SESSION_EXPIRED');
  });

  it('returns 401 for a revoked session', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await provisionUser('revoked@example.com', { password: 'Revoked123' });
    const loginResponse = await login('revoked@example.com', 'Revoked123');
    const token = loginResponse.body.data.sessionToken as string;

    await api()
      .post('/api/v1/auth/logout')
      .set('authorization', `Bearer ${token}`);

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'INVALID_SESSION');
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revokes the session and invalidates the token', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await provisionUser('logout@example.com', {
      password: 'Logout123',
    });
    const loginResponse = await login('logout@example.com', 'Logout123');
    const token = loginResponse.body.data.sessionToken as string;

    const logoutResponse = await api()
      .post('/api/v1/auth/logout')
      .set('authorization', `Bearer ${token}`);

    assert.equal(logoutResponse.status, 200);
    assert.equal(logoutResponse.body.data.revoked, true);

    const row = await getSessionRow(user.id);
    assert.ok(row);
    assert.equal(row.status, 'REVOKED');
    assert.ok(row.revoked_at);

    const meResponse = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`);

    assert.equal(meResponse.status, 401);
  });

  it('returns 401 when logging out without a session', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().post('/api/v1/auth/logout');

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
});

describe('secret leakage', () => {
  it('does not log passwords, raw tokens, or Authorization headers', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await provisionUser('no-leak@example.com', { password: 'LeakPass123' });
    const loginResponse = await login('no-leak@example.com', 'LeakPass123');
    const token = loginResponse.body.data.sessionToken as string;
    const wrongPassword = 'NotLeakedPass123';

    const originalWrite = process.stderr.write.bind(process.stderr);
    const originalLogLevel = process.env.LOG_LEVEL;
    let captured = '';

    process.env.LOG_LEVEL = 'info';
    resetAppConfigCache();
    process.stderr.write = ((chunk: unknown) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await login('no-leak@example.com', wrongPassword);
      await api().get('/api/v1/auth/me').set('authorization', `Bearer ${token}`);

      assert.doesNotMatch(captured, /LeakPass123/);
      assert.doesNotMatch(captured, /NotLeakedPass123/);
      assert.doesNotMatch(captured, new RegExp(token));
      assert.doesNotMatch(captured, /authorization/i);
    } finally {
      process.stderr.write = originalWrite;
      process.env.LOG_LEVEL = originalLogLevel;
      resetAppConfigCache();
    }
  });
});
