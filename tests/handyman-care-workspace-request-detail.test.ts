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
import { getCareWorkspaceRequestDetail } from '../src/modules/handyman-care-workspace/care-workspace-request-detail.service';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { createAdminUser } from './helpers/access';

const DIR = '/tmp/handyman-care-workspace-request-detail-pg';
const PORT = 55537;
const SECRET = 'workspace-detail-test-integration-secret';
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
const get = (id = unitRequests[0], query: Record<string, unknown> = selection(), credential = token) =>
  api().get(`${path}/${id}`).set('Authorization', `Bearer ${credential}`).query(query as any);
function notFound(response: any) {
  assert.equal(response.status, 404, JSON.stringify(response.body));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.error.code, 'HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND');
  assert.equal(response.body.error.message, 'Care workspace resource not found.');
  assert.equal(response.body.data, undefined);
}

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
    originChannel: 'BM_SUPER_APP', originReference: `detail-fixture:${randomUUID()}`,
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
  assert.ok(config, 'Focused request-detail tests require PostgreSQL (no silent skips)');
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
  await pool.query("UPDATE handyman_service_requests SET status = 'TRIAGE' WHERE id = $1", [unitRequests[0]]);
});
beforeEach(async () => { token = await admit(); otherToken = await admit('other-care'); });
after(async () => {
  if (envKey) delete process.env[envKey];
  if (pool) await closePool(pool);
  if (postgres) { await postgres.stop(); await rm(DIR, { recursive: true, force: true }); }
});

