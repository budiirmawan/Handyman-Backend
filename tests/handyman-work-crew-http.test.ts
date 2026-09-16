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
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { entitlementService } from '../src/modules/entitlements';
import {
  HANDYMAN_MODULE_CODE,
  designateHandymanProvider,
} from '../src/modules/handyman-providers';
import { licenseService } from '../src/modules/licenses';
import { moduleRepository, moduleService } from '../src/modules/modules';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { subscriptionService } from '../src/modules/subscriptions';
import { vendorService } from '../src/modules/vendors';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { workforceService } from '../src/modules/workforce';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-04 RUN 2 — focused HTTP/OpenAPI contract tests for the ten
 * Handyman Work Crew endpoints: auth on every route, the read/manage
 * permission separation, strict body/query allowlists (server-derived
 * authority can never be caller-authoritative), the founding-lead creation,
 * login-free Helper seating, duplicate/second-lead rejection over the wire,
 * guarded member removal, the atomic lead change, the freeze/reactivate
 * lifecycle, provider-mismatch and client-access enforcement, the absence of
 * any DELETE / assignment / dispatch surface, and exact runtime↔OpenAPI
 * parity. Business-rule depth lives in the Run-1 service suite
 * (tests/handyman-work-crew.test.ts); here each seam is re-asserted ONCE
 * through the wire to prove thin controller delegation.
 */

const PORT = 55500;
const DIR = '/tmp/asentra-hm04-run2-pg';
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

type ErrorBody = {
  error: { code: string; message?: string; details?: { field: string }[] };
};

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

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
  await pool.query(
    'TRUNCATE handyman_job_assignments, handyman_jobs, handyman_work_crew_members, handyman_work_crews, handyman_providers',
  );
  const admin = await createAdminUser();
  adminToken = admin.token;
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

function detailFields(body: ErrorBody): string[] {
  return (body.error.details ?? []).map((detail) => detail.field);
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

/** Client + Property + Building + Vendor + BE-02C HANDYMAN commercial stack. */
async function createClientContext(assignUserIds: string[] = [adminUserId]) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Crew HTTP Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Crew HTTP Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Crew HTTP Tower',
  });
  for (const userId of assignUserIds) {
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: building.id,
    });
  }
  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Crew HTTP Vendor',
  });
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
  await entitlementService.createEntitlement(subscription.id, {
    moduleId: await ensureHandymanModule(),
    startsAt,
    endsAt,
  });
  return { client, property, building, vendor };
}

type ClientContext = Awaited<ReturnType<typeof createClientContext>>;

async function createOrgChain(clientId: string) {
  const organization = await organizationService.createOrganization({
    clientId,
    code: `ORG_${suffix()}`,
    name: 'Crew HTTP Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Crew HTTP Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Crew HTTP Position',
  });
  return { organization, department, position };
}

type OrgChain = Awaited<ReturnType<typeof createOrgChain>>;

