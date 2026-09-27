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
import {
  hashHandoffExchangeToken,
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
 * CR-HM-01 PART 03 — focused tests for the secure handoff runtime
 * (frozen D1/D2). Runtime/service level only; no HTTP surface exists.
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
  await pool.query(`TRUNCATE handyman_handoff_exchanges,
    handyman_handoff_assertions, handyman_handoff_integrations,
    handyman_channel_attributions, tenant_service_requests,
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

describe('CR-HM-01 PART 03 — secure handoff runtime', () => {
  it('1: valid signed assertion resolves context and issues exchange', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const assertion = makeAssertion(f);
    const signature = signHandoffAssertion(assertion, INTEGRATION_SECRET);
    const accepted = await handoffRuntimeService.acceptHandoffAssertion(
      assertion,
      signature,
    );
    assert.ok(accepted.exchangeId);
    assert.ok(accepted.exchangeToken.length > 20);
    assert.ok(accepted.expiresAt.getTime() > Date.now());
    assert.ok(accepted.expiresAt.getTime() <= Date.now() + 121_000);
    assert.equal(accepted.context.clientId, f.client.id);
    assert.equal(accepted.context.tenantCompanyId, f.company.id);
    assert.equal(accepted.context.tenantPicId, f.pic.id);
    assert.equal(accepted.context.buildingId, f.building.id);
    assert.equal(accepted.context.spaceId, f.space.id);
    assert.equal(accepted.context.tenantBuildingContextId, f.context.id);
    assert.equal(accepted.context.resolvedUserId, f.linkedUser.id);
  });

  it('2: invalid signature is rejected (non-enumerating 401)', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const assertion = makeAssertion(f);
    const forged = signHandoffAssertion(assertion, 'wrong-secret');
    const exchangesBefore = await tableCount('handyman_handoff_exchanges');
    await assert.rejects(
      handoffRuntimeService.acceptHandoffAssertion(assertion, forged),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_HANDOFF_ASSERTION_INVALID',
    );
    assert.equal(await tableCount('handyman_handoff_exchanges'), exchangesBefore);
  });

  it('3: expired assertion is rejected', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const now = Date.now();
    const stale = makeAssertion(f, {
      issuedAt: new Date(now - 600_000).toISOString(),
      expiresAt: new Date(now - 590_000).toISOString(),
    });
    const signature = signHandoffAssertion(stale, INTEGRATION_SECRET);
    await assert.rejects(
      handoffRuntimeService.acceptHandoffAssertion(stale, signature),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_HANDOFF_ASSERTION_INVALID',
    );
  });

  it('4: replayed assertion is rejected with conflict', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const assertion = makeAssertion(f);
    const signature = signHandoffAssertion(assertion, INTEGRATION_SECRET);
    await handoffRuntimeService.acceptHandoffAssertion(assertion, signature);
    const exchangesBefore = await tableCount('handyman_handoff_exchanges');
    await assert.rejects(
      handoffRuntimeService.acceptHandoffAssertion(assertion, signature),
      (error: unknown) =>
        (error as { code?: string }).code ===
        'HANDYMAN_HANDOFF_ASSERTION_REPLAYED',
    );
    assert.equal(await tableCount('handyman_handoff_exchanges'), exchangesBefore);
  });

  it('5: context resolution failure rejects the handoff, no exchange', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const inactiveCompany = await tenantCompanyService.createTenantCompany({
      clientId: f.client.id,
      tenantCode: `TNT_${suffix()}`,
      tenantName: 'Inactive Tenant',
      status: 'INACTIVE',
    }, userId);
    const assertion = makeAssertion(f, {
      tenantCompanyId: inactiveCompany.id,
      tenantPicId: undefined,
      spaceId: undefined,
    });
    const signature = signHandoffAssertion(assertion, INTEGRATION_SECRET);
    const exchangesBefore = await tableCount('handyman_handoff_exchanges');
    await assert.rejects(
      handoffRuntimeService.acceptHandoffAssertion(assertion, signature),
      (error: unknown) =>
        (error as { code?: string }).code ===
        'HANDYMAN_HANDOFF_CONTEXT_INVALID',
    );
    assert.equal(await tableCount('handyman_handoff_exchanges'), exchangesBefore);
  });

  it('6: exchange is hash-only at rest and strictly single-use', async (t) => {
    if (!ready(t) || !pool) return;
    const f = await trustedFixture();
    const assertion = makeAssertion(f);
    const signature = signHandoffAssertion(assertion, INTEGRATION_SECRET);
    const accepted = await handoffRuntimeService.acceptHandoffAssertion(
      assertion,
      signature,
    );
    // at rest: only the SHA-256 hash, never the raw token
    const rows = await pool.query(
      `SELECT token_hash, status FROM handyman_handoff_exchanges
        WHERE id = $1`,
      [accepted.exchangeId],
    );
    assert.match(rows.rows[0].token_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(rows.rows[0].token_hash, accepted.exchangeToken);
    assert.equal(
      rows.rows[0].token_hash,
      hashHandoffExchangeToken(accepted.exchangeToken),
    );
    // first consume succeeds with the canonical snapshot
    const consumed = await handoffRuntimeService.consumeHandoffExchange(
      accepted.exchangeToken,
    );
    assert.equal(consumed.exchangeId, accepted.exchangeId);
    assert.deepEqual(consumed.context, accepted.context);
    // second consume of the same token fails closed
    await assert.rejects(
      handoffRuntimeService.consumeHandoffExchange(accepted.exchangeToken),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_HANDOFF_EXCHANGE_INVALID',
    );
    // unknown token fails closed
    await assert.rejects(
      handoffRuntimeService.consumeHandoffExchange('forged-token-value'),
      (error: unknown) =>
        (error as { code?: string }).code === 'HANDYMAN_HANDOFF_EXCHANGE_INVALID',
    );
  });

  it('7: no standard user session is created by accept or consume', async (t) => {
    if (!ready(t)) return;
    const f = await trustedFixture();
    const sessionsBefore = await tableCount('user_sessions');
    const assertion = makeAssertion(f);
    const signature = signHandoffAssertion(assertion, INTEGRATION_SECRET);
    const accepted = await handoffRuntimeService.acceptHandoffAssertion(
      assertion,
      signature,
    );
    await handoffRuntimeService.consumeHandoffExchange(accepted.exchangeToken);
    assert.equal(await tableCount('user_sessions'), sessionsBefore);
  });
});
