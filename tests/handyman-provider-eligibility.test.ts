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
import { clientService, type PublicClient } from '../src/modules/clients';
import { entitlementService } from '../src/modules/entitlements';
import {
  designateHandymanProvider,
  getBuildingHandymanEnablement,
  HANDYMAN_MODULE_CODE,
  HANDYMAN_SERVICE_CATEGORY,
  isHandymanServiceCategory,
  listAuthorizedHandymanProvidersForBuilding,
  listHandymanProviderServiceEligibilities,
  updateHandymanProviderStatus,
} from '../src/modules/handyman-providers';
import { licenseService } from '../src/modules/licenses';
import { moduleConfigurationService } from '../src/modules/module-configurations';
import { moduleRepository, moduleService } from '../src/modules/modules';
import { propertyService } from '../src/modules/properties';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { subscriptionService } from '../src/modules/subscriptions';
import { userService } from '../src/modules/users';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import {
  vendorCapabilityRepository,
  vendorCapabilityService,
} from '../src/modules/vendor-capabilities';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser } from './helpers/access';
import { activateLatestConfigurationVersion } from './helpers/configuration-lifecycle';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55478;
const DIR = '/tmp/asentra-hm02-run2-pg';
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

const MINUTE = 60_000;
const DAY = 86_400_000;

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let adminToken = '';
let handymanModuleId = '';
let outsiderUserId = '';
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
  adminToken = admin.token;
  handymanModuleId = await ensureHandymanModule();
  const outsider = await userService.createUser({
    email: `outsider-${suffix().toLowerCase()}@example.com`,
    displayName: 'Outsider User',
  });
  outsiderUserId = outsider.id;
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

type HandymanContext = {
  client: PublicClient;
  propertyId: string;
  buildingIds: [string, string];
  vendorIds: [string, string];
  subscriptionId: string | null;
};

/**
 * Client + Property + two Buildings (admin assigned to both) + two Vendors,
 * plus the full BE-02C commercial stack entitled to HANDYMAN unless
 * `entitled: false`. Every context is uniquely coded, so tests never share
 * clients, buildings, vendors, or designations.
 */
async function createHandymanContext(
  options: { entitled?: boolean; assignUserIds?: string[] } = {},
): Promise<HandymanContext> {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Handyman Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Handyman Property',
  });
  const buildingIds: [string, string] = ['' as string, '' as string];
  for (const index of [0, 1] as const) {
    const building = await buildingService.createBuilding({
      propertyId: property.id,
      code: `B${index}_${suffix()}`,
      name: `Handyman Tower ${index + 1}`,
    });
    buildingIds[index] = building.id;
    for (const userId of options.assignUserIds ?? [adminUserId]) {
      await buildingAssignmentService.createAssignment(userId, {
        buildingId: building.id,
      });
    }
  }

  const vendorIds: [string, string] = ['' as string, '' as string];
  for (const index of [0, 1] as const) {
    const vendor = await vendorService.createVendor({
      clientId: client.id,
      vendorCode: `V${index}_${suffix()}`,
      vendorName: `Handyman Vendor ${index + 1}`,
    });
    vendorIds[index] = vendor.id;
  }

  let subscriptionId: string | null = null;
  if (options.entitled !== false) {
    const startsAt = new Date(Date.now() - DAY);
    const endsAt = new Date(Date.now() + 365 * DAY);
    const subscription = await subscriptionService.createSubscription({
      clientId: client.id,
      code: `ASENTRA-${suffix()}`,
      planCode: 'ENTERPRISE',
      startsAt,
      endsAt,
    });
    subscriptionId = subscription.id;
    await licenseService.createLicense(subscription.id, {
      validFrom: startsAt,
      validUntil: endsAt,
    });
    await entitlementService.createEntitlement(subscription.id, {
      moduleId: handymanModuleId,
      startsAt,
      endsAt,
    });
  }

  return { client, propertyId: property.id, buildingIds, vendorIds, subscriptionId };
}

/**
 * Configuration writes capture DRAFT versions (BE-27N/O publish-gated
 * doctrine), so — exactly like the BE-27C effective-read tests — the
 * fixture must validate/publish/activate the captured version before the
 * effective projection consumes it.
 */
