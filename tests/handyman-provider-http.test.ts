import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, runSeeds } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { entitlementService } from '../src/modules/entitlements';
import {
  HANDYMAN_MODULE_CODE,
  HANDYMAN_SERVICE_CATEGORY,
} from '../src/modules/handyman-providers';
import { licenseService } from '../src/modules/licenses';
import { moduleConfigurationService } from '../src/modules/module-configurations';
import { moduleRepository, moduleService } from '../src/modules/modules';
import { propertyService } from '../src/modules/properties';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { subscriptionService } from '../src/modules/subscriptions';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorService } from '../src/modules/vendors';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { activateLatestConfigurationVersion } from './helpers/configuration-lifecycle';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-02 RUN 3 — focused HTTP contract tests for the six Handyman
 * Provider endpoints. The tests exercise the transport layer end-to-end
 * (auth → RBAC → validation → Run 1/Run 2 service authority → success/error
 * envelope) and assert runtime↔OpenAPI parity. Business-rule coverage lives
 * in the Run 1/Run 2 service tests; here each rule is re-asserted once
 * through the wire to prove the thin controller delegation.
 */

const PORT = 55494;
const DIR = '/tmp/asentra-hm02-run3-pg';
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

const DAY = 86_400_000;

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';
let handymanModuleId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

const PROVIDER_READ = {
  code: 'handyman_provider.read',
  name: 'Read Handyman Providers',
};
const PROVIDER_MANAGE = {
  code: 'handyman_provider.manage',
  name: 'Manage Handyman Providers',
};

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
  await pool.query('TRUNCATE handyman_job_assignments, handyman_jobs, handyman_work_crew_members, handyman_work_crews, handyman_providers');
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  handymanModuleId = await ensureHandymanModule();
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

function authHeaders(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
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
  vendorCodes: [string, string];
  subscriptionId: string | null;
};

