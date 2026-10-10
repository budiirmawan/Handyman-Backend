import { serviceCatalogService } from '../src/modules/service-catalog';
import { issueCareCreateExchange } from '../src/modules/handyman-care-workspace/care-create-exchange.service';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import { tenantSpaceRepository } from '../src/modules/tenant-spaces';
import { floorService } from '../src/modules/floors';
import { areaService } from '../src/modules/areas';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName,
  consumeHandoffExchange, acceptHandoffAssertion, signHandoffAssertion } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, revokeCareWorkspaceSession,
  signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { createAdminUser } from './helpers/access';

/** Unique per call: token_hash is UNIQUE, so fixed tokens collide across tests. */
const uniqueWorkspaceToken = (): string => 'hcw_' + randomBytes(32).toString('base64url');


const DIR = '/tmp/handyman-care-workspace-create-exchange-pg';
const PORT = 55535;
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
let serviceId: string;
let clientId: string;
let otherClientId: string;
let props: string[] = [];
let buildings: string[][] = [];
let denied: string;
let foreign: string;
let tenantId: string;
let buildingOnlyTenant: string;
let newTenant: string;
let crossClientTenant: string;
let contextIds: string[] = [];
let relationshipIds: string[] = [];
const unitQuery = () => ({ tenantCompanyId: tenantId, buildingId: buildings[0][0], spaceId: chains[0].spaceIds[0] });
let chains: { buildingId: string; floorId: string; areaId: string; roomId: string; spaceIds: string[] }[] = [];
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const path = '/api/v1/handyman/care/properties';
const exchangePath = (id = props[0]) => `${path}/${id}/create-exchanges`;
const post = (body: unknown = unitQuery(), credential = token, propertyId = props[0]) =>
  api().post(exchangePath(propertyId)).set('Authorization', `Bearer ${credential}`).send(body as any);
const care = (exchangeToken: string, extra = {}) => api().post('/api/v1/handyman/requests/care')
  .send({ exchangeToken, serviceCatalogId: serviceId, ...extra });
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
  assert.ok(config, 'Focused create-exchange tests require PostgreSQL (no silent skips)');
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
  serviceId = (await serviceCatalogService.createServiceCatalogEntry({ clientId, code: `HM_${suffix()}`, name: 'Repair', category: 'HANDYMAN' }, adminId)).id;
  for (const buildingId of buildings.flat()) {
    const floor = await floorService.createFloor({ buildingId, code: `F_${suffix()}`, name: 'Floor', levelNumber: chains.length + 1 });
    const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
    const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
    const first = await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Alpha Unit', description: 'Not for projection' });
    const second = await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`,
      name: chains.length === 0 ? 'Literal %_ Unit' : 'Beta Unit' });
    chains.push({ buildingId, floorId: floor.id, areaId: area.id, roomId: room.id, spaceIds: [first.id, second.id] });
  }
  await pool.query("UPDATE buildings SET status = 'INACTIVE' WHERE property_id = $1 OR id = $2", [props[2], buildings[0][2]]);
  denied = (await propertyService.createProperty({ clientId, code: `P_${suffix()}`, name: 'Not granted same client' })).id;
  foreign = (await propertyService.createProperty({ clientId: otherClientId, code: `P_${suffix()}`, name: 'Not granted other client' })).id;
  otherActorId = (await handymanCareActorService.createCareActor({ integrationId, actorReference: 'other-care', displayName: 'Other care' })).id;
  async function tenant(client = clientId) {
    return (await tenantCompanyRepository.create({ clientId: client, tenantCode: `T_${suffix()}`, tenantName: 'Tenant', email: 'private@example.com' })).id;
  }
  tenantId = await tenant();
  buildingOnlyTenant = await tenant();
  newTenant = await tenant();
  crossClientTenant = await tenant(otherClientId);
  for (const buildingId of buildings[0].slice(0, 2)) {
    contextIds.push((await tenantBuildingContextRepository.create({ tenantCompanyId: tenantId, buildingId,
      status: 'ACTIVE', effectiveFrom: null, effectiveUntil: null })).id);
  }
  for (const [tc, b] of [[buildingOnlyTenant, buildings[0][1]], [newTenant, buildings[0][0]], [crossClientTenant, buildings[0][0]]]) {
    await tenantBuildingContextRepository.create({ tenantCompanyId: tc, buildingId: b, status: 'ACTIVE', effectiveFrom: null, effectiveUntil: null });
  }
  for (const spaceId of chains[0].spaceIds) {
    relationshipIds.push((await tenantSpaceRepository.create({ tenantCompanyId: tenantId, buildingId: buildings[0][0], spaceId,
      status: 'ACTIVE', effectiveFrom: null, effectiveUntil: null })).id);
  }

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

async function issue(body = unitQuery()) {
  const response = await post(body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.headers['cache-control'], 'no-store');
  return response.body.data;
}
async function row(raw: string) {
  const record = await handoffRuntimeRepository.findExchangeByTokenHash(createHash('sha256').update(raw).digest('hex'));
  assert.ok(record);
  return record;
}
async function counts() {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM handyman_handoff_assertions) AS receipts,
    (SELECT count(*)::int FROM handyman_handoff_exchanges) AS exchanges,
    (SELECT count(*)::int FROM handyman_service_requests) AS requests,
    (SELECT count(*)::int FROM handyman_channel_attributions) AS attributions,
    (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM user_sessions) AS sessions`)).rows[0];
}

