import { supersedeHandymanSchedulingReadiness, getHandymanSchedulingReadiness } from '../src/modules/handyman-scheduling';
import { withTransaction } from '../src/database';
import { migration0483HandymanCareInitialSchedulingPreference } from '../src/database/migrations/0483_handyman_care_initial_scheduling_preference';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { parse as parseYaml } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import {
  handymanCareActorService, grantCareActorProperty, revokeCareActorProperty,
} from '../src/modules/handyman-care-actors';
import { handymanServiceVariantService } from '../src/modules/handyman-catalog';
import {
  acceptHandoffAssertion, bindHandoffExchangeToChannelAttribution,
  handoffIntegrationSecretEnvName, handoffRuntimeRepository, signHandoffAssertion,
  type HandoffAssertion,
} from '../src/modules/handyman-handoff';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55527;
const DIR = '/tmp/asentra-care-request-create-pg';
const SECRET = 'care-request-create-test-bm-key';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const secrets: string[] = [];
if (EMBEDDED) {
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_PORT: String(PORT), DB_USER: 'postgres',
    DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false',
  });
}
let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminId = '';
let adminToken = '';

before(async () => {
  if (EMBEDDED) {
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
  if (!config) return;
  database = config;
  pool = await initDatabase(config);
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminId = admin.userId;
  adminToken = admin.token;
});

after(async () => {
  for (const key of secrets) delete process.env[key];
  try { if (pool) await closePool(pool); if (postgres) await postgres.stop(); }
  finally { await rm(DIR, { recursive: true, force: true }); }
});
function ready(t: TestContext): boolean {
  if (!database || !pool) { t.skip('PostgreSQL unavailable'); return false; }
  return true;
}
function db(): Pool { if (!pool) throw new Error('Test database unavailable'); return pool; }

async function fixture(clientId?: string) {
  const client = clientId
    ? { id: clientId }
    : await clientService.createClient({ code: `C_${suffix()}`, name: 'Owner Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  await buildingAssignmentService.createAssignment(adminId, { buildingId: building.id });
  const floor = await floorService.createFloor({ buildingId: building.id, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
  const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
  const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
  const space = await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Unit space' });
  const company = await tenantCompanyService.createTenantCompany({ clientId: client.id, tenantCode: `T_${suffix()}`, tenantName: 'Represented Tenant' }, adminId);
  const linkedUser = await userService.createUser({ email: `${suffix()}@test.invalid`, displayName: 'Customer PIC user' });
  await buildingAssignmentService.createAssignment(linkedUser.id, { buildingId: building.id });
  const pic = await tenantPicService.createTenantPic({ tenantCompanyId: company.id, picName: 'PIC', userId: linkedUser.id }, adminId);
  const occupancy = await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: company.id, buildingId: building.id, spaceId: space.id }, adminId);
  const buildingContext = await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: company.id, buildingId: building.id }, adminId);
  const service = await serviceCatalogService.createServiceCatalogEntry({
    clientId: client.id, code: `HM_${suffix()}`, name: 'Handyman Service', category: 'HANDYMAN',
  }, adminId);
  return { client, property, building, space, company, pic, linkedUser, occupancy, buildingContext, service };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function integration() {
  const code = `BM_CARE_${suffix()}`;
  const row = await handoffRuntimeRepository.createIntegration({ integrationCode: code, displayName: 'BM Care' });
  await handymanCareActorService.setIntegrationActorCapability({ integrationId: row.id, capability: 'CUSTOMER_CARE' });
  const actor = await handymanCareActorService.createCareActor({ integrationId: row.id, actorReference: `CC_${suffix()}`, displayName: 'Agent' });
  const key = handoffIntegrationSecretEnvName(code);
  process.env[key] = SECRET;
  secrets.push(key);
  return { code, actor };
}
type Integration = Awaited<ReturnType<typeof integration>>;
function assertion(f: Fixture, i: Integration, care = true): HandoffAssertion {
  const now = Date.now();
  return {
    integrationCode: i.code, assertionId: randomUUID(),
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 120_000).toISOString(),
    tenantCompanyId: f.company.id, tenantPicId: f.pic.id,
    buildingId: f.building.id, spaceId: f.space.id,
    ...(care ? { actor: { type: 'CUSTOMER_CARE' as const, actorReference: i.actor.actorReference } } : {}),
  };
}
function accept(a: HandoffAssertion) {
  return acceptHandoffAssertion(a, signHandoffAssertion(a, SECRET));
}
async function grant(f: Fixture, i: Integration) {
  return grantCareActorProperty({ careActorId: i.actor.id, propertyId: f.property.id, clientId: f.client.id }, adminId);
}
async function counts() {
  const result = await db().query(`SELECT
    (SELECT count(*)::int FROM handyman_service_requests) AS requests,
    (SELECT count(*)::int FROM handyman_channel_attributions) AS attributions,
    (SELECT count(*)::int FROM user_sessions) AS sessions`);
  return result.rows[0] as { requests: number; attributions: number; sessions: number };
}
const care = (exchangeToken: string, serviceCatalogId: string, extra: Record<string, unknown> = {}) =>
  api().post('/api/v1/handyman/requests/care').send({ exchangeToken, serviceCatalogId, ...extra });

// The care route is the ONLY create surface exercised without bearer auth.
// It never accepts a previously bound attribution ID as an acting credential.
describe('PART 04 — Customer Care request creation authority', () => {
  it('creates from one care exchange with preserved customer/location/channel and no PIC impersonation', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const i = await integration();
    const propertyGrant = await grant(f, i);
    const variant = await handymanServiceVariantService.createHandymanServiceVariant({
      serviceCatalogId: f.service.id, code: `V_${suffix()}`, name: 'Repair',
    }, adminId);
    const claim = assertion(f, i);
    const exchange = await accept(claim);
    assert.equal(propertyGrant.propertyId, f.property.id);
    assert.equal(exchange.context.tenantBuildingContextId, f.buildingContext.id);
    assert.equal(exchange.context.tenantSpaceRelationshipId, f.occupancy.id);
    const before = await counts();
    const rejected = await care(exchange.exchangeToken, f.service.id, { tenantCompanyId: randomUUID() });
    assert.equal(rejected.status, 400);
    const response = await care(exchange.exchangeToken, f.service.id, {
      serviceVariantId: variant.id, description: 'Pipe repair',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const request = response.body.data;
    assert.equal(request.status, 'INTAKE');
    assert.equal(request.tenantCompanyId, f.company.id);
    assert.equal(request.tenantPicId, f.pic.id);
    assert.equal(request.buildingId, f.building.id);
    assert.equal(request.spaceId, f.space.id);
    assert.equal(request.clientId, f.client.id);
    assert.equal(request.serviceVariantId, variant.id);
    assert.equal(request.originChannel, 'BM_SUPER_APP');
    assert.equal(request.createdByUserId, null);
    const attr = await db().query('SELECT * FROM handyman_channel_attributions WHERE id = $1', [request.channelAttributionId]);
    assert.equal(attr.rows.length, 1);
    assert.equal(attr.rows[0].actor_type, 'CUSTOMER_CARE');
    assert.equal(attr.rows[0].care_actor_id, i.actor.id);
    assert.equal(attr.rows[0].actor_reference, i.actor.actorReference);
    assert.equal(attr.rows[0].created_by_user_id, null);
    assert.equal(attr.rows[0].client_id, f.client.id);
    assert.equal(attr.rows[0].tenant_company_id, f.company.id);
    assert.equal(attr.rows[0].tenant_pic_id, f.pic.id);
    assert.equal(attr.rows[0].building_id, f.building.id);
    assert.equal(attr.rows[0].space_id, f.space.id);
    assert.equal(attr.rows[0].origin_channel, 'BM_SUPER_APP');
    assert.equal(attr.rows[0].origin_reference, `bm-handoff:${i.code}:${claim.assertionId}`);
    assert.equal(request.originReference, attr.rows[0].origin_reference);
    assert.equal((await counts()).sessions, before.sessions);
    assert.equal((await counts()).requests, before.requests + 1);
    assert.equal((await counts()).attributions, before.attributions + 1);
    assert.equal((await care(exchange.exchangeToken, f.service.id)).status, 401);
    assert.equal((await api().post('/api/v1/handoff/channel-attributions').send({ exchangeToken: exchange.exchangeToken })).status, 401);
    assert.equal((await api().post('/api/v1/handyman/requests').send({ channelAttributionId: request.channelAttributionId, serviceCatalogId: f.service.id })).status, 401);
    const localRetry = await api().post('/api/v1/handyman/requests').set('Authorization', `Bearer ${adminToken}`)
      .send({ channelAttributionId: request.channelAttributionId, serviceCatalogId: f.service.id });
    assert.equal(localRetry.status, 409);
  });

  it('matches the strict care DTO: no caller actor, customer, property, unit, occupancy or channel overrides', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const i = await integration();
    await grant(f, i);
    const exchange = await accept(assertion(f, i));
    const before = await counts();
    const disallowed: Record<string, unknown> = {
      channelAttributionId: randomUUID(),
      actorType: 'CUSTOMER_CARE', careActorId: i.actor.id,
      createdByUserId: f.linkedUser.id, tenantCompanyId: f.company.id,
      tenantPicId: f.pic.id, propertyId: f.property.id,
      buildingId: f.building.id, spaceId: f.space.id,
      tenantBuildingContextId: f.buildingContext.id,
      tenantSpaceRelationshipId: f.occupancy.id,
      originChannel: 'BM_SUPER_APP', originReference: 'caller-controlled',
      status: 'INTAKE',
    };
    for (const [field, value] of Object.entries(disallowed)) {
      const response = await care(exchange.exchangeToken, f.service.id, { [field]: value });
      assert.equal(response.status, 400, `${field}: ${JSON.stringify(response.body)}`);
    }
    assert.equal((await care('x'.repeat(513), f.service.id)).status, 400);
    assert.equal((await care(exchange.exchangeToken, 'not-a-uuid')).status, 400);
    assert.equal((await care(exchange.exchangeToken, f.service.id, { description: 'x'.repeat(1001) })).status, 400);
    assert.deepEqual(await counts(), before);
    assert.equal((await db().query('SELECT status FROM handyman_handoff_exchanges WHERE id=$1', [exchange.exchangeId])).rows[0].status, 'ACTIVE');
    assert.equal((await care(exchange.exchangeToken, f.service.id)).status, 201);
  });

  it('accepts care for a represented building without a selected unit, without inventing occupancy', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const i = await integration();
    await grant(f, i);
    const { spaceId: _spaceId, ...buildingOnly } = assertion(f, i);
    const exchange = await accept(buildingOnly);
    assert.equal(exchange.context.tenantBuildingContextId, f.buildingContext.id);
    assert.equal(exchange.context.tenantSpaceRelationshipId, null);
    const response = await care(exchange.exchangeToken, f.service.id);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.buildingId, f.building.id);
    assert.equal(response.body.data.spaceId, null);
    assert.equal(response.body.data.tenantCompanyId, f.company.id);
    assert.equal(response.body.data.createdByUserId, null);
    const attr = await db().query('SELECT space_id, care_actor_id FROM handyman_channel_attributions WHERE id=$1', [response.body.data.channelAttributionId]);
    assert.deepEqual(attr.rows[0], { space_id: null, care_actor_id: i.actor.id });
  });

  it('rejects building-context turnover after acceptance even if the same customer returns', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const i = await integration();
    await grant(f, i);
    const exchange = await accept(assertion(f, i));
    await db().query("UPDATE tenant_building_contexts SET status='INACTIVE' WHERE id=$1", [f.buildingContext.id]);
    const before = await counts();
    assert.equal((await care(exchange.exchangeToken, f.service.id)).status, 401);
    const replacement = await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: f.company.id, buildingId: f.building.id }, adminId);
    assert.notEqual(replacement.id, f.buildingContext.id);
    assert.equal((await care(exchange.exchangeToken, f.service.id)).status, 401);
    assert.deepEqual(await counts(), before);
    assert.equal((await db().query('SELECT status FROM handyman_handoff_exchanges WHERE id=$1', [exchange.exchangeId])).rows[0].status, 'ACTIVE');
  });

  it('denies missing/revoked grant and different property, including revocation after acceptance', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const sameClientOtherProperty = await fixture(f.client.id);
    const i = await integration();
    await grant(sameClientOtherProperty, i);
    await assert.rejects(accept(assertion(f, i)), (e: unknown) => (e as { statusCode?: number }).statusCode === 401);
    await grant(f, i);
    const x = await accept(assertion(f, i));
    await revokeCareActorProperty({ careActorId: i.actor.id, propertyId: f.property.id, clientId: f.client.id }, adminId);
    const before = await counts();
    assert.equal((await care(x.exchangeToken, f.service.id)).status, 401);
    assert.deepEqual(await counts(), before);
    assert.equal((await db().query('SELECT status FROM handyman_handoff_exchanges WHERE id=$1', [x.exchangeId])).rows[0].status, 'ACTIVE');
    await grant(f, i);
    assert.equal((await care(x.exchangeToken, f.service.id)).status, 201);
  });

  it('rejects occupancy turnover after acceptance even when old tenant returns to the same space', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const i = await integration();
    await grant(f, i);
    const x = await accept(assertion(f, i));
    await db().query("UPDATE tenant_space_relationships SET status='INACTIVE' WHERE id=$1", [f.occupancy.id]);
    const before = await counts();
    assert.equal((await care(x.exchangeToken, f.service.id)).status, 401);
    assert.deepEqual(await counts(), before);
    const nextOccupancy = await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: f.company.id, buildingId: f.building.id, spaceId: f.space.id }, adminId);
    assert.notEqual(nextOccupancy.id, f.occupancy.id);
    assert.equal((await care(x.exchangeToken, f.service.id)).status, 401);
  });

  it('rolls back token, attribution and request on cross-client catalogue or invalid variant', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const foreign = await fixture();
    const i = await integration();
    await grant(f, i);
    const x = await accept(assertion(f, i));
    const before = await counts();
    const badService = await care(x.exchangeToken, foreign.service.id);
    assert.equal(badService.status, 400);
    assert.deepEqual(await counts(), before);
    const badVariant = await handymanServiceVariantService.createHandymanServiceVariant({
      serviceCatalogId: foreign.service.id, code: `V_${suffix()}`, name: 'Foreign variant',
    }, adminId);
    assert.equal((await care(x.exchangeToken, f.service.id, { serviceVariantId: badVariant.id })).status, 400);
    assert.deepEqual(await counts(), before);
    assert.equal((await care(x.exchangeToken, f.service.id)).status, 201);
  });

  it('rejects legacy exchange on care route but preserves original bind and local-User create', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const i = await integration();
    const x = await accept(assertion(f, i, false));
    const before = await counts();
    assert.equal((await care(x.exchangeToken, f.service.id)).status, 401);
    assert.deepEqual(await counts(), before);
    const attribution = await bindHandoffExchangeToChannelAttribution(x.exchangeToken);
    const bareHandle = await api().post('/api/v1/handyman/requests/care')
      .send({ channelAttributionId: attribution.id, serviceCatalogId: f.service.id });
    assert.equal(bareHandle.status, 400);
    assert.equal((await care(x.exchangeToken, f.service.id)).status, 401);
    const created = await api().post('/api/v1/handyman/requests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ channelAttributionId: attribution.id, serviceCatalogId: f.service.id });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.createdByUserId, f.linkedUser.id);
  });

  it('allows at most one care creation for simultaneous uses of the exchange', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const i = await integration();
    await grant(f, i);
    const x = await accept(assertion(f, i));
    const before = await counts();
    const results = await Promise.all([
      care(x.exchangeToken, f.service.id), care(x.exchangeToken, f.service.id),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 401]);
    assert.equal((await counts()).requests, before.requests + 1);
    assert.equal((await counts()).attributions, before.attributions + 1);
  });

  it('documents the runtime care DTO, nullable actor-less response, and separate local-User contract', () => {
    const spec = parseYaml(readFileSync(new URL('../docs/api/openapi.yaml', import.meta.url), 'utf8')) as {
      paths: Record<string, { post: {
        security: unknown;
        operationId: string;
        requestBody: { content: Record<string, { schema: { $ref: string } }> };
        responses: Record<string, { content: Record<string, { schema: {
          allOf: Array<{ properties?: { data: { $ref: string } } }>;
        } }> }>;
      } }>;
      components: { schemas: Record<string, {
        required: string[];
        additionalProperties?: boolean;
        properties: Record<string, { $ref?: string; nullable?: boolean; minLength?: number; maxLength?: number }>;
      }> };
    };
    const operation = spec.paths['/handyman/requests/care'].post;
    assert.equal(operation.operationId, 'createCareHandymanServiceRequest');
    assert.deepEqual(operation.security, []);
    assert.equal(operation.requestBody.content['application/json'].schema.$ref, '#/components/schemas/CreateCareHandymanServiceRequest');
    assert.equal(operation.responses['201'].content['application/json'].schema.allOf[1].properties?.data.$ref, '#/components/schemas/HandymanServiceRequest');
    const dto = spec.components.schemas.CreateCareHandymanServiceRequest;
    assert.deepEqual(dto.required, ['exchangeToken', 'serviceCatalogId']);
    assert.equal(dto.additionalProperties, false);
    assert.deepEqual(Object.keys(dto.properties), ['exchangeToken', 'serviceCatalogId', 'serviceVariantId', 'description', 'preferredWindowStart', 'preferredWindowEnd']);
    assert.equal(dto.properties.exchangeToken.minLength, 1);
    assert.equal(dto.properties.exchangeToken.maxLength, 512);
    assert.equal(dto.properties.serviceCatalogId.$ref, '#/components/schemas/Uuid');
    assert.equal(dto.properties.description.maxLength, 1000);
    const response = spec.components.schemas.HandymanServiceRequest;
    assert.ok(response.required.includes('channelAttributionId'));
    assert.ok(response.required.includes('createdByUserId'));
    assert.equal(response.properties.createdByUserId.nullable, true);
    assert.equal(response.properties.spaceId.nullable, true);
    const local = spec.paths['/handyman/requests'].post;
    assert.deepEqual(local.security, [{ bearerAuth: [] }]);
    assert.equal(local.requestBody.content['application/json'].schema.$ref, '#/components/schemas/CreateHandymanServiceRequest');
  });
  it('CARE DATE: BM-hosted Care atomically records a preference using its real Care attribution, without a local User or tenant login', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(); const i = await integration(); await grant(f,i);
    await db().query("UPDATE buildings SET timezone='Asia/Jakarta' WHERE id=$1",[f.building.id]);
    const claim = assertion(f,i); delete claim.tenantPicId;
    const x = await accept(claim);
    const before = await counts();
    const response = await care(x.exchangeToken,f.service.id,{preferredWindowStart:'2031-12-10T10:00:00+07:00',preferredWindowEnd:'2031-12-10T12:00:00+07:00'});
    assert.equal(response.status,201,JSON.stringify(response.body));
    const request=response.body.data; const pref=request.schedulingReadiness;
    assert.equal(request.createdByUserId,null); assert.equal(request.tenantPicId,null);
    assert.equal(pref.timezone,'Asia/Jakarta'); assert.equal(pref.status,'ACTIVE');
    assert.equal(pref.preferredWindowStart,'2031-12-10T03:00:00.000Z');
    assert.equal(pref.preferredWindowEnd,'2031-12-10T05:00:00.000Z');
    assert.equal(pref.supersedesReadinessId,null);
    assert.equal('clientId' in pref,false); assert.equal('createdByUserId' in pref,false);
    const row=(await db().query('SELECT * FROM handyman_scheduling_readiness WHERE id=$1',[pref.id])).rows[0];
    assert.equal(row.client_id,f.client.id); assert.equal(row.handyman_request_id,request.id);
    assert.equal(row.created_by_user_id,null,'No customer, admin or phantom User is borrowed');
    const event=(await db().query("SELECT actor_user_id,metadata FROM operational_events WHERE entity_id=$1 AND event_type='HANDYMAN_SCHEDULING_READINESS_CREATED'",[pref.id])).rows[0];
    assert.equal(event.actor_user_id,null); assert.equal(event.metadata.careActorId,i.actor.id);
    assert.equal(event.metadata.channelAttributionId,request.channelAttributionId);
    assert.equal(JSON.stringify(event.metadata).includes(x.exchangeToken),false);
    assert.equal((await counts()).sessions,before.sessions);
    assert.equal((await db().query('SELECT count(*)::int AS n FROM handyman_visit_appointments WHERE handyman_request_id=$1',[request.id])).rows[0].n,0);
    assert.equal((await db().query('SELECT count(*)::int AS n FROM handyman_execution_scopes WHERE handyman_request_id=$1',[request.id])).rows[0].n,0);
    assert.equal((await care(x.exchangeToken,f.service.id,{preferredWindowStart:'2031-12-10T10:00:00+07:00',preferredWindowEnd:'2031-12-10T12:00:00+07:00'})).status,401);
    assert.equal((await db().query('SELECT count(*)::int AS n FROM handyman_scheduling_readiness WHERE handyman_request_id=$1',[request.id])).rows[0].n,1);
  });

  it('CARE DATE: BM invalid pairs/overrides do not consume the credential; timezone failure rolls all creation writes back', async (t) => {
    if (!ready(t)) return;
    const f=await fixture(); const i=await integration(); await grant(f,i);
    const x=await accept(assertion(f,i)); const before=await counts();
    const dates={preferredWindowStart:'2031-12-10T10:00:00Z',preferredWindowEnd:'2031-12-10T12:00:00Z'};
    for(const bad of [{preferredWindowStart:dates.preferredWindowStart},
      {preferredWindowStart:dates.preferredWindowStart,preferredWindowEnd:null},
      {preferredWindowStart:'2031-02-30T10:00:00Z',preferredWindowEnd:'2031-03-01T12:00:00Z'},
      {...dates,timezone:'UTC'},{...dates,createdByUserId:f.linkedUser.id}]) {
      assert.equal((await care(x.exchangeToken,f.service.id,bad)).status,400);
      assert.deepEqual(await counts(),before);
    }
    for (const zone of [null,'Invalid/Zone']) {
      await db().query('UPDATE buildings SET timezone=$1 WHERE id=$2',[zone,f.building.id]);
      const bad=await care(x.exchangeToken,f.service.id,dates);
      assert.equal(bad.status,400,JSON.stringify(bad.body));
      assert.equal(bad.body.error.code,'HANDYMAN_SCHEDULING_READINESS_TIMEZONE_UNAVAILABLE');
      assert.deepEqual(await counts(),before);
      assert.equal((await db().query('SELECT count(*)::int AS n FROM handyman_scheduling_readiness WHERE client_id=$1',[f.client.id])).rows[0].n,0);
    }
    await db().query("UPDATE buildings SET timezone='Asia/Jakarta' WHERE id=$1",[f.building.id]);
    assert.equal((await care(x.exchangeToken,f.service.id,dates)).status,201);
  });

  it('CARE DATE: BM audit failure rolls the preference, request, attribution and single-use exchange back together', async (t) => {
    if (!ready(t)) return;
    const f=await fixture(); const i=await integration(); await grant(f,i);
    await db().query("UPDATE buildings SET timezone='Asia/Jakarta' WHERE id=$1",[f.building.id]);
    const x=await accept(assertion(f,i)); const before=await counts();
    const dates={preferredWindowStart:'2031-12-10T10:00:00Z',preferredWindowEnd:'2031-12-10T12:00:00Z'};
    await db().query("ALTER TABLE operational_events ADD CONSTRAINT care_date_fail_audit CHECK (event_type <> 'HANDYMAN_SCHEDULING_READINESS_CREATED') NOT VALID");
    try {
      assert.equal((await care(x.exchangeToken,f.service.id,dates)).status,500);
      assert.deepEqual(await counts(),before);
      assert.equal((await db().query('SELECT count(*)::int AS n FROM handyman_scheduling_readiness WHERE client_id=$1',[f.client.id])).rows[0].n,0);
    } finally { await db().query('ALTER TABLE operational_events DROP CONSTRAINT care_date_fail_audit'); }
    assert.equal((await care(x.exchangeToken,f.service.id,dates)).status,201,'Failed atomic intake did not consume the exchange');
  });

  it('CARE DATE: simultaneous use of a dated Care exchange produces exactly one request and preference', async (t) => {
    if (!ready(t)) return;
    const f=await fixture(); const i=await integration(); await grant(f,i);
    await db().query("UPDATE buildings SET timezone='Asia/Jakarta' WHERE id=$1",[f.building.id]);
    const x=await accept(assertion(f,i));
    const dates={preferredWindowStart:'2031-12-10T10:00:00Z',preferredWindowEnd:'2031-12-10T12:00:00Z'};
    const responses=await Promise.all([care(x.exchangeToken,f.service.id,dates),care(x.exchangeToken,f.service.id,dates)]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[201,401]);
    const created=responses.find(r=>r.status===201)!.body.data;
    assert.equal((await db().query('SELECT count(*)::int AS n FROM handyman_scheduling_readiness WHERE handyman_request_id=$1',[created.id])).rows[0].n,1);
  });

  it('CARE DATE: Ops supersession preserves the original Care date/actor; database guards reject borrowed creators and null-actor revisions', async (t) => {
    if (!ready(t)) return;
    const f=await fixture(); const i=await integration(); await grant(f,i);
    await db().query("UPDATE buildings SET timezone='Asia/Jakarta' WHERE id=$1",[f.building.id]);
    const x=await accept(assertion(f,i));
    const dates={preferredWindowStart:'2031-12-10T10:00:00Z',preferredWindowEnd:'2031-12-10T12:00:00Z'};
    const response=await care(x.exchangeToken,f.service.id,dates);
    assert.equal(response.status,201,JSON.stringify(response.body));
    const first=response.body.data.schedulingReadiness;
    await assert.rejects(()=>db().query('UPDATE handyman_scheduling_readiness SET created_by_user_id=$1 WHERE id=$2',[f.linkedUser.id,first.id]),(error:any)=>error.code==='23514');
    const revised=await supersedeHandymanSchedulingReadiness(first.id,{preferredWindowStart:'2031-12-11T10:00:00Z',preferredWindowEnd:'2031-12-11T12:00:00Z',changeReason:'Operations recorded tenant-coordinated revision'},adminId);
    const history=await getHandymanSchedulingReadiness(response.body.data.id,adminId);
    assert.equal(history.current!.id,revised.id); assert.equal(revised.supersedesReadinessId,first.id);
    assert.equal(history.history.length,2); assert.equal(history.history[0].createdByUserId,null);
    assert.equal(history.history[0].preferredWindowStart,'2031-12-10T10:00:00.000Z');
    assert.equal(history.history[0].status,'INACTIVE'); assert.equal(history.history[1].createdByUserId,adminId);
    await assert.rejects(()=>db().query(`INSERT INTO handyman_scheduling_readiness
      (id,client_id,handyman_request_id,timezone,preferred_window_start,preferred_window_end,created_by_user_id,supersedes_readiness_id)
      VALUES ($1,$2,$3,'Asia/Jakarta',$4,$5,NULL,$6)`,[randomUUID(),f.client.id,response.body.data.id,dates.preferredWindowStart,dates.preferredWindowEnd,revised.id]),(error:any)=>error.code==='23514');
    await assert.rejects(()=>withTransaction(client=>migration0483HandymanCareInitialSchedulingPreference.down(client)),(error:any)=>error.code==='23514', 'Rollback never erases Care history or invents a User');
  });

  it('CARE DATE: nullable creators cannot be used for non-Care requests or foreign-client preferences', async (t) => {
    if (!ready(t)) return;
    const f=await fixture(); const i=await integration(); await grant(f,i);
    const legacy=await accept(assertion(f,i,false));
    const attr=await bindHandoffExchangeToChannelAttribution(legacy.exchangeToken);
    const local=await api().post('/api/v1/handyman/requests').set('Authorization',`Bearer ${adminToken}`)
      .send({channelAttributionId:attr.id,serviceCatalogId:f.service.id});
    assert.equal(local.status,201);
    const insert=(clientId:string,requestId:string)=>db().query(`INSERT INTO handyman_scheduling_readiness
      (id,client_id,handyman_request_id,timezone,preferred_window_start,preferred_window_end,created_by_user_id)
      VALUES ($1,$2,$3,'Asia/Jakarta','2031-12-10T10:00:00Z','2031-12-10T12:00:00Z',NULL)`,[randomUUID(),clientId,requestId]);
    await assert.rejects(()=>insert(f.client.id,local.body.data.id),(error:any)=>error.code==='23514');
    const other=await fixture();
    const x=await accept(assertion(f,i));
    const cared=await care(x.exchangeToken,f.service.id);
    assert.equal(cared.status,201);
    await assert.rejects(()=>insert(other.client.id,cared.body.data.id),(error:any)=>error.code==='23514');
  });

});
