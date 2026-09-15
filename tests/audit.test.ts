import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
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

type AuditRow = {
  event_type: string;
  outcome: string;
  user_id: string | null;
  actor_user_id: string | null;
  session_id: string | null;
  metadata: Record<string, unknown>;
};

async function latestAuditEvents(eventType?: string): Promise<AuditRow[]> {
  const where = eventType ? `WHERE event_type = $1` : '';
  const result = await pool!.query<AuditRow>(
    `SELECT event_type, outcome, user_id, actor_user_id, session_id, metadata
     FROM authentication_audit_events
     ${where}
     ORDER BY created_at DESC, id DESC`,
    eventType ? [eventType] : [],
  );
  return result.rows;
}

const SECRET_PATTERN =
  /\$2[aby]\$|[0-9a-f]{64}|sessionToken|invitationToken|password_hash|passwordHash|Authorization/i;

describe('login audit', () => {
  it('persists LOGIN_SUCCESS for a valid login', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `audit-login-${randomUUID()}@example.com`;
    const password = 'AuditLogin123';
    const user = await userService.createUser({ email, displayName: 'Audit Login' });
    await credentialService.createInitialCredential({ userId: user.id, password });

    const response = await api().post('/api/v1/auth/login').send({ email, password });
    assert.equal(response.status, 200);

    const events = await latestAuditEvents('LOGIN_SUCCESS');
    const event = events.find((e) => e.user_id === user.id);
    assert.ok(event, 'LOGIN_SUCCESS should be persisted');
    assert.equal(event.outcome, 'SUCCESS');
    assert.ok(event.session_id, 'session id should be correlated');
    assert.doesNotMatch(JSON.stringify(event), SECRET_PATTERN);
  });

  it('persists LOGIN_FAILED with a generic reason for invalid credentials', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'unknown-audit@example.com', password: 'WrongPass123' });

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');

    const events = await latestAuditEvents('LOGIN_FAILED');
    const event = events.find((e) => e.user_id === null);
    assert.ok(event, 'LOGIN_FAILED should be persisted');
    assert.equal(event.outcome, 'FAILURE');
    assert.equal(event.metadata.reason, 'INVALID_CREDENTIALS');
    assert.doesNotMatch(JSON.stringify(event), SECRET_PATTERN);
  });

  it('does not leak account-specific detail in the public failure response', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'unknown-audit@example.com', password: 'WrongPass123' });

    assert.equal(response.status, 401);
    assert.doesNotMatch(JSON.stringify(response.body), /not found|unknown email/i);
  });
});

describe('logout audit', () => {
  it('persists LOGOUT without the raw session token', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `audit-logout-${randomUUID()}@example.com`;
    const password = 'AuditLogout123';
    const user = await userService.createUser({ email, displayName: 'Audit Logout' });
    await credentialService.createInitialCredential({ userId: user.id, password });

    const login = await api().post('/api/v1/auth/login').send({ email, password });
    const token = login.body.data.sessionToken as string;

    const logout = await api()
      .post('/api/v1/auth/logout')
      .set('authorization', `Bearer ${token}`);
    assert.equal(logout.status, 200);

    const events = await latestAuditEvents('LOGOUT');
    const event = events.find((e) => e.user_id === user.id);
    assert.ok(event, 'LOGOUT should be persisted');
    assert.equal(event.outcome, 'SUCCESS');
    assert.doesNotMatch(JSON.stringify(event), SECRET_PATTERN);
    assert.ok(!JSON.stringify(event).includes(token), 'raw session token must not be stored');
  });
});

