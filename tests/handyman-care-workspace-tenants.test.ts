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
import { tenantCompanyRepository } from '../src/modules/tenant-companies';
import { tenantBuildingContextRepository } from '../src/modules/tenant-building-contexts';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { listCareWorkspaceTenants } from '../src/modules/handyman-care-workspace/care-workspace-scope.service';
import { careWorkspaceTenantsRepository } from '../src/modules/handyman-care-workspace/care-workspace-tenants.repository';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName,
  consumeHandoffExchange } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, revokeCareWorkspaceSession,
  signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { createAdminUser } from './helpers/access';

const DIR = '/tmp/handyman-care-workspace-tenants-pg';
const PORT = 55531;
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
let visible: string[] = [];
let contexts: Record<string, string> = {};
let literalTenant: string;
let siblingTenant: string;
let noContext: string;
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const path = '/api/v1/handyman/care/properties';
const tenantPath = (id = props[0]) => `${path}/${id}/tenant-companies`;
const get = (url = tenantPath(), credential = token) => api().get(url).set('Authorization', `Bearer ${credential}`);
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
  async function tenant(name: string, mode: string, b = buildings[0][0], cid = clientId) {
    const row = await tenantCompanyRepository.create({ clientId: cid, tenantCode: `TEN_${suffix()}`,
      tenantName: name, email: 'private@example.com', phone: 'private', address: 'private',
      status: mode === 'inactive-tenant' ? 'INACTIVE' : 'ACTIVE' });
    if (mode !== 'none') {
      const context = await tenantBuildingContextRepository.create({ tenantCompanyId: row.id, buildingId: b,
        status: mode === 'inactive-context' ? 'INACTIVE' : 'ACTIVE',
        effectiveFrom: mode === 'future' ? new Date(Date.now() + 86400000) : null,
        effectiveUntil: mode === 'expired' ? new Date(Date.now() - 86400000) : null });
      contexts[row.id] = context.id;
    }
    return row.id;
  }
  visible.push(await tenant('Alpha Market', 'active'));
  visible.push(await tenant('Beta Market', 'active'));
  literalTenant = await tenant('Literal %_\\ Store', 'active');
  visible.push(literalTenant);
  await tenantBuildingContextRepository.create({ tenantCompanyId: visible[0], buildingId: buildings[0][1],
    status: 'ACTIVE', effectiveFrom: new Date(Date.now() - 86400000), effectiveUntil: new Date(Date.now() + 86400000) });
  await tenant('Old Market', 'expired');
  await tenant('Future Market', 'future');
  await tenant('Inactive Market', 'inactive-tenant');
  await tenant('Inactive Context Market', 'inactive-context');
  noContext = await tenant('No Context Market', 'none');
  await tenant('Inactive Building Market', 'active', buildings[0][2]);
  siblingTenant = await tenant('Sibling Property Market', 'active', buildings[1][0]);
  await tenant('Mismatched Client Market', 'active', buildings[0][0], otherClientId);

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

