import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { parseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  credentialService,
  generateSessionToken,
  hashSessionToken,
  sessionRepository,
} from '../src/modules/auth';
import { userService } from '../src/modules/users';
import { ERROR_CODES } from '../src/shared/errors';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-MOB-CONTRACT-01 PART 01 — Authentication & Session Contract.
 *
 * Two layers:
 *  1. OpenAPI contract inspection (no database): the spec must publish the
 *     login/me/logout request+response schemas, the auth error responses
 *     (validation / invalid-credentials / unauthorized-session / rate-limit),
 *     and the bearer security requirements — so mobile can codegen/validate
 *     against a frozen contract.
 *  2. Runtime contract assertions (embedded PostgreSQL): the deterministic
 *     400/401 behavior, login/logout response shapes, and session
 *     expiry/revocation semantics that the contract documents.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

// --------------------------------------------------------------------------
// Embedded PostgreSQL bootstrap (ASENTRA_USE_EMBEDDED_POSTGRES=true), with a
// graceful fallback to a local asentra_test database when present.
// --------------------------------------------------------------------------
const DB_PORT = 55447;
const DATA_DIR = '/tmp/asentra-mob-auth-pg';
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
  await pool.query(
    `TRUNCATE user_sessions, user_credentials, users CASCADE`,
  );
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

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

// --------------------------------------------------------------------------
// Shared spec loader + helpers
// --------------------------------------------------------------------------
function loadSpec(): Record<string, any> {
  const doc = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;
  assert.ok(doc && typeof doc === 'object', 'openapi.yaml must parse as YAML');
  return doc;
}

function pathOperation(
  spec: Record<string, any>,
  path: string,
  method: string,
): Record<string, any> {
  return spec.paths?.[path]?.[method];
}

async function login(email: string, password: string) {
  return api().post(`${API_PREFIX}/auth/login`).send({ email, password });
}

