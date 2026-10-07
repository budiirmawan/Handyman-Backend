import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { parse as parseYaml } from 'yaml';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { handymanCareActorService } from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName,
  consumeHandoffExchange, acceptHandoffAssertion } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, resolveCareWorkspacePrincipal, revokeCareWorkspaceSession,
  signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { resolveSessionContext } from '../src/modules/auth/session.service';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { createAdminUser } from './helpers/access';

const DIR = '/tmp/handyman-care-workspace-admission-pg';
const PORT = 55529;
const SECRET = 'workspace-admission-test-integration-secret';
let postgres: EmbeddedPostgres | null = null;
let pool: Pool;
let code: string;
let actorId: string;
let integrationId: string;
let envKey: string;
let userToken: string;
const unauthorized = (error: any) => error.statusCode === 401 &&
  error.code === 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED';

before(async () => {
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
  assert.ok(config, 'Focused admission tests require PostgreSQL (no silent skips)');
  pool = await initDatabase(config);
  await migrateUp(pool);
  code = `WS_${randomUUID().slice(0, 8).toUpperCase()}`;
  integrationId = (await handoffRuntimeRepository.createIntegration({ integrationCode: code, displayName: 'Workspace BM' })).id;
  await handymanCareActorService.setIntegrationActorCapability({ integrationId, capability: 'CUSTOMER_CARE' });
  actorId = (await handymanCareActorService.createCareActor({ integrationId, actorReference: 'care-operator', displayName: 'Care' })).id;
  envKey = handoffIntegrationSecretEnvName(code);
  process.env[envKey] = SECRET;
  userToken = (await createAdminUser()).token;
});
beforeEach(() => clearLoginRateLimits());
after(async () => {
  if (envKey) delete process.env[envKey];
  clearLoginRateLimits();
  if (pool) await closePool(pool);
  if (postgres) { await postgres.stop(); await rm(DIR, { recursive: true, force: true }); }
});

