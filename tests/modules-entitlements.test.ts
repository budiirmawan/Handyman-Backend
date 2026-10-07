import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { moduleService } from '../src/modules/modules';
import { subscriptionService } from '../src/modules/subscriptions';
import { licenseService } from '../src/modules/licenses';
import {
  entitlementService,
  resolveEffectiveEntitlements,
} from '../src/modules/entitlements';
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
  await pool.query(
    `TRUNCATE users, roles, permissions, clients, subscriptions, licenses, modules,
       module_entitlements, properties, buildings, user_building_assignments,
       organizations, departments, teams, positions, workforce_profiles,
       workforce_building_assignments, external_workforce_links
     CASCADE`,
  );
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

const STARTS = '2026-01-01T00:00:00.000Z';
const ENDS = '2027-01-01T00:00:00.000Z';
const NOW = '2026-06-01T00:00:00.000Z';

async function createActiveClient() {
  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Client',
  });
  return client;
}

async function createActiveSubscription() {
  const client = await createActiveClient();
  const subscription = await subscriptionService.createSubscription({
    clientId: client.id,
    code: `ASENTRA-${randomUUID().slice(0, 6).toUpperCase()}`,
    planCode: 'ENTERPRISE',
    startsAt: new Date(STARTS),
    endsAt: new Date(ENDS),
  });
  return { client, subscription };
}

async function createValidLicense(subscriptionId: string) {
  return licenseService.createLicense(subscriptionId, {
    validFrom: new Date(STARTS),
    validUntil: new Date(ENDS),
  });
}

