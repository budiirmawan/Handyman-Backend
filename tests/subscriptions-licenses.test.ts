import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import {
  isSubscriptionEffective,
  normalizePlanCode,
  normalizeSubscriptionCode,
} from '../src/modules/subscriptions';
import type { SubscriptionRecord, SubscriptionStatus } from '../src/modules/subscriptions';
import { isLicenseEffective } from '../src/modules/licenses';
import type { LicenseRecord, LicenseStatus } from '../src/modules/licenses';
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
  await pool.query('TRUNCATE users, roles, clients, subscriptions, licenses CASCADE');
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

function authHeaders(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function createClient(status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const client = await clientService.createClient({
    code: `CLI_${suffix}`,
    name: 'Test Client',
    status,
  });
  return client;
}

const STARTS = '2026-01-01T00:00:00.000Z';
const ENDS = '2027-01-01T00:00:00.000Z';

function makeSubscription(
  overrides: Partial<SubscriptionRecord> & { status: SubscriptionStatus },
): SubscriptionRecord {
  return {
    id: randomUUID(),
    clientId: randomUUID(),
    code: 'ASENTRA-2026-001',
    planCode: 'ENTERPRISE',
    startsAt: new Date(STARTS),
    endsAt: new Date(ENDS),
    createdAt: new Date(STARTS),
    updatedAt: new Date(STARTS),
    ...overrides,
  };
}

function makeLicense(
  overrides: Partial<LicenseRecord> & { status: LicenseStatus },
): LicenseRecord {
  return {
    id: randomUUID(),
    subscriptionId: randomUUID(),
    status: 'ACTIVE',
    validFrom: new Date(STARTS),
    validUntil: new Date(ENDS),
    createdAt: new Date(STARTS),
    updatedAt: new Date(STARTS),
    ...overrides,
  };
}

describe('subscription code/plan normalization', () => {
  it('trims and uppercases subscription codes', () => {
    assert.equal(normalizeSubscriptionCode('  asentra-2026-001 '), 'ASENTRA-2026-001');
    assert.equal(normalizePlanCode('professional'), 'PROFESSIONAL');
  });
});

describe('subscription effective state (deterministic)', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('ACTIVE + inside period → effective', () => {
    const sub = makeSubscription({ status: 'ACTIVE' });
    assert.equal(isSubscriptionEffective(sub, now), true);
  });

  it('PENDING → not effective', () => {
    assert.equal(isSubscriptionEffective(makeSubscription({ status: 'PENDING' }), now), false);
  });

  it('SUSPENDED → not effective', () => {
    assert.equal(isSubscriptionEffective(makeSubscription({ status: 'SUSPENDED' }), now), false);
  });

  it('EXPIRED → not effective', () => {
    assert.equal(isSubscriptionEffective(makeSubscription({ status: 'EXPIRED' }), now), false);
  });

  it('CANCELLED → not effective', () => {
    assert.equal(isSubscriptionEffective(makeSubscription({ status: 'CANCELLED' }), now), false);
  });

  it('ACTIVE + before startsAt → not effective', () => {
    const sub = makeSubscription({ status: 'ACTIVE' });
    assert.equal(isSubscriptionEffective(sub, new Date('2025-12-01T00:00:00.000Z')), false);
  });

  it('ACTIVE + after endsAt → not effective', () => {
    const sub = makeSubscription({ status: 'ACTIVE' });
    assert.equal(isSubscriptionEffective(sub, new Date('2027-02-01T00:00:00.000Z')), false);
  });

  it('ACTIVE + open-ended (endsAt null) → effective', () => {
    const sub = makeSubscription({ status: 'ACTIVE', endsAt: null });
    assert.equal(isSubscriptionEffective(sub, new Date('2030-01-01T00:00:00.000Z')), true);
  });
});

