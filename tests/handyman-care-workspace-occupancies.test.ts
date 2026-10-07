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
import { tenantSpaceRepository } from '../src/modules/tenant-spaces';
import { floorService } from '../src/modules/floors';
import { areaService } from '../src/modules/areas';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { listCareWorkspaceOccupancies } from '../src/modules/handyman-care-workspace/care-workspace-scope.service';
import { careWorkspaceOccupanciesRepository } from '../src/modules/handyman-care-workspace/care-workspace-occupancies.repository';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName,
  consumeHandoffExchange } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, revokeCareWorkspaceSession,
  signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { createAdminUser } from './helpers/access';

const DIR = '/tmp/handyman-care-workspace-occupancies-pg';
const PORT = 55533;
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
const occupancyPath = (id = props[0]) => `${path}/${id}/occupancies`;
const get = (url = occupancyPath(), credential = token) => api().get(url).set('Authorization', `Bearer ${credential}`);
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

describe('Care effective occupancy projection', () => {
  it('composes canonical building/unit contexts and relationship windows without inventing occupancy identities', async () => {
    const response = await get().query({ tenantCompanyId: tenantId });
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body.data.items.length, 4);
    for (const row of response.body.data.items) {
      assert.deepEqual(Object.keys(row).sort(), ['kind', 'clientId', 'propertyId', 'tenantCompanyId', 'buildingId', 'spaceId',
        'tenantBuildingContextId', 'tenantSpaceRelationshipId', 'tenantBuildingEffectiveFrom', 'tenantBuildingEffectiveUntil',
        'tenantSpaceEffectiveFrom', 'tenantSpaceEffectiveUntil', 'evaluatedAt'].sort());
      assert.equal(row.clientId, clientId);
      assert.equal(row.propertyId, props[0]);
      assert.equal(row.tenantCompanyId, tenantId);
      assert.ok(contextIds.includes(row.tenantBuildingContextId));
      assert.equal(row.evaluatedAt, response.body.data.evaluatedAt);
      if (row.kind === 'SPACE') {
        assert.ok(relationshipIds.includes(row.tenantSpaceRelationshipId));
        assert.ok(chains[0].spaceIds.includes(row.spaceId));
      } else {
        assert.equal(row.spaceId, null);
        assert.equal(row.tenantSpaceRelationshipId, null);
        assert.equal(row.tenantSpaceEffectiveFrom, null);
        assert.equal(row.tenantSpaceEffectiveUntil, null);
      }
    }
    assert.ok(!JSON.stringify(response.body).includes('private@example.com'));
  });

  it('permits building-only representation with no tenant-space relationship or artificial space requirement', async () => {
    const response = await get().query({ tenantCompanyId: buildingOnlyTenant, buildingId: buildings[0][1] });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.items.length, 1);
    assert.equal(response.body.data.items[0].kind, 'BUILDING');
    assert.equal(response.body.data.items[0].spaceId, null);
    assert.equal(response.body.data.nextCursor, null);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM tenant_space_relationships WHERE tenant_company_id = $1', [buildingOnlyTenant])).rows[0].n, 0);
  });

  it('requires exact tenant/building/space occupancy when spaceId is selected, with no building fallback', async () => {
    const response = await get().query(unitQuery());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.items.length, 1);
    assert.equal(response.body.data.items[0].kind, 'SPACE');
    assert.equal(response.body.data.items[0].tenantSpaceRelationshipId, relationshipIds[0]);
    const spaceOnly = await get().query({ spaceId: chains[0].spaceIds[0] });
    assert.equal(spaceOnly.status, 200);
    assert.equal(spaceOnly.body.data.items[0].tenantCompanyId, tenantId);
    for (const q of [
      { ...unitQuery(), tenantCompanyId: buildingOnlyTenant }, { ...unitQuery(), buildingId: buildings[0][1] },
      { ...unitQuery(), spaceId: chains[1].spaceIds[0] }, { spaceId: randomUUID() }, { tenantCompanyId: crossClientTenant },
      { tenantCompanyId: tenantId, buildingId: buildings[1][0] },
    ]) assert.equal((await get().query(q)).status, 404);
  });

  it('uses current ACTIVE effective records from both authorities, never inactive, future or former relationships', async () => {
    for (const [table, id] of [['tenant_building_contexts', contextIds[0]], ['tenant_space_relationships', relationshipIds[0]]]) {
      for (const patch of ["status = 'INACTIVE'", "effective_from = now() + interval '1 day'", "effective_until = now() - interval '1 day'"]) {
        await pool.query(`UPDATE ${table} SET ${patch} WHERE id = $1`, [id]);
        try { assert.equal((await get().query(unitQuery())).status, 404); }
        finally { await pool.query(`UPDATE ${table} SET status = 'ACTIVE', effective_from = NULL, effective_until = NULL WHERE id = $1`, [id]); }
      }
    }
    await pool.query("UPDATE tenant_companies SET status = 'INACTIVE' WHERE id = $1", [tenantId]);
    try { assert.equal((await get().query(unitQuery())).status, 404); }
    finally { await pool.query("UPDATE tenant_companies SET status = 'ACTIVE' WHERE id = $1", [tenantId]); }
  });

  it('evaluates inclusive relationship boundaries at one server statement time and preserves both windows', async () => {
    const instant = '2026-10-08T00:00:00Z';
    for (const [table, id] of [['tenant_building_contexts', contextIds[0]], ['tenant_space_relationships', relationshipIds[0]]]) {
      await pool.query(`UPDATE ${table} SET effective_from = $2, effective_until = $2 WHERE id = $1`, [id, instant]);
    }
    const original = pool.query.bind(pool);
    pool.query = (async (sql: any, params: any) => {
      if (typeof sql === 'string' && sql.includes('context_base AS')) {
        sql = sql.replaceAll('statement_timestamp()', `'${instant}'::timestamptz`)
          .replace(`s.expires_at > '${instant}'::timestamptz`, 's.expires_at > statement_timestamp()');
      }
      return original(sql, params);
    }) as typeof pool.query;
    try {
      const response = await get().query(unitQuery());
      assert.equal(response.status, 200);
      for (const field of ['tenantBuildingEffectiveFrom', 'tenantBuildingEffectiveUntil', 'tenantSpaceEffectiveFrom', 'tenantSpaceEffectiveUntil', 'evaluatedAt']) {
        assert.equal(Date.parse(response.body.data.items[0][field]), Date.parse(instant));
      }
    } finally {
      pool.query = original;
      for (const [table, id] of [['tenant_building_contexts', contextIds[0]], ['tenant_space_relationships', relationshipIds[0]]]) {
        await pool.query(`UPDATE ${table} SET effective_from = NULL, effective_until = NULL WHERE id = $1`, [id]);
      }
    }
  });

  it('validates every active location ancestor and rejects inconsistent physical-building relationships', async () => {
    const c = chains[0];
    for (const [table, id] of [['spaces', c.spaceIds[0]], ['rooms', c.roomId], ['areas', c.areaId], ['floors', c.floorId],
      ['buildings', c.buildingId], ['properties', props[0]], ['clients', clientId]]) {
      await pool.query(`UPDATE ${table} SET status = 'INACTIVE' WHERE id = $1`, [id]);
      try {
        assert.equal((await get().query(unitQuery())).status, 404);
        if (['spaces', 'rooms', 'areas', 'floors'].includes(table)) {
          const building = await get().query({ tenantCompanyId: tenantId, buildingId: c.buildingId });
          assert.equal(building.status, 200);
          assert.ok(building.body.data.items.some((r: any) => r.kind === 'BUILDING'));
        }
      } finally { await pool.query(`UPDATE ${table} SET status = 'ACTIVE' WHERE id = $1`, [id]); }
    }
    await pool.query('UPDATE tenant_space_relationships SET building_id = $1 WHERE id = $2', [buildings[0][1], relationshipIds[0]]);
    try { assert.equal((await get().query({ tenantCompanyId: tenantId, spaceId: c.spaceIds[0] })).status, 404); }
    finally { await pool.query('UPDATE tenant_space_relationships SET building_id = $1 WHERE id = $2', [buildings[0][0], relationshipIds[0]]); }
  });

  it('paginates deterministically by kind and canonical relationship ID without duplicate rows', async () => {
    const expected = [...contextIds.map(id => 'BUILDING:' + id), ...relationshipIds.map(id => 'SPACE:' + id)].sort();
    let cursor: string | undefined;
    const keys: string[] = [];
    do {
      const response = await get().query({ tenantCompanyId: tenantId, limit: '1', ...(cursor ? { cursor } : {}) });
      assert.equal(response.status, 200);
      assert.equal(response.body.data.items.length, 1);
      const row = response.body.data.items[0];
      keys.push(`${row.kind}:${row.kind === 'BUILDING' ? row.tenantBuildingContextId : row.tenantSpaceRelationshipId}`);
      assert.equal('id' in row, false);
      cursor = response.body.data.nextCursor;
    } while (cursor);
    assert.deepEqual(keys, expected);
  });

  it('rejects continuation on turnover even while a building context remains current; a fresh projection never returns former occupancy', async () => {
    const first = await get().query({ tenantCompanyId: tenantId, limit: '1' });
    await tenantSpaceRepository.update(relationshipIds[0], { status: 'INACTIVE' });
    const replacement = await tenantSpaceRepository.create({ tenantCompanyId: newTenant, buildingId: buildings[0][0], spaceId: chains[0].spaceIds[0],
      status: 'ACTIVE', effectiveFrom: null, effectiveUntil: null });
    try {
      const stale = await get().query({ tenantCompanyId: tenantId, limit: '1', cursor: first.body.data.nextCursor });
      assert.equal(stale.status, 404);
      assert.equal(stale.body.error.code, 'HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND');
      assert.equal((await get().query(unitQuery())).status, 404);
      const current = await get().query({ spaceId: chains[0].spaceIds[0] });
      assert.equal(current.status, 200);
      assert.equal(current.body.data.items[0].tenantCompanyId, newTenant);
      assert.equal(current.body.data.items[0].tenantSpaceRelationshipId, replacement.id);
      assert.ok(!(await get().query({ tenantCompanyId: tenantId })).body.data.items.some((r: any) => r.tenantSpaceRelationshipId === relationshipIds[0]));
    } finally {
      await tenantSpaceRepository.update(replacement.id, { status: 'INACTIVE' });
      await tenantSpaceRepository.update(relationshipIds[0], { status: 'ACTIVE' });
    }
  });

  it('binds cursors to tenant/building/space/scope/session/limit and denies effective-window changes', async () => {
    const cursor = (await get().query({ tenantCompanyId: tenantId, limit: '1' })).body.data.nextCursor;
    for (const q of [{ tenantCompanyId: newTenant, limit: '1', cursor }, { tenantCompanyId: tenantId, buildingId: buildings[0][0], limit: '1', cursor },
      { ...unitQuery(), limit: '1', cursor }, { tenantCompanyId: tenantId, limit: '2', cursor },
      { tenantCompanyId: tenantId, limit: '1', cursor: 'A' + cursor.slice(1) }]) assert.equal((await get().query(q)).status, 400);
    assert.equal((await get(occupancyPath(props[1])).query({ tenantCompanyId: tenantId, limit: '1', cursor })).status, 400);
    assert.equal((await get(occupancyPath(), (await admit()).workspaceToken).query({ tenantCompanyId: tenantId, limit: '1', cursor })).status, 400);
    assert.equal((await get(path).query({ limit: '1', cursor })).status, 400);
    await tenantBuildingContextRepository.update(contextIds[0], { effectiveUntil: new Date(Date.now() + 86400000) });
    try { assert.equal((await get().query({ tenantCompanyId: tenantId, limit: '1', cursor })).status, 404); }
    finally { await tenantBuildingContextRepository.update(contextIds[0], { effectiveUntil: null }); }
  });

  it('denies revoked grants and expired/revoked or non-workspace credentials', async () => {
    const cursor = (await get().query({ tenantCompanyId: tenantId, limit: '1' })).body.data.nextCursor;
    await revokeCareActorProperty({ careActorId: actorId, propertyId: props[0], clientId }, adminId);
    try { assert.equal((await get().query({ tenantCompanyId: tenantId, limit: '1', cursor })).status, 404); }
    finally { await grantCareActorProperty({ careActorId: actorId, propertyId: props[0], clientId }, adminId); }
    const expired = 'hcw_' + 'O'.repeat(43);
    await pool.query(`INSERT INTO handyman_care_workspace_sessions
      (id, integration_id, care_actor_id, assertion_id, token_hash, created_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,now()-interval '16 minutes',now()-interval '1 minute')`,
      [randomUUID(), integrationId, actorId, randomUUID(), createHash('sha256').update(expired).digest('hex')]);
    const revoked = (await admit()).workspaceToken;
    await revokeCareWorkspaceSession(revoked);
    assert.equal((await api().get(occupancyPath()).query(unitQuery())).status, 401);
    for (const credential of [userToken, 'exchange-token', expired, revoked]) {
      const response = await get(occupancyPath(), credential).query(unitQuery());
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');
    }
    for (const id of [denied, foreign, randomUUID()]) assert.equal((await get(occupancyPath(id)).query(unitQuery())).status, 404);
    assert.equal((await get(occupancyPath(), otherToken).query(unitQuery())).status, 404);
  });

  it('revalidates active actor/integration/capability and fails closed on projection-time session revocation or storage errors', async () => {
    for (const [table, id, change, reset] of [
      ['handyman_handoff_care_actors', actorId, "status = 'INACTIVE'", "status = 'ACTIVE'"],
      ['handyman_handoff_integrations', integrationId, "status = 'INACTIVE'", "status = 'ACTIVE'"],
      ['handyman_handoff_integrations', integrationId, "actor_capability = 'NONE'", "actor_capability = 'CUSTOMER_CARE'"],
    ]) {
      token = (await admit()).workspaceToken;
      await pool.query(`UPDATE ${table} SET ${change} WHERE id = $1`, [id]);
      try { assert.equal((await get().query(unitQuery())).status, 401); }
      finally { await pool.query(`UPDATE ${table} SET ${reset} WHERE id = $1`, [id]); }
      assert.equal((await get().query(unitQuery())).status, 401);
    }
    token = (await admit()).workspaceToken;
    const original = careWorkspaceOccupanciesRepository.readOccupancies;
    careWorkspaceOccupanciesRepository.readOccupancies = async (...args) => {
      await revokeCareWorkspaceSession(token);
      return original(...args);
    };
    try { assert.equal((await get().query(unitQuery())).status, 401); }
    finally { careWorkspaceOccupanciesRepository.readOccupancies = original; }
    token = (await admit()).workspaceToken;
    careWorkspaceOccupanciesRepository.readOccupancies = async () => { throw new Error('occupancy storage unavailable'); };
    try { await assert.rejects(listCareWorkspaceOccupancies(token, unitQuery(), props[0]), /occupancy storage unavailable/); }
    finally { careWorkspaceOccupanciesRepository.readOccupancies = original; }
  });

  it('bounds selectors/pagination, rejects injected authority and never treats projection/cursor as a create credential', async () => {
    for (const q of [{}, { buildingId: buildings[0][0] }, { tenantCompanyId: 'bad' }, { ...unitQuery(), limit: '0' },
      { ...unitQuery(), limit: '101' }, { ...unitQuery(), limit: ['1', '2'] }, { ...unitQuery(), q: 'search' },
      { ...unitQuery(), clientId }, { ...unitQuery(), careActorId: actorId }, { ...unitQuery(), status: 'INACTIVE' },
      { ...unitQuery(), spaceId: ['a', 'b'] }, { ...unitQuery(), cursor: 'bad' }]) assert.equal((await get().query(q)).status, 400);
    assert.equal((await get(occupancyPath('bad')).query(unitQuery())).status, 400);
    assert.equal((await get().query(unitQuery()).send({ clientId })).status, 400);
    assert.equal((await get().query({ ...unitQuery(), limit: '100' })).status, 200);
    const response = await get().query({ tenantCompanyId: tenantId, limit: '1' });
    await assert.rejects(consumeHandoffExchange(response.body.data.nextCursor));
    await assert.rejects(consumeHandoffExchange(response.body.data.items[0].tenantBuildingContextId));
    assert.equal((await api().post(occupancyPath()).set('Authorization', `Bearer ${token}`).send(unitQuery())).status, 404);
    for (const segment of [`tenant-companies/${tenantId}/pics`, 'catalogue/services']) assert.equal((await get(`${path}/${props[0]}/${segment}`)).status, 404);
  });

  it('documents only read composition and nullable building-only space fields', () => {
    const spec = parseYaml(readFileSync('docs/api/openapi.yaml', 'utf8'));
    const route = spec.paths['/handyman/care/properties/{propertyId}/occupancies'];
    assert.deepEqual(Object.keys(route), ['get']);
    assert.deepEqual(route.get.security, [{ careWorkspaceSession: [] }]);
    const schema = spec.components.schemas.CareWorkspaceOccupancy;
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.spaceId.nullable, true);
    assert.equal(schema.properties.tenantSpaceRelationshipId.nullable, true);
    assert.deepEqual(schema.properties.kind.enum, ['BUILDING', 'SPACE']);
    assert.equal('id' in schema.properties, false);
  });
});