describe('PART 06B — care workspace represented request detail', () => {
  it('returns exactly the existing safe detail projection for current context, never list/cursor/internal fields', async () => {
    for (const id of [unitRequests[0], unitRequests[1], secondUnitRequest, buildingRequest]) {
      const response = await get(id);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.body.data, await getHandymanServiceRequestDetail(id, adminId));
      assert.equal('items' in response.body.data, false);
      assert.equal('cursorCreatedAt' in response.body.data, false);
      assert.equal('attributionCreatedAt' in response.body.data, false);
      assert.ok(!JSON.stringify(response.body).includes('private@example.com'));
    }
    const care = (await get(unitRequests[0], unit())).body.data;
    assert.equal(care.actorType, 'CUSTOMER_CARE'); assert.equal(care.careActorId, actorId);
    assert.equal(care.createdByUserId, null); assert.equal(care.executionScopeId, null);
    assert.equal(care.status, 'TRIAGE'); assert.equal(care.attribution.careActorId, actorId);
    assert.equal((await get(unitRequests[0].toUpperCase(), { ...unit(), tenantCompanyId: tenantId.toUpperCase() })).status, 200);
  });

  it('supports building-only requests without requiring a space relationship, but rejects a mismatched space selector', async () => {
    const response = await get(buildingOnlyRequest, { ...selection(), tenantCompanyId: buildingOnlyTenant, buildingId: buildings[1] });
    assert.equal(response.status, 200); assert.equal(response.body.data.spaceId, null);
    assert.equal(response.body.data.tenantCompanyId, buildingOnlyTenant);
    notFound(await get(buildingRequest, unit()));
    notFound(await get(secondUnitRequest, unit()));
    assert.equal((await get(secondUnitRequest, { ...selection(), spaceId: chains[1].spaceId })).status, 200);
  });

  it('returns uniform 404 for nonexistent IDs, other tenants, units, buildings, properties and Clients', async () => {
    for (const id of [randomUUID(), otherTenantRequest, otherBuildingRequest, otherPropertyRequest, foreignRequest]) notFound(await get(id));
    for (const change of [{ tenantCompanyId: newTenant }, { buildingId: buildings[1] }, { propertyId: properties[1] },
      { propertyId: properties[2] }, { propertyId: deniedProperty }, { propertyId: randomUUID() }, { spaceId: randomUUID() }]) {
      notFound(await get(unitRequests[0], { ...selection(), ...change }));
    }
    // Property grants are not an all-customer read. Only the correct represented context works.
    assert.equal((await get(otherPropertyRequest, { ...selection(), propertyId: properties[1], buildingId: buildings[2] })).status, 200);
    assert.equal((await get(foreignRequest, { propertyId: properties[2], buildingId: buildings[3], tenantCompanyId: foreignTenant })).status, 200);
    notFound(await get(unitRequests[0], selection(), otherToken));
  });

  it('denies prior-tenant history on unit turnover with and without a space selector; authorship never bypasses occupancy', async () => {
    await tenantSpaceRepository.update(relationships[0], { status: 'INACTIVE' });
    const replacement = await relationship(newTenant, chains[0].spaceId);
    try {
      notFound(await get()); notFound(await get(unitRequests[0], unit()));
      notFound(await get(unitRequests[0], { ...unit(), tenantCompanyId: newTenant }));
      notFound(await get(unitRequests[0], { ...selection(), tenantCompanyId: newTenant }));
      assert.equal((await get(secondUnitRequest)).status, 200);
      assert.equal((await get(buildingRequest)).status, 200);
      // Existing explicit local admin historical authority is unchanged, not borrowed by care.
      assert.equal((await getHandymanServiceRequestDetail(unitRequests[0], adminId)).id, unitRequests[0]);
    } finally {
      await tenantSpaceRepository.update(replacement, { status: 'INACTIVE' });
      await tenantSpaceRepository.update(relationships[0], { status: 'ACTIVE' });
    }
  });

  it('requires current effective tenant-building and exact tenant-space relationships at read time', async () => {
    for (const [table, id] of [['tenant_building_contexts', contexts[0]], ['tenant_space_relationships', relationships[0]]]) {
      for (const [change, reset] of [["status = 'INACTIVE'", "status = 'ACTIVE'"],
        ["effective_from = now()+interval '1 day'", 'effective_from = NULL'],
        ["effective_until = now()-interval '1 day'", 'effective_until = NULL']]) {
        await pool.query(`UPDATE ${table} SET ${change} WHERE id = $1`, [id]);
        try {
          notFound(await get()); notFound(await get(unitRequests[0], unit()));
          if (table === 'tenant_building_contexts') notFound(await get(buildingRequest));
          else assert.equal((await get(buildingRequest)).status, 200);
        } finally { await pool.query(`UPDATE ${table} SET ${reset} WHERE id = $1`, [id]); }
      }
    }
    await pool.query('UPDATE tenant_space_relationships SET building_id = $1 WHERE id = $2', [buildings[1], relationships[0]]);
    try { notFound(await get()); }
    finally { await pool.query('UPDATE tenant_space_relationships SET building_id = $1 WHERE id = $2', [buildings[0], relationships[0]]); }
  });

  it('requires active full physical hierarchy, tenant and Client, and cannot follow a building outside selected property', async () => {
    for (const [table, id] of [['clients', clients[0]], ['properties', properties[0]], ['buildings', buildings[0]],
      ['tenant_companies', tenantId], ['floors', chains[0].floorId], ['areas', chains[0].areaId],
      ['rooms', chains[0].roomId], ['spaces', chains[0].spaceId]]) {
      await pool.query(`UPDATE ${table} SET status = 'INACTIVE' WHERE id = $1`, [id]);
      try { notFound(await get()); notFound(await get(unitRequests[0], unit())); }
      finally { await pool.query(`UPDATE ${table} SET status = 'ACTIVE' WHERE id = $1`, [id]); }
    }
    await pool.query('UPDATE buildings SET property_id = $1 WHERE id = $2', [properties[1], buildings[0]]);
    try { notFound(await get()); }
    finally { await pool.query('UPDATE buildings SET property_id = $1 WHERE id = $2', [properties[0], buildings[0]]); }
  });

  it('denies revoked grants uniformly for known and unknown request IDs', async () => {
    await revokeCareActorProperty({ careActorId: actorId, propertyId: properties[0], clientId: clients[0] }, adminId);
    try { notFound(await get()); notFound(await get(randomUUID())); }
    finally { await grantCareActorProperty({ careActorId: actorId, propertyId: properties[0], clientId: clients[0] }, adminId); }
  });

  it('accepts only live workspace credentials, not User/admin, exchange, expired or revoked workspace credentials', async () => {
    assert.equal((await api().get(`${path}/${unitRequests[0]}`).query(selection())).status, 401);
    const exchange = await issueCareCreateExchange(token, properties[0], { tenantCompanyId: tenantId, buildingId: buildings[0] });
    const expired = 'hcw_' + 'E'.repeat(43);
    await pool.query(`INSERT INTO handyman_care_workspace_sessions
      (id, integration_id, care_actor_id, assertion_id, token_hash, created_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,now()-interval '16 minutes',now()-interval '1 minute')`,
      [randomUUID(), integrationId, actorId, randomUUID(), createHash('sha256').update(expired).digest('hex')]);
    const revoked = await admit(); await revokeCareWorkspaceSession(revoked);
    for (const credential of [userToken, exchange.exchangeToken, 'invalid', expired, revoked]) {
      const response = await get(unitRequests[0], selection(), credential);
      assert.equal(response.status, 401); assert.equal(response.body.error.code, 'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');
      assert.equal(response.body.data, undefined); assert.equal(response.headers['cache-control'], 'no-store');
    }
  });

  it('fails closed on actor/integration/capability invalidation and never resurrects prior sessions', async () => {
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

  it('requires explicit represented context and rejects list filters, authority overrides, arrays, malformed IDs and bodies', async () => {
    for (const q of [{}, { propertyId: properties[0] }, { ...selection(), tenantCompanyId: undefined },
      { ...selection(), buildingId: undefined }, { ...selection(), propertyId: undefined },
      ...[{ propertyId: 'bad' }, { tenantCompanyId: ['a', 'b'] }, { spaceId: '' }, { buildingId: '' },
        ...['clientId', 'careActorId', 'tenantPicId', 'userId', 'limit', 'cursor', 'status', 'channelAttributionId', 'includeHistory', 'q']
          .map(key => ({ [key]: randomUUID() }))].map(extra => ({ ...selection(), ...extra }))]) {
      assert.equal((await get(unitRequests[0], q)).status, 400, JSON.stringify(q));
    }
    assert.equal((await get('not-a-uuid')).status, 400);
    assert.equal((await get().send({ tenantCompanyId: tenantId })).status, 400);
    assert.equal((await get().send([])).status, 400);
    assert.equal((await api().get(`${path}/${unitRequests[0]}/`).set('Authorization', `Bearer ${token}`).query(unit())).status, 200);
  });

  it('rechecks grant, occupancy and session in the projection statement rather than trusting initial authentication', async () => {
    const original = handymanServiceRequestRepository.findWorkspaceProjectionById;
    handymanServiceRequestRepository.findWorkspaceProjectionById = async (...args) => {
      await revokeCareActorProperty({ careActorId: actorId, propertyId: properties[0], clientId: clients[0] }, adminId);
      return original(...args);
    };
    try { notFound(await get()); }
    finally {
      handymanServiceRequestRepository.findWorkspaceProjectionById = original;
      await grantCareActorProperty({ careActorId: actorId, propertyId: properties[0], clientId: clients[0] }, adminId);
    }
    handymanServiceRequestRepository.findWorkspaceProjectionById = async (...args) => {
      await tenantSpaceRepository.update(relationships[0], { status: 'INACTIVE' }); return original(...args);
    };
    try { notFound(await get()); }
    finally {
      handymanServiceRequestRepository.findWorkspaceProjectionById = original;
      await tenantSpaceRepository.update(relationships[0], { status: 'ACTIVE' });
    }
    handymanServiceRequestRepository.findWorkspaceProjectionById = async (...args) => {
      await revokeCareWorkspaceSession(token); return original(...args);
    };
    try { assert.equal((await get()).status, 401); }
    finally { handymanServiceRequestRepository.findWorkspaceProjectionById = original; }
  });

  it('propagates storage failure without fallback and reads without mutations or pagination-signing dependency', async () => {
    const original = handymanServiceRequestRepository.findWorkspaceProjectionById;
    handymanServiceRequestRepository.findWorkspaceProjectionById = async () => { throw new Error('detail storage unavailable'); };
    try { await assert.rejects(getCareWorkspaceRequestDetail(token, unitRequests[0], selection()), /detail storage unavailable/); }
    finally { handymanServiceRequestRepository.findWorkspaceProjectionById = original; }
    const counts = async () => (await pool.query(`SELECT
      (SELECT count(*)::int FROM handyman_service_requests) AS requests,
      (SELECT count(*)::int FROM handyman_channel_attributions) AS attributions,
      (SELECT count(*)::int FROM user_sessions) AS users,
      (SELECT count(*)::int FROM handyman_care_workspace_sessions) AS workspaces,
      (SELECT count(*)::int FROM handyman_handoff_exchanges) AS exchanges`)).rows[0];
    const before = await counts(); delete process.env[envKey];
    try { assert.equal((await get()).status, 200); }
    finally { process.env[envKey] = SECRET; }
    assert.deepEqual(await counts(), before);
  });

  it('documents only GET detail with explicit context and existing safe projection; adds no mutation or nested reads', async () => {
    for (const verb of ['post', 'patch', 'delete'] as const) {
      assert.equal((await api()[verb](`${path}/${unitRequests[0]}`).set('Authorization', `Bearer ${token}`).send(selection())).status, 404);
    }
    for (const extra of ['pics', 'finance', 'evidence']) {
      assert.equal((await api().get(`${path}/${unitRequests[0]}/${extra}`).set('Authorization', `Bearer ${token}`).query(selection())).status, 404);
    }
    const spec = parseYaml(readFileSync('docs/api/openapi.yaml', 'utf8'));
    const route = spec.paths['/handyman/care/requests/{requestId}'];
    assert.deepEqual(Object.keys(route), ['get']);
    assert.deepEqual(route.get.security, [{ careWorkspaceSession: [] }]);
    assert.deepEqual(route.get.parameters.filter((p: any) => p.required).map((p: any) => p.name),
      ['requestId', 'propertyId', 'tenantCompanyId', 'buildingId']);
    assert.equal(route.get.responses['200'].content['application/json'].schema.allOf[1].properties.data.$ref,
      '#/components/schemas/HandymanCustomerCareServiceRequest');
  });
});