describe('license validity (deterministic, subscription-dependent)', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');
  const validSub = makeSubscription({ status: 'ACTIVE' });

  it('ACTIVE + inside validity + valid subscription → valid', () => {
    const license = makeLicense({ status: 'ACTIVE' });
    assert.equal(isLicenseEffective(validSub, license, now), true);
  });

  it('SUSPENDED license → invalid', () => {
    assert.equal(isLicenseEffective(validSub, makeLicense({ status: 'SUSPENDED' }), now), false);
  });

  it('EXPIRED license → invalid', () => {
    assert.equal(isLicenseEffective(validSub, makeLicense({ status: 'EXPIRED' }), now), false);
  });

  it('REVOKED license → invalid', () => {
    assert.equal(isLicenseEffective(validSub, makeLicense({ status: 'REVOKED' }), now), false);
  });

  it('before validFrom → invalid', () => {
    const license = makeLicense({ status: 'ACTIVE' });
    assert.equal(
      isLicenseEffective(validSub, license, new Date('2025-12-01T00:00:00.000Z')),
      false,
    );
  });

  it('after validUntil → invalid', () => {
    const license = makeLicense({ status: 'ACTIVE' });
    assert.equal(
      isLicenseEffective(validSub, license, new Date('2027-02-01T00:00:00.000Z')),
      false,
    );
  });

  it('ACTIVE license + suspended subscription → invalid (dependency)', () => {
    const suspendedSub = makeSubscription({ status: 'SUSPENDED' });
    const license = makeLicense({ status: 'ACTIVE' });
    assert.equal(isLicenseEffective(suspendedSub, license, now), false);
  });

  it('ACTIVE license + expired subscription → invalid (dependency)', () => {
    const expiredSub = makeSubscription({ status: 'EXPIRED' });
    const license = makeLicense({ status: 'ACTIVE' });
    assert.equal(isLicenseEffective(expiredSub, license, now), false);
  });

  it('ACTIVE license + subscription outside its period → invalid (dependency)', () => {
    const outsideSub = makeSubscription({ status: 'ACTIVE' });
    const license = makeLicense({ status: 'ACTIVE' });
    assert.equal(
      isLicenseEffective(outsideSub, license, new Date('2027-02-01T00:00:00.000Z')),
      false,
    );
  });
});

