import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { toPublicUser } from '../src/modules/users/user.mapper';
import { normalizeEmail } from '../src/modules/users/user.service';
import { isValidUuid } from '../src/modules/users/user.validation';
import { createAdminSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE users CASCADE');
  adminToken = await createAdminSession();
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

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${adminToken}` };
}

describe('email normalization', () => {
  it('trims and lowercases email consistently', () => {
    assert.equal(
      normalizeEmail('  Alice.Example@Example.COM  '),
      'alice.example@example.com',
    );
  });
});

describe('UUID validation', () => {
  it('accepts UUIDs and rejects malformed ids', () => {
    assert.equal(isValidUuid('123e4567-e89b-12d3-a456-426614174000'), true);
    assert.equal(isValidUuid('not-a-uuid'), false);
    assert.equal(isValidUuid('123e4567'), false);
  });
});

describe('toPublicUser', () => {
  it('exposes only public identity fields', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const updatedAt = new Date('2026-01-01T00:00:00.000Z');

    const publicUser = toPublicUser({
      id: '123e4567-e89b-12d3-a456-426614174000',
      email: 'alice@example.com',
      displayName: 'Alice Example',
      status: 'ACTIVE',
      whatsappPhone: null,
      whatsappOptedInAt: null,
      whatsappOptedOutAt: null,
      createdAt,
      updatedAt,
    });

    // CR-BE-NOTIFY-PROV-01 PART 06 adds the WhatsApp contact + consent
    // fields to the safe representation.
    assert.deepEqual(Object.keys(publicUser).sort(), [
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
    assert.equal(publicUser.createdAt, createdAt.toISOString());
  });
});

describe('POST /api/v1/users', () => {
  it('creates a user and returns 201 with the safe representation', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/users')
      .set(authHeaders())
      .send({
        email: 'alice@example.com',
        displayName: 'Alice Example',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.email, 'alice@example.com');
    assert.equal(response.body.data.displayName, 'Alice Example');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.ok(response.body.data.id);
    assert.ok(response.body.data.createdAt);
    assert.ok(response.body.data.updatedAt);
  });

  it('stores a consistently normalized email', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/users')
      .set(authHeaders())
      .send({
        email: '  ALICE.Example@Example.COM  ',
        displayName: 'Alice Example',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.email, 'alice.example@example.com');
  });

  it('rejects a duplicate email with 409 USER_EMAIL_ALREADY_EXISTS', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await api().post('/api/v1/users').set(authHeaders()).send({
      email: 'dup@example.com',
      displayName: 'First',
    });

    const response = await api()
      .post('/api/v1/users')
      .set(authHeaders())
      .send({
        email: 'DUP@example.com',
        displayName: 'Second',
      });

    assert.equal(response.status, 409);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'USER_EMAIL_ALREADY_EXISTS');
  });

  it('rejects an invalid email with 400 VALIDATION_ERROR', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/users')
      .set(authHeaders())
      .send({
        email: 'not-an-email',
        displayName: 'Alice',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('requires an email', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/users')
      .set(authHeaders())
      .send({
        displayName: 'Alice',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('requires a display name', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/users')
      .set(authHeaders())
      .send({
        email: 'noname@example.com',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an invalid status with 400 VALIDATION_ERROR', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/users')
      .set(authHeaders())
      .send({
        email: 'status@example.com',
        displayName: 'Alice',
        status: 'BANNED',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('never exposes credential or security fields in the output', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/users')
      .set(authHeaders())
      .send({
        email: 'clean@example.com',
        displayName: 'Clean Output',
      });

    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(response.body.data).sort(), [
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
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /password|credential|secret|token|hash|salt/i,
    );
  });
});

describe('GET /api/v1/users/:id', () => {
  it('returns a user by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const created = await api().post('/api/v1/users').set(authHeaders()).send({
      email: 'findme@example.com',
      displayName: 'Find Me',
    });
    const id = created.body.data.id as string;

    const response = await api().get(`/api/v1/users/${id}`).set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, id);
    assert.equal(response.body.data.email, 'findme@example.com');
  });

  it('returns 404 USER_NOT_FOUND for an unknown user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/users/123e4567-e89b-12d3-a456-426614174000')
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'USER_NOT_FOUND');
  });

  it('rejects a malformed UUID with 400 VALIDATION_ERROR', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/users/not-a-uuid')
      .set(authHeaders());

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});