async function createModule(code?: string, status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') {
  return moduleService.createModule({
    code: code ?? `MOD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Module',
    status,
  });
}

describe('POST /api/v1/modules', () => {
  it('creates a module with a normalized code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/modules')
      .set(authHeaders())
      .send({ code: 'engineering', name: 'Engineering' });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.code, 'ENGINEERING');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.ok(response.body.data.id);
  });

  it('rejects a duplicate module code regardless of case', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await api().post('/api/v1/modules').set(authHeaders()).send({
      code: 'HOUSEKEEPING',
      name: 'Housekeeping',
    });

    const response = await api()
      .post('/api/v1/modules')
      .set(authHeaders())
      .send({ code: 'housekeeping', name: 'Housekeeping (dup)' });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'MODULE_CODE_ALREADY_EXISTS');
  });

  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api().post('/api/v1/modules').send({ code: 'X', name: 'X' });
    assert.equal(response.status, 401);
  });

  it('denies an authenticated user without module.manage', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const plainToken = await createPlainSession();
    const response = await api()
      .post('/api/v1/modules')
      .set(authHeaders(plainToken))
      .send({ code: 'SECURITY', name: 'Security' });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('allows an admin to list modules', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api().get('/api/v1/modules').set(authHeaders());
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
  });
});

describe('POST /api/v1/subscriptions/:id/entitlements', () => {
  it('creates an entitlement for an effective commercial context', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { subscription } = await createActiveSubscription();
    await createValidLicense(subscription.id);
    const module = await createModule(`ENG_${randomUUID().slice(0, 8).toUpperCase()}`);
    const response = await api()
      .post(`/api/v1/subscriptions/${subscription.id}/entitlements`)
      .set(authHeaders())
      .send({ moduleId: module.id, startsAt: STARTS, endsAt: ENDS });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.subscriptionId, subscription.id);
    assert.equal(response.body.data.moduleId, module.id);
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.startsAt, STARTS);
    assert.equal(response.body.data.endsAt, ENDS);
  });

  it('rejects a duplicate ACTIVE entitlement for the same subscription + module', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { subscription } = await createActiveSubscription();
    await createValidLicense(subscription.id);
    const module = await createModule('SECURITY');

    await api()
      .post(`/api/v1/subscriptions/${subscription.id}/entitlements`)
      .set(authHeaders())
      .send({ moduleId: module.id, startsAt: STARTS, endsAt: ENDS });

    const response = await api()
      .post(`/api/v1/subscriptions/${subscription.id}/entitlements`)
      .set(authHeaders())
      .send({ moduleId: module.id, startsAt: STARTS, endsAt: ENDS });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'ENTITLEMENT_ALREADY_EXISTS');
  });

  it('rejects an invalid period (endsAt <= startsAt)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { subscription } = await createActiveSubscription();
    await createValidLicense(subscription.id);
    const module = await createModule('REPORTING');
    const response = await api()
      .post(`/api/v1/subscriptions/${subscription.id}/entitlements`)
      .set(authHeaders())
      .send({ moduleId: module.id, startsAt: ENDS, endsAt: STARTS });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an unknown subscription', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const module = await createModule('TENANT_SERVICE');
    const response = await api()
      .post(`/api/v1/subscriptions/${randomUUID()}/entitlements`)
      .set(authHeaders())
      .send({ moduleId: module.id, startsAt: STARTS });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SUBSCRIPTION_NOT_FOUND');
  });

  it('rejects an unknown module', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { subscription } = await createActiveSubscription();
    await createValidLicense(subscription.id);
    const response = await api()
      .post(`/api/v1/subscriptions/${subscription.id}/entitlements`)
      .set(authHeaders())
      .send({ moduleId: randomUUID(), startsAt: STARTS });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'MODULE_NOT_FOUND');
  });

  it('rejects an ACTIVE entitlement for an INACTIVE module', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { subscription } = await createActiveSubscription();
    await createValidLicense(subscription.id);
    const module = await createModule('INACTIVE_MOD', 'INACTIVE');
    const response = await api()
      .post(`/api/v1/subscriptions/${subscription.id}/entitlements`)
      .set(authHeaders())
      .send({ moduleId: module.id, startsAt: STARTS });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'MODULE_INACTIVE');
  });

  it('rejects an entitlement when the subscription is not ACTIVE', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { subscription } = await createActiveSubscription();
    const module = await createModule('SUSPENDED_MOD');
    await api()
      .patch(`/api/v1/subscriptions/${subscription.id}/status`)
      .set(authHeaders())
      .send({ status: 'SUSPENDED' });
    const response = await api()
      .post(`/api/v1/subscriptions/${subscription.id}/entitlements`)
      .set(authHeaders())
      .send({ moduleId: module.id, startsAt: STARTS });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'SUBSCRIPTION_NOT_ACTIVE');
  });

  it('rejects an entitlement when the license is REVOKED', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { subscription } = await createActiveSubscription();
    const license = await createValidLicense(subscription.id);
    const module = await createModule('REVOKED_MOD');
    await api()
      .patch(`/api/v1/licenses/${license.id}/status`)
      .set(authHeaders())
      .send({ status: 'REVOKED' });
    const response = await api()
      .post(`/api/v1/subscriptions/${subscription.id}/entitlements`)
      .set(authHeaders())
      .send({ moduleId: module.id, startsAt: STARTS });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ENTITLEMENT_COMMERCIAL_CONTEXT_INVALID');
  });
});

describe('effective entitlement resolver (deterministic)', () => {
  it('returns effective modules only for a valid context', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { subscription } = await createActiveSubscription();
    await createValidLicense(subscription.id);

    const engineeringCode = `ENG_${randomUUID().slice(0, 8).toUpperCase()}`;
    const housekeepingCode = `HK_${randomUUID().slice(0, 8).toUpperCase()}`;
    const securityCode = `SEC_${randomUUID().slice(0, 8).toUpperCase()}`;
    const reportingCode = `REP_${randomUUID().slice(0, 8).toUpperCase()}`;
    const engineering = await createModule(engineeringCode);
    const housekeeping = await createModule(housekeepingCode);
    const security = await createModule(securityCode);
    const reporting = await createModule(reportingCode);

    await entitlementService.createEntitlement(subscription.id, {
      moduleId: engineering.id,
      startsAt: new Date(STARTS),
      endsAt: new Date(ENDS),
    });
    await entitlementService.createEntitlement(subscription.id, {
      moduleId: housekeeping.id,
      startsAt: new Date(STARTS),
      endsAt: new Date(ENDS),
    });
    await entitlementService.createEntitlement(subscription.id, {
      moduleId: security.id,
      startsAt: new Date(STARTS),
      endsAt: new Date(ENDS),
      status: 'SUSPENDED',
    });
    await entitlementService.createEntitlement(subscription.id, {
      moduleId: reporting.id,
      startsAt: new Date(STARTS),
      endsAt: new Date('2026-02-01T00:00:00.000Z'),
    });

    const effective = await resolveEffectiveEntitlements(subscription.id, new Date(NOW));
    const codes = effective.map((m) => m.code).sort();

    assert.deepEqual(codes, [engineeringCode, housekeepingCode].sort());
    assert.ok(!codes.includes(securityCode));
    assert.ok(!codes.includes(reportingCode));
  });

  it('excludes an INACTIVE module', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { subscription } = await createActiveSubscription();
    await createValidLicense(subscription.id);
    const module = await createModule(`INACTIVE_${randomUUID().slice(0, 8).toUpperCase()}`);
    const entitlement = await entitlementService.createEntitlement(subscription.id, {
      moduleId: module.id,
      startsAt: new Date(STARTS),
      endsAt: new Date(ENDS),
    });
    await moduleService.updateModuleStatus(module.id, { status: 'INACTIVE' });

    const effective = await resolveEffectiveEntitlements(subscription.id, new Date(NOW));
    assert.equal(effective.length, 0);
    assert.equal(entitlement.status, 'ACTIVE');
  });

  it('returns empty when the subscription is not effective', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { subscription } = await createActiveSubscription();
    await createValidLicense(subscription.id);
    const module = await createModule('EFFECTIVE_A');
    await entitlementService.createEntitlement(subscription.id, {
      moduleId: module.id,
      startsAt: new Date(STARTS),
      endsAt: new Date(ENDS),
    });

    await subscriptionService.updateSubscriptionStatus(subscription.id, {
      status: 'SUSPENDED',
    });
    const effective = await resolveEffectiveEntitlements(subscription.id, new Date(NOW));
    assert.equal(effective.length, 0);
  });

  it('returns empty when the license is not valid', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { subscription } = await createActiveSubscription();
    const license = await createValidLicense(subscription.id);
    const module = await createModule('EFFECTIVE_B');
    await entitlementService.createEntitlement(subscription.id, {
      moduleId: module.id,
      startsAt: new Date(STARTS),
      endsAt: new Date(ENDS),
    });

    await licenseService.updateLicenseStatus(license.id, { status: 'REVOKED' });
    const effective = await resolveEffectiveEntitlements(subscription.id, new Date(NOW));
    assert.equal(effective.length, 0);
  });

  it('returns empty when no license exists', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { subscription } = await createActiveSubscription();
    const module = await createModule('EFFECTIVE_C');
    await entitlementService.createEntitlement(subscription.id, {
      moduleId: module.id,
      startsAt: new Date(STARTS),
      endsAt: new Date(ENDS),
    });

    const effective = await resolveEffectiveEntitlements(subscription.id, new Date(NOW));
    assert.equal(effective.length, 0);
  });
});

describe('multi-client relational separation', () => {
  it('does not leak entitlements across clients/subscriptions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const a = await createActiveSubscription();
    await createValidLicense(a.subscription.id);
    const engCode = `ENG_${randomUUID().slice(0, 8).toUpperCase()}`;
    const eng = await createModule(engCode);
    await entitlementService.createEntitlement(a.subscription.id, {
      moduleId: eng.id,
      startsAt: new Date(STARTS),
      endsAt: new Date(ENDS),
    });

    const b = await createActiveSubscription();
    await createValidLicense(b.subscription.id);
    const hkCode = `HK_${randomUUID().slice(0, 8).toUpperCase()}`;
    const hk = await createModule(hkCode);
    await entitlementService.createEntitlement(b.subscription.id, {
      moduleId: hk.id,
      startsAt: new Date(STARTS),
      endsAt: new Date(ENDS),
    });

    const effectiveA = await resolveEffectiveEntitlements(a.subscription.id, new Date(NOW));
    const codesA = effectiveA.map((m) => m.code);
    assert.deepEqual(codesA, [engCode]);
    assert.ok(!codesA.includes('HOUSEKEEPING'));

    const effectiveB = await resolveEffectiveEntitlements(b.subscription.id, new Date(NOW));
    const codesB = effectiveB.map((m) => m.code);
    assert.deepEqual(codesB, [hkCode]);
  });
});

describe('entitlement RBAC', () => {
  it('requires authentication to read entitlements', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api().get(`/api/v1/subscriptions/${randomUUID()}/entitlements`);
    assert.equal(response.status, 401);
  });

  it('denies an authenticated user without entitlement.read', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const plainToken = await createPlainSession();
    const response = await api()
      .get(`/api/v1/subscriptions/${randomUUID()}/entitlements`)
      .set(authHeaders(plainToken));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('allows an admin to read entitlements', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { subscription } = await createActiveSubscription();
    const response = await api()
      .get(`/api/v1/subscriptions/${subscription.id}/entitlements`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
  });
});