describe('POST /api/v1/subscriptions', () => {
  it('creates a subscription for an ACTIVE client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const response = await api()
      .post('/api/v1/subscriptions')
      .set(authHeaders())
      .send({
        clientId: client.id,
        code: `ASENTRA-${randomUUID().slice(0, 6).toUpperCase()}`,
        planCode: 'ENTERPRISE',
        startsAt: STARTS,
        endsAt: ENDS,
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.planCode, 'ENTERPRISE');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.startsAt, STARTS);
    assert.equal(response.body.data.endsAt, ENDS);
    assert.ok(response.body.data.id);
  });

  it('rejects an unknown client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/subscriptions')
      .set(authHeaders())
      .send({
        clientId: randomUUID(),
        code: `ASENTRA-${randomUUID().slice(0, 6).toUpperCase()}`,
        planCode: 'STANDARD',
        startsAt: STARTS,
      });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLIENT_NOT_FOUND');
  });

  it('rejects an INACTIVE client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient('INACTIVE');
    const response = await api()
      .post('/api/v1/subscriptions')
      .set(authHeaders())
      .send({
        clientId: client.id,
        code: `ASENTRA-${randomUUID().slice(0, 6).toUpperCase()}`,
        planCode: 'STANDARD',
        startsAt: STARTS,
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'CLIENT_INACTIVE');
  });

  it('rejects a duplicate subscription code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const code = `DUP-${randomUUID().slice(0, 6).toUpperCase()}`;

    await api().post('/api/v1/subscriptions').set(authHeaders()).send({
      clientId: client.id,
      code,
      planCode: 'STANDARD',
      startsAt: STARTS,
    });

    const response = await api()
      .post('/api/v1/subscriptions')
      .set(authHeaders())
      .send({
        clientId: client.id,
        code: code.toLowerCase(),
        planCode: 'STANDARD',
        startsAt: STARTS,
      });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'SUBSCRIPTION_CODE_ALREADY_EXISTS');
  });

  it('rejects an invalid period (endsAt <= startsAt)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const response = await api()
      .post('/api/v1/subscriptions')
      .set(authHeaders())
      .send({
        clientId: client.id,
        code: `ASENTRA-${randomUUID().slice(0, 6).toUpperCase()}`,
        planCode: 'STANDARD',
        startsAt: '2027-01-01T00:00:00.000Z',
        endsAt: '2026-01-01T00:00:00.000Z',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a malformed clientId', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/subscriptions')
      .set(authHeaders())
      .send({
        clientId: 'not-a-uuid',
        code: `ASENTRA-${randomUUID().slice(0, 6).toUpperCase()}`,
        planCode: 'STANDARD',
        startsAt: STARTS,
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('GET /api/v1/subscriptions and client lookup', () => {
  it('lists subscriptions filtered by clientId query', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    await api().post('/api/v1/subscriptions').set(authHeaders()).send({
      clientId: client.id,
      code: `ASENTRA-${randomUUID().slice(0, 6).toUpperCase()}`,
      planCode: 'PROFESSIONAL',
      startsAt: STARTS,
    });

    const response = await api()
      .get(`/api/v1/subscriptions?clientId=${client.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
    assert.ok(response.body.data.length >= 1);
    assert.ok(
      response.body.data.every((s: { clientId: string }) => s.clientId === client.id),
    );
  });

  it('lists subscriptions for a client via /clients/:clientId/subscriptions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    await api().post('/api/v1/subscriptions').set(authHeaders()).send({
      clientId: client.id,
      code: `ASENTRA-${randomUUID().slice(0, 6).toUpperCase()}`,
      planCode: 'STANDARD',
      startsAt: STARTS,
    });

    const response = await api()
      .get(`/api/v1/clients/${client.id}/subscriptions`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
    assert.ok(response.body.data.length >= 1);
  });
});

describe('POST /api/v1/subscriptions/:id/licenses', () => {
  async function createActiveSubscription() {
    const client = await createClient();
    const created = await api()
      .post('/api/v1/subscriptions')
      .set(authHeaders())
      .send({
        clientId: client.id,
        code: `ASENTRA-${randomUUID().slice(0, 6).toUpperCase()}`,
        planCode: 'ENTERPRISE',
        startsAt: STARTS,
        endsAt: ENDS,
      });
    return created.body.data.id as string;
  }

  it('creates a license for a valid subscription', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const subscriptionId = await createActiveSubscription();
    const response = await api()
      .post(`/api/v1/subscriptions/${subscriptionId}/licenses`)
      .set(authHeaders())
      .send({
        validFrom: STARTS,
        validUntil: ENDS,
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.subscriptionId, subscriptionId);
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.validFrom, STARTS);
    assert.equal(response.body.data.validUntil, ENDS);
    assert.ok(response.body.data.id);
  });

  it('rejects a second ACTIVE license for the same subscription', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const subscriptionId = await createActiveSubscription();
    await api()
      .post(`/api/v1/subscriptions/${subscriptionId}/licenses`)
      .set(authHeaders())
      .send({ validFrom: STARTS, validUntil: ENDS });

    const response = await api()
      .post(`/api/v1/subscriptions/${subscriptionId}/licenses`)
      .set(authHeaders())
      .send({ validFrom: STARTS, validUntil: ENDS });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'LICENSE_ALREADY_ACTIVE');
  });

  it('rejects a license for an unknown subscription', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post(`/api/v1/subscriptions/${randomUUID()}/licenses`)
      .set(authHeaders())
      .send({ validFrom: STARTS, validUntil: ENDS });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SUBSCRIPTION_NOT_FOUND');
  });

  it('rejects a license for a non-ACTIVE subscription', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const subscriptionId = await createActiveSubscription();
    await api()
      .patch(`/api/v1/subscriptions/${subscriptionId}/status`)
      .set(authHeaders())
      .send({ status: 'SUSPENDED' });

    const response = await api()
      .post(`/api/v1/subscriptions/${subscriptionId}/licenses`)
      .set(authHeaders())
      .send({ validFrom: STARTS, validUntil: ENDS });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'SUBSCRIPTION_NOT_ACTIVE');
  });

  it('rejects an invalid license period', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const subscriptionId = await createActiveSubscription();
    const response = await api()
      .post(`/api/v1/subscriptions/${subscriptionId}/licenses`)
      .set(authHeaders())
      .send({ validFrom: ENDS, validUntil: STARTS });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('RBAC enforcement for subscription and license routes', () => {
  it('requires authentication (401) on subscription create', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api().post('/api/v1/subscriptions').send({});
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });

  it('requires authentication (401) on license create', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api()
      .post(`/api/v1/subscriptions/${randomUUID()}/licenses`)
      .send({});
    assert.equal(response.status, 401);
  });

  it('denies (403) an authenticated user without subscription.read', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const plainToken = await createPlainSession();
    const response = await api()
      .get('/api/v1/subscriptions')
      .set(authHeaders(plainToken));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies (403) an authenticated user without license.manage', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const plainToken = await createPlainSession();
    const response = await api()
      .post(`/api/v1/subscriptions/${randomUUID()}/licenses`)
      .set(authHeaders(plainToken))
      .send({ validFrom: STARTS });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('allows an admin (with permissions) to read subscriptions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api().get('/api/v1/subscriptions').set(authHeaders());
    assert.equal(response.status, 200);
  });
});
