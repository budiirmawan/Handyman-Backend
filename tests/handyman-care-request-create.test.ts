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
    assert.deepEqual(Object.keys(dto.properties), ['exchangeToken', 'serviceCatalogId', 'serviceVariantId', 'description']);
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
});