async function configureHandyman(
  scope: 'CLIENT' | 'BUILDING',
  scopeId: string,
  enabled: boolean,
): Promise<void> {
  const input = { moduleKey: HANDYMAN_MODULE_CODE, enabled };
  const configuration =
    scope === 'CLIENT'
      ? await moduleConfigurationService.createClientModuleConfiguration(
          scopeId,
          input,
          adminUserId,
        )
      : await moduleConfigurationService.createBuildingModuleConfiguration(
          scopeId,
          input,
          adminUserId,
        );
  await activateLatestConfigurationVersion(
    adminToken,
    'MODULE_CONFIGURATION',
    configuration.id,
  );
}

/** Fully-enabled building shortcut: entitled context + BUILDING config on. */
async function createEnabledBuildingContext(
  options: { entitled?: boolean } = {},
): Promise<HandymanContext> {
  const ctx = await createHandymanContext(options);
  if (options.entitled !== false) {
    await configureHandyman('BUILDING', ctx.buildingIds[0], true);
    await configureHandyman('BUILDING', ctx.buildingIds[1], true);
  }
  return ctx;
}

async function designate(ctx: HandymanContext, vendorIndex: 0 | 1 = 0) {
  return designateHandymanProvider(
    { clientId: ctx.client.id, vendorId: ctx.vendorIds[vendorIndex] },
    adminUserId,
  );
}

async function relate(
  vendorId: string,
  buildingId: string,
  options: { effectiveFrom?: Date | null; effectiveUntil?: Date | null; status?: 'ACTIVE' | 'INACTIVE' } = {},
) {
  return vendorBuildingService.assignBuildingToVendor({
    vendorId,
    buildingId,
    effectiveFrom: options.effectiveFrom ?? null,
    effectiveUntil: options.effectiveUntil ?? null,
    status: options.status,
  });
}

async function createService(clientId: string, category: string = HANDYMAN_SERVICE_CATEGORY) {
  return serviceCatalogService.createServiceCatalogEntry(
    {
      clientId,
      code: `SVC_${suffix()}`,
      name: 'Handyman Service',
      category,
    },
    adminUserId,
  );
}

async function createCapability(
  vendorId: string,
  options: {
    serviceCatalogId?: string | null;
    vendorBuildingRelationshipId?: string | null;
    status?: 'ACTIVE' | 'INACTIVE';
  } = {},
) {
  return vendorCapabilityService.createVendorCapability({
    vendorId,
    code: `CAP_${suffix()}`,
    name: 'Handyman Capability',
    serviceCatalogId: options.serviceCatalogId ?? null,
    vendorBuildingRelationshipId: options.vendorBuildingRelationshipId ?? null,
    status: options.status,
  });
}

describe('CR-HM-BE-02 RUN 2 — Handyman category convention (pure)', () => {
  it('centralizes the category convention and fails closed', () => {
    assert.equal(HANDYMAN_SERVICE_CATEGORY, 'HANDYMAN');
    assert.equal(isHandymanServiceCategory('HANDYMAN'), true);
    assert.equal(isHandymanServiceCategory(' Handyman '), true);
    assert.equal(isHandymanServiceCategory('handyman'), true);
    assert.equal(isHandymanServiceCategory('MEP'), false);
    assert.equal(isHandymanServiceCategory('HANDYMAN_EXTRA'), false);
    assert.equal(isHandymanServiceCategory('CLEANING'), false);
    assert.equal(isHandymanServiceCategory(''), false);
  });
});

