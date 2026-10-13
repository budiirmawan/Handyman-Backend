import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
  handymanCareActorRepository,
  handymanCareActorService,
  grantCareActorProperty,
  type PublicHandymanCareActor,
} from '../src/modules/handyman-care-actors';
import {
  handoffIntegrationSecretEnvName,
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
 * CR-HM-01 AMENDMENT 01 PART 12 — final end-to-end certification for the
 * Customer Care BM handoff, driven through the REAL Express API (supertest)
 * against a real migrated PostgreSQL.
 *
 * Certified chain (governance amendment §3, D4–D8):
 *   signed BM assertion → Customer Care actor attestation → represented
 *   tenant/building/unit resolution → one-time exchange → binding →
 *   immutable channel attribution.
 *
 * This suite adds NO production code; it is the exit-gate evidence artifact.
 */

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55494;
const DIR = '/tmp/asentra-part12-pg';
if (EMBEDDED) {
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1',
    DB_PORT: String(PORT),
    DB_USER: 'postgres',
    DB_PASSWORD: 'postgres',
    DB_NAME: 'asentra_test',
    DB_SSL: 'false',
  });
}

const INTEGRATION_SECRET = 'part12-bm-scoped-secret-material';
const SIGNATURE_HEADER = 'x-hub-signature-256';
const ASSERTION_INVALID = 'HANDYMAN_HANDOFF_ASSERTION_INVALID';
const ASSERTION_REPLAYED = 'HANDYMAN_HANDOFF_ASSERTION_REPLAYED';
const EXCHANGE_INVALID = 'HANDYMAN_HANDOFF_EXCHANGE_INVALID';
const CHANNEL = 'BM_SUPER_APP';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
const secretEnvNames: string[] = [];
const registeredCareActors: { id: string; integrationId: string }[] = [];
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  if (EMBEDDED) {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
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
  await pool.query(`TRUNCATE handyman_channel_attributions,
    handyman_handoff_exchanges, handyman_handoff_assertions,
    handyman_handoff_care_actors, handyman_handoff_integrations,
    tenant_space_relationships, tenant_building_contexts, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    user_sessions, user_role_assignments, users, roles, permissions,
    clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
});

after(async () => {
  for (const name of secretEnvNames) delete process.env[name];
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
  pool = null;
  postgres = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('PART 12 PostgreSQL unavailable');
    return false;
  }
  return true;
}

function getPool(): Pool {
  if (!pool) throw new Error('PART 12 test pool is not initialised.');
  return pool;
}

async function integration(options: { careCapable?: boolean } = {}) {
  const code = `BM_${options.careCapable ? 'CARE' : 'LEGACY'}_${suffix()}`;
  const created = await handoffRuntimeRepository.createIntegration({
    integrationCode: code,
    displayName: options.careCapable ? 'BM Care integration' : 'BM integration',
  });
  const envName = handoffIntegrationSecretEnvName(code);
  process.env[envName] = INTEGRATION_SECRET;
  secretEnvNames.push(envName);
  if (options.careCapable) {
    await handymanCareActorService.setIntegrationActorCapability({
      integrationId: created.id,
      capability: 'CUSTOMER_CARE',
    });
  }
  return { id: created.id, code };
}

async function registerActor(integrationId: string): Promise<PublicHandymanCareActor> {
  const actor = await handymanCareActorService.createCareActor({
    integrationId,
    actorReference: `CC_${suffix()}`,
    displayName: 'Customer Care Agent',
  });
  registeredCareActors.push({ id: actor.id, integrationId });
  return actor;
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
  await buildingAssignmentService.createAssignment(adminUserId, {
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
  }, adminUserId);
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
    email: `requester-${suffix().toLowerCase()}@tenant.example.com`,
    userId: linkedUser.id,
  }, adminUserId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: building.id,
    spaceId: space.id,
  }, adminUserId);
  const context = await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: building.id,
  }, adminUserId);
  // PART 03: legacy actor fixtures explicitly provision the new property
  // authority before exercising their pre-existing attestation/binding cases.
  for (const registered of registeredCareActors) {
    const actor = await handymanCareActorRepository.findById(registered.id);
    const integrationScope = await handymanCareActorRepository
      .findIntegrationActorScopeById(registered.integrationId);
    if (actor?.status === 'ACTIVE' && integrationScope?.status === 'ACTIVE' &&
        integrationScope.actorCapability === 'CUSTOMER_CARE') {
      await grantCareActorProperty({
        careActorId: actor.id, propertyId: property.id, clientId: client.id,
      }, adminUserId);
    }
  }
  return { client, property, building, space, company, pic, linkedUser, context };
}

type Fixture = Awaited<ReturnType<typeof trustedFixture>>;

function makeAssertion(
  f: Fixture,
  integrationCode: string,
  actor?: { type: 'CUSTOMER_CARE'; actorReference: string },
): HandoffAssertion {
  const now = Date.now();
  return {
    integrationCode,
    assertionId: randomUUID(),
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
    tenantCompanyId: f.company.id,
    tenantPicId: f.pic.id,
    buildingId: f.building.id,
    spaceId: f.space.id,
    ...(actor ? { actor } : {}),
  } as HandoffAssertion;
}

function signatureFor(assertion: HandoffAssertion): string {
  return signHandoffAssertion(assertion, INTEGRATION_SECRET);
}

async function acceptOverHttp(assertion: HandoffAssertion, signature = signatureFor(assertion)) {
  return api()
    .post('/api/v1/handoff/assertions')
    .set(SIGNATURE_HEADER, signature)
    .send(assertion);
}

async function bindOverHttp(exchangeToken: string) {
  return api()
    .post('/api/v1/handoff/channel-attributions')
    .send({ exchangeToken });
}

async function tableCount(table: string): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return result.rows[0].n;
}

async function persistedRow(table: string, id: string) {
  const result = await getPool().query(
    `SELECT * FROM ${table} WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

describe('CR-HM-01 A01 PART 12 — Customer Care handoff certification', () => {
  it('E2E: full Customer Care chain over the real HTTP API', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    const f = await trustedFixture();

    // 1) signed BM assertion (actor block covered by the integration HMAC)
    const assertion = makeAssertion(f, integrationRecord.code, {
      type: 'CUSTOMER_CARE',
      actorReference: actor.actorReference,
    });
    const accepted = await acceptOverHttp(assertion);
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.ok(accepted.headers['x-request-id']);

    // 2) Customer Care actor attestation + 3) represented context resolution
    const context = accepted.body.data.context as Json;
    assert.equal(context.actorType, 'CUSTOMER_CARE');
    assert.equal(context.careActorId, actor.id);
    assert.equal(context.actorReference, actor.actorReference);
    assert.equal(context.clientId, f.client.id);
    assert.equal(context.tenantCompanyId, f.company.id);
    assert.equal(context.tenantPicId, f.pic.id);
    assert.equal(context.buildingId, f.building.id);
    assert.equal(context.spaceId, f.space.id);
    assert.equal(context.tenantBuildingContextId, f.context.id);
    // acting actor != represented customer (even though the PIC HAS a user)
    assert.equal(context.resolvedUserId, f.linkedUser.id);
    assert.notEqual(context.careActorId, f.linkedUser.id);
    assert.notEqual(context.careActorId, f.pic.id);

    // 4) one-time exchange — short-lived, hash-only, no session
    const sessionsBefore = await tableCount('user_sessions');
    const usersBefore = await tableCount('users');
    const rolesBefore = await tableCount('user_role_assignments');
    const { exchangeToken, expiresAt } = accepted.body.data;
    assert.ok(exchangeToken.length > 20);
    const ttlMs = Date.parse(expiresAt) - Date.now();
    assert.ok(ttlMs > 0 && ttlMs <= 120_000 + 1000);

    // 5) binding + 6) immutable channel attribution
    const bound = await bindOverHttp(exchangeToken);
    assert.equal(bound.status, 201, JSON.stringify(bound.body));
    const attribution = bound.body.data as Json;
    assert.equal(attribution.actorType, 'CUSTOMER_CARE');
    assert.equal(attribution.careActorId, actor.id);
    assert.equal(attribution.actorReference, actor.actorReference);
    assert.equal(attribution.createdByUserId, null);
    assert.equal(attribution.clientId, f.client.id);
    assert.equal(attribution.tenantCompanyId, f.company.id);
    assert.equal(attribution.tenantPicId, f.pic.id);
    assert.equal(attribution.buildingId, f.building.id);
    assert.equal(attribution.spaceId, f.space.id);
    assert.equal(attribution.originChannel, CHANNEL);
    assert.equal(
      attribution.originReference,
      `bm-handoff:${integrationRecord.code}:${assertion.assertionId}`,
    );

    // persisted state: hash-only token, single-use, immutable provenance
    const exchange = await persistedRow(
      'handyman_handoff_exchanges',
      await exchangeIdOf(exchangeToken),
    );
    assert.equal(exchange.status, 'USED');
    assert.equal(
      exchange.token_hash,
      createHash('sha256').update(exchangeToken).digest('hex'),
    );
    assert.notEqual(exchange.token_hash, exchangeToken);
    assert.equal(exchange.actor_type, 'CUSTOMER_CARE');
    assert.equal(exchange.care_actor_id, actor.id);

    const row = await persistedRow('handyman_channel_attributions', attribution.id);
    assert.equal(row.actor_type, 'CUSTOMER_CARE');
    assert.equal(row.care_actor_id, actor.id);
    assert.equal(row.created_by_user_id, null);
    assert.equal(row.origin_channel, CHANNEL);

    // append-only: provenance cannot be rewritten or deleted
    await assert.rejects(
      getPool().query(
        `UPDATE handyman_channel_attributions SET actor_reference = 'MUTATED' WHERE id = $1`,
        [attribution.id],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await assert.rejects(
      getPool().query(`DELETE FROM handyman_channel_attributions WHERE id = $1`, [
        attribution.id,
      ]),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );

    // no user/session/RBAC fabrication by the whole chain
    assert.equal(await tableCount('users'), usersBefore);
    assert.equal(await tableCount('user_sessions'), sessionsBefore);
    assert.equal(await tableCount('user_role_assignments'), rolesBefore);
  });

  it('E2E legacy: assertion without actor keeps the pre-amendment behavior', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration();
    const f = await trustedFixture();
    const assertion = makeAssertion(f, integrationRecord.code);

    const accepted = await acceptOverHttp(assertion);
    assert.equal(accepted.status, 201);
    const context = accepted.body.data.context as Json;
    assert.equal(context.actorType, null);
    assert.equal(context.careActorId, null);
    assert.equal(context.actorReference, null);
    assert.equal(context.resolvedUserId, f.linkedUser.id);

    const bound = await bindOverHttp(accepted.body.data.exchangeToken);
    assert.equal(bound.status, 201);
    const attribution = bound.body.data as Json;
    assert.equal(attribution.actorType, null);
    assert.equal(attribution.careActorId, null);
    assert.equal(attribution.actorReference, null);
    assert.equal(attribution.createdByUserId, f.linkedUser.id);
    assert.equal(attribution.originChannel, CHANNEL);
  });

  it('E2E fail-closed matrix: incapable/unknown/inactive/foreign actor → identical 401, no downgrade', async (t) => {
    if (!ready(t)) return;
    const incapable = await integration();
    const capable = await integration({ careCapable: true });
    const capableOther = await integration({ careCapable: true });
    const actor = await registerActor(capable.id);
    const inactiveActor = await registerActor(capable.id);
    await handymanCareActorService.deactivateCareActor(inactiveActor.id);
    const f = await trustedFixture();

    const attempts: HandoffAssertion[] = [
      makeAssertion(f, incapable.code, { type: 'CUSTOMER_CARE', actorReference: actor.actorReference }),
      makeAssertion(f, capable.code, { type: 'CUSTOMER_CARE', actorReference: `CC_${suffix()}` }),
      makeAssertion(f, capable.code, { type: 'CUSTOMER_CARE', actorReference: inactiveActor.actorReference }),
      makeAssertion(f, capableOther.code, { type: 'CUSTOMER_CARE', actorReference: actor.actorReference }),
      makeAssertion(f, `BM_SUPER_APP_CARE_${suffix()}`, { type: 'CUSTOMER_CARE', actorReference: actor.actorReference }),
      makeAssertion(f, capable.code, { type: 'SUPERVISOR', actorReference: actor.actorReference } as never),
    ];

    const exchangesBefore = await tableCount('handyman_handoff_exchanges');
    const assertionsBefore = await tableCount('handyman_handoff_assertions');
    const attributionsBefore = await tableCount('handyman_channel_attributions');
    const failures: string[] = [];

    for (const assertion of attempts) {
      const res = await acceptOverHttp(assertion);
      assert.equal(res.status, 401, JSON.stringify(res.body));
      assert.equal(res.body.error.code, ASSERTION_INVALID);
      // the failure carries no causal detail and no internals
      assert.deepEqual(Object.keys(res.body.error), [
        'code',
        'message',
        'category',
        'retryable',
        'requestId',
      ]);
      // fingerprint WITHOUT requestId (which is per-request by design)
      const { code, message, category, retryable } = res.body.error;
      failures.push(JSON.stringify({ code, message, category, retryable }));
    }
    // every failure mode is byte-identical (non-enumerating)
    assert.equal(new Set(failures).size, 1);

    // no silent downgrade: nothing was created for any rejected attempt
    assert.equal(await tableCount('handyman_handoff_exchanges'), exchangesBefore);
    assert.equal(await tableCount('handyman_handoff_assertions'), assertionsBefore);
    assert.equal(await tableCount('handyman_channel_attributions'), attributionsBefore);
  });

  it('E2E tamper: the actor block is signature-covered and server-resolved', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    const otherActor = await registerActor(integrationRecord.id);
    const f = await trustedFixture();
    const assertion = makeAssertion(f, integrationRecord.code, {
      type: 'CUSTOMER_CARE',
      actorReference: actor.actorReference,
    });
    const signature = signatureFor(assertion);

    // swap the actor after signing → signature no longer matches
    const swapped = await api()
      .post('/api/v1/handoff/assertions')
      .set(SIGNATURE_HEADER, signature)
      .send({ ...assertion, actor: { type: 'CUSTOMER_CARE', actorReference: otherActor.actorReference } });
    assert.equal(swapped.status, 401);

    // strip the actor after signing → signature no longer matches (the actor
    // block is inside the signed canonical payload, not an extra channel)
    const { actor: _ignored, ...withoutActor } = assertion as Json;
    const stripped = await api()
      .post('/api/v1/handoff/assertions')
      .set(SIGNATURE_HEADER, signature)
      .send(withoutActor);
    assert.equal(stripped.status, 401);

    // add an actor to a legacy-signed assertion → rejected, no privilege gain
    const legacy = makeAssertion(f, integrationRecord.code);
    const elevated = await api()
      .post('/api/v1/handoff/assertions')
      .set(SIGNATURE_HEADER, signatureFor(legacy))
      .send({
        ...legacy,
        actor: { type: 'CUSTOMER_CARE', actorReference: actor.actorReference },
      });
    assert.equal(elevated.status, 401);

    // client cannot supply identity: an invented member fails closed
    const smuggled = await acceptOverHttp({
      ...assertion,
      actor: {
        type: 'CUSTOMER_CARE',
        actorReference: actor.actorReference,
        careActorId: actor.id,
      },
    } as HandoffAssertion);
    assert.equal(smuggled.status, 401);

    // the untampered assertion still works and resolves server-side
    const accepted = await acceptOverHttp(assertion, signature);
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.data.context.careActorId, actor.id);
  });

  it('E2E exchange invariants: TTL, single-use, replay, hash-only — identical for both flows', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    const f = await trustedFixture();
    const assertion = makeAssertion(f, integrationRecord.code, {
      type: 'CUSTOMER_CARE',
      actorReference: actor.actorReference,
    });
    const signature = signatureFor(assertion);

    const accepted = await acceptOverHttp(assertion, signature);
    assert.equal(accepted.status, 201);
    const { exchangeToken, expiresAt } = accepted.body.data;
    // raw token is never persisted (hash-only at rest)
    const rawStored = await getPool().query(
      `SELECT count(*)::int AS n FROM handyman_handoff_exchanges WHERE token_hash = $1`,
      [exchangeToken],
    );
    assert.equal(rawStored.rows[0].n, 0);
    assert.ok(Date.parse(expiresAt) > Date.now());
    assert.ok(Date.parse(expiresAt) <= Date.now() + 121_000);

    // single-use
    assert.equal((await bindOverHttp(exchangeToken)).status, 201);
    const reuse = await bindOverHttp(exchangeToken);
    assert.equal(reuse.status, 401);
    assert.equal(reuse.body.error.code, EXCHANGE_INVALID);

    // replay of the assertion id is still rejected after the whole flow
    const replay = await acceptOverHttp(assertion, signature);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error.code, ASSERTION_REPLAYED);
  });

  it('OpenAPI matches the runtime contract for the Customer Care surfaces', async (t) => {
    if (!ready(t)) return;
    const spec = parseYaml(
      readFileSync(new URL('../docs/api/openapi.yaml', import.meta.url), 'utf8'),
    ) as Json;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    const f = await trustedFixture();
    const assertion = makeAssertion(f, integrationRecord.code, {
      type: 'CUSTOMER_CARE',
      actorReference: actor.actorReference,
    });

    const accepted = await acceptOverHttp(assertion);
    assert.equal(accepted.status, 201);
    const bound = await bindOverHttp(accepted.body.data.exchangeToken);
    assert.equal(bound.status, 201);

    // runtime response keys must be documented (provenance included)
    const snapshotSchema = spec.components.schemas.HandoffContextSnapshot;
    for (const key of Object.keys(accepted.body.data.context)) {
      assert.ok(
        snapshotSchema.properties[key] !== undefined,
        `runtime exchange context key ${key} documented`,
      );
    }
    const attributionSchema = spec.components.schemas.HandymanChannelAttribution;
    for (const key of Object.keys(bound.body.data)) {
      assert.ok(
        attributionSchema.properties[key] !== undefined,
        `runtime attribution key ${key} documented`,
      );
    }

    // and the documented actor block matches the accepted request shape
    const claimSchema = spec.components.schemas.HandoffCareActorClaim;
    assert.deepEqual(claimSchema.required, ['type', 'actorReference']);
    assert.deepEqual(claimSchema.properties.type.enum, ['CUSTOMER_CARE']);
    assert.equal(claimSchema.additionalProperties, false);
    assert.equal(snapshotSchema.properties.careActorId.nullable, true);
    assert.equal(attributionSchema.properties.careActorId.nullable, true);

    // binding accepts only the exchange token: actor identity is never input
    assert.deepEqual(
      Object.keys(spec.components.schemas.HandoffBindingRequest.properties),
      ['exchangeToken'],
    );
    // no invented handoff endpoint, no /webhooks handoff surface
    assert.deepEqual(
      Object.keys(spec.paths).filter((path) => path.includes('handoff')).sort(),
      ['/handoff/assertions', '/handoff/channel-attributions'],
    );
  });
});

async function exchangeIdOf(exchangeToken: string): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM handyman_handoff_exchanges WHERE token_hash = $1`,
    [createHash('sha256').update(exchangeToken).digest('hex')],
  );
  return result.rows[0].id;
}
