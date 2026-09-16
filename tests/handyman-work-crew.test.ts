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
import { departmentService } from '../src/modules/departments';
import { entitlementService } from '../src/modules/entitlements';
import {
  HANDYMAN_MODULE_CODE,
  designateHandymanProvider,
  updateHandymanProviderStatus,
} from '../src/modules/handyman-providers';
import {
  addHandymanWorkCrewMember,
  changeHandymanWorkCrewLeadWorker,
  createHandymanWorkCrew,
  getHandymanWorkCrewById,
  listHandymanWorkCrewMembers,
  listHandymanWorkCrews,
  removeHandymanWorkCrewMember,
  updateHandymanWorkCrew,
  updateHandymanWorkCrewStatus,
} from '../src/modules/handyman-work-crews';
import { licenseService } from '../src/modules/licenses';
import { moduleRepository, moduleService } from '../src/modules/modules';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { subscriptionService } from '../src/modules/subscriptions';
import { userService } from '../src/modules/users';
import { vendorService } from '../src/modules/vendors';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-04 RUN 1 — Handyman Work Crew authority (focused service-level
 * suite; HTTP/OpenAPI is Run 2 and is deliberately NOT tested here).
 *
 * Fixtures consume the EXISTING foundations end to end: BE-02 client/commerce
 * stack → CR-HM-BE-02 provider designation → BE-03C EXTERNAL workforce
 * profile → BE-06F vendor workforce binding — the crew module creates none of
 * them and must not be tested with shortcuts it would not have in production.
 */

const PORT = 55498;
const DIR = '/tmp/asentra-hm04-run1-pg';
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
  await pool.query(
    'TRUNCATE handyman_service_visit_schedules, handyman_service_visits, handyman_job_assignments, handyman_jobs, handyman_work_crew_members, handyman_work_crews, handyman_providers',
  );
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

function requirePool(): Pool {
  if (!pool) throw new Error('pool unavailable');
  return pool;
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

async function createOutsiderUser(): Promise<string> {
  const user = await userService.createUser({
    email: `outsider-${suffix().toLowerCase()}@example.com`,
    displayName: 'Outsider User',
  });
  return user.id;
}

/**
 * Client + Property + Building (admin assigned for BE-02G client reach) +
 * Vendor + the full BE-02C commercial stack (Subscription → License →
 * HANDYMAN Entitlement), mirroring the CR-HM-BE-02 service-suite fixture.
 */
async function createClientContext() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Handyman Crew Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Handyman Crew Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Handyman Crew Tower',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });

  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Handyman Crew Vendor',
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
  const moduleId = await ensureHandymanModule();
  await entitlementService.createEntitlement(subscription.id, {
    moduleId,
    startsAt,
    endsAt,
  });

  return { client, property, building, vendor, subscription };
}

type ClientContext = Awaited<ReturnType<typeof createClientContext>>;

/** Organization chain required by the BE-03C person master. */
async function createOrgChain(clientId: string) {
  const organization = await organizationService.createOrganization({
    clientId,
    code: `ORG_${suffix()}`,
    name: 'Crew Workforce Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Crew Workforce Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Crew Workforce Position',
  });
  return { organization, department, position };
}

type OrgChain = Awaited<ReturnType<typeof createOrgChain>>;

/**
 * An EXTERNAL worker of the given vendor through the EXISTING personnel
 * authority (BE-03C profile → BE-06F binding). `withUser` stays false by
 * default: a HELPER must be seatable with NO login whatsoever. Distinctive
 * names/codes double as PII canaries for the audit assertions.
 */
async function createWorker(
  ctx: ClientContext,
  chain: OrgChain,
  vendorId: string,
  options: { role?: string; personnelCode?: string } = {},
) {
  const tag = options.role ?? 'Worker';
  const fullName = `Zqxf ${tag} ${suffix()}`;
  const vendorPersonnelCode = options.personnelCode ?? `VPC-${tag}-${suffix()}`;
  const profile = await workforceService.createWorkforceProfile({
    organizationId: chain.organization.id,
    departmentId: chain.department.id,
    positionId: chain.position.id,
    employeeCode: `WF_${suffix()}`,
    fullName,
    workforceType: 'EXTERNAL',
  });
  const binding = await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId,
    workforceProfileId: profile.id,
    vendorPersonnelCode,
  });
  return { profile, binding, fullName, vendorPersonnelCode };
}

type Worker = Awaited<ReturnType<typeof createWorker>>;

/** Provider designation + org chain + an ACTIVE crew with its founding lead. */
async function createCrewContext(options: { crewCode?: string } = {}) {
  const ctx = await createClientContext();
  const provider = await designateHandymanProvider(
    { clientId: ctx.client.id, vendorId: ctx.vendor.id },
    adminUserId,
  );
  const chain = await createOrgChain(ctx.client.id);
  const lead = await createWorker(ctx, chain, ctx.vendor.id, {
    role: 'LeadOne',
  });
  const crewCode = options.crewCode ?? `CREW_${suffix()}`;
  const { crew, leadMember } = await createHandymanWorkCrew(
    {
      clientId: ctx.client.id,
      handymanProviderId: provider.id,
      crewCode,
      crewName: `Crew ${crewCode}`,
      leadWorkerBindingId: lead.binding.id,
    },
    adminUserId,
  );
  return { ctx, provider, chain, lead, crew, leadMember, crewCode };
}