describe('CR-HM-BE-02 RUN 2 — Building Handyman enablement', () => {
  it('resolves enabled when entitled and building configuration enabled', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();
    const enablement = await getBuildingHandymanEnablement(
      ctx.buildingIds[0],
      adminUserId,
    );

    assert.equal(enablement.buildingId, ctx.buildingIds[0]);
    assert.equal(enablement.clientId, ctx.client.id);
    assert.equal(enablement.enabled, true);
    assert.equal(enablement.entitled, true);
    assert.equal(enablement.configuredEnabled, true);
  });

  it('fails closed when no module configuration exists', async (t) => {
    if (!ready(t)) return;

    const ctx = await createHandymanContext(); // entitled, but unconfigured
    const enablement = await getBuildingHandymanEnablement(
      ctx.buildingIds[0],
      adminUserId,
    );

    assert.equal(enablement.enabled, false);
    assert.equal(enablement.configuredEnabled, false);
  });

  it('fails closed when entitled but configured disabled', async (t) => {
    if (!ready(t)) return;

    const ctx = await createHandymanContext();
    await configureHandyman('BUILDING', ctx.buildingIds[0], false);

    const enablement = await getBuildingHandymanEnablement(
      ctx.buildingIds[0],
      adminUserId,
    );
    assert.equal(enablement.entitled, true);
    assert.equal(enablement.configuredEnabled, false);
    assert.equal(enablement.enabled, false);
  });

  it('fails closed when configured enabled but not entitled', async (t) => {
    if (!ready(t)) return;

    const ctx = await createHandymanContext({ entitled: false });
    await configureHandyman('BUILDING', ctx.buildingIds[0], true);

    const enablement = await getBuildingHandymanEnablement(
      ctx.buildingIds[0],
      adminUserId,
    );
    assert.equal(enablement.configuredEnabled, true);
    assert.equal(enablement.entitled, false);
    assert.equal(enablement.enabled, false);
  });

  it('applies the building-level override over the client configuration', async (t) => {
    if (!ready(t)) return;

    // Client default ON, building 1 explicitly OFF, building 2 inherits ON
    const ctx = await createHandymanContext();
    await configureHandyman('CLIENT', ctx.client.id, true);
    await configureHandyman('BUILDING', ctx.buildingIds[0], false);

    const overridden = await getBuildingHandymanEnablement(
      ctx.buildingIds[0],
      adminUserId,
    );
    assert.equal(overridden.configuredEnabled, false);
    assert.equal(overridden.enabled, false);

    const inherited = await getBuildingHandymanEnablement(
      ctx.buildingIds[1],
      adminUserId,
    );
    assert.equal(inherited.configuredEnabled, true);
    assert.equal(inherited.enabled, true);

    // Reverse direction: client default OFF, building explicitly ON
    const reverse = await createHandymanContext();
    await configureHandyman('CLIENT', reverse.client.id, false);
    await configureHandyman('BUILDING', reverse.buildingIds[0], true);

    const reverseEnabled = await getBuildingHandymanEnablement(
      reverse.buildingIds[0],
      adminUserId,
    );
    assert.equal(reverseEnabled.enabled, true);

    const reverseInherited = await getBuildingHandymanEnablement(
      reverse.buildingIds[1],
      adminUserId,
    );
    assert.equal(reverseInherited.enabled, false);
  });

  it('enforces building access and never leaks unknown buildings', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();

    await expectError(
      getBuildingHandymanEnablement(ctx.buildingIds[0], outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      getBuildingHandymanEnablement(randomUUID(), adminUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
  });
});

describe('CR-HM-BE-02 RUN 2 — Provider building authorization', () => {
  it('lists a fully-authorized provider and fails closed on a disabled building', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();
    const provider = await designate(ctx, 0);
    const relationship = await relate(ctx.vendorIds[0], ctx.buildingIds[0]);

    const authorized = await listAuthorizedHandymanProvidersForBuilding(
      ctx.buildingIds[0],
      adminUserId,
    );
    assert.equal(authorized.length, 1);
    assert.equal(authorized[0].providerId, provider.id);
    assert.equal(authorized[0].vendorId, ctx.vendorIds[0]);
    assert.equal(authorized[0].clientId, ctx.client.id);
    assert.equal(authorized[0].buildingId, ctx.buildingIds[0]);
    assert.equal(authorized[0].relationshipId, relationship.id);
    assert.ok(authorized[0].vendorCode);
    assert.ok(authorized[0].vendorName);

    // Same stack, but building 2 is enabled without configuration → nobody
    const unconfigured = await createHandymanContext();
    await designate(unconfigured, 0);
    await relate(unconfigured.vendorIds[0], unconfigured.buildingIds[0]);
    const disabledBuilding = await listAuthorizedHandymanProvidersForBuilding(
      unconfigured.buildingIds[0],
      adminUserId,
    );
    assert.deepEqual(disabledBuilding, []);
  });

  it('excludes INACTIVE designations and INACTIVE vendors', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();
    const provider = await designate(ctx, 0);
    await relate(ctx.vendorIds[0], ctx.buildingIds[0]);
    const provider2 = await designate(ctx, 1);
    await relate(ctx.vendorIds[1], ctx.buildingIds[0]);

    // Deactivate designation 1 → only provider 2 remains
    await updateHandymanProviderStatus(
      provider.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    let authorized = await listAuthorizedHandymanProvidersForBuilding(
      ctx.buildingIds[0],
      adminUserId,
    );
    assert.deepEqual(
      authorized.map((row) => row.providerId),
      [provider2.id],
    );

    // Deactivate vendor 2 → nobody remains
    await vendorService.updateVendorStatus(ctx.vendorIds[1], {
      status: 'INACTIVE',
    });
    authorized = await listAuthorizedHandymanProvidersForBuilding(
      ctx.buildingIds[0],
      adminUserId,
    );
    assert.deepEqual(authorized, []);
  });

  it('excludes INACTIVE relationships', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();
    await designate(ctx, 0);
    await relate(ctx.vendorIds[0], ctx.buildingIds[0], { status: 'INACTIVE' });

    const authorized = await listAuthorizedHandymanProvidersForBuilding(
      ctx.buildingIds[0],
      adminUserId,
    );
    assert.deepEqual(authorized, []);
  });

  it('applies effective window semantics including the null standing window', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();
    const extraVendorA = await vendorService.createVendor({
      clientId: ctx.client.id,
      vendorCode: `VA_${suffix()}`,
      vendorName: 'Window Vendor A',
    });
    const extraVendorB = await vendorService.createVendor({
      clientId: ctx.client.id,
      vendorCode: `VB_${suffix()}`,
      vendorName: 'Window Vendor B',
    });

    // vendor 0: undated (NULL/NULL) → standing → authorized
    await designate(ctx, 0);
    await relate(ctx.vendorIds[0], ctx.buildingIds[0]);

    // vendor 1: window fully around now → authorized
    await designate(ctx, 1);
    await relate(ctx.vendorIds[1], ctx.buildingIds[0], {
      effectiveFrom: new Date(Date.now() - DAY),
      effectiveUntil: new Date(Date.now() + DAY),
    });

    // vendor A: window starts in the future → not yet authorized
    await designateHandymanProvider(
      { clientId: ctx.client.id, vendorId: extraVendorA.id },
      adminUserId,
    );
    await relate(extraVendorA.id, ctx.buildingIds[0], {
      effectiveFrom: new Date(Date.now() + MINUTE),
    });

    // vendor B: window ended in the past → no longer authorized
    await designateHandymanProvider(
      { clientId: ctx.client.id, vendorId: extraVendorB.id },
      adminUserId,
    );
    await relate(extraVendorB.id, ctx.buildingIds[0], {
      effectiveUntil: new Date(Date.now() - MINUTE),
    });

    const authorized = await listAuthorizedHandymanProvidersForBuilding(
      ctx.buildingIds[0],
      adminUserId,
    );
    assert.deepEqual(
      authorized.map((row) => row.vendorId).sort(),
      [ctx.vendorIds[0], ctx.vendorIds[1]].sort(),
    );
  });

  it('does not leak providers across buildings of the same client', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();
    await designate(ctx, 0);
    await relate(ctx.vendorIds[0], ctx.buildingIds[0]); // building 1 only

    const atBuilding1 = await listAuthorizedHandymanProvidersForBuilding(
      ctx.buildingIds[0],
      adminUserId,
    );
    assert.equal(atBuilding1.length, 1);

    const atBuilding2 = await listAuthorizedHandymanProvidersForBuilding(
      ctx.buildingIds[1],
      adminUserId,
    );
    assert.deepEqual(atBuilding2, []);
  });

  it('does not leak providers across clients', async (t) => {
    if (!ready(t)) return;

    const ctxA = await createEnabledBuildingContext();
    const ctxB = await createEnabledBuildingContext();
    await designate(ctxA, 0);
    await relate(ctxA.vendorIds[0], ctxA.buildingIds[0]);
    const providerB = await designate(ctxB, 0);
    await relate(ctxB.vendorIds[0], ctxB.buildingIds[0]);

    const atA = await listAuthorizedHandymanProvidersForBuilding(
      ctxA.buildingIds[0],
      adminUserId,
    );
    assert.equal(atA.length, 1);
    assert.equal(atA[0].clientId, ctxA.client.id);
    assert.notEqual(atA[0].providerId, providerB.id);

    const atB = await listAuthorizedHandymanProvidersForBuilding(
      ctxB.buildingIds[0],
      adminUserId,
    );
    assert.equal(atB.length, 1);
    assert.equal(atB[0].providerId, providerB.id);
  });

  it('enforces building access on the authorized-provider list', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();
    await expectError(
      listAuthorizedHandymanProvidersForBuilding(
        ctx.buildingIds[0],
        outsiderUserId,
      ),
      'BUILDING_ACCESS_DENIED',
      403,
    );
  });
});

