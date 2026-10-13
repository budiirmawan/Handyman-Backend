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
import { roleRepository, roleService } from '../src/modules/roles';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { createHandymanServiceRequest, getHandymanServiceRequestDetail, handymanServiceRequestRepository } from '../src/modules/handyman-requests';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, revokeCareWorkspaceSession, signCareWorkspaceAssertion,
  type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { issueCareCreateExchange } from '../src/modules/handyman-care-workspace/care-create-exchange.service';
import { listCareWorkspaceRequests } from '../src/modules/handyman-care-workspace/care-workspace-requests.service';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { createAdminUser } from './helpers/access';

const DIR = '/tmp/handyman-care-workspace-requests-pg';
const PORT = 55536;
const SECRET = 'workspace-list-test-integration-secret';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const path = '/api/v1/handyman/care/requests';
let postgres: EmbeddedPostgres | null = null;
let pool: Pool;
let code: string, integrationId: string, actorId: string, otherActorId: string, envKey: string;
let adminId: string, userToken: string, token: string, otherToken: string;
let tenantId: string, newTenant: string, foreignTenant: string, buildingOnlyTenant: string;
let deniedProperty: string;
const clients: string[] = [], properties: string[] = [], buildings: string[] = [], services: string[] = [];
const chains: { floorId: string; areaId: string; roomId: string; spaceId: string }[] = [];
const contexts: string[] = [], relationships: string[] = [];
let unitRequests: string[] = [], buildingRequest: string, secondUnitRequest: string;
let otherTenantRequest: string, otherBuildingRequest: string, otherPropertyRequest: string, foreignRequest: string, buildingOnlyRequest: string;
const selection = () => ({ propertyId: properties[0], tenantCompanyId: tenantId, buildingId: buildings[0] });
const unit = () => ({ ...selection(), spaceId: chains[0].spaceId });
const get = (query: Record<string, unknown> = selection(), credential = token) =>
  api().get(path).set('Authorization', `Bearer ${credential}`).query(query as any);
const ids = (response: any): string[] => response.body.data.items.map((r: any) => r.id);

function assertion(reference = 'care-operator'): CareWorkspaceAssertion {
  return { purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode: code, assertionId: randomUUID(),
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: reference } };
}
async function admit(reference?: string) {
  const a = assertion(reference);
  return (await admitCareWorkspace(a, signCareWorkspaceAssertion(a, SECRET))).workspaceToken;
}
async function context(tenantCompanyId: string, buildingId: string) {
  return (await tenantBuildingContextRepository.create({ tenantCompanyId, buildingId,
    status: 'ACTIVE', effectiveFrom: null, effectiveUntil: null })).id;
}
async function relationship(tenantCompanyId: string, spaceId: string) {
  return (await tenantSpaceRepository.create({ tenantCompanyId, buildingId: buildings[0], spaceId,
    status: 'ACTIVE', effectiveFrom: null, effectiveUntil: null })).id;
}
async function request(tenantCompanyId: string, buildingId: string, spaceId?: string, service = services[0], care = false) {
  const attribution = await createChannelAttribution({ tenantCompanyId, buildingId, ...(spaceId ? { spaceId } : {}),
    originChannel: 'BM_SUPER_APP', originReference: `list-fixture:${randomUUID()}`,
    ...(care ? { actorType: 'CUSTOMER_CARE' as const, careActorId: actorId, actorReference: 'care-operator' } : {}) });
  return (await createHandymanServiceRequest({ channelAttributionId: attribution.id,
    serviceCatalogId: service, description: 'Bounded request projection' }, adminId)).id;
}

