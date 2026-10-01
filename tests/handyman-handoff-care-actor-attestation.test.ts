import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
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
  handymanCareActorService,
  type PublicHandymanCareActor,
} from '../src/modules/handyman-care-actors';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import {
  canonicalHandoffAssertion,
  consumeHandoffExchange,
  handoffIntegrationSecretEnvName,
  handoffRuntimeRepository,
  handoffRuntimeService,
  hashHandoffExchangeToken,
  signHandoffAssertion,
  type HandoffAssertion,
} from '../src/modules/handyman-handoff';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-01 AMENDMENT 01 PART 09 — focused tests for runtime actor attestation
 * (governance amendment §3.1/§3.3/§3.4/§3.6, frozen D5/D7/D8).
 *
 * Scope: optional signed actor block, byte-identical legacy parity, signature
 * coverage of the actor block, PART 08 resolution, downgrade protection,
 * exchange snapshot provenance, and preservation of TTL / hash-only token /
 * single-use / replay / represented-context rules. No attribution binding
 * (PART 10), no OpenAPI (PART 11), no session/RBAC.
 */

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55489;
const DIR = '/tmp/asentra-part09-pg';
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

const INTEGRATION_SECRET = 'part09-bm-scoped-secret-material';
const ASSERTION_INVALID = 'HANDYMAN_HANDOFF_ASSERTION_INVALID';
const ASSERTION_REPLAYED = 'HANDYMAN_HANDOFF_ASSERTION_REPLAYED';
const EXCHANGE_INVALID = 'HANDYMAN_HANDOFF_EXCHANGE_INVALID';
const TTL_SECONDS = 120;
const CONFIG = {
  assertionMaxAgeSeconds: 300,
  clockSkewSeconds: 60,
  exchangeTtlSeconds: TTL_SECONDS,
};

/**
 * Frozen pre-amendment canonical payload for a legacy assertion: sorted keys,
 * no `actor` member. Any change to this string means legacy signing changed.
 */
const PARITY_ASSERTION: HandoffAssertion = {
  integrationCode: 'BM_PARITY',
  assertionId: 'parity-assertion-1',
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:04:00.000Z',
  tenantCompanyId: '11111111-1111-4111-8111-111111111111',
  buildingId: '22222222-2222-4222-8222-222222222222',
  tenantPicId: '33333333-3333-4333-8333-333333333333',
  spaceId: '44444444-4444-4444-8444-444444444444',
};
const PARITY_CANONICAL =
  '{"assertionId":"parity-assertion-1",' +
  '"buildingId":"22222222-2222-4222-8222-222222222222",' +
  '"expiresAt":"2026-01-01T00:04:00.000Z",' +
  '"integrationCode":"BM_PARITY",' +
  '"issuedAt":"2026-01-01T00:00:00.000Z",' +
  '"spaceId":"44444444-4444-4444-8444-444444444444",' +
  '"tenantCompanyId":"11111111-1111-4111-8111-111111111111",' +
  '"tenantPicId":"33333333-3333-4333-8333-333333333333"}';

let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let userId = '';
const secretEnvNames: string[] = [];
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
  await pool.query(`TRUNCATE handyman_handoff_exchanges,
    handyman_handoff_assertions, handyman_handoff_care_actors,
    handyman_handoff_integrations, handyman_channel_attributions,
    tenant_space_relationships, tenant_building_contexts, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    user_sessions, user_role_assignments, users, roles, permissions,
    clients CASCADE`);
  const admin = await createAdminUser();
  userId = admin.userId;
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
    t.skip('PART 09 PostgreSQL unavailable');
    return false;
  }
  return true;
}

function getPool(): Pool {
  if (!pool) throw new Error('PART 09 test pool is not initialised.');
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

/**
 * Creates an integration (optionally CUSTOMER_CARE-capable) with a scoped
 * secret in environment config, exactly like a provisioned BM integration.
 */
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
  return handymanCareActorService.createCareActor({
    integrationId,
    actorReference: `CC_${suffix()}`,
    displayName: 'Customer Care Agent',
  });
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
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: `requester-${suffix().toLowerCase()}@tenant.example.com`,
  }, userId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: building.id,
    spaceId: space.id,
  }, userId);
  const context = await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: building.id,
  }, userId);
  return { client, property, building, space, company, pic, context };
}

type Fixture = Awaited<ReturnType<typeof trustedFixture>>;