type CrewContext = Awaited<ReturnType<typeof createCrewContext>>;

async function activeLeadCount(base: CrewContext): Promise<number> {
  const members = await listHandymanWorkCrewMembers(
    base.crew.id,
    adminUserId,
    { status: 'ACTIVE' },
  );
  return members.filter((member) => member.crewRole === 'LEAD_WORKER').length;
}

describe('CR-HM-BE-04 RUN 1: Handyman Work Crew creation + provider authority', () => {
  it('creates an ACTIVE crew with its founding LEAD_WORKER atomically', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();

    assert.equal(base.crew.status, 'ACTIVE');
    assert.equal(base.crew.clientId, base.ctx.client.id);
    assert.equal(base.crew.handymanProviderId, base.provider.id);
    assert.equal(base.crew.crewCode, base.crewCode);
    assert.equal(base.crew.createdByUserId, adminUserId);
    assert.equal(base.crew.updatedByUserId, adminUserId);
    assert.ok(base.crew.createdAt);

    assert.equal(base.leadMember.status, 'ACTIVE');
    assert.equal(base.leadMember.crewRole, 'LEAD_WORKER');
    assert.equal(base.leadMember.crewId, base.crew.id);
    assert.equal(
      base.leadMember.vendorWorkforceBindingId,
      base.lead.binding.id,
    );
    assert.equal(base.leadMember.addedByUserId, adminUserId);
    assert.equal(base.leadMember.removedAt, null);
    assert.equal(base.leadMember.effectiveTo, null);
    assert.equal(await activeLeadCount(base), 1);

    const fetched = await getHandymanWorkCrewById(base.crew.id, adminUserId);
    assert.deepEqual(fetched, base.crew);

    const listed = await listHandymanWorkCrews(base.ctx.client.id, adminUserId);
    assert.deepEqual(
      listed.map((row) => row.id),
      [base.crew.id],
    );
    const byProvider = await listHandymanWorkCrews(
      base.ctx.client.id,
      adminUserId,
      { handymanProviderId: base.provider.id, status: 'ACTIVE' },
    );
    assert.equal(byProvider.length, 1);
  });

  it('rejects a missing, foreign-client, or INACTIVE provider designation', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();
    const chain = base.chain;

    // Missing designation.
    await expectError(
      createHandymanWorkCrew(
        {
          clientId: base.ctx.client.id,
          handymanProviderId: randomUUID(),
          crewCode: `CREW_${suffix()}`,
          crewName: 'Ghost Crew',
          leadWorkerBindingId: base.lead.binding.id,
        },
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_NOT_FOUND',
      404,
    );

    // Designation of ANOTHER client.
    const other = await createCrewContext();
    await expectError(
      createHandymanWorkCrew(
        {
          clientId: base.ctx.client.id,
          handymanProviderId: other.provider.id,
          crewCode: `CREW_${suffix()}`,
          crewName: 'Cross Client Crew',
          leadWorkerBindingId: base.lead.binding.id,
        },
        adminUserId,
      ),
      'HANDYMAN_WORK_CREW_PROVIDER_CLIENT_MISMATCH',
      400,
    );

    // INACTIVE designation.
    await updateHandymanProviderStatus(
      base.provider.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    await expectError(
      createHandymanWorkCrew(
        {
          clientId: base.ctx.client.id,
          handymanProviderId: base.provider.id,
          crewCode: `CREW_${suffix()}`,
          crewName: 'Inactive Provider Crew',
          leadWorkerBindingId: base.lead.binding.id,
        },
        adminUserId,
      ),
      'HANDYMAN_PROVIDER_STATUS_INVALID',
      400,
    );

    // Reactivated designation but INACTIVE vendor behind it.
    await updateHandymanProviderStatus(
      base.provider.id,
      { status: 'ACTIVE' },
      adminUserId,
    ).catch(() => undefined);
    await vendorService.updateVendorStatus(base.ctx.vendor.id, {
      status: 'INACTIVE',
    });
    await expectError(
      createHandymanWorkCrew(
        {
          clientId: base.ctx.client.id,
          handymanProviderId: base.provider.id,
          crewCode: `CREW_${suffix()}`,
          crewName: 'Inactive Vendor Crew',
          leadWorkerBindingId: base.lead.binding.id,
        },
        adminUserId,
      ),
      'VENDOR_INACTIVE',
      400,
    );
    void chain;
  });

  it('enforces the ACTIVE-crew lead requirement: an invalid founding lead creates NO crew', async (t) => {
    if (!ready(t)) return;

    const ctx = await createClientContext();
    const provider = await designateHandymanProvider(
      { clientId: ctx.client.id, vendorId: ctx.vendor.id },
      adminUserId,
    );
    const chain = await createOrgChain(ctx.client.id);
    const lead = await createWorker(ctx, chain, ctx.vendor.id, {
      role: 'DoomedLead',
    });
    await vendorWorkforceService.updateVendorWorkforceBinding(
      ctx.vendor.id,
      lead.profile.id,
      { status: 'INACTIVE' },
    );

    await expectError(
      createHandymanWorkCrew(
        {
          clientId: ctx.client.id,
          handymanProviderId: provider.id,
          crewCode: `CREW_${suffix()}`,
          crewName: 'No Lead Crew',
          leadWorkerBindingId: lead.binding.id,
        },
        adminUserId,
      ),
      'HANDYMAN_WORK_CREW_WORKER_BINDING_INACTIVE',
      409,
    );

    const crews = await listHandymanWorkCrews(ctx.client.id, adminUserId);
    assert.equal(crews.length, 0);

    // A nonexistent binding is equally rejected before any crew exists.
    await expectError(
      createHandymanWorkCrew(
        {
          clientId: ctx.client.id,
          handymanProviderId: provider.id,
          crewCode: `CREW_${suffix()}`,
          crewName: 'Ghost Lead Crew',
          leadWorkerBindingId: randomUUID(),
        },
        adminUserId,
      ),
      'VENDOR_WORKFORCE_BINDING_NOT_FOUND',
      404,
    );
    assert.equal((await listHandymanWorkCrews(ctx.client.id, adminUserId)).length, 0);
  });

  it('normalizes crew codes and blocks duplicate ACTIVE codes per provider', async (t) => {
    if (!ready(t)) return;

    const ctx = await createClientContext();
    const provider = await designateHandymanProvider(
      { clientId: ctx.client.id, vendorId: ctx.vendor.id },
      adminUserId,
    );
    const chain = await createOrgChain(ctx.client.id);
    const leadA = await createWorker(ctx, chain, ctx.vendor.id, {
      role: 'CodeLeadA',
    });
    const leadB = await createWorker(ctx, chain, ctx.vendor.id, {
      role: 'CodeLeadB',
    });

    const created = await createHandymanWorkCrew(
      {
        clientId: ctx.client.id,
        handymanProviderId: provider.id,
        crewCode: '  crew_alpha  ',
        crewName: 'Alpha Crew',
        leadWorkerBindingId: leadA.binding.id,
      },
      adminUserId,
    );
    assert.equal(created.crew.crewCode, 'CREW_ALPHA');

    await expectError(
      createHandymanWorkCrew(
        {
          clientId: ctx.client.id,
          handymanProviderId: provider.id,
          crewCode: 'CREW_ALPHA',
          crewName: 'Alpha Twin',
          leadWorkerBindingId: leadB.binding.id,
        },
        adminUserId,
      ),
      'HANDYMAN_WORK_CREW_CODE_ALREADY_EXISTS',
      409,
    );

    // Malformed code rejected by service-level validation.
    await expectError(
      createHandymanWorkCrew(
        {
          clientId: ctx.client.id,
          handymanProviderId: provider.id,
          crewCode: 'bad code!',
          crewName: 'Bad Code Crew',
          leadWorkerBindingId: leadB.binding.id,
        },
        adminUserId,
      ),
      'VALIDATION_ERROR',
      400,
    );

    // After deactivation the code can be deliberately re-issued (history kept).
    await updateHandymanWorkCrewStatus(
      created.crew.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    const reissued = await createHandymanWorkCrew(
      {
        clientId: ctx.client.id,
        handymanProviderId: provider.id,
        crewCode: 'CREW_ALPHA',
        crewName: 'Alpha Reissued',
        leadWorkerBindingId: leadB.binding.id,
      },
      adminUserId,
    );
    assert.notEqual(reissued.crew.id, created.crew.id);
    const all = await listHandymanWorkCrews(ctx.client.id, adminUserId);
    assert.equal(all.length, 2);
  });

  it('denies crew reads to an actor outside the client data scope', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();
    const outsider = await createOutsiderUser();

    await expectError(
      getHandymanWorkCrewById(base.crew.id, outsider),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      listHandymanWorkCrews(base.ctx.client.id, outsider),
      'BUILDING_ACCESS_DENIED',
      403,
    );
    await expectError(
      listHandymanWorkCrewMembers(base.crew.id, outsider),
      'BUILDING_ACCESS_DENIED',
      403,
    );
  });
});

