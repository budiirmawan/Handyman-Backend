import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
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
import { handymanChannelAttributionService } from '../src/modules/handyman-channel-attributions';
import {
  bindHandoffExchangeToChannelAttribution,
  consumeHandoffExchange,
  handoffIntegrationSecretEnvName,
  handoffRuntimeRepository,
  handoffRuntimeService,
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
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-01 AMENDMENT 01 PART 10 — focused tests for binding attested Customer
 * Care actor provenance into the immutable channel attribution
 * (governance amendment §3.5, frozen D4/D8).
 *
 * Scope: actor provenance persistence, represented-context preservation,
 * no-borrow rule for created_by_user_id, byte-equivalent legacy behavior,
 * storage-layer integrity guards, single-use/atomicity preservation, and
 * absence of session/user/RBAC fabrication. No OpenAPI (PART 11) and no
 * PART 11+ work.
 */

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55491;
const DIR = '/tmp/asentra-part10-pg';
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

const INTEGRATION_SECRET = 'part10-bm-scoped-secret-material';
const ORIGIN_CHANNEL = 'BM_SUPER_APP';

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
    t.skip('PART 10 PostgreSQL unavailable');
    return false;
  }
  return true;
}

function getPool(): Pool {
  if (!pool) throw new Error('PART 10 test pool is not initialised.');
  return pool;
}

type Failure = { code?: string; message?: string; statusCode?: number };