/**
 * Client + Property + two Buildings (admin assigned to both) + two Vendors,
 * plus the full BE-02C commercial stack entitled to HANDYMAN unless
 * `entitled: false`. Every context is uniquely coded, so tests never share
 * clients, buildings, vendors, or designations (same convention as the
 * Run 2 service tests).
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
  const vendorCodes: [string, string] = ['' as string, '' as string];
  for (const index of [0, 1] as const) {
    const vendorCode = `V${index}_${suffix()}`;
    const vendor = await vendorService.createVendor({
      clientId: client.id,
      vendorCode,
      vendorName: `Handyman Vendor ${index + 1}`,
    });
    vendorIds[index] = vendor.id;
    vendorCodes[index] = vendorCode;
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

  return {
    client,
    propertyId: property.id,
    buildingIds,
    vendorIds,
    vendorCodes,
    subscriptionId,
  };
}

/**
 * Configuration writes capture DRAFT versions (BE-27N/O publish-gated
 * doctrine), so — exactly like the Run 2 service tests — the fixture must
 * validate/publish/activate the captured version before the effective
 * projection consumes it.
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

async function designateByHttp(ctx: HandymanContext, vendorIndex: 0 | 1 = 0) {
  const response = await api()
    .post(`/api/v1/clients/${ctx.client.id}/handyman-providers`)
    .set(authHeaders())
    .send({ vendorId: ctx.vendorIds[vendorIndex] });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data as {
    id: string;
    clientId: string;
    vendorId: string;
    status: string;
    createdByUserId: string;
    createdAt: string;
    updatedAt: string;
  };
}

async function relate(
  vendorId: string,
  buildingId: string,
  options: {
    effectiveFrom?: Date | null;
    effectiveUntil?: Date | null;
    status?: 'ACTIVE' | 'INACTIVE';
  } = {},
) {
  return vendorBuildingService.assignBuildingToVendor({
    vendorId,
    buildingId,
    effectiveFrom: options.effectiveFrom ?? null,
    effectiveUntil: options.effectiveUntil ?? null,
    status: options.status,
  });
}

async function createService(
  clientId: string,
  category: string = HANDYMAN_SERVICE_CATEGORY,
) {
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

type ErrorBody = {
  error: { code: string; message?: string; details?: { field: string; message: string }[] };
};

function detailFields(body: ErrorBody): string[] {
  return (body.error.details ?? []).map((detail) => detail.field);
}

describe('CR-HM-BE-02 RUN 3 — authentication and RBAC', () => {
  it('requires authentication on all six endpoints', async (t) => {
    if (!ready(t)) return;
    const randomId = randomUUID();
    const unauthenticated = await Promise.all([
      api().post(`/api/v1/clients/${randomId}/handyman-providers`).send({ vendorId: randomId }),
      api().get(`/api/v1/clients/${randomId}/handyman-providers`),
      api().get(`/api/v1/handyman-providers/${randomId}`),
      api().patch(`/api/v1/handyman-providers/${randomId}`).send({ status: 'INACTIVE' }),
      api().get(`/api/v1/buildings/${randomId}/handyman-providers`),
      api().get(
        `/api/v1/buildings/${randomId}/handyman-providers/${randomId}/service-eligibilities`,
      ),
    ]);
    for (const response of unauthenticated) {
      assert.equal(response.status, 401);
      assert.equal((response.body as ErrorBody).error.code, 'AUTHENTICATION_REQUIRED');
    }
  });

  it('denies writes to a read-only session', async (t) => {
    if (!ready(t)) return;
    const ctx = await createHandymanContext();
    const token = await createSessionWithPermissions([PROVIDER_READ]);

    const deniedCreate = await api()
      .post(`/api/v1/clients/${ctx.client.id}/handyman-providers`)
      .set(authHeaders(token))
      .send({ vendorId: ctx.vendorIds[0] });
    assert.equal(deniedCreate.status, 403);
    assert.equal((deniedCreate.body as ErrorBody).error.code, 'PERMISSION_DENIED');

    const deniedPatch = await api()
      .patch(`/api/v1/handyman-providers/${randomUUID()}`)
      .set(authHeaders(token))
      .send({ status: 'INACTIVE' });
    assert.equal(deniedPatch.status, 403);
    assert.equal((deniedPatch.body as ErrorBody).error.code, 'PERMISSION_DENIED');
  });

  it('denies reads to a manage-only session', async (t) => {
    if (!ready(t)) return;
    const ctx = await createHandymanContext();
    const token = await createSessionWithPermissions([PROVIDER_MANAGE]);
    const randomId = randomUUID();

    const denied = await Promise.all([
      api().get(`/api/v1/clients/${ctx.client.id}/handyman-providers`).set(authHeaders(token)),
      api().get(`/api/v1/handyman-providers/${randomId}`).set(authHeaders(token)),
      api().get(`/api/v1/buildings/${ctx.buildingIds[0]}/handyman-providers`).set(authHeaders(token)),
      api()
        .get(`/api/v1/buildings/${ctx.buildingIds[0]}/handyman-providers/${randomId}/service-eligibilities`)
        .set(authHeaders(token)),
    ]);
    for (const response of denied) {
      assert.equal(response.status, 403);
      assert.equal((response.body as ErrorBody).error.code, 'PERMISSION_DENIED');
    }
  });

  it('denies every endpoint to an authenticated session without handyman permissions', async (t) => {
    if (!ready(t)) return;
    const ctx = await createHandymanContext();
    const token = await createPlainSession();
    const randomId = randomUUID();

    const denied = await Promise.all([
      api()
        .post(`/api/v1/clients/${ctx.client.id}/handyman-providers`)
        .set(authHeaders(token))
        .send({ vendorId: ctx.vendorIds[0] }),
      api().get(`/api/v1/clients/${ctx.client.id}/handyman-providers`).set(authHeaders(token)),
      api().get(`/api/v1/handyman-providers/${randomId}`).set(authHeaders(token)),
      api()
        .patch(`/api/v1/handyman-providers/${randomId}`)
        .set(authHeaders(token))
        .send({ status: 'INACTIVE' }),
      api().get(`/api/v1/buildings/${ctx.buildingIds[0]}/handyman-providers`).set(authHeaders(token)),
      api()
        .get(`/api/v1/buildings/${ctx.buildingIds[0]}/handyman-providers/${randomId}/service-eligibilities`)
        .set(authHeaders(token)),
    ]);
    for (const response of denied) {
      assert.equal(response.status, 403);
      assert.equal((response.body as ErrorBody).error.code, 'PERMISSION_DENIED');
    }
  });
});

describe('CR-HM-BE-02 RUN 3 — designation lifecycle over HTTP', () => {
  it('creates a designation and exposes it through the list and detail reads', async (t) => {
    if (!ready(t)) return;
    const ctx = await createHandymanContext();

    const created = await api()
      .post(`/api/v1/clients/${ctx.client.id}/handyman-providers`)
      .set(authHeaders())
      .send({ vendorId: ctx.vendorIds[0] });
    assert.equal(created.status, 201);
    assert.equal(created.body.success, true);
    const designation = created.body.data;
    assert.equal(typeof designation.id, 'string');
    assert.equal(designation.clientId, ctx.client.id);
    assert.equal(designation.vendorId, ctx.vendorIds[0]);
    assert.equal(designation.status, 'ACTIVE');
    assert.equal(designation.createdByUserId, adminUserId);
    assert.ok(!Number.isNaN(Date.parse(designation.createdAt)));
    assert.ok(!Number.isNaN(Date.parse(designation.updatedAt)));

    const list = await api()
      .get(`/api/v1/clients/${ctx.client.id}/handyman-providers`)
      .set(authHeaders());
    assert.equal(list.status, 200);
    assert.equal(list.body.success, true);
    assert.deepEqual(
      (list.body.data as { id: string }[]).map((row) => row.id),
      [designation.id],
    );

    const detail = await api()
      .get(`/api/v1/handyman-providers/${designation.id}`)
      .set(authHeaders());
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.id, designation.id);
    assert.equal(detail.body.data.status, 'ACTIVE');
  });

  it('rejects a duplicate designation with 409', async (t) => {
    if (!ready(t)) return;
    const ctx = await createHandymanContext();
    await designateByHttp(ctx, 0);

    const duplicate = await api()
      .post(`/api/v1/clients/${ctx.client.id}/handyman-providers`)
      .set(authHeaders())
      .send({ vendorId: ctx.vendorIds[0] });
    assert.equal(duplicate.status, 409);
    assert.equal(
      (duplicate.body as ErrorBody).error.code,
      'HANDYMAN_PROVIDER_ALREADY_DESIGNATED',
    );
  });

  it('rejects a vendor of another client with 400', async (t) => {
    if (!ready(t)) return;
    const owner = await createHandymanContext();
    const other = await createHandymanContext();

    const mismatch = await api()
      .post(`/api/v1/clients/${owner.client.id}/handyman-providers`)
      .set(authHeaders())
      .send({ vendorId: other.vendorIds[0] });
    assert.equal(mismatch.status, 400);
    assert.equal(
      (mismatch.body as ErrorBody).error.code,
      'HANDYMAN_PROVIDER_VENDOR_CLIENT_MISMATCH',
    );
  });

  it('rejects designation when the client lacks an effective HANDYMAN entitlement', async (t) => {
    if (!ready(t)) return;
    const ctx = await createHandymanContext({ entitled: false });

    const denied = await api()
      .post(`/api/v1/clients/${ctx.client.id}/handyman-providers`)
      .set(authHeaders())
      .send({ vendorId: ctx.vendorIds[0] });
    assert.equal(denied.status, 403);
    assert.equal(
      (denied.body as ErrorBody).error.code,
      'HANDYMAN_PROVIDER_MODULE_NOT_ENTITLED',
    );
  });

  it('deactivates and reactivates through PATCH and governs invalid transitions', async (t) => {
    if (!ready(t)) return;
    const ctx = await createHandymanContext();
    const designation = await designateByHttp(ctx, 0);

    const deactivated = await api()
      .patch(`/api/v1/handyman-providers/${designation.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');
    assert.equal(deactivated.body.data.id, designation.id);

    const reactivated = await api()
      .patch(`/api/v1/handyman-providers/${designation.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');

    const noop = await api()
      .patch(`/api/v1/handyman-providers/${designation.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(noop.status, 400);
    assert.equal(
      (noop.body as ErrorBody).error.code,
      'HANDYMAN_PROVIDER_STATUS_INVALID',
    );

    const invalidEnum = await api()
      .patch(`/api/v1/handyman-providers/${designation.id}`)
      .set(authHeaders())
      .send({ status: 'WITHDRAWN' });
    assert.equal(invalidEnum.status, 400);
    assert.equal((invalidEnum.body as ErrorBody).error.code, 'VALIDATION_ERROR');

    const unknownId = randomUUID();
    const missingDetail = await api()
      .get(`/api/v1/handyman-providers/${unknownId}`)
      .set(authHeaders());
    assert.equal(missingDetail.status, 404);
    assert.equal(
      (missingDetail.body as ErrorBody).error.code,
      'HANDYMAN_PROVIDER_NOT_FOUND',
    );

    const missingPatch = await api()
      .patch(`/api/v1/handyman-providers/${unknownId}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(missingPatch.status, 404);
    assert.equal(
      (missingPatch.body as ErrorBody).error.code,
      'HANDYMAN_PROVIDER_NOT_FOUND',
    );
  });

  it('keeps deactivated designations readable in the client history list', async (t) => {
    if (!ready(t)) return;
    const ctx = await createHandymanContext();
    const designation = await designateByHttp(ctx, 0);
    await api()
      .patch(`/api/v1/handyman-providers/${designation.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const list = await api()
      .get(`/api/v1/clients/${ctx.client.id}/handyman-providers`)
      .set(authHeaders());
    assert.equal(list.status, 200);
    const rows = list.body.data as { id: string; status: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, designation.id);
    assert.equal(rows[0].status, 'INACTIVE');
  });

  it('strictly rejects protected and unknown write fields', async (t) => {
    if (!ready(t)) return;
    const ctx = await createHandymanContext();

    const protectedCreate = await api()
      .post(`/api/v1/clients/${ctx.client.id}/handyman-providers`)
      .set(authHeaders())
      .send({
        vendorId: ctx.vendorIds[0],
        clientId: randomUUID(),
        createdByUserId: randomUUID(),
        status: 'INACTIVE',
        nickname: 'not-a-field',
      });
    assert.equal(protectedCreate.status, 400);
    assert.equal((protectedCreate.body as ErrorBody).error.code, 'VALIDATION_ERROR');
    const createFields = detailFields(protectedCreate.body as ErrorBody);
    for (const field of ['clientId', 'createdByUserId', 'status', 'nickname']) {
      assert.ok(createFields.includes(field), `expected detail for ${field}`);
    }

    const missingVendor = await api()
      .post(`/api/v1/clients/${ctx.client.id}/handyman-providers`)
      .set(authHeaders())
      .send({});
    assert.equal(missingVendor.status, 400);
    assert.equal((missingVendor.body as ErrorBody).error.code, 'VALIDATION_ERROR');
    assert.ok(detailFields(missingVendor.body as ErrorBody).includes('vendorId'));

    const designation = await designateByHttp(ctx, 0);
    const protectedPatch = await api()
      .patch(`/api/v1/handyman-providers/${designation.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE', vendorId: ctx.vendorIds[1], surprise: 1 });
    assert.equal(protectedPatch.status, 400);
    assert.equal((protectedPatch.body as ErrorBody).error.code, 'VALIDATION_ERROR');
    const patchFields = detailFields(protectedPatch.body as ErrorBody);
    assert.ok(patchFields.includes('vendorId'));
    assert.ok(patchFields.includes('surprise'));

    // The rejected PATCH must not have mutated the designation.
    const unchanged = await api()
      .get(`/api/v1/handyman-providers/${designation.id}`)
      .set(authHeaders());
    assert.equal(unchanged.body.data.status, 'ACTIVE');
  });
});

describe('CR-HM-BE-02 RUN 3 — client access enforcement', () => {
  it('denies an outsider with handyman permissions but no client access', async (t) => {
    if (!ready(t)) return;
    const ctx = await createHandymanContext();
    const designation = await designateByHttp(ctx, 0);
    const outsiderToken = await createSessionWithPermissions([
      PROVIDER_READ,
      PROVIDER_MANAGE,
    ]);

    const deniedCreate = await api()
      .post(`/api/v1/clients/${ctx.client.id}/handyman-providers`)
      .set(authHeaders(outsiderToken))
      .send({ vendorId: ctx.vendorIds[1] });
    assert.equal(deniedCreate.status, 403);
    assert.equal(
      (deniedCreate.body as ErrorBody).error.code,
      'BUILDING_ACCESS_DENIED',
    );

    const deniedList = await api()
      .get(`/api/v1/clients/${ctx.client.id}/handyman-providers`)
      .set(authHeaders(outsiderToken));
    assert.equal(deniedList.status, 403);
    assert.equal(
      (deniedList.body as ErrorBody).error.code,
      'BUILDING_ACCESS_DENIED',
    );

    const deniedDetail = await api()
      .get(`/api/v1/handyman-providers/${designation.id}`)
      .set(authHeaders(outsiderToken));
    assert.equal(deniedDetail.status, 403);
    assert.equal(
      (deniedDetail.body as ErrorBody).error.code,
      'BUILDING_ACCESS_DENIED',
    );

    const deniedPatch = await api()
      .patch(`/api/v1/handyman-providers/${designation.id}`)
      .set(authHeaders(outsiderToken))
      .send({ status: 'INACTIVE' });
    assert.equal(deniedPatch.status, 403);
    assert.equal(
      (deniedPatch.body as ErrorBody).error.code,
      'BUILDING_ACCESS_DENIED',
    );
  });
});

describe('CR-HM-BE-02 RUN 3 — building authorized-provider reads', () => {
  it('lists providers authorized for an enabled building', async (t) => {
    if (!ready(t)) return;
    const ctx = await createEnabledBuildingContext();
    const designation = await designateByHttp(ctx, 0);
    const relationship = await relate(ctx.vendorIds[0], ctx.buildingIds[0]);

    const response = await api()
      .get(`/api/v1/buildings/${ctx.buildingIds[0]}/handyman-providers`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    const rows = response.body.data as Record<string, string>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].providerId, designation.id);
    assert.equal(rows[0].buildingId, ctx.buildingIds[0]);
    assert.equal(rows[0].clientId, ctx.client.id);
    assert.equal(rows[0].vendorId, ctx.vendorIds[0]);
    assert.equal(rows[0].vendorCode, ctx.vendorCodes[0]);
    assert.equal(rows[0].vendorName, 'Handyman Vendor 1');
    assert.equal(rows[0].relationshipId, relationship.id);
  });

  it('fails closed with an empty list for a disabled building', async (t) => {
    if (!ready(t)) return;
    const ctx = await createHandymanContext(); // entitled, unconfigured
    await designateByHttp(ctx, 0);
    await relate(ctx.vendorIds[0], ctx.buildingIds[0]);

    const unconfigured = await api()
      .get(`/api/v1/buildings/${ctx.buildingIds[0]}/handyman-providers`)
      .set(authHeaders());
    assert.equal(unconfigured.status, 200);
    assert.deepEqual(unconfigured.body.data, []);

    await configureHandyman('BUILDING', ctx.buildingIds[0], false);
    const disabled = await api()
      .get(`/api/v1/buildings/${ctx.buildingIds[0]}/handyman-providers`)
      .set(authHeaders());
    assert.equal(disabled.status, 200);
    assert.deepEqual(disabled.body.data, []);
  });

  it('denies an inaccessible building without leaking existence', async (t) => {
    if (!ready(t)) return;
    const ctx = await createEnabledBuildingContext();
    const outsiderToken = await createSessionWithPermissions([PROVIDER_READ]);

    const denied = await api()
      .get(`/api/v1/buildings/${ctx.buildingIds[0]}/handyman-providers`)
      .set(authHeaders(outsiderToken));
    assert.equal(denied.status, 403);
    assert.equal((denied.body as ErrorBody).error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('CR-HM-BE-02 RUN 3 — service-eligibility reads', () => {
  it('lists vendor-wide eligible services for an authorized provider', async (t) => {
    if (!ready(t)) return;
    const ctx = await createEnabledBuildingContext();
    const designation = await designateByHttp(ctx, 0);
    await relate(ctx.vendorIds[0], ctx.buildingIds[0]);
    const service = await createService(ctx.client.id);
    const capability = await createCapability(ctx.vendorIds[0], {
      serviceCatalogId: service.id,
    });

    const response = await api()
      .get(
        `/api/v1/buildings/${ctx.buildingIds[0]}/handyman-providers/${designation.id}/service-eligibilities`,
      )
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    const rows = response.body.data as Record<string, string>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].providerId, designation.id);
    assert.equal(rows[0].buildingId, ctx.buildingIds[0]);
    assert.equal(rows[0].vendorId, ctx.vendorIds[0]);
    assert.equal(rows[0].capabilityId, capability.id);
    assert.equal(rows[0].capabilityScope, 'VENDOR_WIDE');
    assert.equal(rows[0].serviceCatalogId, service.id);
    assert.equal(rows[0].serviceCode, service.code);
    assert.equal(rows[0].serviceName, service.name);
  });

  it('honors building-scoped capabilities per building', async (t) => {
    if (!ready(t)) return;
    const ctx = await createEnabledBuildingContext();
    const designation = await designateByHttp(ctx, 0);
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

    const building0 = await api()
      .get(
        `/api/v1/buildings/${ctx.buildingIds[0]}/handyman-providers/${designation.id}/service-eligibilities`,
      )
      .set(authHeaders());
    assert.equal(building0.status, 200);
    const rows0 = building0.body.data as Record<string, string>[];
    assert.equal(rows0.length, 2);
    const scoped = rows0.find((row) => row.serviceCatalogId === scopedService.id);
    assert.equal(scoped?.capabilityScope, 'BUILDING_SCOPED');
    const wide = rows0.find((row) => row.serviceCatalogId === wideService.id);
    assert.equal(wide?.capabilityScope, 'VENDOR_WIDE');

    const building1 = await api()
      .get(
        `/api/v1/buildings/${ctx.buildingIds[1]}/handyman-providers/${designation.id}/service-eligibilities`,
      )
      .set(authHeaders());
    assert.equal(building1.status, 200);
    assert.deepEqual(
      (building1.body.data as Record<string, string>[]).map((row) => row.serviceCatalogId),
      [wideService.id],
    );
  });

  it('returns 404 for a provider not authorized at the building', async (t) => {
    if (!ready(t)) return;
    const ctx = await createEnabledBuildingContext();
    const designation = await designateByHttp(ctx, 0); // no relationship

    const unauthorized = await api()
      .get(
        `/api/v1/buildings/${ctx.buildingIds[0]}/handyman-providers/${designation.id}/service-eligibilities`,
      )
      .set(authHeaders());
    assert.equal(unauthorized.status, 404);
    assert.equal(
      (unauthorized.body as ErrorBody).error.code,
      'HANDYMAN_PROVIDER_NOT_FOUND',
    );

    const unknownProvider = await api()
      .get(
        `/api/v1/buildings/${ctx.buildingIds[0]}/handyman-providers/${randomUUID()}/service-eligibilities`,
      )
      .set(authHeaders());
    assert.equal(unknownProvider.status, 404);
    assert.equal(
      (unknownProvider.body as ErrorBody).error.code,
      'HANDYMAN_PROVIDER_NOT_FOUND',
    );
  });

  it('excludes non-HANDYMAN categories and deactivated catalog entries', async (t) => {
    if (!ready(t)) return;
    const ctx = await createEnabledBuildingContext();
    const designation = await designateByHttp(ctx, 0);
    await relate(ctx.vendorIds[0], ctx.buildingIds[0]);

    const kept = await createService(ctx.client.id);
    await createCapability(ctx.vendorIds[0], { serviceCatalogId: kept.id });

    const deactivated = await createService(ctx.client.id);
    await createCapability(ctx.vendorIds[0], { serviceCatalogId: deactivated.id });
    await serviceCatalogService.deactivateServiceCatalogEntry(
      deactivated.id,
      adminUserId,
    );

    const otherCategory = await createService(ctx.client.id, 'MEP');
    await createCapability(ctx.vendorIds[0], { serviceCatalogId: otherCategory.id });

    const response = await api()
      .get(
        `/api/v1/buildings/${ctx.buildingIds[0]}/handyman-providers/${designation.id}/service-eligibilities`,
      )
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.deepEqual(
      (response.body.data as Record<string, string>[]).map((row) => row.serviceCatalogId),
      [kept.id],
    );
  });

  it('denies eligibility reads for an inaccessible building', async (t) => {
    if (!ready(t)) return;
    const ctx = await createEnabledBuildingContext();
    const designation = await designateByHttp(ctx, 0);
    const outsiderToken = await createSessionWithPermissions([PROVIDER_READ]);

    const denied = await api()
      .get(
        `/api/v1/buildings/${ctx.buildingIds[0]}/handyman-providers/${designation.id}/service-eligibilities`,
      )
      .set(authHeaders(outsiderToken));
    assert.equal(denied.status, 403);
    assert.equal((denied.body as ErrorBody).error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('CR-HM-BE-02 RUN 3 — runtime/OpenAPI parity', () => {
  it('documents exactly the six provider endpoints with matching RBAC and schemas', () => {
    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as {
      paths: Record<string, Record<string, { 'x-required-permission'?: string; tags?: string[] }>>;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const routesSource = readFileSync(
      resolve(__dirname, '../src/modules/handyman-providers/handyman-provider.routes.ts'),
      'utf8',
    );

    const providerPaths = Object.keys(spec.paths).filter((p) =>
      p.includes('handyman-provider'),
    );
    assert.deepEqual(
      providerPaths.sort(),
      [
        '/clients/{clientId}/handyman-providers',
        '/handyman-providers/{providerId}',
        '/buildings/{buildingId}/handyman-providers',
        '/buildings/{buildingId}/handyman-providers/{providerId}/service-eligibilities',
      ].sort(),
    );

    const expected: Record<string, Record<string, string>> = {
      '/clients/{clientId}/handyman-providers': {
        post: 'handyman_provider.manage',
        get: 'handyman_provider.read',
      },
      '/handyman-providers/{providerId}': {
        get: 'handyman_provider.read',
        patch: 'handyman_provider.manage',
      },
      '/buildings/{buildingId}/handyman-providers': {
        get: 'handyman_provider.read',
      },
      '/buildings/{buildingId}/handyman-providers/{providerId}/service-eligibilities': {
        get: 'handyman_provider.read',
      },
    };

    for (const [path, operations] of Object.entries(expected)) {
      const item = spec.paths[path];
      assert.ok(item, `path ${path} must be documented`);
      const documentedOps = Object.keys(item).filter((method) =>
        ['get', 'post', 'put', 'patch', 'delete'].includes(method),
      );
      assert.deepEqual(
        documentedOps.sort(),
        Object.keys(operations).sort(),
        `${path} must document exactly the runtime operations`,
      );
      for (const [method, permission] of Object.entries(operations)) {
        assert.equal(
          item[method]['x-required-permission'],
          permission,
          `${method.toUpperCase()} ${path} permission`,
        );
        assert.ok(
          (item[method].tags ?? []).includes('Handyman Providers'),
          `${method.toUpperCase()} ${path} must carry the Handyman Providers tag`,
        );
      }
    }

    // Runtime route source must wire the same permissions and paths.
    assert.match(routesSource, /requirePermission\('handyman_provider\.manage'\)/);
    assert.match(routesSource, /requirePermission\('handyman_provider\.read'\)/);
    for (const route of [
      "'/clients/:clientId/handyman-providers'",
      "'/handyman-providers/:providerId'",
      "'/buildings/:buildingId/handyman-providers'",
      "'/buildings/:buildingId/handyman-providers/:providerId/service-eligibilities'",
    ]) {
      assert.ok(routesSource.includes(route), `runtime route ${route} must exist`);
    }

    // Documented schemas exist and expose no internal fields: the write
    // bodies are exactly the allowlists, and the read models carry no
    // entitlement/configuration/pricing internals.
    const schemas = spec.components.schemas;
    for (const name of [
      'HandymanProvider',
      'CreateHandymanProvider',
      'UpdateHandymanProviderStatus',
      'AuthorizedHandymanProvider',
      'HandymanProviderServiceEligibility',
    ]) {
      assert.ok(schemas[name], `schema ${name} must be documented`);
    }
    assert.deepEqual(Object.keys(schemas.CreateHandymanProvider.properties ?? {}).sort(), ['vendorId']);
    assert.deepEqual(Object.keys(schemas.UpdateHandymanProviderStatus.properties ?? {}).sort(), ['status']);
    assert.deepEqual(Object.keys(schemas.HandymanProvider.properties ?? {}).sort(), [
      'clientId',
      'createdAt',
      'createdByUserId',
      'id',
      'status',
      'updatedAt',
      'vendorId',
    ]);
    assert.deepEqual(Object.keys(schemas.AuthorizedHandymanProvider.properties ?? {}).sort(), [
      'buildingId',
      'clientId',
      'providerId',
      'relationshipId',
      'vendorCode',
      'vendorId',
      'vendorName',
    ]);
    assert.deepEqual(
      Object.keys(schemas.HandymanProviderServiceEligibility.properties ?? {}).sort(),
      [
        'buildingId',
        'capabilityId',
        'capabilityScope',
        'providerId',
        'serviceCatalogId',
        'serviceCode',
        'serviceName',
        'vendorId',
      ],
    );
  });
});