describe('invitation audit', () => {
  it('persists INVITATION_CREATED and INVITATION_REVOKED', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `audit-invite-${randomUUID()}@example.com`;
    const created = await api()
      .post('/api/v1/invitations')
      .set(adminHeaders())
      .send({ email });
    assert.equal(created.status, 201);

    const invitationId = created.body.data.id as string;

    await api()
      .post(`/api/v1/invitations/${invitationId}/revoke`)
      .set(adminHeaders());

    const createdEvents = await latestAuditEvents('INVITATION_CREATED');
    assert.ok(createdEvents.some((e) => e.metadata.invitationId === invitationId));

    const revokedEvents = await latestAuditEvents('INVITATION_REVOKED');
    assert.ok(revokedEvents.some((e) => e.metadata.invitationId === invitationId));

    for (const e of [...createdEvents, ...revokedEvents]) {
      assert.doesNotMatch(JSON.stringify(e), SECRET_PATTERN);
    }
  });

  it('persists INVITATION_ACCEPTED without token material', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `audit-accept-${randomUUID()}@example.com`;
    const created = await api()
      .post('/api/v1/invitations')
      .set(adminHeaders())
      .send({ email });
    const rawToken = created.body.data.invitationToken as string;
    const invitationId = created.body.data.id as string;

    const accept = await api().post('/api/v1/invitations/accept').send({
      token: rawToken,
      displayName: 'Audit Accepted',
      password: 'AuditAccept123',
    });
    assert.equal(accept.status, 200);

    const events = await latestAuditEvents('INVITATION_ACCEPTED');
    const event = events.find((e) => e.metadata.invitationId === invitationId);
    assert.ok(event, 'INVITATION_ACCEPTED should be persisted');
    assert.equal(event.outcome, 'SUCCESS');
    assert.ok(event.user_id, 'accepted user id should be captured');
    assert.doesNotMatch(JSON.stringify(event), SECRET_PATTERN);
    assert.ok(!JSON.stringify(event).includes(rawToken), 'raw invitation token must not be stored');
  });
});

describe('account lifecycle audit', () => {
  it('persists ACCOUNT_DEACTIVATED, ACCOUNT_REACTIVATED, ACCOUNT_SUSPENDED', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `audit-lifecycle-${randomUUID()}@example.com`;
    const password = 'AuditLifecycle123';
    const user = await userService.createUser({ email, displayName: 'Audit Lifecycle' });
    await credentialService.createInitialCredential({ userId: user.id, password });

    await api().post(`/api/v1/users/${user.id}/deactivate`).set(adminHeaders());
    await api().post(`/api/v1/users/${user.id}/reactivate`).set(adminHeaders());
    await api().post(`/api/v1/users/${user.id}/suspend`).set(adminHeaders());

    const deactivated = await latestAuditEvents('ACCOUNT_DEACTIVATED');
    assert.ok(deactivated.some((e) => e.user_id === user.id));
    assert.ok(deactivated.some((e) => e.actor_user_id !== null));

    const reactivated = await latestAuditEvents('ACCOUNT_REACTIVATED');
    assert.ok(reactivated.some((e) => e.user_id === user.id));

    const suspended = await latestAuditEvents('ACCOUNT_SUSPENDED');
    assert.ok(suspended.some((e) => e.user_id === user.id));
  });
});

describe('audit read API', () => {
  it('returns 401 without authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get('/api/v1/auth/audit-events');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });

  it('returns 403 for an authenticated user without auth.audit.read', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const response = await api()
      .get('/api/v1/auth/audit-events')
      .set('authorization', `Bearer ${plainToken}`);

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('returns 200 with audit events for an authorized user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/auth/audit-events')
      .set(adminHeaders());

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
    assert.equal(typeof response.body.meta.total, 'number');
    assert.ok(response.body.meta.total > 0);
    assert.doesNotMatch(JSON.stringify(response.body), SECRET_PATTERN);
  });

  it('supports filtering by eventType', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/auth/audit-events?eventType=LOGIN_SUCCESS')
      .set(adminHeaders());

    assert.equal(response.status, 200);
    for (const event of response.body.data) {
      assert.equal(event.eventType, 'LOGIN_SUCCESS');
    }
  });

  it('rejects an invalid eventType filter', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/auth/audit-events?eventType=NONSENSE')
      .set(adminHeaders());

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('has no update or delete endpoints (append-only)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const put = await api()
      .put('/api/v1/auth/audit-events')
      .set(adminHeaders())
      .send({});
    assert.equal(put.status, 404);

    const del = await api()
      .delete('/api/v1/auth/audit-events')
      .set(adminHeaders());
    assert.equal(del.status, 404);
  });
});

describe('secret leakage across audit data', () => {
  it('contains no secrets in persisted events', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const rows = await pool!.query<{ payload: string }>(
      `SELECT row_to_json(t)::text AS payload FROM authentication_audit_events t`,
    );

    for (const row of rows.rows) {
      assert.doesNotMatch(row.payload, SECRET_PATTERN);
    }
  });
});