/** EXTERNAL worker of the vendor via the existing personnel authority (NO login). */
async function createWorker(
  ctx: ClientContext,
  chain: OrgChain,
  vendorId: string,
  role: string,
) {
  const profile = await workforceService.createWorkforceProfile({
    organizationId: chain.organization.id,
    departmentId: chain.department.id,
    positionId: chain.position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: `Zqxf ${role} ${suffix()}`,
    workforceType: 'EXTERNAL',
  });
  const binding = await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VPC-${role}-${suffix()}`,
  });
  return { profile, binding };
}

type CrewPublic = {
  id: string;
  clientId: string;
  handymanProviderId: string;
  crewCode: string;
  crewName: string;
  status: string;
  createdByUserId: string;
};
type MemberPublic = {
  id: string;
  crewId: string;
  vendorWorkforceBindingId: string;
  crewRole: string;
  status: string;
  removedAt: string | null;
  removedByUserId: string | null;
  effectiveTo: string | null;
};

/** Full wire fixture: provider designation + org chain + lead + ACTIVE crew. */
async function createCrewFixture() {
  const ctx = await createClientContext();
  const provider = await designateHandymanProvider(
    { clientId: ctx.client.id, vendorId: ctx.vendor.id },
    adminUserId,
  );
  const chain = await createOrgChain(ctx.client.id);
  const lead = await createWorker(ctx, chain, ctx.vendor.id, 'HttpLead');

  const response = await api()
    .post('/api/v1/handyman-work-crews')
    .set(auth())
    .send({
      handymanProviderId: provider.id,
      crewCode: `CREW_${suffix()}`,
      crewName: 'HTTP Fixture Crew',
      leadWorkerBindingId: lead.binding.id,
    });
  assert.equal(response.status, 201);
  const data = response.body.data as { crew: CrewPublic; leadMember: MemberPublic };
  return { ctx, provider, chain, lead, crew: data.crew, leadMember: data.leadMember };
}

type CrewFixture = Awaited<ReturnType<typeof createCrewFixture>>;

const CREW_ROUTES = {
  create: '/api/v1/handyman-work-crews',
  list: '/api/v1/handyman-work-crews',
  byId: (id: string) => `/api/v1/handyman-work-crews/${id}`,
  deactivate: (id: string) => `/api/v1/handyman-work-crews/${id}/deactivate`,
  activate: (id: string) => `/api/v1/handyman-work-crews/${id}/activate`,
  members: (id: string) => `/api/v1/handyman-work-crews/${id}/members`,
  removeMember: (id: string, memberId: string) =>
    `/api/v1/handyman-work-crews/${id}/members/${memberId}/remove`,
  changeLead: (id: string) => `/api/v1/handyman-work-crews/${id}/lead-worker/change`,
};

describe('CR-HM-BE-04 RUN 2 — authentication and RBAC', () => {
  it('requires authentication on every crew route', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewFixture();
    const memberList = await api()
      .get(CREW_ROUTES.members(base.crew.id))
      .set(auth());
    const leadMemberId = (memberList.body.data as MemberPublic[])[0].id;

    const unauthenticated: Promise<unknown>[] = [
      api().post(CREW_ROUTES.create).send({}),
      api().get(`${CREW_ROUTES.list}?clientId=${base.ctx.client.id}`),
      api().get(CREW_ROUTES.byId(base.crew.id)),
      api().patch(CREW_ROUTES.byId(base.crew.id)).send({ crewName: 'X' }),
      api().post(CREW_ROUTES.deactivate(base.crew.id)).send({}),
      api().post(CREW_ROUTES.activate(base.crew.id)).send({}),
      api().post(CREW_ROUTES.members(base.crew.id)).send({}),
      api().get(CREW_ROUTES.members(base.crew.id)),
      api().post(CREW_ROUTES.removeMember(base.crew.id, leadMemberId)).send({}),
      api().post(CREW_ROUTES.changeLead(base.crew.id)).send({}),
    ];
    const responses = await Promise.all(unauthenticated);
    for (const response of responses) {
      assert.equal(response.status, 401);
      assert.equal((response.body as ErrorBody).error.code, 'AUTHENTICATION_REQUIRED');
    }
  });

  it('separates handyman_work_crew.read from handyman_work_crew.manage', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewFixture();
    const helper = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, 'RbacHelper');

    const readToken = await createSessionWithPermissions([
      { code: 'handyman_work_crew.read', name: 'Read Handyman Work Crews' },
    ]);
    const manageToken = await createSessionWithPermissions([
      { code: 'handyman_work_crew.manage', name: 'Manage Handyman Work Crews' },
    ]);
    const plainToken = await createPlainSession();

    // READ-only: every mutation is denied at RBAC (before any service access).
    const readDenied = await Promise.all([
      api()
        .post(CREW_ROUTES.create)
        .set(auth(readToken))
        .send({
          handymanProviderId: base.provider.id,
          crewCode: `CREW_${suffix()}`,
          crewName: 'Denied',
          leadWorkerBindingId: helper.binding.id,
        }),
      api().patch(CREW_ROUTES.byId(base.crew.id)).set(auth(readToken)).send({ crewName: 'Denied' }),
      api().post(CREW_ROUTES.deactivate(base.crew.id)).set(auth(readToken)).send({}),
      api().post(CREW_ROUTES.activate(base.crew.id)).set(auth(readToken)).send({}),
      api()
        .post(CREW_ROUTES.members(base.crew.id))
        .set(auth(readToken))
        .send({ vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER' }),
      api().post(CREW_ROUTES.removeMember(base.crew.id, base.leadMember.id)).set(auth(readToken)).send({}),
      api()
        .post(CREW_ROUTES.changeLead(base.crew.id))
        .set(auth(readToken))
        .send({ newLeadWorkerBindingId: helper.binding.id }),
    ]);
    for (const response of readDenied) {
      assert.equal(response.status, 403);
      assert.equal((response.body as ErrorBody).error.code, 'PERMISSION_DENIED');
    }

    // MANAGE-only: reads are denied (the separation cuts both ways).
    const manageDenied = await Promise.all([
      api().get(`${CREW_ROUTES.list}?clientId=${base.ctx.client.id}`).set(auth(manageToken)),
      api().get(CREW_ROUTES.byId(base.crew.id)).set(auth(manageToken)),
      api().get(CREW_ROUTES.members(base.crew.id)).set(auth(manageToken)),
    ]);
    for (const response of manageDenied) {
      assert.equal(response.status, 403);
      assert.equal((response.body as ErrorBody).error.code, 'PERMISSION_DENIED');
    }

    // PLAIN authenticated session: denied everywhere (no crew permissions).
    const plainDenied = await Promise.all([
      api().get(`${CREW_ROUTES.list}?clientId=${base.ctx.client.id}`).set(auth(plainToken)),
      api().get(CREW_ROUTES.byId(base.crew.id)).set(auth(plainToken)),
      api().post(CREW_ROUTES.create).set(auth(plainToken)).send({
        handymanProviderId: base.provider.id,
        crewCode: `CREW_${suffix()}`,
        crewName: 'Denied',
        leadWorkerBindingId: helper.binding.id,
      }),
    ]);
    for (const response of plainDenied) {
      assert.equal(response.status, 403);
      assert.equal((response.body as ErrorBody).error.code, 'PERMISSION_DENIED');
    }

    // The admin session holds both codes: read and manage both succeed.
    assert.equal((await api().get(CREW_ROUTES.byId(base.crew.id)).set(auth())).status, 200);
    const manageOk = await api()
      .post(CREW_ROUTES.members(base.crew.id))
      .set(auth())
      .send({ vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER' });
    assert.equal(manageOk.status, 201);
  });
});

describe('CR-HM-BE-04 RUN 2 — crew CRUD over the wire', () => {
  it('creates a crew with its founding lead; clientId is server-derived', async (t) => {
    if (!ready(t)) return;

    const ctx = await createClientContext();
    const provider = await designateHandymanProvider(
      { clientId: ctx.client.id, vendorId: ctx.vendor.id },
      adminUserId,
    );
    const chain = await createOrgChain(ctx.client.id);
    const lead = await createWorker(ctx, chain, ctx.vendor.id, 'FoundingLead');

    const response = await api()
      .post(CREW_ROUTES.create)
      .set(auth())
      .send({
        handymanProviderId: provider.id,
        crewCode: `  crew_wire_${suffix().toLowerCase()}  `,
        crewName: 'Wire Crew',
        leadWorkerBindingId: lead.binding.id,
      });
    assert.equal(response.status, 201);
    const data = response.body.data as { crew: CrewPublic; leadMember: MemberPublic };
    assert.equal(data.crew.status, 'ACTIVE');
    // clientId was NOT sent and is derived from the designation server-side.
    assert.equal(data.crew.clientId, ctx.client.id);
    assert.equal(data.crew.handymanProviderId, provider.id);
    assert.equal(data.crew.createdByUserId, adminUserId);
    assert.match(data.crew.crewCode, /^CREW_WIRE_/); // normalized at the service
    assert.equal(data.leadMember.crewRole, 'LEAD_WORKER');
    assert.equal(data.leadMember.status, 'ACTIVE');
    assert.equal(data.leadMember.vendorWorkforceBindingId, lead.binding.id);

    // Missing founding lead is rejected by the allowlist (required field).
    const noLead = await api()
      .post(CREW_ROUTES.create)
      .set(auth())
      .send({
        handymanProviderId: provider.id,
        crewCode: `CREW_${suffix()}`,
        crewName: 'No Lead',
      });
    assert.equal(noLead.status, 400);
    assert.equal((noLead.body as ErrorBody).error.code, 'VALIDATION_ERROR');
    assert.ok(detailFields(noLead.body as ErrorBody).includes('leadWorkerBindingId'));
  });

  it('rejects server-authoritative field smuggling on every mutating body', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewFixture();
    const helper = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, 'SmuggleHelper');
    const otherCtx = await createClientContext();

    // CREATE: clientId / status / createdByUserId / requestId / workOrderId /
    // buildingId / vendorId / members are never accepted.
    for (const smuggled of [
      { clientId: otherCtx.client.id },
      { status: 'INACTIVE' },
      { createdByUserId: adminUserId },
      { requestId: randomUUID() },
      { workOrderId: randomUUID() },
      { buildingId: base.ctx.building.id },
      { vendorId: base.ctx.vendor.id },
      { members: [] },
      { totallyUnknown: true },
    ]) {
      const response = await api()
        .post(CREW_ROUTES.create)
        .set(auth())
        .send({
          handymanProviderId: base.provider.id,
          crewCode: `CREW_${suffix()}`,
          crewName: 'Smuggle Crew',
          leadWorkerBindingId: base.lead.binding.id,
          ...smuggled,
        });
      assert.equal(response.status, 400, `smuggled ${JSON.stringify(smuggled)}`);
      assert.equal((response.body as ErrorBody).error.code, 'VALIDATION_ERROR');
      assert.ok(detailFields(response.body as ErrorBody).includes(Object.keys(smuggled)[0]));
    }

    // PATCH: only crewName — crewCode / status / provider / lead identity rejected.
    for (const smuggled of [
      { crewName: 'Ok', crewCode: 'HACKED' },
      { crewName: 'Ok', status: 'INACTIVE' },
      { crewName: 'Ok', handymanProviderId: randomUUID() },
      { crewName: 'Ok', clientId: otherCtx.client.id },
      { crewName: 'Ok', leadWorkerBindingId: helper.binding.id },
      { crewName: 'Ok', updatedByUserId: adminUserId },
    ]) {
      const response = await api()
        .patch(CREW_ROUTES.byId(base.crew.id))
        .set(auth())
        .send(smuggled);
      assert.equal(response.status, 400, `smuggled ${JSON.stringify(smuggled)}`);
      assert.equal((response.body as ErrorBody).error.code, 'VALIDATION_ERROR');
    }

    // MEMBER ADD: userId / status / effective window / crewId rejected.
    for (const smuggled of [
      { vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER', userId: randomUUID() },
      { vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER', status: 'INACTIVE' },
      { vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER', crewId: base.crew.id },
      { vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER', effectiveFrom: '2026-01-01T00:00:00.000Z' },
      { vendorWorkforceBindingId: helper.binding.id, crewRole: 'OVERLORD' },
    ]) {
      const response = await api()
        .post(CREW_ROUTES.members(base.crew.id))
        .set(auth())
        .send(smuggled);
      assert.equal(response.status, 400, `smuggled ${JSON.stringify(smuggled)}`);
      assert.equal((response.body as ErrorBody).error.code, 'VALIDATION_ERROR');
    }

    // LEAD CHANGE: only newLeadWorkerBindingId — old-lead derivation inputs,
    // role, status and identity fields rejected.
    for (const smuggled of [
      { newLeadWorkerBindingId: helper.binding.id, oldLeadMemberId: base.leadMember.id },
      { newLeadWorkerBindingId: helper.binding.id, previousMemberId: base.leadMember.id },
      { newLeadWorkerBindingId: helper.binding.id, currentLeadMemberId: base.leadMember.id },
      { newLeadWorkerBindingId: helper.binding.id, crewRole: 'LEAD_WORKER' },
      { newLeadWorkerBindingId: helper.binding.id, status: 'ACTIVE' },
      { newLeadWorkerBindingId: helper.binding.id, clientId: base.ctx.client.id },
      { newLeadWorkerBindingId: helper.binding.id, handymanProviderId: base.provider.id },
    ]) {
      const response = await api()
        .post(CREW_ROUTES.changeLead(base.crew.id))
        .set(auth())
        .send(smuggled);
      assert.equal(response.status, 400, `smuggled ${JSON.stringify(smuggled)}`);
      assert.equal((response.body as ErrorBody).error.code, 'VALIDATION_ERROR');
    }

    // Bodyless commands accept NO body fields at all.
    for (const route of [
      CREW_ROUTES.deactivate(base.crew.id),
      CREW_ROUTES.activate(base.crew.id),
      CREW_ROUTES.removeMember(base.crew.id, base.leadMember.id),
    ]) {
      const response = await api().post(route).set(auth()).send({ status: 'ACTIVE' });
      assert.equal(response.status, 400, `body smuggled on ${route}`);
      assert.equal((response.body as ErrorBody).error.code, 'VALIDATION_ERROR');
    }

    // LIST query allowlist: unknown parameters rejected; clientId required.
    const unknownQuery = await api()
      .get(`${CREW_ROUTES.list}?clientId=${base.ctx.client.id}&buildingId=${base.ctx.building.id}`)
      .set(auth());
    assert.equal(unknownQuery.status, 400);
    assert.equal((unknownQuery.body as ErrorBody).error.code, 'VALIDATION_ERROR');
    const missingClient = await api().get(CREW_ROUTES.list).set(auth());
    assert.equal(missingClient.status, 400);
    assert.ok(detailFields(missingClient.body as ErrorBody).includes('clientId'));
  });

  it('gets, lists (with filters), and renames a crew', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewFixture();

    const detail = await api().get(CREW_ROUTES.byId(base.crew.id)).set(auth());
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.id, base.crew.id);
    assert.equal(detail.body.data.crewName, base.crew.crewName);

    const list = await api()
      .get(`${CREW_ROUTES.list}?clientId=${base.ctx.client.id}`)
      .set(auth());
    assert.equal(list.status, 200);
    assert.deepEqual(
      (list.body.data as CrewPublic[]).map((row) => row.id),
      [base.crew.id],
    );
    const filteredActive = await api()
      .get(
        `${CREW_ROUTES.list}?clientId=${base.ctx.client.id}&status=ACTIVE&handymanProviderId=${base.provider.id}`,
      )
      .set(auth());
    assert.equal((filteredActive.body.data as CrewPublic[]).length, 1);
    const filteredInactive = await api()
      .get(`${CREW_ROUTES.list}?clientId=${base.ctx.client.id}&status=INACTIVE`)
      .set(auth());
    assert.equal((filteredInactive.body.data as CrewPublic[]).length, 0);

    const renamed = await api()
      .patch(CREW_ROUTES.byId(base.crew.id))
      .set(auth())
      .send({ crewName: 'Renamed Wire Crew' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data.crewName, 'Renamed Wire Crew');
    assert.equal(renamed.body.data.crewCode, base.crew.crewCode); // immutable
    assert.equal(renamed.body.data.updatedByUserId, adminUserId);

    const unknown = await api().get(CREW_ROUTES.byId(randomUUID())).set(auth());
    assert.equal(unknown.status, 404);
    assert.equal((unknown.body as ErrorBody).error.code, 'HANDYMAN_WORK_CREW_NOT_FOUND');
  });
});

describe('CR-HM-BE-04 RUN 2 — membership and lead governance over the wire', () => {
  it('seats a login-free Helper, blocks duplicates and second leads', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewFixture();
    const helper = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, 'WireHelper');

    // The helper's profile carries NO user account (login-free by design).
    if (!pool) return;
    const profileRow = await pool.query('SELECT user_id FROM workforce_profiles WHERE id = $1', [
      helper.profile.id,
    ]);
    assert.equal(profileRow.rows[0].user_id, null);

    const added = await api()
      .post(CREW_ROUTES.members(base.crew.id))
      .set(auth())
      .send({ vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER' });
    assert.equal(added.status, 201);
    assert.equal(added.body.data.crewRole, 'HELPER');
    assert.equal(added.body.data.status, 'ACTIVE');

    // Duplicate ACTIVE membership → 409.
    const duplicate = await api()
      .post(CREW_ROUTES.members(base.crew.id))
      .set(auth())
      .send({ vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER' });
    assert.equal(duplicate.status, 409);
    assert.equal(
      (duplicate.body as ErrorBody).error.code,
      'HANDYMAN_WORK_CREW_MEMBER_ALREADY_ACTIVE',
    );

    // Second ACTIVE lead → 409 (lead only changes via the atomic command).
    const secondLead = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, 'WireSecondLead');
    const leadAdd = await api()
      .post(CREW_ROUTES.members(base.crew.id))
      .set(auth())
      .send({ vendorWorkforceBindingId: secondLead.binding.id, crewRole: 'LEAD_WORKER' });
    assert.equal(leadAdd.status, 409);
    assert.equal(
      (leadAdd.body as ErrorBody).error.code,
      'HANDYMAN_WORK_CREW_LEAD_ALREADY_ACTIVE',
    );

    // Wrong-provider worker → 400 (service authority, not the edge).
    const otherVendor = await vendorService.createVendor({
      clientId: base.ctx.client.id,
      vendorCode: `V_${suffix()}`,
      vendorName: 'Other Wire Vendor',
    });
    const foreign = await createWorker(base.ctx, base.chain, otherVendor.id, 'WireForeign');
    const foreignAdd = await api()
      .post(CREW_ROUTES.members(base.crew.id))
      .set(auth())
      .send({ vendorWorkforceBindingId: foreign.binding.id, crewRole: 'HELPER' });
    assert.equal(foreignAdd.status, 400);
    assert.equal(
      (foreignAdd.body as ErrorBody).error.code,
      'HANDYMAN_WORK_CREW_WORKER_PROVIDER_MISMATCH',
    );

    const members = await api().get(CREW_ROUTES.members(base.crew.id)).set(auth());
    assert.equal(members.status, 200);
    assert.equal((members.body.data as MemberPublic[]).length, 2);
    const activeOnly = await api()
      .get(`${CREW_ROUTES.members(base.crew.id)}?status=ACTIVE`)
      .set(auth());
    assert.equal((activeOnly.body.data as MemberPublic[]).length, 2);
  });

  it('removes helpers, forbids direct lead removal, and changes leads atomically', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewFixture();
    const helper = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, 'WireRemovable');
    const successor = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, 'WireSuccessor');

    const added = await api()
      .post(CREW_ROUTES.members(base.crew.id))
      .set(auth())
      .send({ vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER' });
    const helperMember = added.body.data as MemberPublic;

    // Direct removal of the ACTIVE lead is forbidden.
    const leadRemoval = await api()
      .post(CREW_ROUTES.removeMember(base.crew.id, base.leadMember.id))
      .set(auth())
      .send({});
    assert.equal(leadRemoval.status, 409);
    assert.equal(
      (leadRemoval.body as ErrorBody).error.code,
      'HANDYMAN_WORK_CREW_LEAD_REMOVAL_FORBIDDEN',
    );

    // Helper removal closes the row with attribution — no DELETE verb exists.
    const removed = await api()
      .post(CREW_ROUTES.removeMember(base.crew.id, helperMember.id))
      .set(auth())
      .send({});
    assert.equal(removed.status, 200);
    assert.equal(removed.body.data.status, 'INACTIVE');
    assert.equal(removed.body.data.removedByUserId, adminUserId);
    assert.ok(removed.body.data.removedAt);
    assert.ok(removed.body.data.effectiveTo);

    // Second removal is refused (guarded closure).
    const removedAgain = await api()
      .post(CREW_ROUTES.removeMember(base.crew.id, helperMember.id))
      .set(auth())
      .send({});
    assert.equal(removedAgain.status, 400);
    assert.equal(
      (removedAgain.body as ErrorBody).error.code,
      'HANDYMAN_WORK_CREW_MEMBER_STATUS_INVALID',
    );

    // Atomic lead change: previous closed, new seated, exactly one ACTIVE lead.
    const changed = await api()
      .post(CREW_ROUTES.changeLead(base.crew.id))
      .set(auth())
      .send({ newLeadWorkerBindingId: successor.binding.id });
    assert.equal(changed.status, 200);
    const result = changed.body.data as { previousMember: MemberPublic; newMember: MemberPublic };
    assert.equal(result.previousMember.id, base.leadMember.id);
    assert.equal(result.previousMember.status, 'INACTIVE');
    assert.equal(result.previousMember.crewRole, 'LEAD_WORKER'); // identity untouched
    assert.equal(result.newMember.status, 'ACTIVE');
    assert.equal(result.newMember.crewRole, 'LEAD_WORKER');
    assert.equal(result.newMember.vendorWorkforceBindingId, successor.binding.id);

    const afterChange = await api()
      .get(`${CREW_ROUTES.members(base.crew.id)}?status=ACTIVE`)
      .set(auth());
    const activeLeads = (afterChange.body.data as MemberPublic[]).filter(
      (row) => row.crewRole === 'LEAD_WORKER',
    );
    assert.equal(activeLeads.length, 1);
    assert.equal(activeLeads[0].id, result.newMember.id);

    // History read includes the closed rows (immutable evidence).
    const history = await api()
      .get(`${CREW_ROUTES.members(base.crew.id)}?status=INACTIVE`)
      .set(auth());
    const inactiveIds = (history.body.data as MemberPublic[]).map((row) => row.id);
    assert.ok(inactiveIds.includes(helperMember.id));
    assert.ok(inactiveIds.includes(base.leadMember.id));

    // Unknown member addressing.
    const unknownMember = await api()
      .post(CREW_ROUTES.removeMember(base.crew.id, randomUUID()))
      .set(auth())
      .send({});
    assert.equal(unknownMember.status, 404);
    assert.equal(
      (unknownMember.body as ErrorBody).error.code,
      'HANDYMAN_WORK_CREW_MEMBER_NOT_FOUND',
    );
  });

  it('deactivates (freezes) and reactivates crews through the governed commands', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewFixture();
    const helper = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, 'WireFrozen');

    const deactivated = await api().post(CREW_ROUTES.deactivate(base.crew.id)).set(auth()).send({});
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // No-op transition refused.
    const again = await api().post(CREW_ROUTES.deactivate(base.crew.id)).set(auth()).send({});
    assert.equal(again.status, 400);
    assert.equal((again.body as ErrorBody).error.code, 'HANDYMAN_WORK_CREW_STATUS_INVALID');

    // Frozen crew refuses membership changes.
    const frozenAdd = await api()
      .post(CREW_ROUTES.members(base.crew.id))
      .set(auth())
      .send({ vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER' });
    assert.equal(frozenAdd.status, 400);
    assert.equal(
      (frozenAdd.body as ErrorBody).error.code,
      'HANDYMAN_WORK_CREW_STATUS_INVALID',
    );
    const frozenLead = await api()
      .post(CREW_ROUTES.changeLead(base.crew.id))
      .set(auth())
      .send({ newLeadWorkerBindingId: helper.binding.id });
    assert.equal(frozenLead.status, 400);
    assert.equal(
      (frozenLead.body as ErrorBody).error.code,
      'HANDYMAN_WORK_CREW_STATUS_INVALID',
    );

    const reactivated = await api().post(CREW_ROUTES.activate(base.crew.id)).set(auth()).send({});
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');

    const activeAgain = await api().post(CREW_ROUTES.activate(base.crew.id)).set(auth()).send({});
    assert.equal(activeAgain.status, 400);
    assert.equal(
      (activeAgain.body as ErrorBody).error.code,
      'HANDYMAN_WORK_CREW_STATUS_INVALID',
    );
  });

  it('enforces client data scope through the existing context-access authority', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewFixture();

    // Authenticated + permissioned, but NO building assignment for this
    // client: the SERVICE denies access (no existence leak beyond 403).
    const outsiderToken = await createSessionWithPermissions([
      { code: 'handyman_work_crew.read', name: 'Read Handyman Work Crews' },
      { code: 'handyman_work_crew.manage', name: 'Manage Handyman Work Crews' },
    ]);

    const deniedGet = await api().get(CREW_ROUTES.byId(base.crew.id)).set(auth(outsiderToken));
    assert.equal(deniedGet.status, 403);
    assert.equal((deniedGet.body as ErrorBody).error.code, 'BUILDING_ACCESS_DENIED');

    const deniedList = await api()
      .get(`${CREW_ROUTES.list}?clientId=${base.ctx.client.id}`)
      .set(auth(outsiderToken));
    assert.equal(deniedList.status, 403);
    assert.equal((deniedList.body as ErrorBody).error.code, 'BUILDING_ACCESS_DENIED');

    const deniedMembers = await api()
      .get(CREW_ROUTES.members(base.crew.id))
      .set(auth(outsiderToken));
    assert.equal(deniedMembers.status, 403);
    assert.equal((deniedMembers.body as ErrorBody).error.code, 'BUILDING_ACCESS_DENIED');

    // Unknown designation → 404 through the create surface (the client is
    // derived from the designation, so a foreign id cannot even be scoped).
    const foreignCreate = await api()
      .post(CREW_ROUTES.create)
      .set(auth())
      .send({
        handymanProviderId: randomUUID(),
        crewCode: `CREW_${suffix()}`,
        crewName: 'Foreign Crew',
        leadWorkerBindingId: base.lead.binding.id,
      });
    assert.equal(foreignCreate.status, 404);
    assert.equal(
      (foreignCreate.body as ErrorBody).error.code,
      'HANDYMAN_PROVIDER_NOT_FOUND',
    );
  });
});

describe('CR-HM-BE-04 RUN 2 — surface boundary', () => {
  it('exposes no DELETE route and no assignment/dispatch surface', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewFixture();

    // No DELETE verb exists on crews or memberships (history is never deleted).
    const deleteCrew = await api().delete(CREW_ROUTES.byId(base.crew.id)).set(auth());
    assert.equal(deleteCrew.status, 404);
    const deleteMember = await api()
      .delete(`${CREW_ROUTES.members(base.crew.id)}/${base.leadMember.id}`)
      .set(auth());
    assert.equal(deleteMember.status, 404);

    // The runtime route source wires exactly the ten governed operations and
    // no assignment/dispatch/request/work-order/permit/session path.
    const source = readFileSync(
      resolve(__dirname, '../src/modules/handyman-work-crews/handyman-work-crew.routes.ts'),
      'utf8',
    );
    const routes = [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map(
      (match) => ({ method: match[1], path: match[2] }),
    );
    assert.equal(routes.length, 10);
    assert.equal(
      routes.filter((route) => route.method === 'delete').length,
      0,
    );
    for (const route of routes) {
      assert.match(route.path, /^\/handyman-work-crews/);
      assert.ok(
        !/request|work-order|dispatch|assign|permit|session|schedule|building/i.test(
          route.path,
        ),
        `forbidden surface in route ${route.path}`,
      );
    }
  });
});

describe('CR-HM-BE-04 RUN 2 — runtime/OpenAPI parity', () => {
  const CREW_TAG = 'Handyman Work Crews';

  type Spec = {
    paths: Record<
      string,
      Record<string, { 'x-required-permission'?: string; tags?: string[]; operationId?: string }>
    >;
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
  };

  function loadSpec(): Spec {
    return parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as Spec;
  }

  function runtimeOperations(): Record<string, Set<string>> {
    const source = readFileSync(
      resolve(__dirname, '../src/modules/handyman-work-crews/handyman-work-crew.routes.ts'),
      'utf8',
    );
    const operations: Record<string, Set<string>> = {};
    for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      const method = match[1];
      const path = match[2].replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      (operations[path] ??= new Set()).add(method);
    }
    return operations;
  }

  it('documents exactly the crew runtime operation set with permission parity', async (t) => {
    if (!ready(t)) return;

    const spec = loadSpec();
    const runtime = runtimeOperations();

    const documented: Record<string, Set<string>> = {};
    for (const [path, item] of Object.entries(spec.paths)) {
      const methods = Object.keys(item).filter((method) =>
        ['get', 'post', 'put', 'patch', 'delete'].includes(method),
      );
      const crew = methods.filter((method) =>
        (item[method].tags ?? []).includes(CREW_TAG),
      );
      if (crew.length > 0) {
        assert.equal(
          crew.length,
          methods.length,
          `${path} mixes crew and non-crew operations`,
        );
        documented[path] = new Set(crew);
      }
    }

    // Exact set parity in BOTH directions.
    assert.deepEqual(
      Object.keys(documented).sort(),
      Object.keys(runtime).sort(),
      'documented crew paths must equal the runtime crew paths',
    );
    for (const path of Object.keys(runtime)) {
      assert.deepEqual(
        [...(documented[path] ?? [])].sort(),
        [...runtime[path]].sort(),
        `${path} operations must match exactly`,
      );
    }
    let operationCount = 0;
    for (const methods of Object.values(runtime)) operationCount += methods.size;
    assert.equal(operationCount, 10);

    // x-required-permission parity: reads → .read, mutations → .manage.
    const expectedPermissions: Record<string, Record<string, string>> = {
      '/handyman-work-crews': {
        post: 'handyman_work_crew.manage',
        get: 'handyman_work_crew.read',
      },
      '/handyman-work-crews/{crewId}': {
        get: 'handyman_work_crew.read',
        patch: 'handyman_work_crew.manage',
      },
      '/handyman-work-crews/{crewId}/deactivate': {
        post: 'handyman_work_crew.manage',
      },
      '/handyman-work-crews/{crewId}/activate': {
        post: 'handyman_work_crew.manage',
      },
      '/handyman-work-crews/{crewId}/members': {
        post: 'handyman_work_crew.manage',
        get: 'handyman_work_crew.read',
      },
      '/handyman-work-crews/{crewId}/members/{memberId}/remove': {
        post: 'handyman_work_crew.manage',
      },
      '/handyman-work-crews/{crewId}/lead-worker/change': {
        post: 'handyman_work_crew.manage',
      },
    };
    assert.deepEqual(
      Object.keys(expectedPermissions).sort(),
      Object.keys(documented).sort(),
    );
    for (const [path, operations] of Object.entries(expectedPermissions)) {
      for (const [method, permission] of Object.entries(operations)) {
        const operation = spec.paths[path][method];
        assert.ok(operation, `${method.toUpperCase()} ${path} must be documented`);
        assert.equal(
          operation['x-required-permission'],
          permission,
          `${method.toUpperCase()} ${path} permission`,
        );
        // Every documented operation is authenticated.
        assert.deepEqual(
          (operation as unknown as { security?: unknown[] }).security,
          [{ bearerAuth: [] }],
          `${method.toUpperCase()} ${path} must require bearer authentication`,
        );
      }
    }

    // The runtime route source wires exactly these two permission codes.
    const routesSource = readFileSync(
      resolve(__dirname, '../src/modules/handyman-work-crews/handyman-work-crew.routes.ts'),
      'utf8',
    );
    for (const code of ['handyman_work_crew.read', 'handyman_work_crew.manage']) {
      assert.ok(
        routesSource.includes(`requirePermission('${code}')`),
        `runtime must gate with ${code}`,
      );
    }
    assert.equal(
      (routesSource.match(/requirePermission\('/g) ?? []).length,
      2,
      'no permission beyond the existing Run-1 pair may be wired',
    );

    // No DELETE operation is documented anywhere on crew paths.
    for (const [path, item] of Object.entries(spec.paths)) {
      if (path.includes('handyman-work-crews')) {
        assert.equal(item.delete, undefined, `${path} must not document DELETE`);
      }
    }
  });

  it('documents strict body allowlists and privacy-safe read models', async (t) => {
    if (!ready(t)) return;

    const spec = loadSpec();
    const schemas = spec.components.schemas;

    const expectedBodyKeys: Record<string, string[]> = {
      CreateHandymanWorkCrew: [
        'crewCode',
        'crewName',
        'handymanProviderId',
        'leadWorkerBindingId',
      ],
      UpdateHandymanWorkCrew: ['crewName'],
      AddHandymanWorkCrewMember: ['crewRole', 'vendorWorkforceBindingId'],
      ChangeHandymanWorkCrewLead: ['newLeadWorkerBindingId'],
      CreateHandymanWorkCrewResult: ['crew', 'leadMember'],
      ChangeHandymanWorkCrewLeadResult: ['newMember', 'previousMember'],
    };
    for (const [name, keys] of Object.entries(expectedBodyKeys)) {
      assert.ok(schemas[name], `schema ${name} must be documented`);
      assert.deepEqual(
        Object.keys(schemas[name].properties ?? {}).sort(),
        keys,
        `${name} must document exactly the wire allowlist`,
      );
    }

    // Read models expose operational facts only — no worker contact data,
    // credentials, personnel codes, or internal event metadata.
    const memberKeys = Object.keys(schemas.HandymanWorkCrewMember.properties ?? {});
    for (const forbidden of [
      'fullName',
      'employeeCode',
      'vendorPersonnelCode',
      'phone',
      'email',
      'userId',
      'password',
      'token',
      'metadata',
    ]) {
      assert.ok(
        !memberKeys.includes(forbidden),
        `${forbidden} must never be documented on the member read model`,
      );
    }
    assert.deepEqual(memberKeys.sort(), [
      'addedAt',
      'addedByUserId',
      'clientId',
      'crewId',
      'crewRole',
      'effectiveFrom',
      'effectiveTo',
      'id',
      'removedAt',
      'removedByUserId',
      'status',
      'vendorWorkforceBindingId',
    ]);
    assert.deepEqual(Object.keys(schemas.HandymanWorkCrew.properties ?? {}).sort(), [
      'clientId',
      'createdAt',
      'createdByUserId',
      'crewCode',
      'crewName',
      'handymanProviderId',
      'id',
      'status',
      'updatedAt',
      'updatedByUserId',
    ]);
  });
});
