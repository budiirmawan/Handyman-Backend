import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import {
  acceptHandoffAssertion,
  bindHandoffExchangeToChannelAttribution,
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
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-01 PART 04 — focused tests for the trusted exchange → channel
 * attribution binding seam. Runtime/service level only; no HTTP surface
 * exists. Every case builds its own fixture and uses before/after table
 * deltas so tests remain isolated in the shared test database.
 */

const INTEGRATION_CODE = 'BM_SUPER_APP';
const SECRET_ENV = 'HANDYMAN_HANDOFF_SECRET_BM_SUPER_APP';
const INTEGRATION_SECRET = 'test-bm-scoped-secret-material';

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

/** Accept a fresh signed assertion and return the one-time exchange token. */
async function acceptFresh(
  f: Awaited<ReturnType<typeof trustedFixture>>,
  overrides: Record<string, unknown> = {},
) {
  const assertion = makeAssertion(f, overrides);
  const signature = signHandoffAssertion(assertion, INTEGRATION_SECRET);
  const accepted = await acceptHandoffAssertion(assertion, signature);
  return { assertion, accepted };
}

async function tableCount(name: string): Promise<number> {
  assert.ok(pool);
  const result = await pool.query(`SELECT count(*)::int AS n FROM ${name}`);
  return result.rows[0].n as number;
}

async function exchangeRow(id: string) {
  assert.ok(pool);
  const result = await pool.query(
    `SELECT status, used_at, client_id, tenant_company_id, tenant_pic_id,
            building_id, space_id, integration_id, handoff_assertion_id
       FROM handyman_handoff_exchanges WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

describe('CR-HM-01 PART 04 — exchange → channel attribution binding', () => {
  it('1: valid one-time exchange binds to an immutable BM_SUPER_APP attribution', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const { assertion, accepted } = await acceptFresh(f);
    const attribution = await bindHandoffExchangeToChannelAttribution(
      accepted.exchangeToken,
    );
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
    // the exchange was consumed by the binding (single-use)
    const row = await exchangeRow(accepted.exchangeId);
    assert.equal(row.status, 'USED');
    assert.ok(row.used_at);
  });

  it('2: attribution context exactly matches the exchange snapshot', async (t) => {
    if (!ready(t) || !pool) return;
    const f = await trustedFixture();
    const { accepted } = await acceptFresh(f);
    const attribution = await bindHandoffExchangeToChannelAttribution(
      accepted.exchangeToken,
    );
    // attribution derived ONLY from the consumed snapshot
    assert.equal(attribution.clientId, accepted.context.clientId);
    assert.equal(attribution.tenantCompanyId, accepted.context.tenantCompanyId);
    assert.equal(attribution.tenantPicId, accepted.context.tenantPicId);
    assert.equal(attribution.buildingId, accepted.context.buildingId);
    assert.equal(attribution.spaceId, accepted.context.spaceId);
    assert.equal(attribution.createdByUserId, accepted.context.resolvedUserId);
    // persisted attribution row matches the persisted snapshot columns 1:1
    const snapshot = await pool.query(
      `SELECT a.client_id, a.tenant_company_id, a.tenant_pic_id,
              a.building_id, a.space_id, a.created_by_user_id
         FROM handyman_channel_attributions a
         JOIN handyman_handoff_exchanges e
           ON e.client_id = a.client_id
          AND e.tenant_company_id = a.tenant_company_id
          AND e.tenant_pic_id IS NOT DISTINCT FROM a.tenant_pic_id
          AND e.building_id = a.building_id
          AND e.space_id IS NOT DISTINCT FROM a.space_id
         WHERE a.id = $1 AND e.id = $2`,
      [attribution.id, accepted.exchangeId],
    );
    assert.equal(snapshot.rowCount, 1);
  });

  it('3: the same exchange cannot create a second attribution', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const { assertion, accepted } = await acceptFresh(f);
    const before1 = await tableCount('handyman_channel_attributions');
    await bindHandoffExchangeToChannelAttribution(accepted.exchangeToken);
    // exchanging the same token again fails closed (single-use authoritative)
    await assert.rejects(
      bindHandoffExchangeToChannelAttribution(accepted.exchangeToken),
      (error: unknown) =>
        errorCode(error) === 'HANDYMAN_HANDOFF_EXCHANGE_INVALID',
    );
    // exactly one attribution ever came from this exchange
    assert.equal(
      await tableCount('handyman_channel_attributions'),
      before1 + 1,
    );
    // the existing PART 01 conflict rules also reject direct re-creation
    await assert.rejects(
      createChannelAttribution({
        tenantCompanyId: f.company.id,
        buildingId: f.building.id,
        tenantPicId: f.pic.id,
        spaceId: f.space.id,
        originChannel: 'BM_SUPER_APP',
        originReference: `bm-handoff:${INTEGRATION_CODE}:${assertion.assertionId}`,
      }),
      (error: unknown) =>
        errorCode(error) ===
        'HANDYMAN_CHANNEL_ATTRIBUTION_ORIGIN_REFERENCE_CONFLICT',
    );
    assert.equal(
      await tableCount('handyman_channel_attributions'),
      before1 + 1,
    );
  });

  it('4: attribution failure rolls back the exchange consumption', async (t) => {
    if (!ready(t) || !pool) return;
    const f = await trustedFixture();
    const { accepted } = await acceptFresh(f);
    // make PART 01 context validation fail deterministically at binding time
    await pool.query(
      `UPDATE tenant_companies SET status = 'INACTIVE' WHERE id = $1`,
      [f.company.id],
    );
    const attributionsBefore = await tableCount(
      'handyman_channel_attributions',
    );
    await assert.rejects(
      bindHandoffExchangeToChannelAttribution(accepted.exchangeToken),
      (error: unknown) =>
        errorCode(error) === 'HANDYMAN_CHANNEL_ATTRIBUTION_CONTEXT_INVALID',
    );
    // rollback: the exchange is NOT left consumed without its attribution
    const row = await exchangeRow(accepted.exchangeId);
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.used_at, null);
    assert.equal(
      await tableCount('handyman_channel_attributions'),
      attributionsBefore,
    );
  });

  it('5: no standard user session is created by binding', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const sessionsBefore = await tableCount('user_sessions');
    const { accepted } = await acceptFresh(f);
    await bindHandoffExchangeToChannelAttribution(accepted.exchangeToken);
    assert.equal(await tableCount('user_sessions'), sessionsBefore);
  });

  it('6: no service request is created by binding', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const requestsBefore = await tableCount('tenant_service_requests');
    const { accepted } = await acceptFresh(f);
    await bindHandoffExchangeToChannelAttribution(accepted.exchangeToken);
    assert.equal(
      await tableCount('tenant_service_requests'),
      requestsBefore,
    );
  });
});
