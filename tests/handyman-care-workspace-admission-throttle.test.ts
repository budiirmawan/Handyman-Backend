import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { handymanCareActorService } from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-CARE-WORKSPACE-01 A02 — focused admission throttle tests only.
 *
 * Scope: the socket-IP login throttle wrapped around POST /handyman/care/session.
 * A successful admission must not consume failure quota and must clear any
 * accumulated failures; an actual failed admission must still be recorded; the
 * 429 gate and the existing `handyman-care-workspace:` namespace are preserved.
 * Admission, session and crypto authority are asserted only through their
 * existing observable contracts (201 credential / uniform 401).
 */

const DIR = '/tmp/handyman-care-workspace-admission-throttle-pg';
const PORT = 55538;
const SECRET = 'admission-throttle-test-integration-secret';
/** Small deterministic failure budget; the real default is 10 per 15 minutes. */
const MAX_ATTEMPTS = 3;

let postgres: EmbeddedPostgres | null = null;
let pool: Pool;
let code: string;
let envKey: string;

before(async () => {
  process.env.AUTH_LOGIN_RATE_LIMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
  process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES = '15';
  resetAppConfigCache();
  if (process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true') {
    Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: String(PORT),
      DB_USER: 'postgres', DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false' });
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({ databaseDir: DIR, port: PORT,
      user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
    await postgres.initialise();
    await postgres.start();
    const admin = postgres.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }
  const config = await ensureTestDatabase();
  assert.ok(config, 'Focused admission throttle tests require PostgreSQL (no silent skips)');
  pool = await initDatabase(config);
  await migrateUp(pool);
  code = `WST_${randomUUID().slice(0, 8).toUpperCase()}`;
  const integrationId = (await handoffRuntimeRepository.createIntegration(
    { integrationCode: code, displayName: 'Throttle BM' })).id;
  await handymanCareActorService.setIntegrationActorCapability({ integrationId, capability: 'CUSTOMER_CARE' });
  await handymanCareActorService.createCareActor(
    { integrationId, actorReference: 'throttle-operator', displayName: 'Throttle' });
  envKey = handoffIntegrationSecretEnvName(code);
  process.env[envKey] = SECRET;
});
beforeEach(() => clearLoginRateLimits());
after(async () => {
  if (envKey) delete process.env[envKey];
  clearLoginRateLimits();
  if (pool) await closePool(pool);
  if (postgres) { await postgres.stop(); await rm(DIR, { recursive: true, force: true }); }
});

function assertion(): CareWorkspaceAssertion {
  return { purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode: code, assertionId: randomUUID(),
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: 'throttle-operator' } };
}

/** A genuinely successful admission, signed with the integration secret. */
function admitSigned() {
  const a = assertion();
  return api().post('/api/v1/handyman/care/session')
    .set('x-hub-signature-256', signCareWorkspaceAssertion(a, SECRET)).send(a);
}

/** A genuinely failed admission: correct shape, no signature -> uniform 401. */
function admitRejected() {
  return api().post('/api/v1/handyman/care/session').send(assertion());
}

async function sessionCount() {
  return (await pool.query('SELECT count(*)::int AS n FROM handyman_care_workspace_sessions')).rows[0].n;
}

describe('Care workspace admission throttling', () => {
  it('does not let a successful admission consume failure quota', async () => {
    // Far more successes than the failure budget: under the pre-fix behaviour
    // (record-on-every-attempt) the fourth request would already be 429.
    for (let i = 0; i < MAX_ATTEMPTS * 3; i++) {
      const response = await admitSigned();
      assert.equal(response.status, 201, `successful admission ${i + 1} must not be throttled`);
      assert.match(response.body.data.workspaceToken, /^hcw_[A-Za-z0-9_-]{43}$/);
    }
    assert.equal((await admitSigned()).status, 201);
  });

  it('records an actual failed admission and still enforces 429 with Retry-After', async () => {
    let response;
    let requests = 0;
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      response = await admitRejected();
      requests += 1;
      if (response.status === 429) break;
    }
    // Exactly the budget is spent on real failures; the next attempt is refused.
    assert.equal(requests, MAX_ATTEMPTS + 1);
    assert.equal(response?.status, 429);
    assert.equal(response?.body.error.code, 'AUTH_RATE_LIMITED');
    assert.equal(response?.headers['cache-control'], 'no-store');
    assert.ok(Number(response?.headers['retry-after']) > 0);
  });

  it('clears accumulated failure state when an admission succeeds', async () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      assert.equal((await admitRejected()).status, 401);
    }
    assert.equal((await admitSigned()).status, 201);
    // The success must reset the key, so a fresh full failure budget is available
    // again before the gate re-engages.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const response = await admitRejected();
      assert.equal(response.status, 401, `failure ${i + 1} after a success must not be throttled`);
    }
    assert.equal((await admitRejected()).status, 429);
  });

  it('keeps the 429 gate ahead of a valid signed admission', async () => {
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) await admitRejected();
    const before = await sessionCount();
    const throttled = await admitSigned();
    assert.equal(throttled.status, 429);
    assert.equal(throttled.body.error.code, 'AUTH_RATE_LIMITED');
    // The gate short-circuits before any authority work: no credential is issued.
    assert.equal(await sessionCount(), before);
  });

  it('preserves the existing admission namespace in isolation from /auth/login', async () => {
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) await admitRejected();
    assert.equal((await admitRejected()).status, 429);
    // The care namespace is `handyman-care-workspace:<socket address>`, so the
    // bare-IP login namespace must be untouched by the throttled admissions.
    const login = await api().post('/api/v1/auth/login')
      .send({ email: `throttle-${randomUUID()}@example.com`, password: 'NotThePassword123' });
    assert.notEqual(login.status, 429);
    assert.equal(login.status, 401);
    assert.equal(login.body.error.code, 'INVALID_CREDENTIALS');
  });
});
