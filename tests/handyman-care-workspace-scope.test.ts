import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { parse as parseYaml } from 'yaml';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { handymanCareActorService, grantCareActorProperty, revokeCareActorProperty } from '../src/modules/handyman-care-actors';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { listCareWorkspaceScope } from '../src/modules/handyman-care-workspace/care-workspace-scope.service';
import { careWorkspaceScopeRepository } from '../src/modules/handyman-care-workspace/care-workspace-scope.repository';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName,
  consumeHandoffExchange } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, revokeCareWorkspaceSession,
  signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { createAdminUser } from './helpers/access';

const DIR = '/tmp/handyman-care-workspace-scope-pg';
const PORT = 55530;
const SECRET = 'workspace-admission-test-integration-secret';
let postgres: EmbeddedPostgres | null = null;
let pool: Pool;
let code: string;
let actorId: string;
let integrationId: string;
let envKey: string;
let userToken: string;
let adminId: string;
let token: string;
let otherActorId: string;
let otherToken: string;
let clientId: string;
let otherClientId: string;
let props: string[] = [];
let buildings: string[][] = [];
let denied: string;
let foreign: string;
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const path = '/api/v1/handyman/care/properties';
const buildingPath = (id: string) => `${path}/${id}/buildings`;
const get = (url = path, credential = token) => api().get(url).set('Authorization', `Bearer ${credential}`);
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
  assert.ok(config, 'Focused scope-read tests require PostgreSQL (no silent skips)');
  pool = await initDatabase(config);
  await migrateUp(pool);
  code = `WS_${randomUUID().slice(0, 8).toUpperCase()}`;
  integrationId = (await handoffRuntimeRepository.createIntegration({ integrationCode: code, displayName: 'Workspace BM' })).id;
  await handymanCareActorService.setIntegrationActorCapability({ integrationId, capability: 'CUSTOMER_CARE' });
  actorId = (await handymanCareActorService.createCareActor({ integrationId, actorReference: 'care-operator', displayName: 'Care' })).id;
  envKey = handoffIntegrationSecretEnvName(code);
  process.env[envKey] = SECRET;
  const admin = await createAdminUser();
  userToken = admin.token;
  adminId = admin.userId;
  clientId = (await clientService.createClient({ code: `C_${suffix()}`, name: 'Scope client' })).id;
  otherClientId = (await clientService.createClient({ code: `C_${suffix()}`, name: 'Other client' })).id;
  for (let i = 0; i < 3; i++) {
    const cid = i === 2 ? otherClientId : clientId;
    const p = await propertyService.createProperty({ clientId: cid, code: `P_${suffix()}`, name: 'Granted' });
    props.push(p.id);
    const ids: string[] = [];
    for (let j = 0; j < 3; j++) {
      const b = await buildingService.createBuilding({ propertyId: p.id, code: `B_${suffix()}`, name: 'Scope building' });
      ids.push(b.id);
      await buildingAssignmentService.createAssignment(adminId, { buildingId: b.id });
    }
    buildings.push(ids);
    await grantCareActorProperty({ careActorId: actorId, propertyId: p.id, clientId: cid }, adminId);
  }
  await pool.query("UPDATE buildings SET status = 'INACTIVE' WHERE property_id = $1 OR id = $2", [props[2], buildings[0][2]]);
  denied = (await propertyService.createProperty({ clientId, code: `P_${suffix()}`, name: 'Not granted same client' })).id;
  foreign = (await propertyService.createProperty({ clientId: otherClientId, code: `P_${suffix()}`, name: 'Not granted other client' })).id;
  otherActorId = (await handymanCareActorService.createCareActor({ integrationId, actorReference: 'other-care', displayName: 'Other care' })).id;
});
beforeEach(async () => {
  clearLoginRateLimits();
  token = (await admit()).workspaceToken;
  otherToken = (await admit(assertion({ actor: { type: 'CUSTOMER_CARE', actorReference: 'other-care' } }))).workspaceToken;
});
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

