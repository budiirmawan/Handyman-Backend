import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import {
  handymanProviderContextService,
  handymanWorkerContextService,
  handymanWorkCrewService,
} from '../src/modules/handyman-providers';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { userService } from '../src/modules/users';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { vendorService } from '../src/modules/vendors';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-04 PART 03 — focused tests for Handyman Work Crew / Membership /
 * Lead (FROZEN F3/F4/F5/F8/F9/F10).
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_crew_leads, handyman_crew_memberships,
    handyman_work_crews, handyman_worker_contexts,
    handyman_provider_contexts, handyman_request_referrals,
    handyman_request_diagnoses, handyman_request_inspections,
    handyman_request_triage_decisions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    handyman_discipline_service_associations, service_catalog,
    vendor_workforce_bindings, vendor_capabilities, vendor_pics,
    vendor_categories, vendors, workforce_profiles, organizations,
    attendance_records, operational_events, tenant_service_requests,
    work_requests, work_orders, vendor_quotations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

async function tableCount(name: string): Promise<number> {
  const result = await q(`SELECT count(*)::int AS n FROM ${name}`);
  return result.rows[0].n as number;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

async function realmFixture() {
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
  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `O_${suffix()}`,
    name: 'Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Worker Position',
  });
  return { client, property, building, organization, department, position };
}

async function providerFixture() {
  const realm = await realmFixture();
  const vendor = await vendorService.createVendor({
    clientId: realm.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Acme Providers',
  });
  const providerContext = await handymanProviderContextService
    .createHandymanProviderContext({ vendorId: vendor.id }, adminUserId);
  return { ...realm, vendor, providerContext };
}

async function newLinkedUserId(): Promise<string> {
  const user = await userService.createUser({
    email: `crew-${suffix().toLowerCase()}@example.com`,
    displayName: 'Crew Worker User',
  });
  return user.id;
}

/** userId=true ⇒ a FRESH app user is created and linked (profiles allow exactly ONE linked profile per user). */
async function profileIn(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  userId: string | null | 'FRESH_USER',
  label: string,
) {
  const resolved = userId === 'FRESH_USER' ? await newLinkedUserId() : userId;
  return workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `${label}_${suffix()}`,
    fullName: `Worker ${label}`,
    workforceType: 'EXTERNAL',
    userId: resolved,
  });
}