describe('CR-HM-BE-04 RUN 1: worker validation through existing personnel authority', () => {
  it('seats multiple Helpers that have NO user login', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();
    const helperA = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, {
      role: 'HelperNoLoginA',
    });
    const helperB = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, {
      role: 'HelperNoLoginB',
    });

    // The fixture profiles carry no user link at all — a Helper never needs
    // a login, credential, or app account.
    const profileRow = await requirePool().query(
      'SELECT user_id FROM workforce_profiles WHERE id = $1',
      [helperA.profile.id],
    );
    assert.equal(profileRow.rows[0].user_id, null);

    const memberA = await addHandymanWorkCrewMember(
      base.crew.id,
      { vendorWorkforceBindingId: helperA.binding.id, crewRole: 'HELPER' },
      adminUserId,
    );
    const memberB = await addHandymanWorkCrewMember(
      base.crew.id,
      { vendorWorkforceBindingId: helperB.binding.id, crewRole: 'HELPER' },
      adminUserId,
    );

    assert.equal(memberA.status, 'ACTIVE');
    assert.equal(memberA.crewRole, 'HELPER');
    assert.equal(memberB.status, 'ACTIVE');
    assert.equal(memberB.crewRole, 'HELPER');

    const active = await listHandymanWorkCrewMembers(base.crew.id, adminUserId, {
      status: 'ACTIVE',
    });
    assert.equal(active.length, 3);
    assert.equal(await activeLeadCount(base), 1);
  });

  it('rejects a worker bound to a DIFFERENT provider vendor', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();
    const otherVendor = await vendorService.createVendor({
      clientId: base.ctx.client.id,
      vendorCode: `V_${suffix()}`,
      vendorName: 'Other Crew Vendor',
    });
    const foreignWorker = await createWorker(
      base.ctx,
      base.chain,
      otherVendor.id,
      { role: 'ForeignVendorWorker' },
    );

    await expectError(
      addHandymanWorkCrewMember(
        base.crew.id,
        {
          vendorWorkforceBindingId: foreignWorker.binding.id,
          crewRole: 'HELPER',
        },
        adminUserId,
      ),
      'HANDYMAN_WORK_CREW_WORKER_PROVIDER_MISMATCH',
      400,
    );
  });

  it('rejects INTERNAL workforce, inactive profiles, and inactive bindings', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();

    // INTERNAL profile: BE-06F refuses to bind non-EXTERNAL profiles, so the
    // crew-level rule is proven by flipping an already-bound profile to
    // INTERNAL (a governance regression the crew service must still catch).
    const flipWorker = await createWorker(
      base.ctx,
      base.chain,
      base.ctx.vendor.id,
      { role: 'FlippedInternal' },
    );
    await workforceService.updateWorkforceProfile(flipWorker.profile.id, {
      workforceType: 'INTERNAL',
    });
    await expectError(
      addHandymanWorkCrewMember(
        base.crew.id,
        {
          vendorWorkforceBindingId: flipWorker.binding.id,
          crewRole: 'HELPER',
        },
        adminUserId,
      ),
      'WORKFORCE_NOT_EXTERNAL',
      400,
    );

    // INACTIVE profile behind an ACTIVE binding.
    const inactiveProfileWorker = await createWorker(
      base.ctx,
      base.chain,
      base.ctx.vendor.id,
      { role: 'InactiveProfile' },
    );
    await workforceService.updateWorkforceProfile(inactiveProfileWorker.profile.id, {
      status: 'INACTIVE',
    });
    await expectError(
      addHandymanWorkCrewMember(
        base.crew.id,
        {
          vendorWorkforceBindingId: inactiveProfileWorker.binding.id,
          crewRole: 'HELPER',
        },
        adminUserId,
      ),
      'WORKFORCE_PROFILE_INACTIVE',
      400,
    );

    // INACTIVE binding.
    const inactiveBindingWorker = await createWorker(
      base.ctx,
      base.chain,
      base.ctx.vendor.id,
      { role: 'InactiveBinding' },
    );
    await vendorWorkforceService.updateVendorWorkforceBinding(
      base.ctx.vendor.id,
      inactiveBindingWorker.profile.id,
      { status: 'INACTIVE' },
    );
    await expectError(
      addHandymanWorkCrewMember(
        base.crew.id,
        {
          vendorWorkforceBindingId: inactiveBindingWorker.binding.id,
          crewRole: 'HELPER',
        },
        adminUserId,
      ),
      'HANDYMAN_WORK_CREW_WORKER_BINDING_INACTIVE',
      409,
    );

    const active = await listHandymanWorkCrewMembers(base.crew.id, adminUserId, {
      status: 'ACTIVE',
    });
    assert.equal(active.length, 1); // only the founding lead
  });

  it('structurally refuses memberships referencing a nonexistent binding (FK)', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();

    await assert.rejects(
      requirePool().query(
        `INSERT INTO handyman_work_crew_members
           (id, client_id, crew_id, vendor_workforce_binding_id, crew_role,
            status, added_by_user_id)
         VALUES ($1, $2, $3, $4, 'HELPER', 'ACTIVE', $5)`,
        [
          randomUUID(),
          base.ctx.client.id,
          base.crew.id,
          randomUUID(),
          adminUserId,
        ],
      ),
      (error: { code?: string }) => error.code === '23503',
    );
  });
});