function makeAssertion(
  f: Fixture,
  integrationCode: string,
  overrides: Record<string, unknown> = {},
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
    ...overrides,
  } as HandoffAssertion;
}

async function tableCount(table: string): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return result.rows[0].n;
}

async function exchangeRow(exchangeId: string) {
  const result = await getPool().query<{
    tokenHash: string;
    status: string;
    actorType: string | null;
    careActorId: string | null;
    actorReference: string | null;
  }>(
    `SELECT token_hash AS "tokenHash", status, actor_type AS "actorType",
            care_actor_id AS "careActorId", actor_reference AS "actorReference"
       FROM handyman_handoff_exchanges WHERE id = $1`,
    [exchangeId],
  );
  return result.rows[0];
}

describe('CR-HM-01 A01 PART 09 — runtime Customer Care actor attestation', () => {
  it('legacy canonical signing payload is byte-identical to pre-amendment', async (t) => {
    if (!ready(t)) return;
    const canonical = canonicalHandoffAssertion(PARITY_ASSERTION);
    assert.equal(canonical, PARITY_CANONICAL);
    assert.equal(canonical.includes('actor'), false);

    // Signature framing ('sha256=' + HMAC over that exact canonical payload)
    // is unchanged too — recomputed here independently of the helper.
    const expected =
      'sha256=' +
      createHmac('sha256', INTEGRATION_SECRET).update(canonical).digest('hex');
    assert.equal(signHandoffAssertion(PARITY_ASSERTION, INTEGRATION_SECRET), expected);
  });

  it('legacy assertion (no actor key) keeps legacy exchange behavior end to end', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration();
    const f = await trustedFixture();
    const assertion = makeAssertion(f, integrationRecord.code);
    const before = Date.now();

    const accepted = await handoffRuntimeService.acceptHandoffAssertion(
      assertion,
      signHandoffAssertion(assertion, INTEGRATION_SECRET),
      CONFIG,
    );

    // Context resolution unchanged.
    assert.equal(accepted.context.clientId, f.client.id);
    assert.equal(accepted.context.tenantCompanyId, f.company.id);
    assert.equal(accepted.context.tenantPicId, f.pic.id);
    assert.equal(accepted.context.buildingId, f.building.id);
    assert.equal(accepted.context.spaceId, f.space.id);
    assert.equal(accepted.context.tenantBuildingContextId, f.context.id);

    // Actor provenance is null — no fabricated actor.
    assert.equal(accepted.context.actorType, null);
    assert.equal(accepted.context.careActorId, null);
    assert.equal(accepted.context.actorReference, null);

    // TTL + hash-only token storage preserved.
    assert.ok(accepted.expiresAt.getTime() > before);
    assert.ok(accepted.expiresAt.getTime() <= Date.now() + TTL_SECONDS * 1000 + 1000);
    const row = await exchangeRow(accepted.exchangeId);
    assert.equal(row.tokenHash, hashHandoffExchangeToken(accepted.exchangeToken));
    assert.match(row.tokenHash, /^[0-9a-f]{64}$/);
    assert.notEqual(row.tokenHash, accepted.exchangeToken);
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.actorType, null);
    assert.equal(row.careActorId, null);
    assert.equal(row.actorReference, null);

    // Single-use + consume parity.
    const consumed = await consumeHandoffExchange(accepted.exchangeToken);
    assert.deepEqual(consumed.context, accepted.context);
    const reused = await captureFailure(() =>
      consumeHandoffExchange(accepted.exchangeToken),
    );
    assert.equal(reused.code, EXCHANGE_INVALID);

    // Replay protection parity.
    const replayed = await captureFailure(() =>
      handoffRuntimeService.acceptHandoffAssertion(
        assertion,
        signHandoffAssertion(assertion, INTEGRATION_SECRET),
        CONFIG,
      ),
    );
    assert.equal(replayed.code, ASSERTION_REPLAYED);
    assert.equal(replayed.statusCode, 409);
  });

  it('attests a Customer Care actor and carries provenance into the exchange', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    const f = await trustedFixture();
    const assertion = makeAssertion(f, integrationRecord.code, {
      actor: { type: 'CUSTOMER_CARE', actorReference: actor.actorReference },
    });
    const sessionsBefore = await tableCount('user_sessions');
    const usersBefore = await tableCount('users');

    const accepted = await handoffRuntimeService.acceptHandoffAssertion(
      assertion,
      signHandoffAssertion(assertion, INTEGRATION_SECRET),
      CONFIG,
    );

    assert.equal(accepted.context.actorType, 'CUSTOMER_CARE');
    assert.equal(accepted.context.careActorId, actor.id);
    assert.equal(accepted.context.actorReference, actor.actorReference);
    // Represented context still comes from PART 02 only.
    assert.equal(accepted.context.tenantCompanyId, f.company.id);
    assert.equal(accepted.context.tenantPicId, f.pic.id);
    assert.equal(accepted.context.buildingId, f.building.id);
    assert.equal(accepted.context.spaceId, f.space.id);

    const row = await exchangeRow(accepted.exchangeId);
    assert.equal(row.actorType, 'CUSTOMER_CARE');
    assert.equal(row.careActorId, actor.id);
    assert.equal(row.actorReference, actor.actorReference);
    assert.equal(row.tokenHash, hashHandoffExchangeToken(accepted.exchangeToken));
    assert.equal(row.status, 'ACTIVE');

    // The snapshot (not caller input) is what a consumer sees; single-use and
    // TTL semantics are unchanged for actor-bearing exchanges.
    const consumed = await consumeHandoffExchange(accepted.exchangeToken);
    assert.deepEqual(consumed.context, accepted.context);
    assert.equal(
      (await captureFailure(() => consumeHandoffExchange(accepted.exchangeToken))).code,
      EXCHANGE_INVALID,
    );

    // The actor never becomes a local user/session/PIC identity: attestation
    // creates no user and no session (counts unchanged by the whole flow).
    assert.equal(await tableCount('user_sessions'), sessionsBefore);
    assert.equal(await tableCount('users'), usersBefore);
    const careActorColumns = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'handyman_handoff_care_actors'`,
    );
    for (const { column_name } of careActorColumns.rows) {
      assert.doesNotMatch(column_name, /user|session|role|permission|tenant|pic/i);
    }
  });

  it('covers the actor block with the integration signature', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    const otherActor = await registerActor(integrationRecord.id);
    const f = await trustedFixture();
    const assertion = makeAssertion(f, integrationRecord.code, {
      actor: { type: 'CUSTOMER_CARE', actorReference: actor.actorReference },
    });
    const signature = signHandoffAssertion(assertion, INTEGRATION_SECRET);

    // Actor swapped AFTER signing → signature no longer matches.
    const swapped = {
      ...assertion,
      actor: { type: 'CUSTOMER_CARE', actorReference: otherActor.actorReference },
    };
    assert.equal(
      (await captureFailure(() =>
        handoffRuntimeService.acceptHandoffAssertion(swapped, signature, CONFIG),
      )).code,
      ASSERTION_INVALID,
    );

    // Actor ADDED to a legacy-signed assertion → rejected (no privilege gain).
    const legacyAssertion = makeAssertion(f, integrationRecord.code);
    const legacySignature = signHandoffAssertion(legacyAssertion, INTEGRATION_SECRET);
    assert.equal(
      (await captureFailure(() =>
        handoffRuntimeService.acceptHandoffAssertion(
          {
            ...legacyAssertion,
            actor: { type: 'CUSTOMER_CARE', actorReference: actor.actorReference },
          },
          legacySignature,
          CONFIG,
        ),
      )).code,
      ASSERTION_INVALID,
    );

    // Actor block with an unknown member fails structurally (401) even when
    // the signature is valid over it: no smuggled semantics.
    const smuggled = {
      ...assertion,
      actor: {
        type: 'CUSTOMER_CARE',
        actorReference: actor.actorReference,
        careActorId: actor.id,
      },
    };
    assert.equal(
      (await captureFailure(() =>
        handoffRuntimeService.acceptHandoffAssertion(
          smuggled,
          signHandoffAssertion(smuggled as HandoffAssertion, INTEGRATION_SECRET),
          CONFIG,
        ),
      )).code,
      ASSERTION_INVALID,
    );

    // Untampered assertion still succeeds.
    const accepted = await handoffRuntimeService.acceptHandoffAssertion(
      assertion,
      signature,
      CONFIG,
    );
    assert.equal(accepted.context.careActorId, actor.id);
  });

  it('never downgrades an actor-bearing assertion to legacy semantics', async (t) => {
    if (!ready(t)) return;
    const incapable = await integration();
    const careful = await integration({ careCapable: true });
    const carefulOther = await integration({ careCapable: true });
    const actor = await registerActor(careful.id);
    const inactive = await registerActor(careful.id);
    await handymanCareActorService.deactivateCareActor(inactive.id);
    const f = await trustedFixture();

    const attempts: HandoffAssertion[] = [
      // Capability absent on the attesting integration.
      makeAssertion(f, incapable.code, {
        actor: { type: 'CUSTOMER_CARE', actorReference: actor.actorReference },
      }),
      // Unknown actor reference.
      makeAssertion(f, careful.code, {
        actor: { type: 'CUSTOMER_CARE', actorReference: `CC_${suffix()}` },
      }),
      // INACTIVE actor.
      makeAssertion(f, careful.code, {
        actor: { type: 'CUSTOMER_CARE', actorReference: inactive.actorReference },
      }),
      // Actor registered to ANOTHER (capable, active) integration.
      makeAssertion(f, carefulOther.code, {
        actor: { type: 'CUSTOMER_CARE', actorReference: actor.actorReference },
      }),
      // Unprovisioned dedicated care integration code (rolled-out guard).
      makeAssertion(f, `BM_SUPER_APP_CARE_${suffix()}`, {
        actor: { type: 'CUSTOMER_CARE', actorReference: actor.actorReference },
      }),
      // `actor` present but null — not legacy, not valid.
      makeAssertion(f, careful.code, { actor: null }),
    ];

    const exchangesBefore = await tableCount('handyman_handoff_exchanges');
    const assertionsBefore = await tableCount('handyman_handoff_assertions');
    for (const assertion of attempts) {
      const failure = await captureFailure(() =>
        handoffRuntimeService.acceptHandoffAssertion(
          assertion,
          signHandoffAssertion(assertion, INTEGRATION_SECRET),
          CONFIG,
        ),
      );
      assert.equal(failure.code, ASSERTION_INVALID);
      assert.equal(failure.statusCode, 401);
      assert.equal(failure.message, 'Invalid or expired handoff assertion.');
    }
    // No exchange was created and no replay record was burned: a rejected
    // actor-bearing attempt leaves no legacy artifact behind.
    assert.equal(await tableCount('handyman_handoff_exchanges'), exchangesBefore);
    assert.equal(await tableCount('handyman_handoff_assertions'), assertionsBefore);

    // The incapable integration still works for genuine legacy traffic.
    const legacy = makeAssertion(f, incapable.code);
    const acceptedLegacy = await handoffRuntimeService.acceptHandoffAssertion(
      legacy,
      signHandoffAssertion(legacy, INTEGRATION_SECRET),
      CONFIG,
    );
    assert.equal(acceptedLegacy.context.actorType, null);
    assert.equal(acceptedLegacy.context.careActorId, null);
  });

  it('preserves represented tenant/building/unit rules for actor-bearing assertions', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    const actorClaim = { type: 'CUSTOMER_CARE', actorReference: actor.actorReference };
    const f = await trustedFixture();
    const foreign = await trustedFixture();

    const actorBearing = (overrides: Record<string, unknown>) =>
      makeAssertion(f, integrationRecord.code, { actor: actorClaim, ...overrides });

    // Foreign tenant (other client) cannot be widened into by an actor.
    const foreignTenant = actorBearing({ tenantCompanyId: foreign.company.id, tenantPicId: undefined });
    const tenantFailure = await captureFailure(() =>
      handoffRuntimeService.acceptHandoffAssertion(
        foreignTenant,
        signHandoffAssertion(foreignTenant, INTEGRATION_SECRET),
        CONFIG,
      ),
    );
    assert.equal(tenantFailure.code, 'HANDYMAN_HANDOFF_CONTEXT_INVALID');

    // Foreign building likewise.
    const foreignBuilding = actorBearing({
      buildingId: foreign.building.id,
      spaceId: undefined,
    });
    assert.equal(
      (await captureFailure(() =>
        handoffRuntimeService.acceptHandoffAssertion(
          foreignBuilding,
          signHandoffAssertion(foreignBuilding, INTEGRATION_SECRET),
          CONFIG,
        ),
      )).code,
      'HANDYMAN_HANDOFF_CONTEXT_INVALID',
    );

    // Space that does not belong to the claimed building is still rejected.
    const spaceMismatch = actorBearing({ spaceId: foreign.space.id });
    assert.equal(
      (await captureFailure(() =>
        handoffRuntimeService.acceptHandoffAssertion(
          spaceMismatch,
          signHandoffAssertion(spaceMismatch, INTEGRATION_SECRET),
          CONFIG,
        ),
      )).code,
      'HANDYMAN_HANDOFF_SPACE_MISMATCH',
    );

    // Replay protection is unchanged for actor-bearing assertions.
    const replayAssertion = actorBearing({});
    const replaySignature = signHandoffAssertion(replayAssertion, INTEGRATION_SECRET);
    await handoffRuntimeService.acceptHandoffAssertion(
      replayAssertion,
      replaySignature,
      CONFIG,
    );
    const replayed = await captureFailure(() =>
      handoffRuntimeService.acceptHandoffAssertion(
        replayAssertion,
        replaySignature,
        CONFIG,
      ),
    );
    assert.equal(replayed.code, ASSERTION_REPLAYED);
    assert.equal(replayed.statusCode, 409);
  });

  it('enforces exchange actor coherence at the storage layer', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const f = await trustedFixture();

    // A LEGACY exchange (no actor key) keeps every actor column NULL.
    const legacyAssertion = makeAssertion(f, integrationRecord.code);
    const legacy = await handoffRuntimeService.acceptHandoffAssertion(
      legacyAssertion,
      signHandoffAssertion(legacyAssertion, INTEGRATION_SECRET),
      CONFIG,
    );
    const legacyRow = await exchangeRow(legacy.exchangeId);
    assert.equal(legacyRow.actorType, null);
    assert.equal(legacyRow.careActorId, null);
    assert.equal(legacyRow.actorReference, null);

    // Partial actor identity (type without registry id/reference) is rejected.
    await assert.rejects(
      getPool().query(
        `UPDATE handyman_handoff_exchanges SET actor_type = 'CUSTOMER_CARE'
          WHERE id = $1`,
        [legacy.exchangeId],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );

    // Unknown actor type is rejected.
    await assert.rejects(
      getPool().query(
        `UPDATE handyman_handoff_exchanges SET actor_type = 'SUPERVISOR'
          WHERE id = $1`,
        [legacy.exchangeId],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );

    // A care actor id must reference a real registry row.
    await assert.rejects(
      getPool().query(
        `UPDATE handyman_handoff_exchanges
            SET actor_type = 'CUSTOMER_CARE', care_actor_id = $2,
                actor_reference = 'CC_UNKNOWN'
          WHERE id = $1`,
        [legacy.exchangeId, randomUUID()],
      ),
      (error: unknown) => (error as { code?: string }).code === '23503',
    );

    // Actor-bearing exchange: provenance present and coherent.
    const actor = await registerActor(integrationRecord.id);
    const actorAssertion = makeAssertion(f, integrationRecord.code, {
      actor: { type: 'CUSTOMER_CARE', actorReference: actor.actorReference },
    });
    const accepted = await handoffRuntimeService.acceptHandoffAssertion(
      actorAssertion,
      signHandoffAssertion(actorAssertion, INTEGRATION_SECRET),
      CONFIG,
    );
    const row = await exchangeRow(accepted.exchangeId);
    assert.equal(row.actorType, 'CUSTOMER_CARE');
    assert.equal(row.careActorId, actor.id);
    assert.equal(row.actorReference, actor.actorReference);
  });

  it('keeps the exchange token hash-only and unchanged by actor attestation', async (t) => {
    if (!ready(t)) return;
    const integrationRecord = await integration({ careCapable: true });
    const actor = await registerActor(integrationRecord.id);
    const f = await trustedFixture();
    const assertion = makeAssertion(f, integrationRecord.code, {
      actor: { type: 'CUSTOMER_CARE', actorReference: actor.actorReference },
    });

    const accepted = await handoffRuntimeService.acceptHandoffAssertion(
      assertion,
      signHandoffAssertion(assertion, INTEGRATION_SECRET),
      CONFIG,
    );

    // Raw token exists only in the response; the stored value is its SHA-256.
    const raw = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM handyman_handoff_exchanges
        WHERE token_hash = $1 OR actor_reference = $1`,
      [accepted.exchangeToken],
    );
    assert.equal(raw.rows[0].n, 0);
    assert.equal(
      createHash('sha256').update(accepted.exchangeToken).digest('hex'),
      hashHandoffExchangeToken(accepted.exchangeToken),
    );
    assert.equal(
      (await exchangeRow(accepted.exchangeId)).tokenHash,
      hashHandoffExchangeToken(accepted.exchangeToken),
    );
  });
});