/** Profile bound ACTIVE to the fixture vendor + worker context created. */
async function workerContextFixture(
  provider: Awaited<ReturnType<typeof providerFixture>>,
  userId: string | null | 'FRESH_USER',
  label: string,
) {
  const profile = await profileIn(provider, userId, label);
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: provider.vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VP_${suffix()}`,
  });
  const workerContext = await handymanWorkerContextService
    .createHandymanWorkerContext(
      {
        handymanProviderContextId: provider.providerContext.id,
        workforceProfileId: profile.id,
      },
      adminUserId,
    );
  return { profile, workerContext };
}

async function crewFixture() {
  const provider = await providerFixture();
  const leadWU = await workerContextFixture(provider, 'FRESH_USER', 'LEAD');
  const bundle = await handymanWorkCrewService.createHandymanWorkCrew(
    {
      handymanProviderContextId: provider.providerContext.id,
      code: `CREW_${suffix()}`,
      name: 'Field Crew',
      leadWorkerContextId: leadWU.workerContext.id,
    },
    adminUserId,
  );
  return { provider, leadWU, bundle };
}

describe('CR-HM-04 PART 03 — work crew / membership / lead', () => {
  it('1: ACTIVE crew created atomically with a valid Lead member', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await crewFixture();
    assert.equal(f.bundle.crew.status, 'ACTIVE');
    assert.equal(f.bundle.leadMembership.status, 'ACTIVE');
    assert.equal(
      f.bundle.lead.handymanCrewMembershipId,
      f.bundle.leadMembership.id,
    );
    const read = await handymanWorkCrewService.getHandymanWorkCrew(
      f.bundle.crew.id,
    );
    assert.equal(read.currentLead?.handymanCrewMembershipId,
      f.bundle.leadMembership.id);
    assert.equal(read.members.length, 1);
  });

  it('2: login-less helper joins as ordinary member', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await crewFixture();
    const helper = await workerContextFixture(f.provider, null, 'HELPER');
    const membership = await handymanWorkCrewService.addHandymanCrewMember(
      {
        handymanCrewId: f.bundle.crew.id,
        handymanWorkerContextId: helper.workerContext.id,
      },
      adminUserId,
    );
    assert.equal(membership.status, 'ACTIVE');
    assert.equal(helper.profile.userId, null);
    const row = await q(
      'SELECT user_id FROM workforce_profiles WHERE id = $1',
      [helper.profile.id],
    );
    assert.equal(row.rows[0].user_id, null);
  });

  it('3: login-less helper cannot become Lead', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await crewFixture();
    const helper = await workerContextFixture(f.provider, null, 'HELPER');
    await handymanWorkCrewService.addHandymanCrewMember(
      {
        handymanCrewId: f.bundle.crew.id,
        handymanWorkerContextId: helper.workerContext.id,
      },
      adminUserId,
    );
    await assert.rejects(
      handymanWorkCrewService.designateHandymanCrewLead(
        {
          handymanCrewId: f.bundle.crew.id,
          handymanWorkerContextId: helper.workerContext.id,
        },
        adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_CREW_LEAD_INVALID',
    );
    const leads = await q(
      'SELECT count(*)::int AS n FROM handyman_crew_leads WHERE handyman_crew_id = $1',
      [f.bundle.crew.id],
    );
    assert.equal(leads.rows[0].n, 1, 'designation list stays one');
  });

  it('4: cross-provider / cross-client workers cannot be members', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await crewFixture();
    const foreign = await workerContextFixture(
      await providerFixture(), null, 'FOREIGN');
    const before = await tableCount('handyman_crew_memberships');
    await assert.rejects(
      handymanWorkCrewService.addHandymanCrewMember(
        {
          handymanCrewId: f.bundle.crew.id,
          handymanWorkerContextId: foreign.workerContext.id,
        },
        adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_CREW_LEAD_INVALID',
    );
    assert.equal(await tableCount('handyman_crew_memberships'), before);
  });

  it('5: INACTIVE worker context cannot be added', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await crewFixture();
    const helper = await workerContextFixture(f.provider, null, 'HELPER');
    await handymanWorkerContextService.setHandymanWorkerContextStatus(
      helper.workerContext.id, 'INACTIVE', adminUserId);
    const before = await tableCount('handyman_crew_memberships');
    await assert.rejects(
      handymanWorkCrewService.addHandymanCrewMember(
        {
          handymanCrewId: f.bundle.crew.id,
          handymanWorkerContextId: helper.workerContext.id,
        },
        adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_CREW_LEAD_INVALID',
    );
    assert.equal(await tableCount('handyman_crew_memberships'), before);
  });

  it('6: lead change preserves history; exactly one current Lead', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await crewFixture();
    const nextLead = await workerContextFixture(
      f.provider, 'FRESH_USER', 'NEXTLEAD');
    await handymanWorkCrewService.addHandymanCrewMember(
      {
        handymanCrewId: f.bundle.crew.id,
        handymanWorkerContextId: nextLead.workerContext.id,
      },
      adminUserId,
    );
    const designation = await handymanWorkCrewService
      .designateHandymanCrewLead(
        {
          handymanCrewId: f.bundle.crew.id,
          handymanWorkerContextId: nextLead.workerContext.id,
        },
        adminUserId,
      );
    assert.ok(designation.leadSeq > f.bundle.lead.leadSeq);
    const read = await handymanWorkCrewService.getHandymanWorkCrew(
      f.bundle.crew.id,
    );
    assert.equal(
      read.currentLead?.handymanCrewMembershipId,
      designation.handymanCrewMembershipId,
    );
    const history = await q(
      `SELECT handyman_crew_membership_id, lead_seq FROM handyman_crew_leads
        WHERE handyman_crew_id = $1 ORDER BY lead_seq`,
      [f.bundle.crew.id],
    );
    assert.equal(history.rowCount, 2, 'old designation preserved');
    assert.equal(
      history.rows[0].handyman_crew_membership_id,
      f.bundle.leadMembership.id,
    );
    assert.equal(
      history.rows[1].handyman_crew_membership_id,
      designation.handymanCrewMembershipId,
    );
    const journal = await q(
      `SELECT metadata FROM operational_events
        WHERE entity_id = $1
          AND event_type = 'HANDYMAN_CREW_LEAD_DESIGNATED'
        ORDER BY occurred_at ASC, created_at ASC`,
      [f.bundle.crew.id],
    );
    assert.equal(journal.rows[1].metadata.fromLeadMembershipId,
      f.bundle.leadMembership.id);
    assert.equal(journal.rows[1].metadata.leadMembershipId,
      designation.handymanCrewMembershipId);
  });

  it('7: current Lead membership cannot deactivate while designated', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await crewFixture();
    await assert.rejects(
      handymanWorkCrewService.setHandymanCrewMemberStatus(
        f.bundle.leadMembership.id, 'INACTIVE', adminUserId),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_CREW_LEAD_MEMBERSHIP_LOCKED',
    );
    const row = await q(
      'SELECT status FROM handyman_crew_memberships WHERE id = $1',
      [f.bundle.leadMembership.id],
    );
    assert.equal(row.rows[0].status, 'ACTIVE');
  });

  it('8: crew lifecycle preserves the valid-Lead invariant', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await crewFixture();
    // ACTIVE → INACTIVE → ACTIVE works with a valid Lead in place
    await handymanWorkCrewService.setHandymanWorkCrewStatus(
      f.bundle.crew.id, 'INACTIVE', adminUserId);
    const back = await handymanWorkCrewService.setHandymanWorkCrewStatus(
      f.bundle.crew.id, 'ACTIVE', adminUserId);
    assert.equal(back.status, 'ACTIVE');
    // poison the Lead channel below the crew context
    await handymanWorkerContextService.setHandymanWorkerContextStatus(
      f.leadWU.workerContext.id, 'INACTIVE', adminUserId);
    await handymanWorkCrewService.setHandymanWorkCrewStatus(
      f.bundle.crew.id, 'INACTIVE', adminUserId);
    await assert.rejects(
      handymanWorkCrewService.setHandymanWorkCrewStatus(
        f.bundle.crew.id, 'ACTIVE', adminUserId),
      (e: unknown) => errorCode(e) === 'HANDYMAN_CREW_LEAD_REQUIRED',
    );
    const row = await q(
      'SELECT status FROM handyman_work_crews WHERE id = $1',
      [f.bundle.crew.id],
    );
    assert.equal(row.rows[0].status, 'INACTIVE');
  });

  it('9: crew/member/lead mutation + journal atomic (failure = zero partial commits)', async (t) => {
    if (!requireDatabase(t)) return;
    const provider = await providerFixture();
    const helper = await workerContextFixture(provider, null, 'HELPER');
    // fixtures journal their own events (worker-context created etc.) — build
    // them BEFORE the baseline so only the crew ops are counted below
    const leadWU = await workerContextFixture(provider, 'FRESH_USER', 'LEAD');
    const beforeCrew = await tableCount('handyman_work_crews');
    const beforeMem = await tableCount('handyman_crew_memberships');
    const beforeLead = await tableCount('handyman_crew_leads');
    const beforeEv = await tableCount('operational_events');
    // login-less candidate as initial Lead → whole tx must roll back
    await assert.rejects(
      handymanWorkCrewService.createHandymanWorkCrew(
        {
          handymanProviderContextId: provider.providerContext.id,
          code: `CREW_${suffix()}`,
          name: 'Paradox Crew',
          leadWorkerContextId: helper.workerContext.id,
        },
        adminUserId,
      ),
      (e: unknown) => errorCode(e) === 'HANDYMAN_CREW_LEAD_INVALID',
    );
    assert.equal(await tableCount('handyman_work_crews'), beforeCrew);
    assert.equal(await tableCount('handyman_crew_memberships'), beforeMem);
    assert.equal(await tableCount('handyman_crew_leads'), beforeLead);
    assert.equal(await tableCount('operational_events'), beforeEv);
    // happy path: one tx commits crew + membership + lead + 3 events
    const bundle = await handymanWorkCrewService.createHandymanWorkCrew(
      {
        handymanProviderContextId: provider.providerContext.id,
        code: `CREW_${suffix()}`,
        name: 'Atomic Crew',
        leadWorkerContextId: leadWU.workerContext.id,
      },
      adminUserId,
    );
    assert.equal(await tableCount('handyman_work_crews'), beforeCrew + 1);
    assert.equal(await tableCount('handyman_crew_memberships'), beforeMem + 1);
    assert.equal(await tableCount('handyman_crew_leads'), beforeLead + 1);
    assert.equal(await tableCount('operational_events'), beforeEv + 3);
    assert.equal(bundle.crew.status, 'ACTIVE');
  });

  it('10: teams/workforce/vendor/assignment/attendance/session surfaces unchanged', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await crewFixture();
    const helper = await workerContextFixture(f.provider, null, 'HELPER');
    const tables = [
      'teams',
      'workforce_profiles',
      'vendors',
      'vendor_workforce_bindings',
      'work_order_assignments',
      'attendance_records',
    ];
    // baseline AFTER fixture setup: crew/member/lead/lifecycle ops must now
    // touch NOTHING in these tables
    const before = Object.fromEntries(
      await Promise.all(tables.map(async (n) => [n, await tableCount(n)])),
    );
    await handymanWorkCrewService.addHandymanCrewMember(
      {
        handymanCrewId: f.bundle.crew.id,
        handymanWorkerContextId: helper.workerContext.id,
      },
      adminUserId,
    );
    await handymanWorkCrewService.setHandymanWorkCrewStatus(
      f.bundle.crew.id, 'INACTIVE', adminUserId);
    await handymanWorkCrewService.setHandymanWorkCrewStatus(
      f.bundle.crew.id, 'ACTIVE', adminUserId);
    for (const name of tables) {
      assert.equal(await tableCount(name), before[name], `${name} unchanged`);
    }
    const profile = await q(
      'SELECT full_name, employee_code, user_id FROM workforce_profiles WHERE id = $1',
      [helper.profile.id],
    );
    assert.equal(profile.rows[0].user_id, null, 'helper stays login-less');
  });
});
