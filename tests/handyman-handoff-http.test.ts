import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  hashHandoffExchangeToken,
  handoffRuntimeRepository,
  signHandoffAssertion,
  type HandoffAssertion,
} from '../src/modules/handyman-handoff';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-01 PART 05 — focused HTTP + OpenAPI tests for the exposed secure
 * handoff flow (frozen D3: /api/v1 only, never /webhooks).
 * Tests 1–6 are the mandated HTTP surface checks; test 7 is the focused
 * OpenAPI parse/contract check. Real migrated PostgreSQL; supertest drives
 * the real Express app. Delta-based table counts keep tests isolated.
 */

const INTEGRATION_CODE = 'BM_SUPER_APP';
const SECRET_ENV = 'HANDYMAN_HANDOFF_SECRET_BM_SUPER_APP';
const INTEGRATION_SECRET = 'test-bm-scoped-secret-material';
const SIGNATURE_HEADER = 'x-hub-signature-256';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let userId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_channel_attributions,
    handyman_handoff_exchanges, handyman_handoff_assertions,
    handyman_handoff_integrations, tenant_service_requests,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  process.env[SECRET_ENV] = INTEGRATION_SECRET;
  await handoffRuntimeRepository.createIntegration({
    integrationCode: INTEGRATION_CODE,
    displayName: 'BM Super App',
  });
  const admin = await createAdminUser();
  userId = admin.userId;
  database = db;
});

after(async () => {
  delete process.env[SECRET_ENV];
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function trustedFixture() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Owner Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  await buildingAssignmentService.createAssignment(userId, {
    buildingId: building.id,
  });
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `F_${suffix()}`,
    name: 'Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A_${suffix()}`,
    name: 'Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R_${suffix()}`,
    name: 'Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `S_${suffix()}`,
    name: 'Tenant Space',
  });
  const company = await tenantCompanyService.createTenantCompany({
    clientId: client.id,
    tenantCode: `TNT_${suffix()}`,
    tenantName: 'Tenant Company',
  }, userId);
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: building.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: 'requester@tenant.example.com',
    userId: linkedUser.id,
  }, userId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: building.id,
    spaceId: space.id,
  }, userId);
  const context = await tenantBuildingContextService
    .createTenantBuildingContext({
      tenantCompanyId: company.id,
      buildingId: building.id,
    }, userId);
  return { client, building, space, company, pic, linkedUser, context };
}

function makeAssertion(
  f: Awaited<ReturnType<typeof trustedFixture>>,
  overrides: Record<string, unknown> = {},
): HandoffAssertion {
  const now = Date.now();
  return {
    integrationCode: INTEGRATION_CODE,
    assertionId: randomUUID(),
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
    tenantCompanyId: f.company.id,
    tenantPicId: f.pic.id,
    buildingId: f.building.id,
    spaceId: f.space.id,
    ...overrides,
  } as HandoffAssertion;
}

