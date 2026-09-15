import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  credentialRepository,
  hashSessionToken,
  passwordService,
} from '../src/modules/auth';
import { hashInvitationToken } from '../src/modules/invitations';
import { userService } from '../src/modules/users';
import { createAdminSession, createPlainSession } from './helpers/access';
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
  await pool.query('TRUNCATE users, roles, permissions CASCADE');
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

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${adminToken}` };
}

async function createInvitation(email: string) {
  return api().post('/api/v1/invitations').set(adminHeaders()).send({ email });
}

async function getInvitationRow(id: string) {
  const result = await pool!.query<{ token_hash: string; status: string }>(
    `SELECT token_hash, status FROM user_invitations WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

describe('POST /api/v1/invitations', () => {
  it('creates a PENDING invitation with a hashed token and expiry', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `invite-${randomUUID()}@example.com`;
    const response = await createInvitation(email);

    assert.equal(response.status, 201);
    assert.equal(response.body.data.email, email);
    assert.equal(response.body.data.status, 'PENDING');
    assert.ok(Date.parse(response.body.data.expiresAt) > Date.now());

    const rawToken = response.body.data.invitationToken as string;
    assert.ok(rawToken && rawToken.length > 20);

    const row = await getInvitationRow(response.body.data.id);
    assert.ok(row);
    assert.equal(row.status, 'PENDING');
    assert.notEqual(row.token_hash, rawToken);
    assert.equal(row.token_hash, hashInvitationToken(rawToken));
  });

  it('returns 401 without authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/invitations')
      .send({ email: 'nobody@example.com' });

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });

  it('returns 403 for an authenticated user without user.manage', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const response = await api()
      .post('/api/v1/invitations')
      .set('authorization', `Bearer ${plainToken}`)
      .send({ email: 'plain@example.com' });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('rejects a duplicate pending invitation for the same email', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `dup-invite-${randomUUID()}@example.com`;
    const first = await createInvitation(email);
    assert.equal(first.status, 201);

    const second = await createInvitation(email.toUpperCase());
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'INVITATION_ALREADY_PENDING');
  });

  it('rejects an invitation for an existing ACTIVE user email', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `existing-${randomUUID()}@example.com`;
    await userService.createUser({ email, displayName: 'Existing' });

    const response = await createInvitation(email);

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'USER_EMAIL_ALREADY_EXISTS');
  });

  it('rejects an invalid email', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createInvitation('not-an-email');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('POST /api/v1/invitations/accept', () => {
  it('accepts a valid invitation creating ACTIVE user + credential', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `accept-${randomUUID()}@example.com`;
    const password = 'AcceptPass123';
    const created = await createInvitation(email);
    const rawToken = created.body.data.invitationToken as string;
    const invitationId = created.body.data.id as string;

    const response = await api().post('/api/v1/invitations/accept').send({
      token: rawToken,
      displayName: 'Accepted User',
      password,
    });

    assert.equal(response.status, 200);
    const user = response.body.data.user;
    assert.equal(user.email, email);
    assert.equal(user.displayName, 'Accepted User');
    assert.equal(user.status, 'ACTIVE');

    const row = await getInvitationRow(invitationId);
    assert.equal(row?.status, 'ACCEPTED');

    const credential = await credentialRepository.findByUserId(user.id);
    assert.ok(credential, 'credential should exist');
    assert.notEqual(credential.passwordHash, password);
    assert.equal(await passwordService.verifyPassword(password, credential.passwordHash), true);
  });

  it('rejects token reuse (single-use)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `reuse-${randomUUID()}@example.com`;
    const created = await createInvitation(email);
    const rawToken = created.body.data.invitationToken as string;

    const first = await api().post('/api/v1/invitations/accept').send({
      token: rawToken,
      displayName: 'First',
      password: 'ReusePass123',
    });
    assert.equal(first.status, 200);

    const second = await api().post('/api/v1/invitations/accept').send({
      token: rawToken,
      displayName: 'Second',
      password: 'ReusePass123',
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'INVITATION_ALREADY_ACCEPTED');
  });

  it('rejects an unknown token with a generic error', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().post('/api/v1/invitations/accept').send({
      token: 'totally-unknown-token',
      displayName: 'Nobody',
      password: 'UnknownPass123',
    });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'INVALID_INVITATION_TOKEN');
    assert.doesNotMatch(JSON.stringify(response.body), /email|hash/i);
  });

  it('rejects an expired token without partial state', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `expired-${randomUUID()}@example.com`;
    const created = await createInvitation(email);
    const rawToken = created.body.data.invitationToken as string;

    await pool!.query(
      `UPDATE user_invitations SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [created.body.data.id],
    );

    const response = await api().post('/api/v1/invitations/accept').send({
      token: rawToken,
      displayName: 'Expired',
      password: 'ExpiredPass123',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVITATION_EXPIRED');

    const row = await getInvitationRow(created.body.data.id);
    assert.equal(row?.status, 'PENDING');
  });

  it('rejects a revoked token', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `revoked-${randomUUID()}@example.com`;
    const created = await createInvitation(email);
    const rawToken = created.body.data.invitationToken as string;

    const revoke = await api()
      .post(`/api/v1/invitations/${created.body.data.id}/revoke`)
      .set(adminHeaders());
    assert.equal(revoke.status, 200);

    const response = await api().post('/api/v1/invitations/accept').send({
      token: rawToken,
      displayName: 'Revoked',
      password: 'RevokedPass123',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVITATION_REVOKED');
  });

  it('rejects an invalid password with no partial state', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `weakpass-${randomUUID()}@example.com`;
    const created = await createInvitation(email);
    const rawToken = created.body.data.invitationToken as string;

    const response = await api().post('/api/v1/invitations/accept').send({
      token: rawToken,
      displayName: 'Weak',
      password: 'short',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PASSWORD_POLICY_VIOLATION');

    const row = await getInvitationRow(created.body.data.id);
    assert.equal(row?.status, 'PENDING');
  });

  it('rolls back cleanly when acceptance conflicts with an existing user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `conflict-${randomUUID()}@example.com`;
    const created = await createInvitation(email);
    const rawToken = created.body.data.invitationToken as string;

    // Simulate a concurrent identity creation for the same email.
    const existing = await pool!.query<{ id: string }>(
      `INSERT INTO users (id, email, display_name, status)
       VALUES ($1, $2, $3, 'ACTIVE')
       RETURNING id`,
      [randomUUID(), email, 'Conflicting User'],
    );

    const response = await api().post('/api/v1/invitations/accept').send({
      token: rawToken,
      displayName: 'Conflict',
      password: 'ConflictPass123',
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'USER_EMAIL_ALREADY_EXISTS');

    // No partial state: invitation still PENDING, no credential for the user.
    const row = await getInvitationRow(created.body.data.id);
    assert.equal(row?.status, 'PENDING');
    const credential = await credentialRepository.findByUserId(existing.rows[0].id);
    assert.equal(credential, null);
  });
});

describe('invitation revocation', () => {
  it('revokes a PENDING invitation (token becomes unusable)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `revoke-me-${randomUUID()}@example.com`;
    const created = await createInvitation(email);

    const response = await api()
      .post(`/api/v1/invitations/${created.body.data.id}/revoke`)
      .set(adminHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'REVOKED');

    const row = await getInvitationRow(created.body.data.id);
    assert.equal(row?.status, 'REVOKED');
  });

  it('returns 404 for an unknown invitation id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post(`/api/v1/invitations/${randomUUID()}/revoke`)
      .set(adminHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'INVITATION_NOT_FOUND');
  });

  it('requires user.manage to revoke', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const response = await api()
      .post(`/api/v1/invitations/${randomUUID()}/revoke`)
      .set('authorization', `Bearer ${plainToken}`);

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });
});

describe('account lifecycle', () => {
  async function provisionUser() {
    const email = `lifecycle-${randomUUID()}@example.com`;
    const password = 'LifecyclePass123';
    const user = await userService.createUser({ email, displayName: 'Lifecycle' });
    await credentialRepository.createForUser({
      userId: user.id,
      passwordHash: await passwordService.hashPassword(password),
      mustChangePassword: false,
    });
    return { user, email, password };
  }

  async function login(email: string, password: string) {
    return api().post('/api/v1/auth/login').send({ email, password });
  }

  it('deactivation: new login denied and existing session denied', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { user, email, password } = await provisionUser();
    const session = await login(email, password);
    const token = session.body.data.sessionToken as string;

    const before = await api().get('/api/v1/auth/me').set('authorization', `Bearer ${token}`);
    assert.equal(before.status, 200);

    const deactivate = await api()
      .post(`/api/v1/users/${user.id}/deactivate`)
      .set(adminHeaders());
    assert.equal(deactivate.status, 200);
    assert.equal(deactivate.body.data.status, 'INACTIVE');

    const loginAfter = await login(email, password);
    assert.equal(loginAfter.status, 401);

    const sessionAfter = await api().get('/api/v1/auth/me').set('authorization', `Bearer ${token}`);
    assert.equal(sessionAfter.status, 401);
  });

  it('suspension: new login denied and existing session denied', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { user, email, password } = await provisionUser();
    const session = await login(email, password);
    const token = session.body.data.sessionToken as string;

    const suspend = await api()
      .post(`/api/v1/users/${user.id}/suspend`)
      .set(adminHeaders());
    assert.equal(suspend.status, 200);
    assert.equal(suspend.body.data.status, 'SUSPENDED');

    const loginAfter = await login(email, password);
    assert.equal(loginAfter.status, 401);

    const sessionAfter = await api().get('/api/v1/auth/me').set('authorization', `Bearer ${token}`);
    assert.equal(sessionAfter.status, 401);
  });

  it('reactivation: INACTIVE → ACTIVE restores login without restoring old sessions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { user, email, password } = await provisionUser();
    const session = await login(email, password);
    const oldToken = session.body.data.sessionToken as string;

    await api().post(`/api/v1/users/${user.id}/deactivate`).set(adminHeaders());

    const reactivate = await api()
      .post(`/api/v1/users/${user.id}/reactivate`)
      .set(adminHeaders());
    assert.equal(reactivate.status, 200);
    assert.equal(reactivate.body.data.status, 'ACTIVE');

    const loginAfter = await login(email, password);
    assert.equal(loginAfter.status, 200);

    // Old session was revoked and must not work.
    const oldSession = await api().get('/api/v1/auth/me').set('authorization', `Bearer ${oldToken}`);
    assert.equal(oldSession.status, 401);
  });

  it('rejects an invalid transition with INVALID_ACCOUNT_STATE', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { user } = await provisionUser();

    // Already ACTIVE → reactivate is invalid (only INACTIVE → ACTIVE).
    const response = await api()
      .post(`/api/v1/users/${user.id}/reactivate`)
      .set(adminHeaders());

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_ACCOUNT_STATE');
  });

  it('rejects lifecycle changes without user.manage', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const response = await api()
      .post(`/api/v1/users/${randomUUID()}/deactivate`)
      .set('authorization', `Bearer ${plainToken}`);

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });
});

describe('invitation token storage safety', () => {
  it('never stores the raw invitation token', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `rawstore-${randomUUID()}@example.com`;
    const created = await createInvitation(email);
    const rawToken = created.body.data.invitationToken as string;

    const row = await getInvitationRow(created.body.data.id);
    assert.ok(row);
    assert.notEqual(row.token_hash, rawToken);
    assert.equal(hashSessionToken(rawToken), row.token_hash);
  });
});
