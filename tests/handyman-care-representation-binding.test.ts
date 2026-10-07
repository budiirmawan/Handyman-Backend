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
  handymanCareActorService, grantCareActorProperty, revokeCareActorProperty,
} from '../src/modules/handyman-care-actors';
import {
  acceptHandoffAssertion, bindHandoffExchangeToChannelAttribution,
  handoffIntegrationSecretEnvName, handoffRuntimeRepository, signHandoffAssertion,
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

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55526;
const DIR = '/tmp/asentra-care-representation-pg';
const SECRET = 'care-representation-test-bm-integration-secret';
if (EMBEDDED) {
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_PORT: String(PORT), DB_USER: 'postgres',
    DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false',
  });
}
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminId = '';
let integrationCode = '';
let actorId = '';
let actorReference = '';
let clientId = '';
let propertyId = '';
let buildingId = '';
let otherPropertyId = '';
let otherBuildingId = '';
let companyId = '';
let picId = '';
let linkedUserId = '';
let spaceId = '';
let tenantBuildingContextId = '';
let tenantSpaceRelationshipId = '';
let secretEnv = '';

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
  adminId = (await createAdminUser()).userId;
  clientId = (await clientService.createClient({ code: `C_${suffix()}`, name: 'Owner' })).id;
  propertyId = (await propertyService.createProperty({ clientId, code: `P_${suffix()}`, name: 'Property A' })).id;
  buildingId = (await buildingService.createBuilding({ propertyId, code: `B_${suffix()}`, name: 'Building A' })).id;
  otherPropertyId = (await propertyService.createProperty({ clientId, code: `P_${suffix()}`, name: 'Property B' })).id;
  otherBuildingId = (await buildingService.createBuilding({ propertyId: otherPropertyId, code: `B_${suffix()}`, name: 'Building B' })).id;
  await buildingAssignmentService.createAssignment(adminId, { buildingId });
  await buildingAssignmentService.createAssignment(adminId, { buildingId: otherBuildingId });
  const floor = await floorService.createFloor({ buildingId, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
  const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
  const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
  spaceId = (await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Unit space' })).id;
  companyId = (await tenantCompanyService.createTenantCompany({ clientId, tenantCode: `T_${suffix()}`, tenantName: 'Represented Tenant' }, adminId)).id;
  linkedUserId = (await userService.createUser({ email: `${suffix()}@test.invalid`, displayName: 'Customer user' })).id;
  await buildingAssignmentService.createAssignment(linkedUserId, { buildingId });
  picId = (await tenantPicService.createTenantPic({ tenantCompanyId: companyId, picName: 'Customer PIC', userId: linkedUserId }, adminId)).id;
  tenantSpaceRelationshipId = (await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: companyId, buildingId, spaceId }, adminId)).id;
  tenantBuildingContextId = (await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: companyId, buildingId }, adminId)).id;
  integrationCode = `BM_CARE_${suffix()}`;
  const integration = await handoffRuntimeRepository.createIntegration({ integrationCode, displayName: 'BM care' });
  await handymanCareActorService.setIntegrationActorCapability({ integrationId: integration.id, capability: 'CUSTOMER_CARE' });
  actorReference = `CC_${suffix()}`;
  actorId = (await handymanCareActorService.createCareActor({ integrationId: integration.id, actorReference, displayName: 'Care operator' })).id;
  secretEnv = handoffIntegrationSecretEnvName(integrationCode);
  process.env[secretEnv] = SECRET;
});

after(async () => {
  if (secretEnv) delete process.env[secretEnv];
  try { if (pool) await closePool(pool); if (postgres) await postgres.stop(); }
  finally { await rm(DIR, { recursive: true, force: true }); }
});
function ready(t: TestContext): boolean {
  if (!database || !pool) { t.skip('PostgreSQL unavailable'); return false; }
  return true;
}
function db(): Pool { if (!pool) throw new Error('Test database unavailable'); return pool; }
function assertion(actor = true, overrides: Partial<HandoffAssertion> = {}): HandoffAssertion {
  const now = Date.now();
  return {
    integrationCode, assertionId: randomUUID(),
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
    tenantCompanyId: companyId, tenantPicId: picId, buildingId, spaceId,
    ...(actor ? { actor: { type: 'CUSTOMER_CARE' as const, actorReference } } : {}),
    ...overrides,
  };
}
function accept(value: HandoffAssertion) {
  return acceptHandoffAssertion(value, signHandoffAssertion(value, SECRET));
}
async function failureCode(action: () => Promise<unknown>): Promise<string> {
  let code = '';
  try { await action(); } catch (e) { code = (e as { code?: string }).code ?? ''; }
  assert.ok(code, 'expected fail-closed application error');
  return code;
}