describe('Care workspace property scope reads', () => {
  it('projects only granted ACTIVE properties and derived Client IDs with minimal fields', async () => {
    const response = await get();
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const data = response.body.data;
    assert.deepEqual(Object.keys(data).sort(), ['evaluatedAt', 'items', 'nextCursor']);
    assert.deepEqual(data.items.map((p: any) => p.id), [...props].sort());
    for (const item of data.items) {
      assert.deepEqual(Object.keys(item).sort(), ['clientId', 'code', 'id', 'name']);
      assert.equal(item.clientId, item.id === props[2] ? otherClientId : clientId);
    }
    assert.equal(data.nextCursor, null);
    assert.ok(Number.isFinite(Date.parse(data.evaluatedAt)));
    assert.ok(!JSON.stringify(data).includes(adminId));
  });

  it('returns only ACTIVE buildings within the granted parent, including an empty collection', async () => {
    const response = await get(buildingPath(props[0]));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.items.map((b: any) => b.id), buildings[0].slice(0, 2).sort());
    for (const item of response.body.data.items) {
      assert.deepEqual(Object.keys(item).sort(), ['code', 'id', 'name', 'propertyId']);
      assert.equal(item.propertyId, props[0]);
    }
    const empty = await get(buildingPath(props[2]));
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.data.items, []);
  });

  it('does not widen from actor or shared Client membership; inaccessible and absent parents have uniform 404', async () => {
    const responses = [];
    for (const id of [denied, foreign, randomUUID()]) {
      const response = await get(buildingPath(id));
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND');
      responses.push(response.body.error.message);
    }
    assert.equal(new Set(responses).size, 1);
    const noGrants = await get(path, otherToken);
    assert.equal(noGrants.status, 200);
    assert.deepEqual(noGrants.body.data.items, []);
    assert.equal((await get(buildingPath(props[0]), otherToken)).status, 404);
  });

  it('omits inactive properties/Clients and denies their building collections', async () => {
    for (const [table, id, hidden] of [
      ['properties', props[0], [props[0]]], ['clients', clientId, props.slice(0, 2)],
    ] as [string, string, string[]][]) {
      await pool.query(`UPDATE ${table} SET status = 'INACTIVE' WHERE id = $1`, [id]);
      try {
        const response = await get();
        assert.equal(response.status, 200);
        assert.ok(response.body.data.items.every((p: any) => !hidden.includes(p.id)));
        for (const p of hidden) assert.equal((await get(buildingPath(p))).status, 404);
      } finally { await pool.query(`UPDATE ${table} SET status = 'ACTIVE' WHERE id = $1`, [id]); }
    }
  });

  it('rechecks grant revocation on every page and denies revoked parent even with its old cursor', async () => {
    const page = await get(buildingPath(props[1])).query({ limit: '1' });
    assert.ok(page.body.data.nextCursor);
    await revokeCareActorProperty({ careActorId: actorId, propertyId: props[1], clientId }, adminId);
    try {
      assert.equal((await get(buildingPath(props[1])).query({ limit: '1', cursor: page.body.data.nextCursor })).status, 404);
      const response = await get();
      assert.ok(!response.body.data.items.some((p: any) => p.id === props[1]));
    } finally { await grantCareActorProperty({ careActorId: actorId, propertyId: props[1], clientId }, adminId); }
  });

  it('paginates deterministically by canonical ID without duplicates or totals', async () => {
    for (const [url, expected] of [[path, [...props].sort()], [buildingPath(props[1]), [...buildings[1]].sort()]] as [string, string[]][]) {
      let cursor: string | undefined;
      const seen: string[] = [];
      do {
        const response = await get(url).query({ limit: '1', ...(cursor ? { cursor } : {}) });
        assert.equal(response.status, 200);
        assert.equal(response.body.data.items.length, 1);
        seen.push(response.body.data.items[0].id);
        assert.equal('total' in response.body.data, false);
        cursor = response.body.data.nextCursor;
      } while (cursor);
      assert.deepEqual(seen, expected);
    }
    const first = await get().query({ limit: '1' });
    const repeat = await get().query({ limit: '1' });
    assert.equal(first.body.data.nextCursor, repeat.body.data.nextCursor);
  });

  it('reauthorizes property and building rows between pages, including removed next rows', async () => {
    const first = await get().query({ limit: '1' });
    const removed = [...props].sort()[1];
    const cid = removed === props[2] ? otherClientId : clientId;
    // Grant administration retains its existing active-building assignment wall.
    if (removed === props[2]) await pool.query("UPDATE buildings SET status = 'ACTIVE' WHERE id = $1", [buildings[2][0]]);
    await revokeCareActorProperty({ careActorId: actorId, propertyId: removed, clientId: cid }, adminId);
    try {
      const next = await get().query({ limit: '1', cursor: first.body.data.nextCursor });
      assert.equal(next.status, 200);
      assert.deepEqual(next.body.data.items.map((p: any) => p.id), [[...props].sort()[2]]);
      assert.equal(next.body.data.nextCursor, null);
    } finally {
      await grantCareActorProperty({ careActorId: actorId, propertyId: removed, clientId: cid }, adminId);
      if (removed === props[2]) await pool.query("UPDATE buildings SET status = 'INACTIVE' WHERE id = $1", [buildings[2][0]]);
    }
    const bFirst = await get(buildingPath(props[1])).query({ limit: '1' });
    const inactive = [...buildings[1]].sort()[1];
    await pool.query("UPDATE buildings SET status = 'INACTIVE' WHERE id = $1", [inactive]);
    try {
      const next = await get(buildingPath(props[1])).query({ limit: '1', cursor: bFirst.body.data.nextCursor });
      assert.equal(next.status, 200);
      assert.deepEqual(next.body.data.items.map((b: any) => b.id), [[...buildings[1]].sort()[2]]);
      assert.equal(next.body.data.nextCursor, null);
    } finally { await pool.query("UPDATE buildings SET status = 'ACTIVE' WHERE id = $1", [inactive]); }
  });

  it('rejects tampered, wrong-session/actor/endpoint/property/limit cursors', async () => {
    const page = await get().query({ limit: '1' });
    const cursor = page.body.data.nextCursor;
    assert.ok(cursor);
    const secondToken = (await admit()).workspaceToken;
    for (const credential of [secondToken, otherToken]) {
      assert.equal((await get(path, credential).query({ limit: '1', cursor })).status, 400);
    }
    assert.equal((await get().query({ limit: '2', cursor })).status, 400);
    assert.equal((await get(buildingPath(props[0])).query({ limit: '1', cursor })).status, 400);
    for (const broken of ['nonsense', cursor.slice(0, -1), `A${cursor.slice(1)}`]) {
      assert.equal((await get().query({ limit: '1', cursor: broken })).status, 400);
    }
    const buildingsPage = await get(buildingPath(props[0])).query({ limit: '1' });
    assert.equal((await get(buildingPath(props[1])).query({ limit: '1', cursor: buildingsPage.body.data.nextCursor })).status, 400);
  });

  it('validates bounds/unknown fields and never takes careActorId or clientId from input', async () => {
    for (const q of [{ limit: '0' }, { limit: '101' }, { limit: '-1' }, { limit: '1.5' }, { limit: ['1', '2'] },
      { cursor: '' }, { cursor: 'x'.repeat(2049) }, { careActorId: otherActorId }, { clientId }, { offset: '0' }, { q: 'Granted' }]) {
      assert.equal((await get().query(q)).status, 400);
    }
    assert.equal((await get(buildingPath('not-a-uuid'))).status, 400);
    assert.equal((await get().send({ careActorId: otherActorId })).status, 400);
    assert.equal((await get().query({ limit: '100' })).status, 200);
  });

  it('authenticates both routes only with live care workspace credentials', async () => {
    const expired = 'hcw_' + 'X'.repeat(43);
    await pool.query(`INSERT INTO handyman_care_workspace_sessions
      (id, integration_id, care_actor_id, assertion_id, token_hash, created_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,now()-interval '16 minutes',now()-interval '1 minute')`,
      [randomUUID(), integrationId, actorId, randomUUID(), createHash('sha256').update(expired).digest('hex')]);
    const revoked = (await admit()).workspaceToken;
    await revokeCareWorkspaceSession(revoked);
    for (const url of [path, buildingPath(props[0])]) {
      assert.equal((await api().get(url)).status, 401);
      for (const bad of [userToken, expired, revoked, 'exchange-token', 'hcw_' + 'A'.repeat(43)]) {
        const r = await get(url, bad);
        assert.equal(r.status, 401);
        assert.equal(r.body.error.code, 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');
        assert.equal(r.headers['cache-control'], 'no-store');
      }
    }
  });

  it('denies inactive actor/integration or lost capability, without resurrection after reactivation', async () => {
    for (const [table, id, change, reset] of [
      ['handyman_handoff_care_actors', actorId, "status = 'INACTIVE'", "status = 'ACTIVE'"],
      ['handyman_handoff_integrations', integrationId, "status = 'INACTIVE'", "status = 'ACTIVE'"],
      ['handyman_handoff_integrations', integrationId, "actor_capability = 'NONE'", "actor_capability = 'CUSTOMER_CARE'"],
    ]) {
      const credential = (await admit()).workspaceToken;
      await pool.query(`UPDATE ${table} SET ${change} WHERE id = $1`, [id]);
      try {
        assert.equal((await get(path, credential)).status, 401);
        assert.equal((await get(buildingPath(props[0]), credential)).status, 401);
      } finally { await pool.query(`UPDATE ${table} SET ${reset} WHERE id = $1`, [id]); }
      assert.equal((await get(path, credential)).status, 401);
    }
  });

  it('revalidates session in the projection statement and fails closed on storage errors', async () => {
    const original = careWorkspaceScopeRepository.readScope;
    careWorkspaceScopeRepository.readScope = async (...args) => {
      await revokeCareWorkspaceSession(token);
      return original(...args);
    };
    try { assert.equal((await get()).status, 401); }
    finally { careWorkspaceScopeRepository.readScope = original; }
    token = (await admit()).workspaceToken;
    careWorkspaceScopeRepository.readScope = async () => { throw new Error('simulated scope outage'); };
    try { await assert.rejects(listCareWorkspaceScope(token, {}), /simulated scope outage/); }
    finally { careWorkspaceScopeRepository.readScope = original; }
  });

  it('does not change local bearer authority, create exchange separation, or out-of-scope routes', async () => {
    assert.equal((await get('/api/v1/properties', userToken)).status, 200);
    assert.equal((await get('/api/v1/properties')).status, 401);
    await assert.rejects(consumeHandoffExchange(token));
    for (const url of [`${path}/${props[0]}/tenant-companies/${randomUUID()}/pics`, `${path}/${props[0]}/catalogue/services`]) {
      assert.equal((await get(url)).status, 404);
    }
    assert.equal((await api().post(path).set('Authorization', `Bearer ${token}`).send({})).status, 404);
  });

  it('documents just the admitted care route families and bounded minimal projections', () => {
    const spec = parseYaml(readFileSync('docs/api/openapi.yaml', 'utf8'));
    assert.deepEqual(Object.keys(spec.paths).filter(p => p.startsWith('/handyman/care/')).sort(),
      ['/handyman/care/session', '/handyman/care/properties', '/handyman/care/properties/{propertyId}/buildings', '/handyman/care/properties/{propertyId}/tenant-companies', '/handyman/care/properties/{propertyId}/spaces', '/handyman/care/properties/{propertyId}/occupancies'].sort());
    for (const p of ['/handyman/care/properties', '/handyman/care/properties/{propertyId}/buildings']) {
      assert.deepEqual(Object.keys(spec.paths[p]), ['get']);
      assert.deepEqual(spec.paths[p].get.security, [{ careWorkspaceSession: [] }]);
    }
    assert.equal(spec.components.parameters.CareWorkspaceLimit.schema.maximum, 100);
    assert.equal(spec.components.parameters.CareWorkspaceLimit.schema.default, 25);
    assert.deepEqual(Object.keys(spec.components.schemas.CareWorkspaceProperty.properties).sort(), ['clientId', 'code', 'id', 'name']);
    assert.deepEqual(Object.keys(spec.components.schemas.CareWorkspaceBuilding.properties).sort(), ['code', 'id', 'name', 'propertyId']);
  });
});