describe('Care property-scoped tenant discovery', () => {
  it('returns only current ACTIVE property tenants, once each, without requiring a space or exposing private fields', async () => {
    const response = await get();
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.body.data.items.map((r: any) => r.id), [...visible].sort());
    for (const item of response.body.data.items) assert.deepEqual(Object.keys(item).sort(), ['id', 'tenantCode', 'tenantName']);
    assert.deepEqual(Object.keys(response.body.data).sort(), ['evaluatedAt', 'items', 'nextCursor']);
    assert.equal(response.body.data.nextCursor, null);
    assert.ok(Number.isFinite(Date.parse(response.body.data.evaluatedAt)));
    assert.ok(!JSON.stringify(response.body).includes('private'));
  });

  it('searches trimmed case-insensitive literal names/codes without SQL wildcard or regex interpretation', async () => {
    const a = await get().query({ q: '  aLpHa  ' });
    assert.equal(a.status, 200);
    assert.deepEqual(a.body.data.items.map((r: any) => r.id), [visible[0]]);
    const codeSearch = await get().query({ q: a.body.data.items[0].tenantCode.toLowerCase() });
    assert.deepEqual(codeSearch.body.data.items.map((r: any) => r.id), [visible[0]]);
    for (const q of ['%', '_\\']) {
      const response = await get().query({ q });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.data.items.map((r: any) => r.id), [literalTenant]);
    }
    for (const q of ['.*', "' OR 1=1 --", 'Old Market', 'Future Market', 'No Context']) {
      const response = await get().query({ q });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.data.items, []);
    }
  });

  it('narrows by active building in the granted property, without crossing property or Client', async () => {
    const response = await get().query({ buildingId: buildings[0][1] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.items.map((r: any) => r.id), [visible[0]]);
    for (const buildingId of [buildings[1][0], buildings[0][2], randomUUID()]) {
      const denied = await get().query({ buildingId });
      assert.equal(denied.status, 404);
      assert.equal(denied.body.error.code, 'HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND');
    }
    const sibling = await get(tenantPath(props[1]));
    assert.deepEqual(sibling.body.data.items.map((r: any) => r.id), [siblingTenant]);
    const empty = await get(tenantPath(props[2]));
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.data.items, []);
  });

  it('bounds and deduplicates deterministic ID keyset pages and binds search/building/route/session filters', async () => {
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
      const response = await get().query({ limit: '1', ...(cursor ? { cursor } : {}) });
      assert.equal(response.status, 200);
      assert.equal(response.body.data.items.length, 1);
      ids.push(response.body.data.items[0].id);
      cursor = response.body.data.nextCursor;
    } while (cursor);
    assert.deepEqual(ids, [...visible].sort());
    const first = await get().query({ limit: '1' });
    cursor = first.body.data.nextCursor;
    for (const q of [{ limit: '2', cursor }, { limit: '1', cursor, q: 'Market' },
      { limit: '1', cursor, buildingId: buildings[0][0] }, { limit: '1', cursor: 'A' + cursor!.slice(1) }]) {
      assert.equal((await get().query(q)).status, 400);
    }
    assert.equal((await get(tenantPath(props[1])).query({ limit: '1', cursor })).status, 400);
    assert.equal((await get(path).query({ limit: '1', cursor })).status, 400);
    assert.equal((await get(tenantPath(), (await admit()).workspaceToken).query({ limit: '1', cursor })).status, 400);
    assert.equal((await get(tenantPath(), otherToken).query({ limit: '1', cursor })).status, 400);
    const search = await get().query({ limit: '1', q: '  Market  ' });
    assert.equal((await get().query({ limit: '1', q: 'Market', cursor: search.body.data.nextCursor })).status, 200);
  });

  it('reauthorizes effective context/tenant status between pages rather than treating a cursor as a historical snapshot', async () => {
    const sorted = [...visible].sort();
    const removed = sorted[1];
    const first = await get().query({ limit: '1' });
    await pool.query("UPDATE tenant_building_contexts SET effective_until = now() - interval '1 second' WHERE tenant_company_id = $1", [removed]);
    try {
      const next = await get().query({ limit: '1', cursor: first.body.data.nextCursor });
      assert.equal(next.status, 200);
      assert.deepEqual(next.body.data.items.map((r: any) => r.id), [sorted[2]]);
    } finally { await pool.query('UPDATE tenant_building_contexts SET effective_until = NULL WHERE tenant_company_id = $1', [removed]); }
    await pool.query("UPDATE tenant_companies SET status = 'INACTIVE' WHERE id = $1", [removed]);
    try { assert.ok(!(await get()).body.data.items.some((r: any) => r.id === removed)); }
    finally { await pool.query("UPDATE tenant_companies SET status = 'ACTIVE' WHERE id = $1", [removed]); }
  });

  it('evaluates inclusive effective boundaries at the same database statement time as projection', async () => {
    // Use a controlled effective-context clock in the real repository SQL to
    // test equality at both boundaries without timing-sensitive sleeps.
    const original = pool.query.bind(pool);
    pool.query = (async (sql: any, params: any) => {
      if (typeof sql === 'string' && sql.includes('selected_buildings AS')) {
        sql = sql.replaceAll('statement_timestamp()', "'2026-10-08T00:00:00Z'::timestamptz");
        // Authentication uses the real clock; the fixed boundary applies to occupancy only.
        sql = sql.replace("s.expires_at > '2026-10-08T00:00:00Z'::timestamptz", 's.expires_at > statement_timestamp()');
      }
      return original(sql, params);
    }) as typeof pool.query;
    const context = await tenantBuildingContextRepository.create({ tenantCompanyId: noContext, buildingId: buildings[0][0], status: 'ACTIVE',
      effectiveFrom: new Date('2026-10-08T00:00:00Z'), effectiveUntil: new Date('2026-10-08T00:00:00Z') });
    try {
      const response = await get();
      assert.equal(response.status, 200);
      assert.ok(response.body.data.items.some((r: any) => r.id === noContext));
    } finally {
      pool.query = original;
      await tenantBuildingContextRepository.update(context.id, { status: 'INACTIVE' });
    }
  });

  it('requires a live workspace credential; User, exchange, missing, expired and revoked tokens fail closed', async () => {
    const expired = 'hcw_' + 'T'.repeat(43);
    await pool.query(`INSERT INTO handyman_care_workspace_sessions
      (id, integration_id, care_actor_id, assertion_id, token_hash, created_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,now()-interval '16 minutes',now()-interval '1 minute')`,
      [randomUUID(), integrationId, actorId, randomUUID(), createHash('sha256').update(expired).digest('hex')]);
    const revoked = (await admit()).workspaceToken;
    await revokeCareWorkspaceSession(revoked);
    assert.equal((await api().get(tenantPath())).status, 401);
    for (const credential of [expired, revoked, userToken, 'exchange-token']) {
      const response = await get(tenantPath(), credential);
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  });

  it('requires current property grant and active hierarchy, with uniform absent/inaccessible denials', async () => {
    for (const id of [denied, foreign, randomUUID()]) assert.equal((await get(tenantPath(id))).status, 404);
    assert.equal((await get(tenantPath(), otherToken)).status, 404);
    const first = await get().query({ limit: '1' });
    await revokeCareActorProperty({ careActorId: actorId, propertyId: props[0], clientId }, adminId);
    try {
      const response = await get().query({ limit: '1', cursor: first.body.data.nextCursor });
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND');
    } finally { await grantCareActorProperty({ careActorId: actorId, propertyId: props[0], clientId }, adminId); }
    for (const [table, id] of [['properties', props[0]], ['clients', clientId]]) {
      await pool.query(`UPDATE ${table} SET status = 'INACTIVE' WHERE id = $1`, [id]);
      try { assert.equal((await get()).status, 404); }
      finally { await pool.query(`UPDATE ${table} SET status = 'ACTIVE' WHERE id = $1`, [id]); }
    }
  });

  it('denies inactive actor/integration or capability loss and revalidates sessions inside projection', async () => {
    for (const [table, id, change, restore] of [
      ['handyman_handoff_care_actors', actorId, "status = 'INACTIVE'", "status = 'ACTIVE'"],
      ['handyman_handoff_integrations', integrationId, "status = 'INACTIVE'", "status = 'ACTIVE'"],
      ['handyman_handoff_integrations', integrationId, "actor_capability = 'NONE'", "actor_capability = 'CUSTOMER_CARE'"],
    ]) {
      token = (await admit()).workspaceToken;
      await pool.query(`UPDATE ${table} SET ${change} WHERE id = $1`, [id]);
      try { assert.equal((await get()).status, 401); }
      finally { await pool.query(`UPDATE ${table} SET ${restore} WHERE id = $1`, [id]); }
      assert.equal((await get()).status, 401);
    }
    token = (await admit()).workspaceToken;
    const original = careWorkspaceTenantsRepository.readTenants;
    careWorkspaceTenantsRepository.readTenants = async (...args) => {
      await revokeCareWorkspaceSession(token);
      return original(...args);
    };
    try { assert.equal((await get()).status, 401); }
    finally { careWorkspaceTenantsRepository.readTenants = original; }
  });

  it('rejects invalid bounds, query/body authority injection and unexpected fields', async () => {
    for (const q of [{ limit: '0' }, { limit: '101' }, { limit: '1.5' }, { limit: ['1', '2'] },
      { q: '' }, { q: '   ' }, { q: 'x'.repeat(101) }, { q: ['A', 'B'] }, { q: '\0' },
      { buildingId: 'bad' }, { careActorId: actorId }, { clientId }, { status: 'INACTIVE' }, { offset: '0' },
      { cursor: 'invalid' }, { cursor: '' }]) assert.equal((await get().query(q)).status, 400);
    assert.equal((await get(tenantPath('bad-id'))).status, 400);
    assert.equal((await get().send({ clientId })).status, 400);
    assert.equal((await get().query({ q: 'x'.repeat(100), limit: '100' })).status, 200);
  });

  it('fails closed on storage failure and leaves out-of-scope surfaces and bearer/create separation unchanged', async () => {
    const original = careWorkspaceTenantsRepository.readTenants;
    careWorkspaceTenantsRepository.readTenants = async () => { throw new Error('tenant projection outage'); };
    try { await assert.rejects(listCareWorkspaceTenants(token, {}, props[0]), /tenant projection outage/); }
    finally { careWorkspaceTenantsRepository.readTenants = original; }
    await assert.rejects(consumeHandoffExchange(token));
    for (const suffix of ['catalogue/services', `tenant-companies/${randomUUID()}/pics`]) {
      assert.equal((await get(`${path}/${props[0]}/${suffix}`)).status, 404);
    }
    assert.equal((await api().post(tenantPath()).set('Authorization', `Bearer ${token}`).send({})).status, 404);
    assert.equal((await get(`/api/v1/clients/${clientId}/tenant-companies`, userToken)).status, 200);
    assert.equal((await get(`/api/v1/clients/${clientId}/tenant-companies`)).status, 401);
  });

  it('documents the exact read-only route, closed minimal projection and existing workspace pagination', () => {
    const spec = parseYaml(readFileSync('docs/api/openapi.yaml', 'utf8'));
    const route = spec.paths['/handyman/care/properties/{propertyId}/tenant-companies'];
    assert.deepEqual(Object.keys(route), ['get']);
    assert.deepEqual(route.get.security, [{ careWorkspaceSession: [] }]);
    assert.deepEqual(Object.keys(spec.components.schemas.CareWorkspaceTenant.properties).sort(), ['id', 'tenantCode', 'tenantName']);
    assert.equal(spec.components.schemas.CareWorkspaceTenant.additionalProperties, false);
    assert.equal(route.get.parameters.find((p: any) => p.name === 'q').schema.maxLength, 100);
  });
});