// No business request is created by this suite. The exchange already carries
// occupancy IDs; attribution remains the existing immutable context carrier.
describe('PART 03 — attested care representation at handoff', () => {
  it('rejects a care actor without a grant while leaving the legacy path intact', async (t) => {
    if (!ready(t)) return;
    assert.equal(await failureCode(() => accept(assertion())), 'HANDYMAN_HANDOFF_ASSERTION_INVALID');
    const legacy = await accept(assertion(false));
    assert.equal(legacy.context.actorType, null);
    assert.equal(legacy.context.tenantBuildingContextId, tenantBuildingContextId);
    assert.equal(legacy.context.tenantSpaceRelationshipId, tenantSpaceRelationshipId);
    const attr = await bindHandoffExchangeToChannelAttribution(legacy.exchangeToken);
    assert.equal(attr.careActorId, null);
    assert.equal(attr.createdByUserId, linkedUserId);
  });

  it('uses only the grant to the derived property and preserves represented context', async (t) => {
    if (!ready(t)) return;
    await grantCareActorProperty({ careActorId: actorId, propertyId: otherPropertyId, clientId }, adminId);
    assert.equal(await failureCode(() => accept(assertion())), 'HANDYMAN_HANDOFF_ASSERTION_INVALID');
    const grant = await grantCareActorProperty({ careActorId: actorId, propertyId, clientId }, adminId);
    const accepted = await accept(assertion());
    assert.equal(accepted.context.careActorId, actorId);
    assert.equal(accepted.context.tenantCompanyId, companyId);
    assert.equal(accepted.context.tenantPicId, picId);
    assert.equal(accepted.context.buildingId, buildingId);
    assert.equal(accepted.context.spaceId, spaceId);
    assert.equal(accepted.context.tenantBuildingContextId, tenantBuildingContextId);
    assert.equal(accepted.context.tenantSpaceRelationshipId, tenantSpaceRelationshipId);
    assert.equal(grant.propertyId, propertyId);
    const attr = await bindHandoffExchangeToChannelAttribution(accepted.exchangeToken);
    assert.equal(attr.careActorId, actorId);
    assert.equal(attr.createdByUserId, null);
    assert.equal(attr.tenantCompanyId, companyId);
    assert.equal(attr.tenantPicId, picId);
    assert.equal(attr.buildingId, buildingId);
    assert.equal(attr.spaceId, spaceId);
    assert.equal(attr.originChannel, 'BM_SUPER_APP');
    assert.equal(await failureCode(() => bindHandoffExchangeToChannelAttribution(accepted.exchangeToken)), 'HANDYMAN_HANDOFF_EXCHANGE_INVALID');
  });

  it('rejects revoked scope between acceptance and binding without consuming exchange', async (t) => {
    if (!ready(t)) return;
    const accepted = await accept(assertion());
    await revokeCareActorProperty({ careActorId: actorId, propertyId, clientId }, adminId);
    assert.equal(await failureCode(() => bindHandoffExchangeToChannelAttribution(accepted.exchangeToken)), 'HANDYMAN_HANDOFF_EXCHANGE_INVALID');
    assert.equal(await failureCode(() => accept(assertion())), 'HANDYMAN_HANDOFF_ASSERTION_INVALID');
    assert.equal((await db().query('SELECT status FROM handyman_handoff_exchanges WHERE id=$1', [accepted.exchangeId])).rows[0].status, 'ACTIVE');
    await grantCareActorProperty({ careActorId: actorId, propertyId, clientId }, adminId);
    await bindHandoffExchangeToChannelAttribution(accepted.exchangeToken);
  });

  it('rejects invalid occupancy and identity turnover at binding, including reactivation with new identity', async (t) => {
    if (!ready(t)) return;
    const accepted = await accept(assertion());
    await db().query("UPDATE tenant_space_relationships SET status='INACTIVE' WHERE id=$1", [tenantSpaceRelationshipId]);
    assert.equal(await failureCode(() => bindHandoffExchangeToChannelAttribution(accepted.exchangeToken)), 'HANDYMAN_HANDOFF_EXCHANGE_INVALID');
    assert.equal(await failureCode(() => accept(assertion())), 'HANDYMAN_HANDOFF_SPACE_MISMATCH');
    const replacement = await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: companyId, buildingId, spaceId }, adminId);
    assert.notEqual(replacement.id, tenantSpaceRelationshipId);
    assert.equal(await failureCode(() => bindHandoffExchangeToChannelAttribution(accepted.exchangeToken)), 'HANDYMAN_HANDOFF_EXCHANGE_INVALID');
    assert.equal((await db().query('SELECT status FROM handyman_handoff_exchanges WHERE id=$1', [accepted.exchangeId])).rows[0].status, 'ACTIVE');
    assert.equal((await db().query('SELECT COUNT(*)::int AS n FROM handyman_channel_attributions WHERE origin_reference LIKE $1', [`bm-handoff:${integrationCode}:%`])).rows[0].n, 3);
    await db().query("UPDATE tenant_building_contexts SET status='INACTIVE' WHERE id=$1", [tenantBuildingContextId]);
    assert.equal(await failureCode(() => accept(assertion())), 'HANDYMAN_HANDOFF_CONTEXT_INVALID');
    await db().query("UPDATE tenant_building_contexts SET status='ACTIVE' WHERE id=$1", [tenantBuildingContextId]);
  });

  it('never accepts a cross-property unit or turns customer identity into actor authority', async (t) => {
    if (!ready(t)) return;
    assert.equal(await failureCode(() => accept(assertion(true, { buildingId: otherBuildingId }))), 'HANDYMAN_HANDOFF_CONTEXT_INVALID');
    assert.equal(await failureCode(() => accept(assertion(true, { tenantPicId: actorId }))), 'HANDYMAN_HANDOFF_REQUESTER_INVALID');
  });
});