describe('CR-HM-BE-04 RUN 1: Lead Worker governance', () => {
  it('blocks a second ACTIVE lead via addMember', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();
    const secondLead = await createWorker(
      base.ctx,
      base.chain,
      base.ctx.vendor.id,
      { role: 'SecondLeadAttempt' },
    );

    await expectError(
      addHandymanWorkCrewMember(
        base.crew.id,
        {
          vendorWorkforceBindingId: secondLead.binding.id,
          crewRole: 'LEAD_WORKER',
        },
        adminUserId,
      ),
      'HANDYMAN_WORK_CREW_LEAD_ALREADY_ACTIVE',
      409,
    );
    assert.equal(await activeLeadCount(base), 1);
  });

  it('replaces the lead atomically and preserves the old row as immutable evidence', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();
    const newLead = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, {
      role: 'NewLead',
    });

    const { previousMember, newMember } = await changeHandymanWorkCrewLeadWorker(
      base.crew.id,
      { newLeadWorkerBindingId: newLead.binding.id },
      adminUserId,
    );

    assert.equal(previousMember.id, base.leadMember.id);
    assert.equal(previousMember.status, 'INACTIVE');
    assert.equal(previousMember.crewRole, 'LEAD_WORKER'); // role never mutated
    assert.equal(
      previousMember.vendorWorkforceBindingId,
      base.lead.binding.id,
    ); // identity never mutated
    assert.ok(previousMember.removedAt);
    assert.equal(previousMember.removedByUserId, adminUserId);
    assert.ok(previousMember.effectiveTo);

    assert.equal(newMember.status, 'ACTIVE');
    assert.equal(newMember.crewRole, 'LEAD_WORKER');
    assert.equal(newMember.vendorWorkforceBindingId, newLead.binding.id);

    assert.equal(await activeLeadCount(base), 1);
    const all = await listHandymanWorkCrewMembers(base.crew.id, adminUserId);
    assert.equal(all.length, 2);
  });

  it('forbids direct removal of the ACTIVE lead — zero-lead is unreachable', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();

    await expectError(
      removeHandymanWorkCrewMember(base.crew.id, base.leadMember.id, adminUserId),
      'HANDYMAN_WORK_CREW_LEAD_REMOVAL_FORBIDDEN',
      409,
    );
    assert.equal(await activeLeadCount(base), 1);
  });

  it('refuses change-lead onto an already ACTIVE member; explicit promotion path works', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();
    const helper = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, {
      role: 'PromotableHelper',
    });
    const helperMember = await addHandymanWorkCrewMember(
      base.crew.id,
      { vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER' },
      adminUserId,
    );

    // No silent double-seat / promotion.
    await expectError(
      changeHandymanWorkCrewLeadWorker(
        base.crew.id,
        { newLeadWorkerBindingId: helper.binding.id },
        adminUserId,
      ),
      'HANDYMAN_WORK_CREW_MEMBER_ALREADY_ACTIVE',
      409,
    );

    // Explicit two-command promotion path never opens a zero-lead window.
    await removeHandymanWorkCrewMember(
      base.crew.id,
      helperMember.id,
      adminUserId,
    );
    const { previousMember, newMember } = await changeHandymanWorkCrewLeadWorker(
      base.crew.id,
      { newLeadWorkerBindingId: helper.binding.id },
      adminUserId,
    );

    assert.equal(previousMember.id, base.leadMember.id);
    assert.equal(previousMember.status, 'INACTIVE');
    assert.equal(newMember.crewRole, 'LEAD_WORKER');
    assert.equal(newMember.vendorWorkforceBindingId, helper.binding.id);
    assert.notEqual(newMember.id, helperMember.id);
    assert.equal(await activeLeadCount(base), 1);

    // Both historical rows survive untouched (helper row keeps HELPER role).
    const all = await listHandymanWorkCrewMembers(base.crew.id, adminUserId);
    assert.equal(all.length, 3);
    const historicHelper = all.find((row) => row.id === helperMember.id);
    assert.equal(historicHelper?.crewRole, 'HELPER');
    assert.equal(historicHelper?.status, 'INACTIVE');
  });

  it('retains membership history after deactivation and allows deliberate re-adds', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();
    const helper = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, {
      role: 'HistoryHelper',
    });
    const first = await addHandymanWorkCrewMember(
      base.crew.id,
      { vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER' },
      adminUserId,
    );

    const removed = await removeHandymanWorkCrewMember(
      base.crew.id,
      first.id,
      adminUserId,
    );
    assert.equal(removed.status, 'INACTIVE');
    assert.equal(removed.id, first.id);
    assert.equal(removed.crewRole, 'HELPER');
    assert.ok(removed.removedAt);
    assert.equal(removed.removedByUserId, adminUserId);
    assert.ok(removed.effectiveTo);

    // Removing twice is refused — history rows are closed evidence.
    await expectError(
      removeHandymanWorkCrewMember(base.crew.id, first.id, adminUserId),
      'HANDYMAN_WORK_CREW_MEMBER_STATUS_INVALID',
      400,
    );

    // History does not block a deliberate new ACTIVE membership.
    const second = await addHandymanWorkCrewMember(
      base.crew.id,
      { vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER' },
      adminUserId,
    );
    assert.notEqual(second.id, first.id);
    assert.equal(second.status, 'ACTIVE');

    const all = await listHandymanWorkCrewMembers(base.crew.id, adminUserId);
    const bindingRows = all.filter(
      (row) => row.vendorWorkforceBindingId === helper.binding.id,
    );
    assert.equal(bindingRows.length, 2);
    assert.equal(
      bindingRows.filter((row) => row.status === 'INACTIVE').length,
      1,
    );
    const inactiveOnly = await listHandymanWorkCrewMembers(
      base.crew.id,
      adminUserId,
      { status: 'INACTIVE' },
    );
    assert.deepEqual(
      inactiveOnly.map((row) => row.id),
      [first.id],
    );

    // Unknown member addressing.
    await expectError(
      removeHandymanWorkCrewMember(base.crew.id, randomUUID(), adminUserId),
      'HANDYMAN_WORK_CREW_MEMBER_NOT_FOUND',
      404,
    );
  });
});

