import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, runSeeds } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { entitlementService } from '../src/modules/entitlements';
import {
  designateHandymanProvider,
  getHandymanProviderById,
  HANDYMAN_MODULE_CODE,
  listHandymanProviders,
  updateHandymanProviderStatus,
  type CreateHandymanProviderInput,
} from '../src/modules/handyman-providers';
import { licenseService } from '../src/modules/licenses';
import { moduleRepository, moduleService } from '../src/modules/modules';
import { propertyService } from '../src/modules/properties';
import { subscriptionService } from '../src/modules/subscriptions';
import { userService } from '../src/modules/users';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55476;
const DIR = '/tmp/asentra-hm02-run1-svc-pg';
const EM = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';

if (EM) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  if (EM) {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }

  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await runSeeds(pool);
  await pool.query('TRUNCATE handyman_work_sessions, handyman_visit_presence, handyman_visit_arrivals, handyman_service_visit_schedules, handyman_service_visits, handyman_job_assignments, handyman_jobs, handyman_work_crew_members, handyman_work_crews, handyman_providers');
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    if (EM) await rm(DIR, { recursive: true, force: true });
  }
  pool = null;
  pg = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function expectError(
  promise: Promise<unknown>,
  code: string,
  statusCode: number,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const appError = error as { code?: string; statusCode?: number };
    assert.equal(appError.code, code);
    assert.equal(appError.statusCode, statusCode);
    return;
  }
  assert.fail(`Expected error ${code} (${statusCode}) was not thrown`);
}

/**
 * Resolves the HANDYMAN module through the BE-02C catalogue authority the
 * same way production provisioning would — by stable code, never by a
 * hardcoded database id. Idempotent across test files sharing the database.
 */
async function ensureHandymanModule(): Promise<string> {
  const existing = await moduleRepository.findByCode(HANDYMAN_MODULE_CODE);
  if (existing) {
    if (existing.status !== 'ACTIVE') {
      await moduleService.updateModuleStatus(existing.id, { status: 'ACTIVE' });
    }
    return existing.id;
  }
  const created = await moduleService.createModule({
    code: HANDYMAN_MODULE_CODE,
    name: 'Handyman',
  });
  return created.id;
}

async function createOutsiderUser(): Promise<string> {
  const user = await userService.createUser({
    email: `outsider-${suffix().toLowerCase()}@example.com`,
    displayName: 'Outsider User',
  });
  return user.id;
}

/**
 * Client + Property + Building hierarchy with the given users assigned
 * (BE-02G client reach requires an ACTIVE building assignment), plus the
 * full BE-02C commercial stack: Subscription → License → Module
 * Entitlement. `entitlementModuleCode` defaults to HANDYMAN; passing
 * another code builds a commercially-valid client that is NOT entitled to
 * Handyman. `withCommercialStack: false` omits subscription/license/
 * entitlement entirely.
 */
async function createClientContext(
  options: {
    assignUserIds?: string[];
    entitlementModuleCode?: string;
    withCommercialStack?: boolean;
  } = {},
) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Handyman Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Handyman Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Handyman Tower',
  });
  for (const userId of options.assignUserIds ?? [adminUserId]) {
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: building.id,
    });
  }

  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Handyman Vendor',
  });

  if (options.withCommercialStack === false) {
    return { client, property, building, vendor, subscription: null };
  }

  const startsAt = new Date(Date.now() - 86_400_000);
  const endsAt = new Date(Date.now() + 365 * 86_400_000);
  const subscription = await subscriptionService.createSubscription({
    clientId: client.id,
    code: `ASENTRA-${suffix()}`,
    planCode: 'ENTERPRISE',
    startsAt,
    endsAt,
  });
  await licenseService.createLicense(subscription.id, {
    validFrom: startsAt,
    validUntil: endsAt,
  });

  const moduleCode = options.entitlementModuleCode ?? HANDYMAN_MODULE_CODE;
  const moduleId =
    moduleCode === HANDYMAN_MODULE_CODE
      ? await ensureHandymanModule()
      : (
          await moduleService.createModule({
            code: moduleCode,
            name: 'Non-Handyman Module',
          })
        ).id;
  await entitlementService.createEntitlement(subscription.id, {
    moduleId,
    startsAt,
    endsAt,
  });

  return { client, property, building, vendor, subscription };
}