describe('CR-HM-BE-02 RUN 2 — Provider service eligibility', () => {
  it('resolves vendor-wide capabilities at every authorized building', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();
    const provider = await designate(ctx, 0);
    await relate(ctx.vendorIds[0], ctx.buildingIds[0]);
    await relate(ctx.vendorIds[0], ctx.buildingIds[1]);
    const service = await createService(ctx.client.id);
    await createCapability(ctx.vendorIds[0], {
      serviceCatalogId: service.id,
    });

    for (const buildingId of ctx.buildingIds) {
      const eligible = await listHandymanProviderServiceEligibilities(
        buildingId,
        provider.id,
        adminUserId,
      );
      assert.equal(eligible.length, 1);
      assert.equal(eligible[0].providerId, provider.id);
      assert.equal(eligible[0].buildingId, buildingId);
      assert.equal(eligible[0].vendorId, ctx.vendorIds[0]);
      assert.equal(eligible[0].capabilityScope, 'VENDOR_WIDE');
      assert.equal(eligible[0].serviceCatalogId, service.id);
      assert.equal(eligible[0].serviceCode, service.code);
      assert.equal(eligible[0].serviceName, service.name);
    }
  });

  it('resolves building-scoped capabilities only at their building', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();
    const provider = await designate(ctx, 0);
    const relationship1 = await relate(ctx.vendorIds[0], ctx.buildingIds[0]);
    await relate(ctx.vendorIds[0], ctx.buildingIds[1]);
    const scopedService = await createService(ctx.client.id);
    await createCapability(ctx.vendorIds[0], {
      serviceCatalogId: scopedService.id,
      vendorBuildingRelationshipId: relationship1.id,
    });
    const wideService = await createService(ctx.client.id);
    await createCapability(ctx.vendorIds[0], {
      serviceCatalogId: wideService.id,
    });

    const atBuilding1 = await listHandymanProviderServiceEligibilities(
      ctx.buildingIds[0],
      provider.id,
      adminUserId,
    );
    assert.equal(atBuilding1.length, 2);
    const scoped = atBuilding1.find(
      (row) => row.serviceCatalogId === scopedService.id,
    );
    assert.equal(scoped?.capabilityScope, 'BUILDING_SCOPED');

    const atBuilding2 = await listHandymanProviderServiceEligibilities(
      ctx.buildingIds[1],
      provider.id,
      adminUserId,
    );
    assert.deepEqual(
      atBuilding2.map((row) => row.serviceCatalogId),
      [wideService.id],
    );
  });

  it('excludes INACTIVE capabilities and capabilities without a catalog link', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();
    const provider = await designate(ctx, 0);
    await relate(ctx.vendorIds[0], ctx.buildingIds[0]);

    const activeService = await createService(ctx.client.id);
    await createCapability(ctx.vendorIds[0], {
      serviceCatalogId: activeService.id,
    });

    const inactiveService = await createService(ctx.client.id);
    await createCapability(ctx.vendorIds[0], {
      serviceCatalogId: inactiveService.id,
      status: 'INACTIVE',
    });

    // Legacy code-only capability (no governed identity) fails closed
    await createCapability(ctx.vendorIds[0], { serviceCatalogId: null });

    const eligible = await listHandymanProviderServiceEligibilities(
      ctx.buildingIds[0],
      provider.id,
      adminUserId,
    );
    assert.deepEqual(
      eligible.map((row) => row.serviceCatalogId),
      [activeService.id],
    );
  });

  it('excludes INACTIVE catalog entries and non-HANDYMAN categories', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();
    const provider = await designate(ctx, 0);
    await relate(ctx.vendorIds[0], ctx.buildingIds[0]);

    const kept = await createService(ctx.client.id);
    await createCapability(ctx.vendorIds[0], { serviceCatalogId: kept.id });

    const deactivated = await createService(ctx.client.id);
    await createCapability(ctx.vendorIds[0], {
      serviceCatalogId: deactivated.id,
    });
    await serviceCatalogService.deactivateServiceCatalogEntry(
      deactivated.id,
      adminUserId,
    );

    const otherCategory = await createService(ctx.client.id, 'MEP');
    await createCapability(ctx.vendorIds[0], {
      serviceCatalogId: otherCategory.id,
    });

    const eligible = await listHandymanProviderServiceEligibilities(
      ctx.buildingIds[0],
      provider.id,
      adminUserId,
    );
    assert.deepEqual(
      eligible.map((row) => row.serviceCatalogId),
      [kept.id],
    );
  });

  it('excludes cross-client catalog links at read time (fail closed)', async (t) => {
    if (!ready(t)) return;

    const ctxA = await createEnabledBuildingContext();
    const ctxB = await createEnabledBuildingContext();
    const providerA = await designate(ctxA, 0);
    await relate(ctxA.vendorIds[0], ctxA.buildingIds[0]);

    // Bypass the write-side guard with a direct repository insert: a
    // capability of A's vendor linked to B's catalog entry must never
    // resolve as eligible in A's building.
    const foreignService = await createService(ctxB.client.id);
    await vendorCapabilityRepository.createVendorCapability({
      vendorId: ctxA.vendorIds[0],
      code: `CAPX_${suffix()}`,
      name: 'Foreign Link Capability',
      description: null,
      vendorBuildingRelationshipId: null,
      serviceCatalogId: foreignService.id,
      status: 'ACTIVE',
    });

    const eligible = await listHandymanProviderServiceEligibilities(
      ctxA.buildingIds[0],
      providerA.id,
      adminUserId,
    );
    assert.deepEqual(eligible, []);
  });

  it('excludes capabilities scoped through stale or inactive relationships', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();
    const provider = await designate(ctx, 0);
    const staleRelationship = await relate(ctx.vendorIds[0], ctx.buildingIds[0]);
    const staleService = await createService(ctx.client.id);
    await createCapability(ctx.vendorIds[0], {
      serviceCatalogId: staleService.id,
      vendorBuildingRelationshipId: staleRelationship.id,
    });

    // Deactivate the relationship, then re-establish a fresh undated one:
    // the provider is authorized again, but the stale-scoped capability is
    // not eligible; a vendor-wide capability is.
    await vendorBuildingService.updateVendorBuildingRelationship(
      ctx.vendorIds[0],
      ctx.buildingIds[0],
      { status: 'INACTIVE' },
    );
    await relate(ctx.vendorIds[0], ctx.buildingIds[0]);
    const wideService = await createService(ctx.client.id);
    await createCapability(ctx.vendorIds[0], {
      serviceCatalogId: wideService.id,
    });

    const authorized = await listAuthorizedHandymanProvidersForBuilding(
      ctx.buildingIds[0],
      adminUserId,
    );
    assert.deepEqual(
      authorized.map((row) => row.providerId),
      [provider.id],
    );

    const eligible = await listHandymanProviderServiceEligibilities(
      ctx.buildingIds[0],
      provider.id,
      adminUserId,
    );
    assert.deepEqual(
      eligible.map((row) => row.serviceCatalogId),
      [wideService.id],
    );
  });

  it('hides providers that are not authorized at the building behind 404', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();
    const provider = await designate(ctx, 0);
    // No relationship at all → not authorized anywhere

    await expectError(
      listHandymanProviderServiceEligibilities(
        ctx.buildingIds[0],
        provider.id,
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_NOT_FOUND',
      404,
    );

    // Unknown designation id
    await expectError(
      listHandymanProviderServiceEligibilities(
        ctx.buildingIds[0],
        randomUUID(),
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_NOT_FOUND',
      404,
    );

    // Deactivated designation is indistinguishable from unknown
    await relate(ctx.vendorIds[0], ctx.buildingIds[0]);
    await updateHandymanProviderStatus(
      provider.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    await expectError(
      listHandymanProviderServiceEligibilities(
        ctx.buildingIds[0],
        provider.id,
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_NOT_FOUND',
      404,
    );
  });

  it('returns an empty eligibility list for an authorized provider without capabilities', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();
    const provider = await designate(ctx, 0);
    await relate(ctx.vendorIds[0], ctx.buildingIds[0]);

    const eligible = await listHandymanProviderServiceEligibilities(
      ctx.buildingIds[0],
      provider.id,
      adminUserId,
    );
    assert.deepEqual(eligible, []);
  });

  it('enforces building access on the eligibility read', async (t) => {
    if (!ready(t)) return;

    const ctx = await createEnabledBuildingContext();
    const provider = await designate(ctx, 0);
    await relate(ctx.vendorIds[0], ctx.buildingIds[0]);

    await expectError(
      listHandymanProviderServiceEligibilities(
        ctx.buildingIds[0],
        provider.id,
        outsiderUserId,
      ),
      'BUILDING_ACCESS_DENIED',
      403,
    );
  });
});
