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
import { floorService } from '../src/modules/floors';
import { areaService } from '../src/modules/areas';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { listCareWorkspaceSpaces } from '../src/modules/handyman-care-workspace/care-workspace-scope.service';
import { careWorkspaceSpacesRepository } from '../src/modules/handyman-care-workspace/care-workspace-spaces.repository';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName,
  consumeHandoffExchange } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, revokeCareWorkspaceSession,
  signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { createAdminUser } from './helpers/access';

const DIR = '/tmp/handyman-care-workspace-spaces-pg';
const PORT = 55532;
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
let chains: { buildingId: string; floorId: string; areaId: string; roomId: string; spaceIds: string[] }[] = [];
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const path = '/api/v1/handyman/care/properties';
const spacePath = (id = props[0]) => `${path}/${id}/spaces`;
const get = (url = spacePath(), credential = token) => api().get(url).set('Authorization', `Bearer ${credential}`);
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

const visible = () => chains.slice(0, 2).flatMap(c => c.spaceIds).sort();
describe('Care workspace physical unit discovery', () => {
  it('reuses canonical space IDs and derives parent IDs without requiring or inferring occupancy', async () => {
    const response = await get();
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.body.data.items.map((s: any) => s.id), visible());
    for (const item of response.body.data.items) {
      assert.deepEqual(Object.keys(item).sort(), ['buildingId', 'code', 'id', 'name', 'roomId']);
      const chain = chains.find(c => c.spaceIds.includes(item.id))!;
      assert.equal(item.roomId, chain.roomId);
      assert.equal(item.buildingId, chain.buildingId);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM tenant_space_relationships')).rows[0].n, 0);
    assert.ok(!JSON.stringify(response.body).includes('tenant'));
    assert.ok(!JSON.stringify(response.body).includes('occupancy'));
    assert.deepEqual(Object.keys(response.body.data).sort(), ['evaluatedAt', 'items', 'nextCursor']);
  });

  it('excludes each inactive Space/Room/Area/Floor/Building ancestor independently', async () => {
    const chain = chains[0];
    for (const [table, id] of [['spaces', chain.spaceIds[0]], ['rooms', chain.roomId],
      ['areas', chain.areaId], ['floors', chain.floorId], ['buildings', chain.buildingId]]) {
      await pool.query(`UPDATE ${table} SET status = 'INACTIVE' WHERE id = $1`, [id]);
      try {
        const response = await get();
        assert.equal(response.status, 200);
        const excluded = table === 'spaces' ? [chain.spaceIds[0]] : chain.spaceIds;
        assert.deepEqual(response.body.data.items.map((s: any) => s.id), visible().filter(id => !excluded.includes(id)));
      } finally { await pool.query(`UPDATE ${table} SET status = 'ACTIVE' WHERE id = $1`, [id]); }
    }
  });

  it('denies inactive property/Client and tracks authoritative reparenting instead of cached scope', async () => {
    for (const [table, id] of [['properties', props[0]], ['clients', clientId]]) {
      await pool.query(`UPDATE ${table} SET status = 'INACTIVE' WHERE id = $1`, [id]);
      try { assert.equal((await get()).status, 404); }
      finally { await pool.query(`UPDATE ${table} SET status = 'ACTIVE' WHERE id = $1`, [id]); }
    }
    await pool.query('UPDATE floors SET building_id = $1 WHERE id = $2', [buildings[1][0], chains[0].floorId]);
    try {
      assert.deepEqual((await get()).body.data.items.map((s: any) => s.id), [...chains[1].spaceIds].sort());
      const other = await get(spacePath(props[1]));
      const moved = other.body.data.items.find((s: any) => s.id === chains[0].spaceIds[0]);
      assert.equal(moved.buildingId, buildings[1][0]);
    } finally { await pool.query('UPDATE floors SET building_id = $1 WHERE id = $2', [buildings[0][0], chains[0].floorId]); }
  });

  it('narrows by active building inside the property; foreign/missing/inactive selections are uniform 404', async () => {
    const response = await get().query({ buildingId: buildings[0][0] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.items.map((s: any) => s.id), [...chains[0].spaceIds].sort());
    for (const buildingId of [buildings[1][0], buildings[0][2], randomUUID()]) {
      const denied = await get().query({ buildingId });
      assert.equal(denied.status, 404);
      assert.equal(denied.body.error.code, 'HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND');
    }
    const empty = await get(spacePath(props[2]));
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.data.items, []);
    assert.equal(empty.body.data.nextCursor, null);
  });

  it('searches trimmed case-insensitive literal space name/code with no wildcard or regex expansion', async () => {
    const result = await get().query({ q: '  aLPHa  ' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data.items.map((s: any) => s.id), [chains[0].spaceIds[0], chains[1].spaceIds[0]].sort());
    const byCode = await get().query({ q: result.body.data.items[0].code.toLowerCase() });
    assert.deepEqual(byCode.body.data.items.map((s: any) => s.id), [result.body.data.items[0].id]);
    assert.deepEqual((await get().query({ q: '%_' })).body.data.items.map((s: any) => s.id), [chains[0].spaceIds[1]]);
    for (const q of ['.*', "' OR 1=1 --", 'absent']) {
      const response = await get().query({ q });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.data.items, []);
    }
  });

  it('pages deterministically by space ID without duplicates and rechecks hierarchy on the next page', async () => {
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
      const response = await get().query({ limit: '1', ...(cursor ? { cursor } : {}) });
      assert.equal(response.status, 200);
      assert.equal(response.body.data.items.length, 1);
      ids.push(response.body.data.items[0].id);
      cursor = response.body.data.nextCursor;
    } while (cursor);
    assert.deepEqual(ids, visible());
    const page = await get().query({ limit: '1' });
    const removed = visible()[1];
    await pool.query("UPDATE spaces SET status = 'INACTIVE' WHERE id = $1", [removed]);
    try {
      const next = await get().query({ limit: '1', cursor: page.body.data.nextCursor });
      assert.equal(next.status, 200);
      assert.equal(next.body.data.items[0].id, visible()[2]);
    } finally { await pool.query("UPDATE spaces SET status = 'ACTIVE' WHERE id = $1", [removed]); }
  });

  it('binds cursors to session/actor/property/building/search/limit/endpoint and rejects tampering', async () => {
    const cursor = (await get().query({ limit: '1' })).body.data.nextCursor;
    for (const q of [{ limit: '2', cursor }, { limit: '1', cursor, buildingId: buildings[0][0] },
      { limit: '1', cursor, q: 'Alpha' }, { limit: '1', cursor: 'A' + cursor.slice(1) }]) {
      assert.equal((await get().query(q)).status, 400);
    }
    for (const url of [spacePath(props[1]), path, `${path}/${props[0]}/tenant-companies`, `${path}/${props[0]}/buildings`]) {
      assert.equal((await get(url).query({ limit: '1', cursor })).status, 400);
    }
    for (const credential of [otherToken, (await admit()).workspaceToken]) {
      assert.equal((await get(spacePath(), credential).query({ limit: '1', cursor })).status, 400);
    }
    const page = await get().query({ limit: '1', q: ' Alpha ' });
    assert.equal((await get().query({ limit: '1', q: 'Alpha', cursor: page.body.data.nextCursor })).status, 200);
  });

  it('requires explicit active property grants, including when using an old cursor after revocation', async () => {
    for (const propertyId of [denied, foreign, randomUUID()]) assert.equal((await get(spacePath(propertyId))).status, 404);
    assert.equal((await get(spacePath(), otherToken)).status, 404);
    const cursor = (await get().query({ limit: '1' })).body.data.nextCursor;
    await revokeCareActorProperty({ careActorId: actorId, propertyId: props[0], clientId }, adminId);
    try {
      const response = await get().query({ limit: '1', cursor });
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND');
    } finally { await grantCareActorProperty({ careActorId: actorId, propertyId: props[0], clientId }, adminId); }
  });

  it('accepts only live workspace credentials, rejecting User/exchange/expired/revoked credentials', async () => {
    const expired = 'hcw_' + 'Z'.repeat(43);
    await pool.query(`INSERT INTO handyman_care_workspace_sessions
      (id, integration_id, care_actor_id, assertion_id, token_hash, created_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,now()-interval '16 minutes',now()-interval '1 minute')`,
      [randomUUID(), integrationId, actorId, randomUUID(), createHash('sha256').update(expired).digest('hex')]);
    const revoked = (await admit()).workspaceToken;
    await revokeCareWorkspaceSession(revoked);
    assert.equal((await api().get(spacePath())).status, 401);
    for (const credential of [userToken, 'exchange-token', expired, revoked]) {
      const response = await get(spacePath(), credential);
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  });

  it('revalidates actor/integration/capability and does not resurrect sessions', async () => {
    for (const [table, id, change, reset] of [
      ['handyman_handoff_care_actors', actorId, "status = 'INACTIVE'", "status = 'ACTIVE'"],
      ['handyman_handoff_integrations', integrationId, "status = 'INACTIVE'", "status = 'ACTIVE'"],
      ['handyman_handoff_integrations', integrationId, "actor_capability = 'NONE'", "actor_capability = 'CUSTOMER_CARE'"],
    ]) {
      token = (await admit()).workspaceToken;
      await pool.query(`UPDATE ${table} SET ${change} WHERE id = $1`, [id]);
      try { assert.equal((await get()).status, 401); }
      finally { await pool.query(`UPDATE ${table} SET ${reset} WHERE id = $1`, [id]); }
      assert.equal((await get()).status, 401);
    }
  });

  it('rejects invalid bounds and all caller Client/actor/tenant/occupancy authority fields', async () => {
    for (const q of [{ limit: '0' }, { limit: '101' }, { limit: '1.5' }, { limit: ['1', '2'] },
      { q: '' }, { q: ' ' }, { q: 'x'.repeat(101) }, { q: ['a', 'b'] }, { q: '\0' },
      { buildingId: 'bad' }, { careActorId: actorId }, { clientId }, { tenantCompanyId: randomUUID() },
      { occupancy: 'ACTIVE' }, { status: 'INACTIVE' }, { offset: '1' }, { cursor: '' }, { cursor: 'bad' }]) {
      assert.equal((await get().query(q)).status, 400);
    }
    assert.equal((await get(spacePath('bad'))).status, 400);
    assert.equal((await get().send({ clientId })).status, 400);
    assert.equal((await get().query({ limit: '100', q: 'x'.repeat(100) })).status, 200);
  });

  it('rechecks sessions in projection and fails closed on storage/signing failure', async () => {
    const original = careWorkspaceSpacesRepository.readSpaces;
    careWorkspaceSpacesRepository.readSpaces = async (...args) => {
      await revokeCareWorkspaceSession(token);
      return original(...args);
    };
    try { assert.equal((await get()).status, 401); }
    finally { careWorkspaceSpacesRepository.readSpaces = original; }
    token = (await admit()).workspaceToken;
    careWorkspaceSpacesRepository.readSpaces = async () => { throw new Error('space projection outage'); };
    try { await assert.rejects(listCareWorkspaceSpaces(token, {}, props[0]), /space projection outage/); }
    finally { careWorkspaceSpacesRepository.readSpaces = original; }
    delete process.env[envKey];
    try { await assert.rejects(listCareWorkspaceSpaces(token, {}, props[0]), /pagination is unavailable/); }
    finally { process.env[envKey] = SECRET; }
  });

  it('does not enable PIC/catalogue/request routes, mutation or create exchange substitution', async () => {
    for (const segment of [`tenant-companies/${randomUUID()}/pics`]) {
      assert.equal((await get(`${path}/${props[0]}/${segment}`)).status, 404);
    }
    assert.equal((await api().post(spacePath()).set('Authorization', `Bearer ${token}`).send({})).status, 404);
    assert.equal((await get(`/api/v1/spaces/${chains[0].spaceIds[0]}`, userToken)).status, 200);
    assert.equal((await get(`/api/v1/spaces/${chains[0].spaceIds[0]}`)).status, 401);
    await assert.rejects(consumeHandoffExchange(token));
  });

  it('documents one read-only route, existing workspace security and minimal canonical space fields', () => {
    const spec = parseYaml(readFileSync('docs/api/openapi.yaml', 'utf8'));
    const route = spec.paths['/handyman/care/properties/{propertyId}/spaces'];
    assert.deepEqual(Object.keys(route), ['get']);
    assert.deepEqual(route.get.security, [{ careWorkspaceSession: [] }]);
    assert.deepEqual(Object.keys(spec.components.schemas.CareWorkspaceSpace.properties).sort(), ['buildingId', 'code', 'id', 'name', 'roomId']);
    assert.equal(spec.components.schemas.CareWorkspaceSpace.additionalProperties, false);
    assert.equal(route.get.parameters.find((p: any) => p.name === 'q').schema.maxLength, 100);
  });
});