describe('CR-HM-BE-02 RUN 1: Handyman Provider Designation Service Authority', () => {
  it('designates an ACTIVE vendor of an entitled client with actor attribution', async (t) => {
    if (!ready(t)) return;

    const ctx = await createClientContext();

    const provider = await designateHandymanProvider(
      { clientId: ctx.client.id, vendorId: ctx.vendor.id },
      adminUserId,
    );

    assert.ok(provider.id);
    assert.equal(provider.clientId, ctx.client.id);
    assert.equal(provider.vendorId, ctx.vendor.id);
    assert.equal(provider.status, 'ACTIVE');
    assert.equal(provider.createdByUserId, adminUserId);
    assert.ok(provider.createdAt);
    assert.ok(provider.updatedAt);

    const fetched = await getHandymanProviderById(provider.id, adminUserId);
    assert.deepEqual(fetched, provider);

    const listed = await listHandymanProviders(ctx.client.id, adminUserId);
    assert.deepEqual(
      listed.map((row) => row.id),
      [provider.id],
    );
  });

  it('rejects designation when the vendor belongs to another client', async (t) => {
    if (!ready(t)) return;

    const ctxA = await createClientContext();
    const ctxB = await createClientContext();

    await expectError(
      designateHandymanProvider(
        { clientId: ctxA.client.id, vendorId: ctxB.vendor.id },
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_VENDOR_CLIENT_MISMATCH',
      400,
    );
  });

  it('rejects designation of an unknown vendor', async (t) => {
    if (!ready(t)) return;

    const ctx = await createClientContext();

    await expectError(
      designateHandymanProvider(
        { clientId: ctx.client.id, vendorId: randomUUID() },
        adminUserId,
      ),
      'VENDOR_NOT_FOUND',
      404,
    );
  });

  it('rejects designation of an INACTIVE vendor', async (t) => {
    if (!ready(t)) return;

    const ctx = await createClientContext();
    await vendorService.updateVendorStatus(ctx.vendor.id, {
      status: 'INACTIVE',
    });

    await expectError(
      designateHandymanProvider(
        { clientId: ctx.client.id, vendorId: ctx.vendor.id },
        adminUserId,
      ),
      'VENDOR_INACTIVE',
      400,
    );
  });

  it('rejects designation when the client holds no effective HANDYMAN entitlement', async (t) => {
    if (!ready(t)) return;

    // Commercially valid client, but the entitlement is for another module
    const otherModuleCtx = await createClientContext({
      entitlementModuleCode: `OTHER_${suffix()}`,
    });
    await expectError(
      designateHandymanProvider(
        {
          clientId: otherModuleCtx.client.id,
          vendorId: otherModuleCtx.vendor.id,
        },
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_MODULE_NOT_ENTITLED',
      403,
    );

    // No commercial stack at all
    const bareCtx = await createClientContext({ withCommercialStack: false });
    await expectError(
      designateHandymanProvider(
        { clientId: bareCtx.client.id, vendorId: bareCtx.vendor.id },
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_MODULE_NOT_ENTITLED',
      403,
    );
  });

  it('rejects designation for an INACTIVE client', async (t) => {
    if (!ready(t)) return;

    const ctx = await createClientContext();
    await clientService.updateClient(ctx.client.id, { status: 'INACTIVE' });

    await expectError(
      designateHandymanProvider(
        { clientId: ctx.client.id, vendorId: ctx.vendor.id },
        adminUserId,
      ),
      'CLIENT_INACTIVE',
      400,
    );
  });

  it('rejects a duplicate ACTIVE designation for the same client and vendor', async (t) => {
    if (!ready(t)) return;

    const ctx = await createClientContext();
    await designateHandymanProvider(
      { clientId: ctx.client.id, vendorId: ctx.vendor.id },
      adminUserId,
    );

    await expectError(
      designateHandymanProvider(
        { clientId: ctx.client.id, vendorId: ctx.vendor.id },
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_ALREADY_DESIGNATED',
      409,
    );

    const listed = await listHandymanProviders(ctx.client.id, adminUserId);
    assert.equal(listed.length, 1);
  });

  it('supports the ACTIVE to INACTIVE lifecycle and rejects redundant transitions', async (t) => {
    if (!ready(t)) return;

    const ctx = await createClientContext();
    const provider = await designateHandymanProvider(
      { clientId: ctx.client.id, vendorId: ctx.vendor.id },
      adminUserId,
    );

    const deactivated = await updateHandymanProviderStatus(
      provider.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    assert.equal(deactivated.status, 'INACTIVE');
    assert.equal(deactivated.id, provider.id);

    await expectError(
      updateHandymanProviderStatus(
        provider.id,
        { status: 'INACTIVE' },
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_STATUS_INVALID',
      400,
    );

    const reactivated = await updateHandymanProviderStatus(
      provider.id,
      { status: 'ACTIVE' },
      adminUserId,
    );
    assert.equal(reactivated.status, 'ACTIVE');

    await expectError(
      updateHandymanProviderStatus(
        provider.id,
        { status: 'ACTIVE' },
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_STATUS_INVALID',
      400,
    );
  });

  it('rejects reactivating a stale designation while a newer ACTIVE designation exists', async (t) => {
    if (!ready(t)) return;

    const ctx = await createClientContext();
    const first = await designateHandymanProvider(
      { clientId: ctx.client.id, vendorId: ctx.vendor.id },
      adminUserId,
    );
    await updateHandymanProviderStatus(
      first.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    const second = await designateHandymanProvider(
      { clientId: ctx.client.id, vendorId: ctx.vendor.id },
      adminUserId,
    );
    assert.notEqual(second.id, first.id);

    await expectError(
      updateHandymanProviderStatus(
        first.id,
        { status: 'ACTIVE' },
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_ALREADY_DESIGNATED',
      409,
    );

    // History is preserved and visible through the list surface
    const history = await listHandymanProviders(ctx.client.id, adminUserId);
    assert.equal(history.length, 2);
    const activeOnly = await listHandymanProviders(
      ctx.client.id,
      adminUserId,
      { status: 'ACTIVE' },
    );
    assert.deepEqual(
      activeOnly.map((row) => row.id),
      [second.id],
    );
  });

  it('rejects reactivation when the vendor became INACTIVE', async (t) => {
    if (!ready(t)) return;

    const ctx = await createClientContext();
    const provider = await designateHandymanProvider(
      { clientId: ctx.client.id, vendorId: ctx.vendor.id },
      adminUserId,
    );
    await updateHandymanProviderStatus(
      provider.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    await vendorService.updateVendorStatus(ctx.vendor.id, {
      status: 'INACTIVE',
    });

    await expectError(
      updateHandymanProviderStatus(
        provider.id,
        { status: 'ACTIVE' },
        adminUserId,
      ),
      'VENDOR_INACTIVE',
      400,
    );
  });

  it('rejects reactivation when the HANDYMAN entitlement lapsed', async (t) => {
    if (!ready(t)) return;

    const ctx = await createClientContext();
    const provider = await designateHandymanProvider(
      { clientId: ctx.client.id, vendorId: ctx.vendor.id },
      adminUserId,
    );
    await updateHandymanProviderStatus(
      provider.id,
      { status: 'INACTIVE' },
      adminUserId,
    );

    await subscriptionService.updateSubscriptionStatus(ctx.subscription!.id, {
      status: 'SUSPENDED',
    });

    await expectError(
      updateHandymanProviderStatus(
        provider.id,
        { status: 'ACTIVE' },
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_MODULE_NOT_ENTITLED',
      403,
    );
  });

  it('enforces actor client access on every designation operation', async (t) => {
    if (!ready(t)) return;

    const ctx = await createClientContext();
    const provider = await designateHandymanProvider(
      { clientId: ctx.client.id, vendorId: ctx.vendor.id },
      adminUserId,
    );

    const outsiderId = await createOutsiderUser();

    await expectError(
      designateHandymanProvider(
        { clientId: ctx.client.id, vendorId: ctx.vendor.id },
        outsiderId,
      ),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      getHandymanProviderById(provider.id, outsiderId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      listHandymanProviders(ctx.client.id, outsiderId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      updateHandymanProviderStatus(
        provider.id,
        { status: 'INACTIVE' },
        outsiderId,
      ),
      'BUILDING_ACCESS_DENIED',
      403,
    );

    // The designation survived the denied deactivation attempt
    const untouched = await getHandymanProviderById(provider.id, adminUserId);
    assert.equal(untouched.status, 'ACTIVE');
  });

  it('derives createdBy from the authenticated actor only, ignoring payload identity', async (t) => {
    if (!ready(t)) return;

    const actorB = await userService.createUser({
      email: `designator-${suffix().toLowerCase()}@example.com`,
      displayName: 'Second Designator',
    });
    const ctx = await createClientContext({
      assignUserIds: [adminUserId, actorB.id],
    });
    const secondVendor = await vendorService.createVendor({
      clientId: ctx.client.id,
      vendorCode: `V_${suffix()}`,
      vendorName: 'Second Handyman Vendor',
    });

    // A forged createdByUserId in the payload is structurally ignored: the
    // persisted attribution is always the acting user.
    const forged = {
      clientId: ctx.client.id,
      vendorId: secondVendor.id,
      createdByUserId: adminUserId,
    } as CreateHandymanProviderInput;

    const provider = await designateHandymanProvider(forged, actorB.id);
    assert.equal(provider.createdByUserId, actorB.id);

    const fetched = await getHandymanProviderById(provider.id, actorB.id);
    assert.equal(fetched.createdByUserId, actorB.id);
  });

  it('returns 404 for unknown designation ids', async (t) => {
    if (!ready(t)) return;

    await expectError(
      getHandymanProviderById(randomUUID(), adminUserId),
      'HANDYMAN_PROVIDER_NOT_FOUND',
      404,
    );
    await expectError(
      updateHandymanProviderStatus(
        randomUUID(),
        { status: 'INACTIVE' },
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_NOT_FOUND',
      404,
    );
  });
});