async function captureFailure(run: () => Promise<unknown>): Promise<Failure> {
  let captured: Failure | null = null;
  try {
    await run();
  } catch (error) {
    captured = error as Failure;
  }
  assert.ok(captured, 'expected the call to fail closed');
  return captured;
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

async function trustedFixture(options: { linkedPicUser?: boolean } = {}) {
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

  let linkedUser: { id: string } | null = null;
  if (options.linkedPicUser ?? true) {
    linkedUser = await userService.createUser({
      email: `customer-${suffix().toLowerCase()}@example.com`,
      displayName: 'Customer Person',
    });
    await buildingAssignmentService.createAssignment(linkedUser.id, {
      buildingId: building.id,
    });
  }
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: `requester-${suffix().toLowerCase()}@tenant.example.com`,
    ...(linkedUser ? { userId: linkedUser.id } : {}),
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

async function accept(
  assertion: HandoffAssertion,
): Promise<{ exchangeId: string; exchangeToken: string }> {
  const accepted = await handoffRuntimeService.acceptHandoffAssertion(
    assertion,
    signHandoffAssertion(assertion, INTEGRATION_SECRET),
  );
  return { exchangeId: accepted.exchangeId, exchangeToken: accepted.exchangeToken };
}

async function tableCount(table: string): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return result.rows[0].n;
}

async function attributionRow(id: string) {
  const result = await getPool().query<{
    actorType: string | null;
    careActorId: string | null;
    actorReference: string | null;
    createdByUserId: string | null;
    tenantCompanyId: string;
    tenantPicId: string | null;
    buildingId: string;
    spaceId: string | null;
    originChannel: string;
    originReference: string | null;
  }>(
    `SELECT actor_type AS "actorType", care_actor_id AS "careActorId",
            actor_reference AS "actorReference",
            created_by_user_id AS "createdByUserId",
            tenant_company_id AS "tenantCompanyId",
            tenant_pic_id AS "tenantPicId", building_id AS "buildingId",
            space_id AS "spaceId", origin_channel AS "originChannel",
            origin_reference AS "originReference"
       FROM handyman_channel_attributions WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

async function exchangeStatus(exchangeId: string): Promise<string> {
  const result = await getPool().query<{ status: string }>(
    `SELECT status FROM handyman_handoff_exchanges WHERE id = $1`,
    [exchangeId],
  );
  return result.rows[0].status;
}

describe('CR-HM-01 A01 PART 10 — Customer Care actor attribution binding', () => {
  it('binds attested actor provenance while preserving the represented context', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    const f = await trustedFixture();
    const assertion = makeAssertion(f, integrationRecord.code, {
      type: 'CUSTOMER_CARE',
      actorReference: actor.actorReference,
    });
    const { exchangeToken } = await accept(assertion);

    const attribution = await bindHandoffExchangeToChannelAttribution(exchangeToken);

    // Acting identity = authoritative registry actor only.
    assert.equal(attribution.actorType, 'CUSTOMER_CARE');
    assert.equal(attribution.careActorId, actor.id);
    assert.equal(attribution.actorReference, actor.actorReference);
    // The represented customer is never borrowed as the acting user.
    assert.equal(attribution.createdByUserId, null);
    // Represented tenant/customer/building/unit attribution is unchanged.
    assert.equal(attribution.clientId, f.client.id);
    assert.equal(attribution.tenantCompanyId, f.company.id);
    assert.equal(attribution.tenantPicId, f.pic.id);
    assert.equal(attribution.buildingId, f.building.id);
    assert.equal(attribution.spaceId, f.space.id);
    // Channel preserved; provenance format unchanged.
    assert.equal(attribution.originChannel, ORIGIN_CHANNEL);
    assert.equal(
      attribution.originReference,
      `bm-handoff:${integrationRecord.code}:${assertion.assertionId}`,
    );

    // Persisted row matches 1:1 (immutable provenance).
    const row = await attributionRow(attribution.id);
    assert.equal(row.actorType, 'CUSTOMER_CARE');
    assert.equal(row.careActorId, actor.id);
    assert.equal(row.actorReference, actor.actorReference);
    assert.equal(row.createdByUserId, null);
    assert.equal(row.tenantCompanyId, f.company.id);
    assert.equal(row.tenantPicId, f.pic.id);
    assert.equal(row.buildingId, f.building.id);
    assert.equal(row.spaceId, f.space.id);
    assert.equal(row.originChannel, ORIGIN_CHANNEL);
  });

  it('never borrows the represented PIC linked user, even when the PIC has one', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    // This fixture's PIC has a local linked user — the exact case that must
    // not leak into created_by_user_id for an attested actor flow.
    const f = await trustedFixture({ linkedPicUser: true });
    assert.ok(f.linkedUser);
    const assertion = makeAssertion(f, integrationRecord.code, {
      type: 'CUSTOMER_CARE',
      actorReference: actor.actorReference,
    });
    const { exchangeToken } = await accept(assertion);

    const attribution = await bindHandoffExchangeToChannelAttribution(exchangeToken);
    assert.notEqual(attribution.careActorId, f.linkedUser?.id);
    assert.notEqual(attribution.createdByUserId, f.linkedUser?.id);
    assert.equal(attribution.createdByUserId, null);

    const row = await attributionRow(attribution.id);
    assert.equal(row.createdByUserId, null);
    assert.equal(row.careActorId, actor.id);
  });

  it('keeps the legacy handoff attribution byte-for-byte unchanged', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration();
    const f = await trustedFixture({ linkedPicUser: true });
    const assertion = makeAssertion(f, integrationRecord.code);
    const { exchangeToken } = await accept(assertion);

    const attribution = await bindHandoffExchangeToChannelAttribution(exchangeToken);

    // Legacy path: actor columns NULL, acting user still the resolved
    // customer user, exactly as before PART 10.
    assert.equal(attribution.actorType, null);
    assert.equal(attribution.careActorId, null);
    assert.equal(attribution.actorReference, null);
    assert.equal(attribution.createdByUserId, f.linkedUser?.id);
    assert.equal(attribution.originChannel, ORIGIN_CHANNEL);
    assert.equal(
      attribution.originReference,
      `bm-handoff:${integrationRecord.code}:${assertion.assertionId}`,
    );

    const row = await attributionRow(attribution.id);
    assert.equal(row.actorType, null);
    assert.equal(row.careActorId, null);
    assert.equal(row.actorReference, null);
    assert.equal(row.createdByUserId, f.linkedUser?.id);
  });

  it('keeps a legacy PIC without a linked user attributable with a null actor', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration();
    const f = await trustedFixture({ linkedPicUser: false });
    assert.equal(f.linkedUser, null);
    const assertion = makeAssertion(f, integrationRecord.code);
    const { exchangeToken } = await accept(assertion);

    const attribution = await bindHandoffExchangeToChannelAttribution(exchangeToken);
    assert.equal(attribution.createdByUserId, null);
    assert.equal(attribution.actorType, null);
    assert.equal(attribution.careActorId, null);
    assert.equal(attribution.tenantPicId, f.pic.id);
  });

  it('preserves single-use binding and leaves no attribution on retry', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    const f = await trustedFixture();
    const assertion = makeAssertion(f, integrationRecord.code, {
      type: 'CUSTOMER_CARE',
      actorReference: actor.actorReference,
    });
    const { exchangeToken } = await accept(assertion);

    const attribution = await bindHandoffExchangeToChannelAttribution(exchangeToken);
    const countAfterFirst = await tableCount('handyman_channel_attributions');

    const retry = await captureFailure(() =>
      bindHandoffExchangeToChannelAttribution(exchangeToken),
    );
    assert.equal(retry.code, 'HANDYMAN_HANDOFF_EXCHANGE_INVALID');
    assert.equal(retry.statusCode, 401);
    assert.equal(await tableCount('handyman_channel_attributions'), countAfterFirst);

    // Exactly one attribution carries this actor's provenance.
    const rows = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM handyman_channel_attributions
        WHERE care_actor_id = $1`,
      [actor.id],
    );
    assert.equal(rows.rows[0].n, 1);
    assert.equal((await attributionRow(attribution.id)).careActorId, actor.id);
  });

  it('rolls back exchange consumption when attribution creation fails', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    const f = await trustedFixture();
    const assertion = makeAssertion(f, integrationRecord.code, {
      type: 'CUSTOMER_CARE',
      actorReference: actor.actorReference,
    });
    const { exchangeId, exchangeToken } = await accept(assertion);

    // Occupy the exact origin reference this binding will derive, forcing the
    // PART 01 conflict path inside the binding transaction.
    await getPool().query(
      `INSERT INTO handyman_channel_attributions
         (id, client_id, tenant_company_id, tenant_pic_id, building_id,
          space_id, origin_channel, origin_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        randomUUID(),
        f.client.id,
        f.company.id,
        f.pic.id,
        f.building.id,
        f.space.id,
        ORIGIN_CHANNEL,
        `bm-handoff:${integrationRecord.code}:${assertion.assertionId}`,
      ],
    );

    const failure = await captureFailure(() =>
      bindHandoffExchangeToChannelAttribution(exchangeToken),
    );
    assert.equal(failure.code, 'HANDYMAN_CHANNEL_ATTRIBUTION_ORIGIN_REFERENCE_CONFLICT');
    assert.equal(failure.statusCode, 409);
    // Atomicity: the exchange was NOT left consumed by the failed binding.
    assert.equal(await exchangeStatus(exchangeId), 'ACTIVE');
    const consumed = await consumeHandoffExchange(exchangeToken);
    assert.equal(consumed.context.careActorId, actor.id);
  });

  it('enforces storage-layer integrity for attribution actor provenance', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    const f = await trustedFixture();
    const assertion = makeAssertion(f, integrationRecord.code, {
      type: 'CUSTOMER_CARE',
      actorReference: actor.actorReference,
    });
    const { exchangeToken } = await accept(assertion);
    const attribution = await bindHandoffExchangeToChannelAttribution(exchangeToken);

    // Append-only contract is untouched: actor provenance is immutable too.
    await assert.rejects(
      getPool().query(
        `UPDATE handyman_channel_attributions SET actor_type = 'CUSTOMER_CARE'
          WHERE id = $1`,
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

    // Coherence: actor columns are all-or-nothing.
    await assert.rejects(
      getPool().query(
        `INSERT INTO handyman_channel_attributions
           (id, client_id, tenant_company_id, building_id, origin_channel,
            actor_type)
         VALUES ($1,$2,$3,$4,$5,'CUSTOMER_CARE')`,
        [randomUUID(), f.client.id, f.company.id, f.building.id, ORIGIN_CHANNEL],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    // Unknown actor type is rejected.
    await assert.rejects(
      getPool().query(
        `INSERT INTO handyman_channel_attributions
           (id, client_id, tenant_company_id, building_id, origin_channel,
            actor_type, care_actor_id, actor_reference)
         VALUES ($1,$2,$3,$4,$5,'SUPERVISOR',$6,$7)`,
        [
          randomUUID(),
          f.client.id,
          f.company.id,
          f.building.id,
          ORIGIN_CHANNEL,
          actor.id,
          actor.actorReference,
        ],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    // care_actor_id can only reference the registry — never a local user.
    await assert.rejects(
      getPool().query(
        `INSERT INTO handyman_channel_attributions
           (id, client_id, tenant_company_id, building_id, origin_channel,
            actor_type, care_actor_id, actor_reference)
         VALUES ($1,$2,$3,$4,$5,'CUSTOMER_CARE',$6,$7)`,
        [
          randomUUID(),
          f.client.id,
          f.company.id,
          f.building.id,
          ORIGIN_CHANNEL,
          adminUserId,
          actor.actorReference,
        ],
      ),
      (error: unknown) => (error as { code?: string }).code === '23503',
    );
  });

  it('blocks borrowing the represented customer user at the storage layer', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    const f = await trustedFixture({ linkedPicUser: true });
    assert.ok(f.linkedUser);

    // Raw storage attempt to record the customer's linked user as the acting
    // user of an attested Customer Care attribution must fail.
    const borrowed = await captureFailure(() =>
      getPool().query(
        `INSERT INTO handyman_channel_attributions
           (id, client_id, tenant_company_id, tenant_pic_id, building_id,
            origin_channel, created_by_user_id, actor_type, care_actor_id,
            actor_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'CUSTOMER_CARE',$8,$9)`,
        [
          randomUUID(),
          f.client.id,
          f.company.id,
          f.pic.id,
          f.building.id,
          ORIGIN_CHANNEL,
          f.linkedUser?.id,
          actor.id,
          actor.actorReference,
        ],
      ),
    );
    assert.equal(borrowed.code, '23514');
    assert.match(borrowed.message ?? '', /must not record the represented customer user/);

    // The guard is precisely scoped: the same row without the borrowed user
    // (i.e. the correct PART 10 shape) is accepted.
    await getPool().query(
      `INSERT INTO handyman_channel_attributions
         (id, client_id, tenant_company_id, tenant_pic_id, building_id,
          origin_channel, actor_type, care_actor_id, actor_reference)
       VALUES ($1,$2,$3,$4,$5,$6,'CUSTOMER_CARE',$7,$8)`,
      [
        randomUUID(),
        f.client.id,
        f.company.id,
        f.pic.id,
        f.building.id,
        ORIGIN_CHANNEL,
        actor.id,
        actor.actorReference,
      ],
    );
  });

  it('rejects malformed or invented actor provenance at the service boundary', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    const otherActor = await registerActor(integrationRecord.id);
    const f = await trustedFixture();
    const base = {
      tenantCompanyId: f.company.id,
      buildingId: f.building.id,
      originChannel: ORIGIN_CHANNEL as const,
    };
    const invalid: Record<string, unknown>[] = [
      // Partial actor provenance.
      { ...base, actorType: 'CUSTOMER_CARE' },
      { ...base, careActorId: actor.id },
      { ...base, actorReference: actor.actorReference },
      // Unknown actor type vocabulary.
      { ...base, actorType: 'SUPERVISOR', careActorId: actor.id, actorReference: actor.actorReference },
      // Unknown registry row.
      { ...base, actorType: 'CUSTOMER_CARE', careActorId: randomUUID(), actorReference: 'CC_UNKNOWN' },
      // Reference does not match the registry row.
      { ...base, actorType: 'CUSTOMER_CARE', careActorId: actor.id, actorReference: otherActor.actorReference },
      // A local acting user must never accompany an attested actor.
      { ...base, actorType: 'CUSTOMER_CARE', careActorId: actor.id, actorReference: actor.actorReference, createdByUserId: adminUserId },
      // Blank reference.
      { ...base, actorType: 'CUSTOMER_CARE', careActorId: actor.id, actorReference: '   ' },
    ];

    for (const input of invalid) {
      const failure = await captureFailure(() =>
        handymanChannelAttributionService.createChannelAttribution(
          input as never,
        ),
      );
      assert.equal(failure.code, 'VALIDATION_ERROR');
      assert.equal(failure.statusCode, 400);
    }
  });

  it('creates no user, session or RBAC row for a Customer Care attribution', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    const f = await trustedFixture({ linkedPicUser: false });
    const usersBefore = await tableCount('users');
    const sessionsBefore = await tableCount('user_sessions');
    const rolesBefore = await tableCount('user_role_assignments');

    const assertion = makeAssertion(f, integrationRecord.code, {
      type: 'CUSTOMER_CARE',
      actorReference: actor.actorReference,
    });
    const { exchangeToken } = await accept(assertion);
    const attribution = await bindHandoffExchangeToChannelAttribution(exchangeToken);

    assert.equal(attribution.careActorId, actor.id);
    assert.equal(await tableCount('users'), usersBefore);
    assert.equal(await tableCount('user_sessions'), sessionsBefore);
    assert.equal(await tableCount('user_role_assignments'), rolesBefore);
  });
});