describe('PART 05B — workspace create-only exchange issuance', () => {
  it('issues fresh hash-only short-lived exchanges from a reusable workspace, with canonical actor/customer/location/channel', async () => {
    const before = await counts();
    const first = await issue();
    const second = await issue();
    assert.notEqual(first.exchangeToken, second.exchangeToken);
    assert.notEqual(first.exchangeToken, token);
    const stored = await row(first.exchangeToken);
    assert.equal(stored.purpose, 'CARE_CREATE');
    assert.equal(stored.carePropertyId, props[0]);
    assert.equal(stored.integrationId, integrationId);
    assert.equal(stored.careActorId, actorId);
    assert.equal(stored.actorReference, 'care-operator');
    assert.ok(stored.workspaceSessionId);
    assert.equal(stored.status, 'ACTIVE');
    assert.equal(stored.usedAt, null);
    assert.ok(stored.expiresAt.getTime() > Date.now());
    assert.ok(stored.expiresAt.getTime() <= Date.now() + 120_000);
    assert.deepEqual(first.context, { ...unitQuery(), propertyId: props[0], clientId,
      tenantPicId: null, resolvedUserId: null, tenantBuildingContextId: contextIds[0],
      tenantSpaceRelationshipId: relationshipIds[0], actorType: 'CUSTOMER_CARE',
      careActorId: actorId, actorReference: 'care-operator', originChannel: 'BM_SUPER_APP' });
    const receipt = await handoffRuntimeRepository.findAssertionById(stored.handoffAssertionId);
    assert.ok(receipt?.assertionId.startsWith(`workspace-create:${stored.workspaceSessionId}:`));
    assert.match(receipt!.assertionHash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify({ stored, receipt }).includes(first.exchangeToken));
    assert.deepEqual(await counts(), { ...before, receipts: before.receipts + 2, exchanges: before.exchanges + 2 });
    await assert.rejects(pool.query("UPDATE handyman_handoff_exchanges SET purpose = 'HANDOFF', workspace_session_id = NULL, care_property_id = NULL WHERE id = $1", [stored.id]), /immutable/);
    await assert.rejects(pool.query('UPDATE handyman_handoff_exchanges SET care_property_id = $1 WHERE id = $2', [props[1], stored.id]), /immutable/);
  });

  it('creates through the unchanged care POST, preserving provenance without local User/PIC impersonation; reuse fails', async () => {
    const fresh = await issue();
    const before = await counts();
    const response = await care(fresh.exchangeToken, { description: 'Pipe repair' });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const request = response.body.data;
    assert.equal(request.tenantCompanyId, tenantId);
    assert.equal(request.clientId, clientId);
    assert.equal(request.buildingId, buildings[0][0]);
    assert.equal(request.spaceId, chains[0].spaceIds[0]);
    assert.equal(request.createdByUserId, null);
    assert.equal(request.tenantPicId, null);
    assert.equal(request.originChannel, 'BM_SUPER_APP');
    const attr = (await pool.query('SELECT * FROM handyman_channel_attributions WHERE id = $1', [request.channelAttributionId])).rows[0];
    assert.equal(attr.care_actor_id, actorId);
    assert.equal(attr.actor_reference, 'care-operator');
    assert.equal(attr.actor_type, 'CUSTOMER_CARE');
    assert.equal(attr.created_by_user_id, null);
    assert.ok(attr.origin_reference.startsWith(`bm-handoff:${code}:workspace-create:`));
    assert.deepEqual(await counts(), { ...before, requests: before.requests + 1, attributions: before.attributions + 1 });
    assert.equal((await row(fresh.exchangeToken)).status, 'USED');
    assert.equal((await care(fresh.exchangeToken)).status, 401);
  });

  it('accepts effective building-only context with no artificial space or PIC requirement', async () => {
    const fresh = await issue({ tenantCompanyId: buildingOnlyTenant, buildingId: buildings[0][1] } as any);
    assert.equal(fresh.context.spaceId, null);
    assert.equal(fresh.context.tenantSpaceRelationshipId, null);
    const response = await care(fresh.exchangeToken);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.spaceId, null);
    assert.equal(response.body.data.tenantCompanyId, buildingOnlyTenant);
    assert.equal(response.body.data.buildingId, buildings[0][1]);
  });

  it('is create-only: generic consume, standalone attribution, bearer routes, and workspace-as-create-token all fail', async () => {
    const fresh = await issue();
    const before = await counts();
    await assert.rejects(consumeHandoffExchange(fresh.exchangeToken), (e: any) => e.statusCode === 401);
    assert.equal((await api().post('/api/v1/handoff/channel-attributions').send({ exchangeToken: fresh.exchangeToken })).status, 401);
    assert.equal((await api().get(path).set('Authorization', `Bearer ${fresh.exchangeToken}`)).status, 401);
    assert.equal((await post(unitQuery(), fresh.exchangeToken)).status, 401);
    assert.equal((await api().post('/api/v1/handyman/requests').set('Authorization', `Bearer ${fresh.exchangeToken}`)
      .send({ serviceCatalogId: serviceId })).status, 401);
    assert.equal((await care(token)).status, 401);
    assert.equal((await row(fresh.exchangeToken)).status, 'ACTIVE');
    assert.deepEqual(await counts(), before);
    assert.equal((await care(fresh.exchangeToken)).status, 201);
  });

  it('keeps legacy signed handoff exchanges usable by the existing generic consume and standalone binding', async () => {
    for (const standalone of [false, true]) {
      const a = { integrationCode: code, assertionId: randomUUID(), issuedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(), ...unitQuery() };
      const accepted = await acceptHandoffAssertion(a, signHandoffAssertion(a, SECRET));
      assert.equal((await row(accepted.exchangeToken)).purpose, 'HANDOFF');
      if (standalone) assert.equal((await api().post('/api/v1/handoff/channel-attributions').send({ exchangeToken: accepted.exchangeToken })).status, 201);
      else await consumeHandoffExchange(accepted.exchangeToken);
    }
  });

  it('requires a live workspace and the selected active property grant; denies wrong kind and cross-property/Client selection', async () => {
    const before = await counts();
    assert.equal((await api().post(exchangePath()).send(unitQuery())).status, 401);
    for (const credential of [userToken, 'not-a-token']) assert.equal((await post(unitQuery(), credential)).status, 401);
    assert.equal((await post(unitQuery(), otherToken)).status, 404);
    for (const prop of [props[1], denied, foreign, randomUUID()]) assert.equal((await post(unitQuery(), token, prop)).status, 404);
    assert.equal((await post({ ...unitQuery(), tenantCompanyId: crossClientTenant })).status, 404);
    await revokeCareActorProperty({ careActorId: actorId, propertyId: props[0], clientId }, adminId);
    try { assert.equal((await post()).status, 404); }
    finally { await grantCareActorProperty({ careActorId: actorId, propertyId: props[0], clientId }, adminId); }
    await revokeCareWorkspaceSession(token);
    assert.equal((await post()).status, 401);
    assert.deepEqual(await counts(), before);
  });

  it('rejects authority overrides, malformed selectors, null/array space and all query parameters', async () => {
    const before = await counts();
    for (const body of [{}, { ...unitQuery(), buildingId: 'bad' }, { ...unitQuery(), tenantCompanyId: null },
      { ...unitQuery(), spaceId: null }, { ...unitQuery(), spaceId: [chains[0].spaceIds[0]] }, [],
      ...['clientId', 'careActorId', 'actorReference', 'propertyId', 'tenantPicId', 'resolvedUserId', 'createdByUserId',
        'originChannel', 'originReference', 'expiresAt', 'purpose', 'tenantBuildingContextId', 'tenantSpaceRelationshipId', 'cursor']
        .map(key => ({ ...unitQuery(), [key]: randomUUID() }))]) {
      assert.equal((await post(body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await post(unitQuery(), token, 'bad')).status, 400);
    assert.equal((await post().query({ clientId })).status, 400);
    assert.deepEqual(await counts(), before);
  });

  it('requires exact current occupancy and active full physical/tenant/Client hierarchy', async () => {
    const before = await counts();
    assert.equal((await post({ ...unitQuery(), spaceId: chains[1].spaceIds[0] })).status, 404);
    assert.equal((await post({ ...unitQuery(), tenantCompanyId: newTenant })).status, 404);
    const c = chains[0];
    for (const [table, id] of [['tenant_companies', tenantId], ['clients', clientId], ['properties', props[0]],
      ['buildings', c.buildingId], ['floors', c.floorId], ['areas', c.areaId], ['rooms', c.roomId], ['spaces', c.spaceIds[0]],
      ['tenant_building_contexts', contextIds[0]], ['tenant_space_relationships', relationshipIds[0]]]) {
      await pool.query(`UPDATE ${table} SET status = 'INACTIVE' WHERE id = $1`, [id]);
      try { assert.equal((await post()).status, 404, table); }
      finally { await pool.query(`UPDATE ${table} SET status = 'ACTIVE' WHERE id = $1`, [id]); }
    }
    for (const [table, id] of [['tenant_building_contexts', contextIds[0]], ['tenant_space_relationships', relationshipIds[0]]]) {
      for (const field of ['effective_from', 'effective_until']) {
        await pool.query(`UPDATE ${table} SET ${field} = now() ${field === 'effective_from' ? '+' : '-'} interval '1 day' WHERE id = $1`, [id]);
        try { assert.equal((await post()).status, 404); }
        finally { await pool.query(`UPDATE ${table} SET ${field} = NULL WHERE id = $1`, [id]); }
      }
    }
    assert.deepEqual(await counts(), before);
  });

  it('fails closed on actor/integration/capability changes at issuance and consumption, even after reactivation', async () => {
    for (const [table, id, change, reset] of [
      ['handyman_handoff_care_actors', actorId, "status = 'INACTIVE'", "status = 'ACTIVE'"],
      ['handyman_handoff_integrations', integrationId, "status = 'INACTIVE'", "status = 'ACTIVE'"],
      ['handyman_handoff_integrations', integrationId, "actor_capability = 'NONE'", "actor_capability = 'CUSTOMER_CARE'"],
    ]) {
      token = (await admit()).workspaceToken;
      const fresh = await issue();
      await pool.query(`UPDATE ${table} SET ${change} WHERE id = $1`, [id]);
      try {
        assert.equal((await post()).status, 401);
        assert.equal((await care(fresh.exchangeToken)).status, 401);
      } finally { await pool.query(`UPDATE ${table} SET ${reset} WHERE id = $1`, [id]); }
      assert.equal((await post()).status, 401);
      assert.equal((await care(fresh.exchangeToken)).status, 401);
      assert.equal((await row(fresh.exchangeToken)).status, 'ACTIVE');
    }
  });

  it('caps TTL by both configured exchange lifetime and remaining workspace lifetime, and rejects expired credentials', async () => {
    const original = process.env.HANDYMAN_HANDOFF_EXCHANGE_TTL_SECONDS;
    try {
      process.env.HANDYMAN_HANDOFF_EXCHANGE_TTL_SECONDS = '900';
      assert.ok(new Date((await issue()).expiresAt).getTime() <= Date.now() + 120_000);
      process.env.HANDYMAN_HANDOFF_EXCHANGE_TTL_SECONDS = '20';
      assert.ok(new Date((await issue()).expiresAt).getTime() <= Date.now() + 20_000);
      process.env.HANDYMAN_HANDOFF_EXCHANGE_TTL_SECONDS = '120';
      const short = uniqueWorkspaceToken();
      const expired = uniqueWorkspaceToken();
      for (const [raw, duration] of [[short, '90 seconds'], [expired, '-1 seconds']]) {
        await pool.query(`INSERT INTO handyman_care_workspace_sessions
          (id, integration_id, care_actor_id, assertion_id, token_hash, created_at, expires_at)
          VALUES ($1,$2,$3,$4,$5,clock_timestamp()-interval '2 minutes',clock_timestamp()+$6::interval)`,
          [randomUUID(), integrationId, actorId, randomUUID(), createHash('sha256').update(raw).digest('hex'), duration]);
      }
      const response = await post(unitQuery(), short);
      assert.equal(response.status, 201);
      const stored = await row(response.body.data.exchangeToken);
      const session = (await pool.query('SELECT expires_at FROM handyman_care_workspace_sessions WHERE id = $1', [stored.workspaceSessionId])).rows[0];
      assert.equal(stored.expiresAt.toISOString(), session.expires_at.toISOString());
      assert.equal((await post(unitQuery(), expired)).status, 401);
      await pool.query("UPDATE handyman_handoff_exchanges SET expires_at = now()-interval '1 second' WHERE id = $1", [stored.id]);
      assert.equal((await care(response.body.data.exchangeToken)).status, 401);
    } finally {
      if (original === undefined) delete process.env.HANDYMAN_HANDOFF_EXCHANGE_TTL_SECONDS;
      else process.env.HANDYMAN_HANDOFF_EXCHANGE_TTL_SECONDS = original;
    }
  });

  it('revalidates grant, workspace, physical hierarchy and original property when consuming without burning failed exchanges', async () => {
    let fresh = await issue();
    await revokeCareActorProperty({ careActorId: actorId, propertyId: props[0], clientId }, adminId);
    try { assert.equal((await care(fresh.exchangeToken)).status, 401); }
    finally { await grantCareActorProperty({ careActorId: actorId, propertyId: props[0], clientId }, adminId); }
    assert.equal((await row(fresh.exchangeToken)).status, 'ACTIVE');
    await revokeCareWorkspaceSession(token);
    assert.equal((await care(fresh.exchangeToken)).status, 401);
    token = (await admit()).workspaceToken;
    fresh = await issue();
    await pool.query("UPDATE rooms SET status = 'INACTIVE' WHERE id = $1", [chains[0].roomId]);
    try { assert.equal((await care(fresh.exchangeToken)).status, 401); }
    finally { await pool.query("UPDATE rooms SET status = 'ACTIVE' WHERE id = $1", [chains[0].roomId]); }
    // Both properties are granted: a building move must still not rebind the selected property.
    await pool.query('UPDATE buildings SET property_id = $1 WHERE id = $2', [props[1], buildings[0][0]]);
    try { assert.equal((await care(fresh.exchangeToken)).status, 401); }
    finally { await pool.query('UPDATE buildings SET property_id = $1 WHERE id = $2', [props[0], buildings[0][0]]); }
    assert.equal((await row(fresh.exchangeToken)).status, 'ACTIVE');
  });

  it('denies occupancy turnover, including replacement with a new relationship for the same customer', async () => {
    for (const [table, original] of [['tenant_space_relationships', relationshipIds[0]], ['tenant_building_contexts', contextIds[0]]]) {
      const fresh = await issue();
      await pool.query(`UPDATE ${table} SET status = 'INACTIVE' WHERE id = $1`, [original]);
      const replacement = table === 'tenant_space_relationships'
        ? await tenantSpaceRepository.create({ ...unitQuery(), status: 'ACTIVE', effectiveFrom: null, effectiveUntil: null })
        : await tenantBuildingContextRepository.create({ tenantCompanyId: tenantId, buildingId: buildings[0][0], status: 'ACTIVE', effectiveFrom: null, effectiveUntil: null });
      try {
        assert.equal((await care(fresh.exchangeToken)).status, 401);
        assert.equal((await row(fresh.exchangeToken)).status, 'ACTIVE');
        const next = await issue();
        assert.equal(next.context[table === 'tenant_space_relationships' ? 'tenantSpaceRelationshipId' : 'tenantBuildingContextId'], replacement.id);
      } finally {
        await pool.query(`UPDATE ${table} SET status = 'INACTIVE' WHERE id = $1`, [replacement.id]);
        await pool.query(`UPDATE ${table} SET status = 'ACTIVE' WHERE id = $1`, [original]);
      }
    }
  });

  it('rechecks workspace after initial authentication and rolls back the issuance receipt on exchange storage failure', async () => {
    const before = await counts();
    const find = tenantCompanyRepository.findById;
    tenantCompanyRepository.findById = async (...args) => {
      tenantCompanyRepository.findById = find;
      await revokeCareWorkspaceSession(token);
      return find(...args);
    };
    try { assert.equal((await post()).status, 401); }
    finally { tenantCompanyRepository.findById = find; }
    token = (await admit()).workspaceToken;
    const create = handoffRuntimeRepository.createExchange;
    handoffRuntimeRepository.createExchange = async () => { throw new Error('issuance storage unavailable'); };
    try { await assert.rejects(issueCareCreateExchange(token, props[0], unitQuery()), /issuance storage unavailable/); }
    finally { handoffRuntimeRepository.createExchange = create; }
    assert.deepEqual(await counts(), before);
  });

  it('consumes at most once under concurrent care creation and rolls back failed request validation', async () => {
    const fresh = await issue();
    const invalid = await care(fresh.exchangeToken, { serviceCatalogId: randomUUID() });
    assert.notEqual(invalid.status, 201);
    assert.equal((await row(fresh.exchangeToken)).status, 'ACTIVE');
    const before = await counts();
    const responses = await Promise.all([care(fresh.exchangeToken), care(fresh.exchangeToken)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 401]);
    assert.deepEqual(await counts(), { ...before, requests: before.requests + 1, attributions: before.attributions + 1 });
  });

  it('documents a closed workspace-authenticated create-exchange selection and short-lived create-only response', () => {
    const spec = parseYaml(readFileSync('docs/api/openapi.yaml', 'utf8'));
    const route = spec.paths['/handyman/care/properties/{propertyId}/create-exchanges'];
    assert.deepEqual(Object.keys(route), ['post']);
    assert.deepEqual(route.post.security, [{ careWorkspaceSession: [] }]);
    const input = spec.components.schemas.CareCreateExchangeSelection;
    assert.equal(input.additionalProperties, false);
    assert.deepEqual(input.required, ['tenantCompanyId', 'buildingId']);
    assert.deepEqual(Object.keys(input.properties).sort(), ['buildingId', 'spaceId', 'tenantCompanyId']);
    assert.match(route.post.description, /single-use/);
    assert.match(route.post.description, /120 seconds/);
  });
});