before(async () => {
  if (process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true') {
    Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: String(PORT),
      DB_USER: 'postgres', DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false' });
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({ databaseDir: DIR, port: PORT,
      user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
    await postgres.initialise(); await postgres.start();
    const admin = postgres.getPgClient('postgres', '127.0.0.1');
    await admin.connect(); await admin.query('CREATE DATABASE asentra_test'); await admin.end();
  }
  const config = await ensureTestDatabase();
  assert.ok(config, 'Focused request-list tests require PostgreSQL (no silent skips)');
  pool = await initDatabase(config); await migrateUp(pool);
  code = `WS_${suffix()}`;
  integrationId = (await handoffRuntimeRepository.createIntegration({ integrationCode: code, displayName: 'Workspace BM' })).id;
  await handymanCareActorService.setIntegrationActorCapability({ integrationId, capability: 'CUSTOMER_CARE' });
  actorId = (await handymanCareActorService.createCareActor({ integrationId, actorReference: 'care-operator', displayName: 'Care' })).id;
  otherActorId = (await handymanCareActorService.createCareActor({ integrationId, actorReference: 'other-care', displayName: 'Other care' })).id;
  envKey = handoffIntegrationSecretEnvName(code); process.env[envKey] = SECRET;
  const admin = await createAdminUser(); adminId = admin.userId; userToken = admin.token;
  const role = await roleRepository.findByCode('PLATFORM_ADMIN') ??
    await roleService.createRole({ code: 'PLATFORM_ADMIN', name: 'Platform Administrator' });
  await roleService.assignRoleToUser(adminId, role.id);
  for (let i = 0; i < 2; i++) clients.push((await clientService.createClient({ code: `C_${suffix()}`, name: 'Client' })).id);
  for (let i = 0; i < 3; i++) {
    const clientId = clients[i === 2 ? 1 : 0];
    const propertyId = (await propertyService.createProperty({ clientId, code: `P_${suffix()}`, name: 'Granted' })).id;
    properties.push(propertyId);
    for (let j = 0; j < (i === 0 ? 2 : 1); j++) {
      const b = await buildingService.createBuilding({ propertyId, code: `B_${suffix()}`, name: 'Building' });
      buildings.push(b.id); await buildingAssignmentService.createAssignment(adminId, { buildingId: b.id });
    }
    await grantCareActorProperty({ careActorId: actorId, propertyId, clientId }, adminId);
  }
  deniedProperty = (await propertyService.createProperty({ clientId: clients[0], code: `P_${suffix()}`, name: 'Denied' })).id;
  for (const clientId of clients) services.push((await serviceCatalogService.createServiceCatalogEntry({
    clientId, code: `HM_${suffix()}`, name: 'Repair', category: 'HANDYMAN' }, adminId)).id);
  for (let i = 0; i < 2; i++) {
    const floorId = (await floorService.createFloor({ buildingId: buildings[0], code: `F_${suffix()}`, name: 'Floor', levelNumber: i + 1 })).id;
    const areaId = (await areaService.createArea({ floorId, code: `A_${suffix()}`, name: 'Area' })).id;
    const roomId = (await roomService.createRoom({ areaId, code: `R_${suffix()}`, name: 'Room' })).id;
    const spaceId = (await spaceService.createSpace({ roomId, code: `S_${suffix()}`, name: 'Unit' })).id;
    chains.push({ floorId, areaId, roomId, spaceId });
  }
  async function tenant(clientId = clients[0]) {
    return (await tenantCompanyRepository.create({ clientId, tenantCode: `T_${suffix()}`, tenantName: 'Tenant', email: 'private@example.com' })).id;
  }
  tenantId = await tenant(); newTenant = await tenant(); foreignTenant = await tenant(clients[1]); buildingOnlyTenant = await tenant();
  for (const b of buildings.slice(0, 3)) contexts.push(await context(tenantId, b));
  await context(newTenant, buildings[0]); await context(foreignTenant, buildings[3]); await context(buildingOnlyTenant, buildings[1]);
  for (const c of chains) relationships.push(await relationship(tenantId, c.spaceId));
  for (let i = 0; i < 3; i++) unitRequests.push(await request(tenantId, buildings[0], chains[0].spaceId, services[0], i === 0));
  secondUnitRequest = await request(tenantId, buildings[0], chains[1].spaceId);
  buildingRequest = await request(tenantId, buildings[0]);
  otherTenantRequest = await request(newTenant, buildings[0]);
  otherBuildingRequest = await request(tenantId, buildings[1]);
  otherPropertyRequest = await request(tenantId, buildings[2]);
  foreignRequest = await request(foreignTenant, buildings[3], undefined, services[1]);
  buildingOnlyRequest = await request(buildingOnlyTenant, buildings[1]);
  // Equal timestamps plus distinct sub-millisecond timestamps certify the full keyset.
  for (let i = 0; i < unitRequests.length; i++) await pool.query(
    'UPDATE handyman_service_requests SET created_at = $1 WHERE id = $2',
    [`2026-01-01T12:00:00.00000${i === 2 ? 1 : 2}Z`, unitRequests[i]]);
  await pool.query("UPDATE handyman_service_requests SET status = 'TRIAGE' WHERE id = $1", [unitRequests[0]]);
});
beforeEach(async () => { token = await admit(); otherToken = await admit('other-care'); });
after(async () => {
  if (envKey) delete process.env[envKey];
  if (pool) await closePool(pool);
  if (postgres) { await postgres.stop(); await rm(DIR, { recursive: true, force: true }); }
});

describe('PART 06A — care workspace represented request list', () => {
  it('returns only the selected tenant/building/property, reusing the exact existing safe request projection', async () => {
    const response = await get();
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(new Set(ids(response)), new Set([...unitRequests, secondUnitRequest, buildingRequest]));
    assert.deepEqual(Object.keys(response.body.data).sort(), ['evaluatedAt', 'items', 'nextCursor']);
    assert.equal(response.body.data.nextCursor, null);
    assert.ok(Number.isFinite(Date.parse(response.body.data.evaluatedAt)));
    for (const item of response.body.data.items) {
      assert.deepEqual(item, await getHandymanServiceRequestDetail(item.id, adminId));
      assert.equal('cursorCreatedAt' in item, false);
    }
    const own = response.body.data.items.find((r: any) => r.id === unitRequests[0]);
    assert.equal(own.actorType, 'CUSTOMER_CARE'); assert.equal(own.careActorId, actorId);
    assert.equal(own.createdByUserId, null); assert.equal(own.executionScopeId, null);
    assert.ok(!JSON.stringify(response.body).includes('private@example.com'));
  });

  it('supports exact optional-space selection, existing status/attribution filters and authorized empty results', async () => {
    assert.deepEqual(new Set(ids(await get(unit()))), new Set(unitRequests));
    assert.deepEqual(ids(await get({ ...unit(), status: 'TRIAGE' })), [unitRequests[0]]);
    const attributionId = (await pool.query('SELECT channel_attribution_id FROM handyman_service_requests WHERE id = $1', [unitRequests[0]])).rows[0].channel_attribution_id;
    assert.deepEqual(ids(await get({ ...selection(), channelAttributionId: attributionId })), [unitRequests[0]]);
    for (const query of [{ ...unit(), status: 'REFERRED' }, { ...selection(), channelAttributionId: randomUUID() },
      { ...selection(), channelAttributionId: (await pool.query('SELECT channel_attribution_id FROM handyman_service_requests WHERE id = $1', [otherTenantRequest])).rows[0].channel_attribution_id }]) {
      const response = await get(query); assert.equal(response.status, 200); assert.deepEqual(ids(response), []);
      assert.equal(response.body.data.nextCursor, null);
    }
  });

  it('supports building-only representation with no artificial space relationship', async () => {
    const response = await get({ ...selection(), tenantCompanyId: buildingOnlyTenant, buildingId: buildings[1] });
    assert.equal(response.status, 200); assert.deepEqual(ids(response), [buildingOnlyRequest]);
    assert.equal(response.body.data.items[0].spaceId, null);
  });

  it('paginates deterministically newest-first with UUID tie-break and lossless microseconds, filtering before pagination', async () => {
    const expected = (await pool.query('SELECT id FROM handyman_service_requests WHERE id = ANY($1::uuid[]) ORDER BY created_at DESC, id DESC', [unitRequests])).rows.map(r => r.id);
    let cursor: string | null = null; const seen: string[] = [];
    do {
      const response = await get({ ...unit(), limit: '1', ...(cursor ? { cursor } : {}) });
      assert.equal(response.status, 200); assert.equal(response.body.data.items.length, 1);
      seen.push(...ids(response)); cursor = response.body.data.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, expected); assert.equal(new Set(seen).size, 3);
    assert.deepEqual(ids(await get({ ...unit(), limit: '100' })), expected);
    // Newer unrelated requests must not consume slots or influence nextCursor.
    const one = await get({ ...unit(), limit: '1', status: 'TRIAGE' });
    assert.deepEqual(ids(one), [unitRequests[0]]); assert.equal(one.body.data.nextCursor, null);
  });

  it('requires workspace credentials, never User/admin or exchange credentials, and requires all represented selectors', async () => {
    assert.equal((await api().get(path).query(selection())).status, 401);
    const exchange = await issueCareCreateExchange(token, properties[0], { tenantCompanyId: tenantId, buildingId: buildings[0] });
    for (const credential of [userToken, exchange.exchangeToken, 'invalid']) {
      const response = await get(selection(), credential); assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');
    }
    for (const q of [{}, { propertyId: properties[0] }, { ...selection(), tenantCompanyId: undefined },
      { ...selection(), buildingId: undefined }, { tenantCompanyId: tenantId, buildingId: buildings[0] },
      { propertyId: properties[0], spaceId: chains[0].spaceId }]) assert.equal((await get(q)).status, 400);
  });

  it('denies ungranted/foreign/mismatched scopes without leaking existence, even when another selected property is granted', async () => {
    for (const propertyId of [properties[1], properties[2], deniedProperty, randomUUID()]) {
      const response = await get({ ...selection(), propertyId }); assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND');
    }
    assert.equal((await get(selection(), otherToken)).status, 404);
    assert.equal((await get({ ...selection(), tenantCompanyId: foreignTenant })).status, 404);
    assert.equal((await get({ ...unit(), buildingId: buildings[1] })).status, 404);
    assert.deepEqual(ids(await get({ ...selection(), propertyId: properties[1], buildingId: buildings[2] })), [otherPropertyRequest]);
    assert.deepEqual(ids(await get({ propertyId: properties[2], buildingId: buildings[3], tenantCompanyId: foreignTenant })), [foreignRequest]);
  });

  it('denies prior-tenant unit history after turnover, including care-authored rows; new occupants never inherit it', async () => {
    const cursor = (await get({ ...unit(), limit: '1' })).body.data.nextCursor;
    await tenantSpaceRepository.update(relationships[0], { status: 'INACTIVE' });
    const replacement = await relationship(newTenant, chains[0].spaceId);
    try {
      assert.equal((await get(unit())).status, 404);
      assert.equal((await get({ ...unit(), limit: '1', cursor })).status, 404);
      assert.deepEqual(new Set(ids(await get())), new Set([buildingRequest, secondUnitRequest]));
      const next = await get({ ...unit(), tenantCompanyId: newTenant });
      assert.equal(next.status, 200); assert.deepEqual(ids(next), []);
      assert.deepEqual(ids(await get({ ...selection(), tenantCompanyId: newTenant })), [otherTenantRequest]);
    } finally {
      await tenantSpaceRepository.update(replacement, { status: 'INACTIVE' });
      await tenantSpaceRepository.update(relationships[0], { status: 'ACTIVE' });
    }
  });

  it('revalidates every row without a space filter, before pagination, and denies invalid building representation', async () => {
    const cursor = (await get({ ...selection(), limit: '1' })).body.data.nextCursor;
    await tenantSpaceRepository.update(relationships[1], { effectiveUntil: new Date(Date.now() - 1000) });
    try {
      const response = await get({ ...selection(), limit: '100' });
      assert.deepEqual(new Set(ids(response)), new Set([buildingRequest, ...unitRequests]));
      const continued = await get({ ...selection(), limit: '1', cursor });
      assert.equal(continued.status, 200); assert.ok(!ids(continued).includes(secondUnitRequest));
      assert.equal((await get({ ...selection(), spaceId: chains[1].spaceId })).status, 404);
    } finally { await tenantSpaceRepository.update(relationships[1], { effectiveUntil: null }); }
    for (const fields of [{ status: 'INACTIVE' as const }, { effectiveFrom: new Date(Date.now() + 86400000) }, { effectiveUntil: new Date(Date.now() - 86400000) }]) {
      await tenantBuildingContextRepository.update(contexts[0], fields);
      try { assert.equal((await get()).status, 404); }
      finally { await tenantBuildingContextRepository.update(contexts[0], { status: 'ACTIVE', effectiveFrom: null, effectiveUntil: null }); }
    }
    await tenantSpaceRepository.update(relationships[0], { effectiveFrom: new Date(Date.now() + 86400000) });
    try { assert.equal((await get(unit())).status, 404); assert.ok(!ids(await get()).some(id => unitRequests.includes(id))); }
    finally { await tenantSpaceRepository.update(relationships[0], { effectiveFrom: null }); }
  });

  it('enforces active tenant/Client/property/building and full physical space ancestry', async () => {
    for (const [table, id] of [['clients', clients[0]], ['properties', properties[0]], ['buildings', buildings[0]], ['tenant_companies', tenantId]]) {
      await pool.query(`UPDATE ${table} SET status = 'INACTIVE' WHERE id = $1`, [id]);
      try { assert.equal((await get()).status, 404, table); }
      finally { await pool.query(`UPDATE ${table} SET status = 'ACTIVE' WHERE id = $1`, [id]); }
    }
    for (const [table, id] of [['floors', chains[0].floorId], ['areas', chains[0].areaId], ['rooms', chains[0].roomId], ['spaces', chains[0].spaceId]]) {
      await pool.query(`UPDATE ${table} SET status = 'INACTIVE' WHERE id = $1`, [id]);
      try {
        assert.equal((await get(unit())).status, 404, table);
        assert.deepEqual(new Set(ids(await get())), new Set([secondUnitRequest, buildingRequest]));
      } finally { await pool.query(`UPDATE ${table} SET status = 'ACTIVE' WHERE id = $1`, [id]); }
    }
    await pool.query('UPDATE tenant_space_relationships SET building_id = $1 WHERE id = $2', [buildings[1], relationships[0]]);
    try { assert.equal((await get(unit())).status, 404); assert.ok(!ids(await get()).some(id => unitRequests.includes(id))); }
    finally { await pool.query('UPDATE tenant_space_relationships SET building_id = $1 WHERE id = $2', [buildings[0], relationships[0]]); }
  });

  it('revalidates grants and workspace revocation/expiry on all pages', async () => {
    const cursor = (await get({ ...unit(), limit: '1' })).body.data.nextCursor;
    await revokeCareActorProperty({ careActorId: actorId, propertyId: properties[0], clientId: clients[0] }, adminId);
    try { assert.equal((await get()).status, 404); assert.equal((await get({ ...unit(), limit: '1', cursor })).status, 404); }
    finally { await grantCareActorProperty({ careActorId: actorId, propertyId: properties[0], clientId: clients[0] }, adminId); }
    await revokeCareWorkspaceSession(token);
    assert.equal((await get({ ...unit(), limit: '1', cursor })).status, 401);
    const expired = 'hcw_' + 'E'.repeat(43);
    await pool.query(`INSERT INTO handyman_care_workspace_sessions
      (id, integration_id, care_actor_id, assertion_id, token_hash, created_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,now()-interval '16 minutes',now()-interval '1 minute')`,
      [randomUUID(), integrationId, actorId, randomUUID(), createHash('sha256').update(expired).digest('hex')]);
    assert.equal((await get(selection(), expired)).status, 401);
  });

  it('denies inactive actor/integration or removed capability and never resurrects revoked sessions', async () => {
    for (const [table, id, change, reset] of [
      ['handyman_handoff_care_actors', actorId, "status = 'INACTIVE'", "status = 'ACTIVE'"],
      ['handyman_handoff_integrations', integrationId, "status = 'INACTIVE'", "status = 'ACTIVE'"],
      ['handyman_handoff_integrations', integrationId, "actor_capability = 'NONE'", "actor_capability = 'CUSTOMER_CARE'"],
    ]) {
      token = await admit(); await pool.query(`UPDATE ${table} SET ${change} WHERE id = $1`, [id]);
      try { assert.equal((await get()).status, 401); }
      finally { await pool.query(`UPDATE ${table} SET ${reset} WHERE id = $1`, [id]); }
      assert.equal((await get()).status, 401);
    }
  });

  it('binds cursor to session/actor/endpoint/selection/filters/limit and rejects tampering and wrong-kind handles', async () => {
    const cursor = (await get({ ...unit(), limit: '1' })).body.data.nextCursor;
    for (const change of [{ propertyId: properties[1] }, { tenantCompanyId: newTenant }, { buildingId: buildings[1] },
      { spaceId: chains[1].spaceId }, { spaceId: undefined }, { status: 'INTAKE' }, { channelAttributionId: randomUUID() }, { limit: '2' },
      { cursor: 'A' + cursor.slice(1) }, { cursor: randomUUID() }, { cursor: token }]) {
      assert.equal((await get({ ...unit(), limit: '1', cursor, ...change })).status, 400);
    }
    assert.equal((await get({ ...unit(), limit: '1', cursor }, await admit())).status, 400);
    assert.equal((await get({ ...unit(), limit: '1', cursor }, otherToken)).status, 400);
    assert.equal((await api().get('/api/v1/handyman/care/properties').set('Authorization', `Bearer ${token}`).query({ limit: '1', cursor })).status, 400);
    const otherCursor = (await api().get('/api/v1/handyman/care/properties').set('Authorization', `Bearer ${token}`).query({ limit: '1' })).body.data.nextCursor;
    assert.equal((await get({ ...unit(), limit: '1', cursor: otherCursor })).status, 400);
  });

  it('bounds pagination and rejects unknown filters, arrays, body fields and client/actor/PIC authority overrides', async () => {
    for (const extra of [{ limit: '0' }, { limit: '101' }, { limit: '1.5' }, { limit: '-1' }, { limit: ['1', '2'] },
      { propertyId: 'bad' }, { tenantCompanyId: ['a', 'b'] }, { buildingId: 'null' }, { spaceId: '' }, { status: 'CLOSED' },
      { status: ['INTAKE', 'TRIAGE'] }, { channelAttributionId: 'bad' }, { cursor: 'x'.repeat(2049) },
      ...['clientId', 'careActorId', 'actorReference', 'tenantPicId', 'userId', 'q', 'offset', 'sort', 'includeHistory', 'serviceCatalogId']
        .map(key => ({ [key]: randomUUID() }))]) assert.equal((await get({ ...selection(), ...extra })).status, 400, JSON.stringify(extra));
    assert.equal((await get().send({ clientId: clients[0] })).status, 400);
    assert.equal((await api().get(path + '/').set('Authorization', `Bearer ${token}`).query(selection())).status, 200);
  });

  it('rechecks authority in the projection statement and fails closed on storage/signing failures', async () => {
    const original = handymanServiceRequestRepository.listWorkspaceProjectionsScoped;
    handymanServiceRequestRepository.listWorkspaceProjectionsScoped = async (...args) => {
      await revokeCareWorkspaceSession(token); return original(...args);
    };
    try { assert.equal((await get()).status, 401); }
    finally { handymanServiceRequestRepository.listWorkspaceProjectionsScoped = original; }
    token = await admit();
    handymanServiceRequestRepository.listWorkspaceProjectionsScoped = async () => { throw new Error('request storage unavailable'); };
    try { await assert.rejects(listCareWorkspaceRequests(token, selection()), /request storage unavailable/); }
    finally { handymanServiceRequestRepository.listWorkspaceProjectionsScoped = original; }
    delete process.env[envKey];
    try { await assert.rejects(listCareWorkspaceRequests(token, selection()), (e: any) => e.statusCode === 500); }
    finally { process.env[envKey] = SECRET; }
  });

  it('defaults to 25 rows, caps the page, and performs no request/attribution/session mutations', async () => {
    const tenantCompanyId = (await tenantCompanyRepository.create({ clientId: clients[0],
      tenantCode: `T_${suffix()}`, tenantName: 'Pagination tenant' })).id;
    await context(tenantCompanyId, buildings[0]);
    for (let i = 0; i < 27; i++) await request(tenantCompanyId, buildings[0]);
    const counts = async () => (await pool.query(`SELECT
      (SELECT count(*)::int FROM handyman_service_requests) AS requests,
      (SELECT count(*)::int FROM handyman_channel_attributions) AS attributions,
      (SELECT count(*)::int FROM user_sessions) AS user_sessions,
      (SELECT count(*)::int FROM handyman_care_workspace_sessions) AS workspaces,
      (SELECT count(*)::int FROM handyman_handoff_exchanges) AS exchanges`)).rows[0];
    const before = await counts();
    const query = { ...selection(), tenantCompanyId };
    const first = await get(query);
    assert.equal(first.status, 200); assert.equal(ids(first).length, 25);
    assert.ok(first.body.data.nextCursor);
    const second = await get({ ...query, cursor: first.body.data.nextCursor });
    assert.equal(second.status, 200); assert.equal(ids(second).length, 2);
    assert.equal(second.body.data.nextCursor, null);
    assert.equal(new Set([...ids(first), ...ids(second)]).size, 27);
    assert.equal(ids(await get({ ...query, limit: '100' })).length, 27);
    assert.deepEqual(await counts(), before);
  });

  it('adds only list, not workspace detail/mutation, and documents the bounded existing projection', async () => {
    assert.equal((await api().get(`${path}/${unitRequests[0]}`).set('Authorization', `Bearer ${token}`).query(selection())).status, 404);
    assert.equal((await api().post(path).set('Authorization', `Bearer ${token}`).send(selection())).status, 404);
    const spec = parseYaml(readFileSync('docs/api/openapi.yaml', 'utf8'));
    const route = spec.paths['/handyman/care/requests'];
    assert.deepEqual(Object.keys(route), ['get']);
    assert.deepEqual(route.get.security, [{ careWorkspaceSession: [] }]);
    assert.deepEqual(route.get.parameters.filter((p: any) => p.required).map((p: any) => p.name), ['propertyId', 'tenantCompanyId', 'buildingId']);
    assert.equal(spec.components.schemas.CareWorkspaceRequestPage.properties.items.items.$ref, '#/components/schemas/HandymanCustomerCareServiceRequest');
    assert.equal(spec.paths['/handyman/care/requests/{handymanRequestId}'], undefined);
  });
});