async function provisionUser(
  email: string,
  password: string,
): Promise<{ userId: string; email: string }> {
  const user = await userService.createUser({
    email,
    displayName: 'Auth Contract Tester',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  return { userId: user.id, email: user.email };
}

async function createExpiredSessionToken(userId: string): Promise<string> {
  const rawToken = generateSessionToken(32);
  await sessionRepository.createSession({
    userId,
    tokenHash: hashSessionToken(rawToken),
    expiresAt: new Date(Date.now() - 60_000),
  });
  return rawToken;
}

// --------------------------------------------------------------------------
// Layer 1 — OpenAPI contract (no database)
// --------------------------------------------------------------------------
describe('CR-BE-MOB-CONTRACT-01 PART 01 — auth/session OpenAPI contract', () => {
  const spec = loadSpec();

  it('publishes login, me and logout paths with bearer security', () => {
    const loginOp = pathOperation(spec, '/auth/login', 'post');
    const meOp = pathOperation(spec, '/auth/me', 'get');
    const logoutOp = pathOperation(spec, '/auth/logout', 'post');

    assert.ok(loginOp, 'POST /auth/login must be documented');
    assert.ok(meOp, 'GET /auth/me must be documented');
    assert.ok(logoutOp, 'POST /auth/logout must be documented');

    // Login is public (no per-operation security requirement).
    assert.ok(
      !loginOp.security || loginOp.security.length === 0,
      'login must not require authentication',
    );
    // me/logout require the bearer session.
    for (const op of [meOp, logoutOp]) {
      assert.ok(
        Array.isArray(op.security) &&
          op.security.some((s: Record<string, unknown>) => 'bearerAuth' in s),
        'protected auth endpoint must declare bearerAuth security',
      );
    }
  });

  it('defines the login request schema (email + password, required)', () => {
    const schema = spec.components.schemas.LoginRequest;
    assert.ok(schema, 'LoginRequest schema required');
    assert.deepEqual(
      [...schema.required].sort(),
      ['email', 'password'],
      'LoginRequest must require email and password',
    );
    assert.equal(schema.properties.email.format, 'email');
    assert.equal(schema.properties.password.format, 'password');
  });

  it('defines the login/logout response schemas with required fields', () => {
    const loginResponse = spec.components.schemas.LoginResponse;
    assert.ok(loginResponse, 'LoginResponse schema required');
    assert.deepEqual(
      [...loginResponse.required].sort(),
      ['expiresAt', 'sessionToken', 'user'],
    );
    assert.equal(loginResponse.properties.sessionToken.type, 'string');
    assert.equal(loginResponse.properties.expiresAt.format, 'date-time');

    const logoutResponse = spec.components.schemas.LogoutResponse;
    assert.ok(logoutResponse, 'LogoutResponse schema required');
    assert.deepEqual([...logoutResponse.required], ['revoked']);
    assert.equal(logoutResponse.properties.revoked.const, true);
  });

  it('defines the public user and status schemas', () => {
    const publicUser = spec.components.schemas.PublicUser;
    assert.ok(publicUser, 'PublicUser schema required');
    assert.deepEqual(
      [...publicUser.required].sort(),
      ['createdAt', 'displayName', 'email', 'id', 'status', 'updatedAt'],
    );
    assert.equal(
      spec.components.schemas.UserStatus.enum.join(','),
      'INVITED,ACTIVE,INACTIVE,SUSPENDED',
    );
  });

  it('publishes the deterministic auth error responses', () => {
    const responses = spec.components.responses ?? {};
    for (const name of [
      'BadRequest',
      'InvalidCredentials',
      'Unauthorized',
      'RateLimited',
    ]) {
      assert.ok(responses[name], `reusable response ${name} required`);
    }

    // Login's 401 must be the enumeration-safe INVALID_CREDENTIALS, not the
    // generic session Unauthorized response.
    const loginOp = pathOperation(spec, '/auth/login', 'post');
    assert.match(
      loginOp.responses['401'].$ref,
      /InvalidCredentials$/,
      'login 401 must reference InvalidCredentials',
    );
    assert.match(loginOp.responses['400'].$ref, /BadRequest$/);
    assert.match(loginOp.responses['429'].$ref, /RateLimited$/);
  });

  it('documents the session-expiry 401 behavior on protected endpoints', () => {
    const meOp = pathOperation(spec, '/auth/me', 'get');
    assert.match(meOp.responses['401'].$ref, /Unauthorized$/);
    const unauthorized = spec.components.responses.Unauthorized;
    const examples = Object.keys(unauthorized.content['application/json'].examples);
    assert.deepEqual(
      examples.sort(),
      ['invalidSession', 'missingSession', 'sessionExpired'],
      'Unauthorized must show AUTHENTICATION_REQUIRED / INVALID_SESSION / SESSION_EXPIRED',
    );
  });

  it('keeps the auth error codes authoritative in ERROR_CODES', () => {
    for (const code of [
      'INVALID_CREDENTIALS',
      'AUTHENTICATION_REQUIRED',
      'INVALID_SESSION',
      'SESSION_EXPIRED',
      'AUTH_RATE_LIMITED',
      'VALIDATION_ERROR',
    ] as const) {
      assert.equal(
        ERROR_CODES[code],
        code,
        `ERROR_CODES.${code} must equal its literal`,
      );
    }
  });
});

// --------------------------------------------------------------------------
// Layer 2 — runtime contract (embedded PostgreSQL)
// --------------------------------------------------------------------------
describe('CR-BE-MOB-CONTRACT-01 PART 01 — auth/session runtime contract', () => {
  it('login returns the opaque session token + expiry + public user', async (t) => {
    if (!requireDatabase(t)) return;
    const email = `login-${randomUUID().slice(0, 8)}@example.com`;
    await provisionUser(email, 'CorrectPass123');

    const response = await login(email, 'CorrectPass123');

    assert.equal(response.status, 200);
    const data = response.body.data;
    assert.deepEqual(Object.keys(data).sort(), ['expiresAt', 'sessionToken', 'user']);
    assert.ok(typeof data.sessionToken === 'string' && data.sessionToken.length > 0);
    assert.ok(Date.parse(data.expiresAt) > Date.now());
    // CR-BE-NOTIFY-PROV-01 PART 06 adds the WhatsApp contact + consent
    // fields to the safe user representation.
    assert.deepEqual(Object.keys(data.user).sort(), [
      'createdAt',
      'displayName',
      'email',
      'id',
      'status',
      'updatedAt',
      'whatsappOptedInAt',
      'whatsappOptedOutAt',
      'whatsappPhone',
    ]);
  });

  it('rejects an invalid login body with 400 VALIDATION_ERROR + details', async (t) => {
    if (!requireDatabase(t)) return;
    const response = await api().post(`${API_PREFIX}/auth/login`).send({ email: 'not-an-email' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(response.body.error.details));
    assert.ok(
      response.body.error.details.some((d: any) => d.field === 'password'),
      'password field detail expected',
    );
    assert.ok(
      response.body.error.details.some((d: any) => d.field === 'email'),
      'email field detail expected',
    );
    assert.equal(response.body.error.category, 'VALIDATION');
    assert.equal(response.body.error.retryable, false);
  });

  it('returns a generic 401 INVALID_CREDENTIALS for a wrong password', async (t) => {
    if (!requireDatabase(t)) return;
    const email = `wrong-${randomUUID().slice(0, 8)}@example.com`;
    await provisionUser(email, 'CorrectPass123');

    const response = await login(email, 'WrongPass1234');

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');
    assert.equal(response.body.error.category, 'UNAUTHORIZED');
    assert.equal(response.body.error.retryable, false);
    assert.ok(typeof response.body.error.requestId === 'string');
  });

  it('requires a bearer token (401 AUTHENTICATION_REQUIRED)', async (t) => {
    if (!requireDatabase(t)) return;
    const response = await api().get(`${API_PREFIX}/auth/me`);
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });

  it('rejects an unknown token with 401 INVALID_SESSION', async (t) => {
    if (!requireDatabase(t)) return;
    const response = await api()
      .get(`${API_PREFIX}/auth/me`)
      .set('Authorization', `Bearer ${generateSessionToken(32)}`);
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'INVALID_SESSION');
  });

  it('rejects an expired session with 401 SESSION_EXPIRED', async (t) => {
    if (!requireDatabase(t)) return;
    const { userId } = await provisionUser(
      `expired-${randomUUID().slice(0, 8)}@example.com`,
      'ExpiredPass123',
    );
    const token = await createExpiredSessionToken(userId);

    const response = await api()
      .get(`${API_PREFIX}/auth/me`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'SESSION_EXPIRED');
  });

  it('/auth/me returns the effective context for a valid session', async (t) => {
    if (!requireDatabase(t)) return;
    const email = `me-${randomUUID().slice(0, 8)}@example.com`;
    await provisionUser(email, 'MePass123');
    const loginResponse = await login(email, 'MePass123');
    const token = loginResponse.body.data.sessionToken as string;

    const me = await api()
      .get(`${API_PREFIX}/auth/me`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(me.status, 200);
    assert.deepEqual(Object.keys(me.body.data).sort(), [
      'access',
      'context',
      'entitlements',
      'scope',
      'user',
    ]);
    assert.deepEqual(Object.keys(me.body.data.access).sort(), ['permissions', 'roles']);
    assert.deepEqual(Object.keys(me.body.data.scope).sort(), ['buildingIds', 'clientIds']);
  });

  it('logout revokes the session (200 {revoked:true}); reuse → 401', async (t) => {
    if (!requireDatabase(t)) return;
    const email = `logout-${randomUUID().slice(0, 8)}@example.com`;
    await provisionUser(email, 'LogoutPass123');
    const token = (await login(email, 'LogoutPass123')).body.data.sessionToken as string;

    const logout = await api()
      .post(`${API_PREFIX}/auth/logout`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    assert.equal(logout.status, 200);
    assert.deepEqual(logout.body.data, { revoked: true });

    const reuse = await api()
      .get(`${API_PREFIX}/auth/me`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(reuse.status, 401);
    assert.equal(reuse.body.error.code, 'INVALID_SESSION');
  });
});