function assertion(overrides: Partial<CareWorkspaceAssertion> = {}): CareWorkspaceAssertion {
  return { purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode: code, assertionId: randomUUID(),
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: 'care-operator' }, ...overrides };
}
async function admit(a = assertion()) { return admitCareWorkspace(a, signCareWorkspaceAssertion(a, SECRET)); }
async function count(table: string) { return (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n; }

describe('Care workspace admission', () => {
  it('issues a reusable opaque credential, stores only its hash, binds identity and does not slide expiry', async () => {
    const beforeUsers = await count('users');
    const beforeSessions = await count('user_sessions');
    const beforeExchanges = await count('handyman_handoff_exchanges');
    const a = assertion();
    const start = Date.now();
    const admitted = await admit(a);
    assert.match(admitted.workspaceToken, /^hcw_[A-Za-z0-9_-]{43}$/);
    assert.ok(Date.parse(admitted.expiresAt) <= Date.now() + 900_000);
    assert.ok(Date.parse(admitted.expiresAt) >= start + 899_000);
    const first = await resolveCareWorkspacePrincipal(admitted.workspaceToken);
    assert.equal(first.careActorId, actorId);
    assert.equal(first.integrationId, integrationId);
    assert.equal(first.actorType, 'CUSTOMER_CARE');
    assert.equal('userId' in first, false);
    assert.deepEqual(await resolveCareWorkspacePrincipal(admitted.workspaceToken), first);
    const row = (await pool.query('SELECT * FROM handyman_care_workspace_sessions WHERE id = $1', [first.sessionId])).rows[0];
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(row).includes(admitted.workspaceToken));
    assert.equal(row.expires_at.getTime() - row.created_at.getTime(), 900_000);
    assert.equal(await count('users'), beforeUsers);
    assert.equal(await count('user_sessions'), beforeSessions);
    assert.equal(await count('handyman_handoff_exchanges'), beforeExchanges);
  });

  it('rejects bad signatures, missing secrets and unknown/cross-integration actors uniformly', async () => {
    const a = assertion();
    await assert.rejects(admitCareWorkspace(a, undefined), unauthorized);
    await assert.rejects(admitCareWorkspace(a, signCareWorkspaceAssertion(a, 'wrong')), unauthorized);
    delete process.env[envKey];
    await assert.rejects(admit(a), unauthorized);
    process.env[envKey] = SECRET;
    await assert.rejects(admit(assertion({ actor: { type: 'CUSTOMER_CARE', actorReference: 'unknown' } })), unauthorized);
    const otherCode = `WS_OTHER_${randomUUID().slice(0, 8)}`;
    const other = await handoffRuntimeRepository.createIntegration({ integrationCode: otherCode, displayName: 'Other' });
    await handymanCareActorService.setIntegrationActorCapability({ integrationId: other.id, capability: 'CUSTOMER_CARE' });
    const key = handoffIntegrationSecretEnvName(otherCode);
    process.env[key] = SECRET;
    try { await assert.rejects(admit(assertion({ integrationCode: otherCode })), unauthorized); }
    finally { delete process.env[key]; }
  });

  it('rejects future, expired, oversized-window and malformed/purpose/context-smuggled assertions', async () => {
    const now = Date.now();
    for (const patch of [
      { issuedAt: new Date(now + 60_000).toISOString() },
      { expiresAt: new Date(now - 1).toISOString() },
      { expiresAt: new Date(now + 600_000).toISOString() },
      { issuedAt: 'invalid' }, { purpose: 'HANDYMAN_HANDOFF' },
      { tenantCompanyId: randomUUID() }, { actor: { type: 'USER', actorReference: 'care-operator' } },
    ]) {
      const a = { ...assertion(), ...patch } as CareWorkspaceAssertion;
      await assert.rejects(admit(a), unauthorized);
    }
    await assert.rejects(admitCareWorkspace(null, ''), unauthorized);
  });

  it('consumes an assertion once, including concurrent replay and replay after logout', async () => {
    const a = assertion();
    const results = await Promise.allSettled([admit(a), admit(a)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(unauthorized(failed.reason));
    const success = results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof admit>>>;
    await revokeCareWorkspaceSession(success.value.workspaceToken);
    await assert.rejects(admit(a), unauthorized);
  });

  it('revokes idempotently and rejects every subsequent authentication', async () => {
    const { workspaceToken } = await admit();
    await revokeCareWorkspaceSession(workspaceToken);
    await revokeCareWorkspaceSession(workspaceToken);
    await assert.rejects(resolveCareWorkspacePrincipal(workspaceToken), unauthorized);
    await assert.rejects(resolveCareWorkspacePrincipal('hcw_' + 'A'.repeat(43)), unauthorized);
  });

  it('permanently invalidates on actor deactivation, even if reactivated before next use', async () => {
    const { workspaceToken } = await admit();
    await handymanCareActorService.deactivateCareActor(actorId);
    await assert.rejects(admit(), unauthorized);
    await assert.rejects(resolveCareWorkspacePrincipal(workspaceToken), unauthorized);
    await handymanCareActorService.activateCareActor(actorId);
    await assert.rejects(resolveCareWorkspacePrincipal(workspaceToken), unauthorized);
    await resolveCareWorkspacePrincipal((await admit()).workspaceToken);
  });

  it('permanently invalidates on integration deactivation and capability loss', async () => {
    for (const change of ["status = 'INACTIVE'", "actor_capability = 'NONE'"]) {
      const { workspaceToken } = await admit();
      await pool.query(`UPDATE handyman_handoff_integrations SET ${change} WHERE id = $1`, [integrationId]);
      await assert.rejects(admit(), unauthorized);
      await assert.rejects(resolveCareWorkspacePrincipal(workspaceToken), unauthorized);
      await pool.query("UPDATE handyman_handoff_integrations SET status = 'ACTIVE', actor_capability = 'CUSTOMER_CARE' WHERE id = $1", [integrationId]);
      await assert.rejects(resolveCareWorkspacePrincipal(workspaceToken), unauthorized);
    }
  });

  it('denies expired tokens and prevents expiry extension/storage identity edits', async () => {
    const a = assertion();
    const admitted = await admit(a);
    const principal = await resolveCareWorkspacePrincipal(admitted.workspaceToken);
    await assert.rejects(pool.query("UPDATE handyman_care_workspace_sessions SET expires_at = expires_at + interval '1 second' WHERE id = $1", [principal.sessionId]));
    // Seed an already expired hash-only credential without bypassing immutable updates.
    const { createHash } = await import('node:crypto');
    const expired = 'hcw_' + 'E'.repeat(43);
    await pool.query(`INSERT INTO handyman_care_workspace_sessions
      (id, integration_id, care_actor_id, assertion_id, token_hash, created_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,now()-interval '16 minutes',now()-interval '1 minute')`,
      [randomUUID(), integrationId, actorId, randomUUID(), createHash('sha256').update(expired).digest('hex')]);
    await assert.rejects(resolveCareWorkspacePrincipal(expired), unauthorized);
    await assert.rejects(revokeCareWorkspaceSession(expired), unauthorized);
  });

  it('does not substitute for User sessions, represented-context exchanges, or assertions', async () => {
    const a = assertion();
    const { workspaceToken } = await admit(a);
    await assert.rejects(resolveSessionContext(workspaceToken));
    await assert.rejects(consumeHandoffExchange(workspaceToken));
    await assert.rejects(resolveCareWorkspacePrincipal(userToken), unauthorized);
    await assert.rejects(resolveCareWorkspacePrincipal('regular-exchange-token'), unauthorized);
    await assert.rejects(acceptHandoffAssertion(a, signCareWorkspaceAssertion(a, SECRET)));
    const response = await api().post('/api/v1/handyman/requests/care')
      .send({ exchangeToken: workspaceToken, serviceCatalogId: randomUUID() });
    assert.equal(response.status, 401);
    const bearer = await api().get('/api/v1/handyman/requests').set('Authorization', `Bearer ${workspaceToken}`);
    assert.equal(bearer.status, 401);
  });

  it('fails closed on storage failure', async () => {
    const connection = pool.connect.bind(pool);
    pool.connect = (async () => { throw new Error('simulated database outage'); }) as typeof pool.connect;
    try {
      await assert.rejects(admit(), /simulated database outage/);
      await assert.rejects(resolveCareWorkspacePrincipal('hcw_' + 'A'.repeat(43)), /simulated database outage/);
    } finally { pool.connect = connection; }
  });

  it('rolls back issuance on transactional failure without consuming the assertion', async () => {
    const a = assertion();
    const countBefore = await count('handyman_care_workspace_sessions');
    const connect = pool.connect.bind(pool);
    pool.connect = (async () => {
      const client = await connect();
      const query = client.query.bind(client);
      const release = client.release.bind(client);
      client.query = (async (...args: any[]) => {
        const result = await (query as any)(...args);
        if (String(args[0]).includes('INSERT INTO handyman_care_workspace_sessions')) {
          throw new Error('simulated failure after insert');
        }
        return result;
      }) as typeof client.query;
      client.release = (...args) => { client.query = query; client.release = release; release(...args); };
      return client;
    }) as typeof pool.connect;
    try { await assert.rejects(admit(a), /simulated failure after insert/); }
    finally { pool.connect = connect; }
    assert.equal(await count('handyman_care_workspace_sessions'), countBefore);
    await resolveCareWorkspacePrincipal((await admit(a)).workspaceToken);
  });

  it('retains immutable replay tombstones and cannot restore a revoked credential', async () => {
    const admitted = await admit();
    const principal = await resolveCareWorkspacePrincipal(admitted.workspaceToken);
    await revokeCareWorkspaceSession(admitted.workspaceToken);
    await assert.rejects(pool.query('UPDATE handyman_care_workspace_sessions SET revoked_at = NULL WHERE id = $1', [principal.sessionId]));
    await assert.rejects(pool.query('DELETE FROM handyman_care_workspace_sessions WHERE id = $1', [principal.sessionId]));
    await assert.rejects(resolveCareWorkspacePrincipal(admitted.workspaceToken), unauthorized);
  });

  it('exposes only POST/DELETE admission with no-store, uniform 401 and idempotent logout', async () => {
    const a = assertion();
    const response = await api().post('/api/v1/handyman/care/session')
      .set('x-hub-signature-256', signCareWorkspaceAssertion(a, SECRET)).send(a);
    assert.equal(response.status, 201);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(response.body.data).sort(), ['expiresAt', 'workspaceToken']);
    const token = response.body.data.workspaceToken;
    for (let i = 0; i < 2; i++) {
      const logout = await api().delete('/api/v1/handyman/care/session').set('Authorization', `Bearer ${token}`);
      assert.equal(logout.status, 204);
      assert.equal(logout.headers['cache-control'], 'no-store');
    }
    const rejected = await api().delete('/api/v1/handyman/care/session').set('Authorization', `Bearer ${userToken}`);
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.error.code, 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');
    const unsigned = await api().post('/api/v1/handyman/care/session').send(assertion());
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.headers['cache-control'], 'no-store');
    assert.equal((await api().get('/api/v1/handyman/care/session')).status, 404);
    assert.equal((await api().post('/webhooks/handyman/care/session').send(a)).status, 404);
  });

  it('throttles admission attempts with Retry-After', async () => {
    let response;
    for (let i = 0; i < 100; i++) {
      response = await api().post('/api/v1/handyman/care/session').send({});
      if (response.status === 429) break;
    }
    assert.equal(response?.status, 429);
    assert.ok(Number(response?.headers['retry-after']) > 0);
  });

  it('documents only admission/logout, with distinct workspace security and closed assertion schema', () => {
    const spec = parseYaml(readFileSync('docs/api/openapi.yaml', 'utf8'));
    const route = spec.paths['/handyman/care/session'];
    assert.ok(route.post && route.delete);
    assert.deepEqual(route.post.security, [{ handoffAssertionSignature: [] }]);
    assert.deepEqual(route.delete.security, [{ careWorkspaceSession: [] }]);
    assert.equal(spec.components.schemas.CareWorkspaceAssertion.additionalProperties, false);
    assert.deepEqual(Object.keys(spec.paths).filter(p => p.startsWith('/handyman/care/')), ['/handyman/care/session']);
  });
});