async function tableCount(name: string): Promise<number> {
  assert.ok(pool);
  const result = await pool.query(`SELECT count(*)::int AS n FROM ${name}`);
  return result.rows[0].n as number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe('CR-HM-01 PART 05 — secure handoff HTTP + OpenAPI', () => {
  it('1: valid signed assertion → 201 one-time exchange + canonical context', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const assertion = makeAssertion(f);
    const signature = signHandoffAssertion(assertion, INTEGRATION_SECRET);
    const res = await api()
      .post('/api/v1/handoff/assertions')
      .set(SIGNATURE_HEADER, signature)
      .send(assertion);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.headers['x-request-id']);
    const body = res.body as Json;
    assert.equal(body.success, true);
    assert.ok(body.data.exchangeToken.length > 20);
    assert.ok(Date.parse(body.data.expiresAt) > Date.now());
    assert.equal(body.data.context.clientId, f.client.id);
    assert.equal(body.data.context.tenantCompanyId, f.company.id);
    assert.equal(body.data.context.tenantPicId, f.pic.id);
    assert.equal(body.data.context.buildingId, f.building.id);
    assert.equal(body.data.context.spaceId, f.space.id);
    assert.equal(body.data.context.tenantBuildingContextId, f.context.id);
    assert.equal(body.data.context.resolvedUserId, f.linkedUser.id);
  });

  it('2: invalid signature → non-enumerating 401', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const assertion = makeAssertion(f);
    const forged = signHandoffAssertion(assertion, 'wrong-secret');
    const resForged = await api()
      .post('/api/v1/handoff/assertions')
      .set(SIGNATURE_HEADER, forged)
      .send(assertion);
    assert.equal(resForged.status, 401);
    assert.equal(resForged.body.success, false);
    assert.equal(
      resForged.body.error.code,
      'HANDYMAN_HANDOFF_ASSERTION_INVALID',
    );
    // missing signature yields the SAME non-enumerating failure
    const resMissing = await api()
      .post('/api/v1/handoff/assertions')
      .send(assertion);
    assert.equal(resMissing.status, 401);
    assert.equal(
      resMissing.body.error.code,
      'HANDYMAN_HANDOFF_ASSERTION_INVALID',
    );
    assert.equal(
      resMissing.body.error.message,
      resForged.body.error.message,
    );
  });

  it('3: replayed assertion → 409 conflict', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const assertion = makeAssertion(f);
    const signature = signHandoffAssertion(assertion, INTEGRATION_SECRET);
    const first = await api()
      .post('/api/v1/handoff/assertions')
      .set(SIGNATURE_HEADER, signature)
      .send(assertion);
    assert.equal(first.status, 201);
    const replay = await api()
      .post('/api/v1/handoff/assertions')
      .set(SIGNATURE_HEADER, signature)
      .send(assertion);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.success, false);
    assert.equal(
      replay.body.error.code,
      'HANDYMAN_HANDOFF_ASSERTION_REPLAYED',
    );
  });

  it('4: valid exchange bind → 201 immutable attribution', async (t) => {
    if (!ready(t) || !pool) return;
    const f = await trustedFixture();
    const assertion = makeAssertion(f);
    const signature = signHandoffAssertion(assertion, INTEGRATION_SECRET);
    const accept = await api()
      .post('/api/v1/handoff/assertions')
      .set(SIGNATURE_HEADER, signature)
      .send(assertion);
    assert.equal(accept.status, 201);
    const { exchangeToken } = accept.body.data;
    const bind = await api()
      .post('/api/v1/handoff/channel-attributions')
      .send({ exchangeToken });
    assert.equal(bind.status, 201, JSON.stringify(bind.body));
    assert.ok(bind.headers['x-request-id']);
    const attribution = bind.body.data;
    assert.ok(attribution.id);
    assert.equal(attribution.clientId, f.client.id);
    assert.equal(attribution.tenantCompanyId, f.company.id);
    assert.equal(attribution.tenantPicId, f.pic.id);
    assert.equal(attribution.buildingId, f.building.id);
    assert.equal(attribution.spaceId, f.space.id);
    assert.equal(attribution.originChannel, 'BM_SUPER_APP');
    assert.equal(
      attribution.originReference,
      `bm-handoff:${INTEGRATION_CODE}:${assertion.assertionId}`,
    );
    assert.equal(attribution.createdByUserId, f.linkedUser.id);
    assert.ok(!Number.isNaN(Date.parse(attribution.createdAt)));
  });

  it('5: second bind of the consumed exchange → non-enumerating 401', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const assertion = makeAssertion(f);
    const signature = signHandoffAssertion(assertion, INTEGRATION_SECRET);
    const accept = await api()
      .post('/api/v1/handoff/assertions')
      .set(SIGNATURE_HEADER, signature)
      .send(assertion);
    assert.equal(accept.status, 201);
    const { exchangeToken } = accept.body.data;
    const before1 = await tableCount('handyman_channel_attributions');
    const first = await api()
      .post('/api/v1/handoff/channel-attributions')
      .send({ exchangeToken });
    assert.equal(first.status, 201);
    const second = await api()
      .post('/api/v1/handoff/channel-attributions')
      .send({ exchangeToken });
    assert.equal(second.status, 401);
    assert.equal(second.body.success, false);
    assert.equal(second.body.error.code, 'HANDYMAN_HANDOFF_EXCHANGE_INVALID');
    // unknown token is the identical non-enumerating failure
    const forged = await api()
      .post('/api/v1/handoff/channel-attributions')
      .send({ exchangeToken: 'forged-token-value' });
    assert.equal(forged.status, 401);
    assert.equal(forged.body.error.code, 'HANDYMAN_HANDOFF_EXCHANGE_INVALID');
    assert.equal(forged.body.error.message, second.body.error.message);
    // exactly one attribution ever came from this exchange
    assert.equal(
      await tableCount('handyman_channel_attributions'),
      before1 + 1,
    );
  });

  it('6: responses never expose secret/hash/replay internals', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const assertion = makeAssertion(f);
    const signature = signHandoffAssertion(assertion, INTEGRATION_SECRET);
    const accept = await api()
      .post('/api/v1/handoff/assertions')
      .set(SIGNATURE_HEADER, signature)
      .send(assertion);
    assert.equal(accept.status, 201);
    const acceptRaw = JSON.stringify(accept.body);
    const { exchangeToken } = accept.body.data;
    const tokenHash = hashHandoffExchangeToken(exchangeToken);
    // success surface: no secret material, no stored hash, no replay records
    assert.ok(!acceptRaw.includes(INTEGRATION_SECRET));
    assert.ok(!acceptRaw.includes(tokenHash));
    assert.ok(!acceptRaw.includes('tokenHash'));
    assert.ok(!acceptRaw.includes('assertionHash'));
    assert.ok(!acceptRaw.includes(signature));
    const bind = await api()
      .post('/api/v1/handoff/channel-attributions')
      .send({ exchangeToken });
    assert.equal(bind.status, 201);
    const bindRaw = JSON.stringify(bind.body);
    assert.ok(!bindRaw.includes(INTEGRATION_SECRET));
    assert.ok(!bindRaw.includes(tokenHash));
    assert.ok(!bindRaw.includes('tokenHash'));
    assert.ok(!bindRaw.includes('assertionHash'));
    assert.ok(!bindRaw.includes(exchangeToken));
    // error surface: no causal detail, secrets, hashes, or internal rows
    const forged = await api()
      .post('/api/v1/handoff/assertions')
      .set(SIGNATURE_HEADER, signHandoffAssertion(assertion, 'wrong-secret'))
      .send(assertion);
    assert.equal(forged.status, 401);
    const errorRaw = JSON.stringify(forged.body);
    assert.ok(!errorRaw.includes(INTEGRATION_SECRET));
    assert.ok(!errorRaw.includes('signature'));
    assert.ok(!errorRaw.includes('handyman_handoff_'));
    assert.deepEqual(Object.keys(forged.body.error), [
      'code',
      'message',
      'category',
      'retryable',
      'requestId',
    ]);
    const replay = await api()
      .post('/api/v1/handoff/assertions')
      .set(SIGNATURE_HEADER, signature)
      .send(assertion);
    assert.equal(replay.status, 409);
    const replayRaw = JSON.stringify(replay.body);
    assert.ok(!replayRaw.includes('assertionHash'));
    assert.ok(!replayRaw.includes('handyman_handoff_'));
  });

  it('7: OpenAPI documents exactly the implemented contract', async () => {
    const raw = readFileSync(
      new URL('../docs/api/openapi.yaml', import.meta.url),
      'utf8',
    );
    const spec = parseYaml(raw) as Json;
    assert.ok(spec.paths['/handoff/assertions']?.post);
    assert.ok(spec.paths['/handoff/channel-attributions']?.post);
    // D3: no handoff surface under /webhooks
    for (const path of Object.keys(spec.paths)) {
      assert.ok(
        !path.startsWith('/webhooks/') ||
          !path.toLowerCase().includes('handoff'),
        `handoff leaked into webhook path ${path}`,
      );
    }
    const accept = spec.paths['/handoff/assertions'].post;
    // integration signature auth; Bearer session is not a substitute
    assert.deepEqual(accept.security, [{ handoffAssertionSignature: [] }]);
    assert.equal(
      spec.components.securitySchemes.handoffAssertionSignature.name,
      SIGNATURE_HEADER,
    );
    assert.deepEqual(
      Object.keys(accept.responses).sort(),
      ['201', '400', '401', '409'],
    );
    assert.equal(
      accept.requestBody.content['application/json'].schema.$ref,
      '#/components/schemas/HandoffAssertion',
    );
    const bind = spec.paths['/handoff/channel-attributions'].post;
    assert.deepEqual(
      Object.keys(bind.responses).sort(),
      ['201', '400', '401', '409'],
    );
    const schemas = spec.components.schemas;
    for (const name of [
      'HandoffAssertion',
      'HandoffBindingRequest',
      'HandoffContextSnapshot',
      'HandoffExchangeAccepted',
      'HandymanChannelAttribution',
    ]) {
      assert.ok(schemas[name], `schema ${name} documented`);
    }
    assert.deepEqual(
      schemas.HandoffAssertion.required,
      [
        'integrationCode',
        'assertionId',
        'issuedAt',
        'expiresAt',
        'tenantCompanyId',
        'buildingId',
      ],
    );
    assert.deepEqual(
      schemas.HandymanChannelAttribution.properties.originChannel.enum,
      ['BM_SUPER_APP'],
    );
  });
});