describe('CR-HM-BE-04 RUN 1: crew lifecycle', () => {
  it('deactivates, freezes membership, reactivates with lead re-validation, and renames', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();
    const helper = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, {
      role: 'LifecycleHelper',
    });

    const deactivated = await updateHandymanWorkCrewStatus(
      base.crew.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    assert.equal(deactivated.status, 'INACTIVE');

    // Same-status transitions are refused.
    await expectError(
      updateHandymanWorkCrewStatus(base.crew.id, { status: 'INACTIVE' }, adminUserId),
      'HANDYMAN_WORK_CREW_STATUS_INVALID',
      400,
    );

    // Frozen crew: no operational membership changes. Adding is refused by
    // the crew-status gate, and removal (even of the lead) is refused while
    // frozen — the lead-removal ban applies to the operational ACTIVE crew.
    await expectError(
      addHandymanWorkCrewMember(
        base.crew.id,
        { vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER' },
        adminUserId,
      ),
      'HANDYMAN_WORK_CREW_STATUS_INVALID',
      400,
    );
    await expectError(
      removeHandymanWorkCrewMember(base.crew.id, base.leadMember.id, adminUserId),
      'HANDYMAN_WORK_CREW_STATUS_INVALID',
      400,
    );

    // Rename is metadata-only and allowed while frozen.
    const renamed = await updateHandymanWorkCrew(
      base.crew.id,
      { crewName: 'Renamed Frozen Crew' },
      adminUserId,
    );
    assert.equal(renamed.crewName, 'Renamed Frozen Crew');
    assert.equal(renamed.crewCode, base.crewCode);
    assert.equal(renamed.updatedByUserId, adminUserId);

    // Reactivation succeeds while the lead chain is valid.
    const reactivated = await updateHandymanWorkCrewStatus(
      base.crew.id,
      { status: 'ACTIVE' },
      adminUserId,
    );
    assert.equal(reactivated.status, 'ACTIVE');
    await expectError(
      updateHandymanWorkCrewStatus(base.crew.id, { status: 'ACTIVE' }, adminUserId),
      'HANDYMAN_WORK_CREW_STATUS_INVALID',
      400,
    );

    // Freeze again, break the lead binding, reactivation must refuse — an
    // ACTIVE operational crew may never come back with zero valid leads.
    await updateHandymanWorkCrewStatus(
      base.crew.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    await vendorWorkforceService.updateVendorWorkforceBinding(
      base.ctx.vendor.id,
      base.lead.profile.id,
      { status: 'INACTIVE' },
    );
    await expectError(
      updateHandymanWorkCrewStatus(base.crew.id, { status: 'ACTIVE' }, adminUserId),
      'HANDYMAN_WORK_CREW_WORKER_BINDING_INACTIVE',
      409,
    );
    const stillInactive = await getHandymanWorkCrewById(base.crew.id, adminUserId);
    assert.equal(stillInactive.status, 'INACTIVE');
  });

  it('blocks unknown-crew addressing', async (t) => {
    if (!ready(t)) return;

    const ghost = randomUUID();
    await expectError(
      getHandymanWorkCrewById(ghost, adminUserId),
      'HANDYMAN_WORK_CREW_NOT_FOUND',
      404,
    );
    await expectError(
      listHandymanWorkCrewMembers(ghost, adminUserId),
      'HANDYMAN_WORK_CREW_NOT_FOUND',
      404,
    );
    await expectError(
      updateHandymanWorkCrewStatus(ghost, { status: 'INACTIVE' }, adminUserId),
      'HANDYMAN_WORK_CREW_NOT_FOUND',
      404,
    );
  });
});

describe('CR-HM-BE-04 RUN 1: concurrency seams', () => {
  it('concurrent duplicate member adds produce exactly one winner', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();
    const helper = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, {
      role: 'RaceHelper',
    });

    const results = await Promise.allSettled([
      addHandymanWorkCrewMember(
        base.crew.id,
        { vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER' },
        adminUserId,
      ),
      addHandymanWorkCrewMember(
        base.crew.id,
        { vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER' },
        adminUserId,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 1);
    const rejected = results.filter(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult[];
    assert.equal(rejected.length, 1);
    assert.equal(
      (rejected[0].reason as { code?: string }).code,
      'HANDYMAN_WORK_CREW_MEMBER_ALREADY_ACTIVE',
    );

    const rows = await requirePool().query(
      `SELECT COUNT(*)::INT AS n FROM handyman_work_crew_members
       WHERE crew_id = $1 AND vendor_workforce_binding_id = $2
         AND status = 'ACTIVE'`,
      [base.crew.id, helper.binding.id],
    );
    assert.equal(rows.rows[0].n, 1);
  });

  it('concurrent lead additions never yield two ACTIVE leads', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();
    const candidateA = await createWorker(
      base.ctx,
      base.chain,
      base.ctx.vendor.id,
      { role: 'RaceLeadA' },
    );
    const candidateB = await createWorker(
      base.ctx,
      base.chain,
      base.ctx.vendor.id,
      { role: 'RaceLeadB' },
    );

    // Two concurrent addMember(LEAD_WORKER) attempts: both must fail while
    // the founding lead holds the single ACTIVE lead seat.
    const addResults = await Promise.allSettled([
      addHandymanWorkCrewMember(
        base.crew.id,
        {
          vendorWorkforceBindingId: candidateA.binding.id,
          crewRole: 'LEAD_WORKER',
        },
        adminUserId,
      ),
      addHandymanWorkCrewMember(
        base.crew.id,
        {
          vendorWorkforceBindingId: candidateB.binding.id,
          crewRole: 'LEAD_WORKER',
        },
        adminUserId,
      ),
    ]);
    assert.equal(
      addResults.filter((r) => r.status === 'fulfilled').length,
      0,
    );
    for (const result of addResults) {
      assert.equal(
        (result as PromiseRejectedResult).reason?.code,
        'HANDYMAN_WORK_CREW_LEAD_ALREADY_ACTIVE',
      );
    }

    // Two concurrent atomic lead replacements serialize on the crew lock;
    // whatever the ordering, exactly one ACTIVE lead remains.
    const changeResults = await Promise.allSettled([
      changeHandymanWorkCrewLeadWorker(base.crew.id, {
        newLeadWorkerBindingId: candidateA.binding.id,
      }, adminUserId),
      changeHandymanWorkCrewLeadWorker(base.crew.id, {
        newLeadWorkerBindingId: candidateB.binding.id,
      }, adminUserId),
    ]);
    assert.ok(
      changeResults.filter((r) => r.status === 'fulfilled').length >= 1,
    );
    const leadRows = await requirePool().query(
      `SELECT COUNT(*)::INT AS n FROM handyman_work_crew_members
       WHERE crew_id = $1 AND crew_role = 'LEAD_WORKER' AND status = 'ACTIVE'`,
      [base.crew.id],
    );
    assert.equal(leadRows.rows[0].n, 1);
  });

  it('concurrent lead removal and replacement never leave an ACTIVE crew without a lead', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();
    const successor = await createWorker(
      base.ctx,
      base.chain,
      base.ctx.vendor.id,
      { role: 'RaceSuccessor' },
    );

    const results = await Promise.allSettled([
      removeHandymanWorkCrewMember(base.crew.id, base.leadMember.id, adminUserId),
      removeHandymanWorkCrewMember(base.crew.id, base.leadMember.id, adminUserId),
      changeHandymanWorkCrewLeadWorker(
        base.crew.id,
        { newLeadWorkerBindingId: successor.binding.id },
        adminUserId,
      ),
    ]);

    // Direct lead removals ALWAYS fail — regardless of interleaving. While
    // the founding lead is still ACTIVE the role ban rejects (403...409
    // LEAD_REMOVAL_FORBIDDEN); if a concurrent change-lead already closed
    // the row, the guarded-status check rejects (MEMBER_STATUS_INVALID).
    // Both outcomes prove removal can never succeed against the lead seat
    // (the CR03 concurrent-decision acceptance idiom).
    const removalOutcomes = results.slice(0, 2);
    for (const outcome of removalOutcomes) {
      assert.equal(outcome.status, 'rejected');
      assert.ok(
        [
          'HANDYMAN_WORK_CREW_LEAD_REMOVAL_FORBIDDEN',
          'HANDYMAN_WORK_CREW_MEMBER_STATUS_INVALID',
        ].includes((outcome as PromiseRejectedResult).reason?.code),
        `unexpected rejection code: ${(outcome as PromiseRejectedResult).reason?.code}`,
      );
    }

    const leadRows = await requirePool().query(
      `SELECT COUNT(*)::INT AS n FROM handyman_work_crew_members
       WHERE crew_id = $1 AND crew_role = 'LEAD_WORKER' AND status = 'ACTIVE'`,
      [base.crew.id],
    );
    assert.equal(leadRows.rows[0].n, 1);
    const crew = await getHandymanWorkCrewById(base.crew.id, adminUserId);
    assert.equal(crew.status, 'ACTIVE');
  });

  it('stale lifecycle transitions cannot overwrite newer state', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();

    const results = await Promise.allSettled([
      updateHandymanWorkCrewStatus(base.crew.id, { status: 'INACTIVE' }, adminUserId),
      updateHandymanWorkCrewStatus(base.crew.id, { status: 'INACTIVE' }, adminUserId),
    ]);
    assert.equal(
      results.filter((r) => r.status === 'fulfilled').length,
      1,
    );
    const loser = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    assert.equal(
      (loser.reason as { code?: string }).code,
      'HANDYMAN_WORK_CREW_STATUS_INVALID',
    );
    const crew = await getHandymanWorkCrewById(base.crew.id, adminUserId);
    assert.equal(crew.status, 'INACTIVE');

    // Concurrent member closure: exactly one removal wins.
    await updateHandymanWorkCrewStatus(
      base.crew.id,
      { status: 'ACTIVE' },
      adminUserId,
    );
    const helper = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, {
      role: 'StaleRaceHelper',
    });
    const member = await addHandymanWorkCrewMember(
      base.crew.id,
      { vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER' },
      adminUserId,
    );
    const removeResults = await Promise.allSettled([
      removeHandymanWorkCrewMember(base.crew.id, member.id, adminUserId),
      removeHandymanWorkCrewMember(base.crew.id, member.id, adminUserId),
    ]);
    assert.equal(
      removeResults.filter((r) => r.status === 'fulfilled').length,
      1,
    );
    const removeLoser = removeResults.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    assert.equal(
      (removeLoser.reason as { code?: string }).code,
      'HANDYMAN_WORK_CREW_MEMBER_STATUS_INVALID',
    );
  });
});

describe('CR-HM-BE-04 RUN 1: audit + privacy', () => {
  it('records crew lifecycle events with IDs only — no worker PII', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();
    const helper = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, {
      role: 'AuditHelper',
      personnelCode: `VPC-SECRET-${suffix()}`,
    });
    const newLead = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, {
      role: 'AuditNewLead',
      personnelCode: `VPC-SECRET-${suffix()}`,
    });

    const member = await addHandymanWorkCrewMember(
      base.crew.id,
      { vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER' },
      adminUserId,
    );
    await removeHandymanWorkCrewMember(base.crew.id, member.id, adminUserId);
    await changeHandymanWorkCrewLeadWorker(base.crew.id, {
      newLeadWorkerBindingId: newLead.binding.id,
    }, adminUserId);
    await updateHandymanWorkCrew(
      base.crew.id,
      { crewName: 'Audit Renamed Crew' },
      adminUserId,
    );
    await updateHandymanWorkCrewStatus(
      base.crew.id,
      { status: 'INACTIVE' },
      adminUserId,
    );
    await updateHandymanWorkCrewStatus(
      base.crew.id,
      { status: 'ACTIVE' },
      adminUserId,
    ).catch(() => undefined); // reactivation may fail (lead chain) — event coverage below is unaffected

    const events = await requirePool().query<{
      event_type: string;
      entity_id: string;
      summary: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT event_type, entity_id, summary, metadata
       FROM operational_events
       WHERE entity_type = 'HANDYMAN_WORK_CREW' AND client_id = $1
       ORDER BY created_at ASC`,
      [base.ctx.client.id],
    );

    const types = new Set(events.rows.map((row) => row.event_type));
    assert.ok(types.has('HANDYMAN_WORK_CREW_CREATED'));
    assert.ok(types.has('HANDYMAN_WORK_CREW_MEMBER_ADDED'));
    assert.ok(types.has('HANDYMAN_WORK_CREW_MEMBER_REMOVED'));
    assert.ok(types.has('HANDYMAN_WORK_CREW_LEAD_CHANGED'));
    assert.ok(types.has('HANDYMAN_WORK_CREW_UPDATED'));
    assert.ok(types.has('HANDYMAN_WORK_CREW_DEACTIVATED'));
    for (const row of events.rows) {
      assert.equal(row.entity_id, base.crew.id);
    }

    // PII canaries: worker full names and vendor personnel codes must never
    // appear in event summaries or metadata (IDs/status/role are sufficient).
    const canaries = [
      base.lead.fullName,
      base.lead.vendorPersonnelCode,
      helper.fullName,
      helper.vendorPersonnelCode,
      newLead.fullName,
      newLead.vendorPersonnelCode,
    ];
    const forbiddenKeys = ['fullName', 'employeeCode', 'vendorPersonnelCode'];
    for (const row of events.rows) {
      const blob = `${row.summary} ${JSON.stringify(row.metadata)}`;
      for (const canary of canaries) {
        assert.equal(
          blob.includes(canary),
          false,
          `operational event leaked PII (${canary}) in ${row.event_type}`,
        );
      }
      for (const key of forbiddenKeys) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(row.metadata, key),
          false,
          `operational event metadata carries forbidden key ${key}`,
        );
      }
      assert.equal(row.summary.includes(base.lead.fullName), false);
    }

    // Actor attribution present on every event.
    const actors = await requirePool().query(
      `SELECT COUNT(*)::INT AS n FROM operational_events
       WHERE entity_type = 'HANDYMAN_WORK_CREW' AND client_id = $1
         AND actor_user_id = $2`,
      [base.ctx.client.id, adminUserId],
    );
    assert.equal(actors.rows[0].n, events.rows.length);
  });

  it('never creates users, credentials, or building access for crew workers', async (t) => {
    if (!ready(t)) return;

    const base = await createCrewContext();
    const helper = await createWorker(base.ctx, base.chain, base.ctx.vendor.id, {
      role: 'NoAccountHelper',
    });
    await addHandymanWorkCrewMember(
      base.crew.id,
      { vendorWorkforceBindingId: helper.binding.id, crewRole: 'HELPER' },
      adminUserId,
    );

    const userRows = await requirePool().query(
      'SELECT user_id FROM workforce_profiles WHERE id = $1',
      [helper.profile.id],
    );
    assert.equal(userRows.rows[0].user_id, null);

    const accessRows = await requirePool().query(
      `SELECT COUNT(*)::INT AS n
       FROM user_building_assignments uba
       JOIN users u ON u.id = uba.user_id
       JOIN workforce_profiles wp ON wp.user_id = u.id
       WHERE wp.id = $1`,
      [helper.profile.id],
    );
    assert.equal(accessRows.rows[0].n, 0);

    const bindingCount = await requirePool().query(
      `SELECT COUNT(*)::INT AS n FROM vendor_workforce_bindings
       WHERE workforce_profile_id = $1`,
      [helper.profile.id],
    );
    assert.equal(bindingCount.rows[0].n, 1); // the fixture's single binding — no duplicates created
  });
});
