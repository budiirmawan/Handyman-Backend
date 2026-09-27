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
} from '../src/modules/handyman-providers';
import type { CreateHandymanWorkerContextInput } from '../src/modules/handyman-providers';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { vendorService } from '../src/modules/vendors';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-04 PART 02 — focused tests for the Handyman Worker Context
 * (FROZEN F2/F5/F8/F9/F10).
 *
 * Ten cases prove: worker-context creation grounded on the ACTIVE
 * provider context + workforce profile + ACTIVE vendor↔workforce binding
 * (read-only; never synthesized); login-less helpers (`userId` NULL)
 * accepted; one context per provider/profile pair; cross-client and
 * inactive-provider rejection; bounded ACTIVE ⇄ INACTIVE lifecycle; actor
 * smuggle-proofing; atomic mutation + journal; and zero mutation of the
 * workforce/vendor masters or crew/assignment surfaces.
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
  await pool.query(`TRUNCATE handyman_worker_contexts,
    handyman_provider_contexts, handyman_request_referrals,
    handyman_request_diagnoses, handyman_request_inspections,
    handyman_request_triage_decisions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    handyman_discipline_service_associations, service_catalog,
    vendor_workforce_bindings, vendor_capabilities, vendor_pics,
    vendor_categories, vendors, workforce_profiles, organizations,
    evidence_submissions, operational_events, tenant_service_requests,
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

/** Client realm + org/department/position chain in the SAME client. */
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

/** Realm + vendor + ACTIVE provider context. */
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

async function workforceProfile(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  userId: string | null,
  label: string,
) {
  return workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `${label}_${suffix()}`,
    fullName: `Worker ${label}`,
    workforceType: 'EXTERNAL',
    userId,
  });
}

/** Profile bound ACTIVE to the fixture vendor (vendor-authoritative seam). */
async function boundProfileFixture(
  withUserAccount = false,
) {
  const f = await providerFixture();
  const profile = await workforceProfile(
    f,
    withUserAccount ? adminUserId : null,
    'P1',
  );
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: f.vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VP_${suffix()}`,
  });
  return { ...f, profile };
}

describe('CR-HM-04 PART 02 — Handyman worker context', () => {
  it('1: ACTIVE provider + valid bound workforce profile → ACTIVE worker context', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await boundProfileFixture(true);
    const context = await handymanWorkerContextService
      .createHandymanWorkerContext(
        {
          handymanProviderContextId: f.providerContext.id,
          workforceProfileId: f.profile.id,
        },
        adminUserId,
      );
    assert.ok(context.id);
    assert.equal(context.handymanProviderContextId, f.providerContext.id);
    assert.equal(context.workforceProfileId, f.profile.id);
    assert.equal(context.clientId, f.client.id);
    assert.equal(context.status, 'ACTIVE');
    assert.equal(context.createdByUserId, adminUserId);
  });

  it('2: login-less workforce profile (userId NULL) is accepted', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await providerFixture();
    const helper = await workforceProfile(f, null, 'HELPER');
    assert.equal(helper.userId, null);
    await vendorWorkforceService.createVendorWorkforceBinding({
      vendorId: f.vendor.id,
      workforceProfileId: helper.id,
      vendorPersonnelCode: `VP_${suffix()}`,
    });
    const context = await handymanWorkerContextService
      .createHandymanWorkerContext(
        {
          handymanProviderContextId: f.providerContext.id,
          workforceProfileId: helper.id,
        },
        adminUserId,
      );
    assert.equal(context.status, 'ACTIVE');
    assert.equal(context.workforceProfileId, helper.id);
    const row = await q(
      'SELECT user_id FROM workforce_profiles WHERE id = $1',
      [helper.id],
    );
    assert.equal(row.rows[0].user_id, null, 'helper stays login-less');
  });

  it('3: duplicate provider/profile pair is rejected (race-safe 409)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await boundProfileFixture();
    await handymanWorkerContextService.createHandymanWorkerContext(
      {
        handymanProviderContextId: f.providerContext.id,
        workforceProfileId: f.profile.id,
      },
      adminUserId,
    );
    const before = await tableCount('handyman_worker_contexts');
    await assert.rejects(
      handymanWorkerContextService.createHandymanWorkerContext(
        {
          handymanProviderContextId: f.providerContext.id,
          workforceProfileId: f.profile.id,
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_WORKER_CONTEXT_ALREADY_EXISTS',
    );
    assert.equal(await tableCount('handyman_worker_contexts'), before);
  });

  it('4: INACTIVE provider context rejects new worker contexts', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await providerFixture();
    await handymanProviderContextService.setHandymanProviderContextStatus(
      f.providerContext.id, 'INACTIVE', adminUserId);
    const profile = await workforceProfile(f, null, 'P2');
    await vendorWorkforceService.createVendorWorkforceBinding({
      vendorId: f.vendor.id,
      workforceProfileId: profile.id,
      vendorPersonnelCode: `VP_${suffix()}`,
    });
    const before = await tableCount('handyman_worker_contexts');
    await assert.rejects(
      handymanWorkerContextService.createHandymanWorkerContext(
        {
          handymanProviderContextId: f.providerContext.id,
          workforceProfileId: profile.id,
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_WORKFORCE_BINDING_REQUIRED',
    );
    assert.equal(await tableCount('handyman_worker_contexts'), before);
  });

  it('5: cross-client / unbound profile is rejected (never synthesized)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await providerFixture();
    // (a) profile from ANOTHER client realm, unbound to this vendor
    const foreignRealm = await realmFixture();
    const foreignProfile = await workforceProfile(
      foreignRealm, null, 'FOREIGN');
    await assert.rejects(
      handymanWorkerContextService.createHandymanWorkerContext(
        {
          handymanProviderContextId: f.providerContext.id,
          workforceProfileId: foreignProfile.id,
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_WORKFORCE_BINDING_REQUIRED',
    );
    // (b) same-client profile WITHOUT the vendor binding → required-but-absent
    const unbound = await workforceProfile(f, null, 'UNBOUND');
    await assert.rejects(
      handymanWorkerContextService.createHandymanWorkerContext(
        {
          handymanProviderContextId: f.providerContext.id,
          workforceProfileId: unbound.id,
        },
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_WORKFORCE_BINDING_REQUIRED',
    );
    const bindingsBefore = await tableCount('vendor_workforce_bindings');
    try {
      await handymanWorkerContextService.createHandymanWorkerContext(
        {
          handymanProviderContextId: f.providerContext.id,
          workforceProfileId: unbound.id,
        },
        adminUserId,
      );
    } catch {
      /* expected */
    }
    const bindingsAfter = await tableCount('vendor_workforce_bindings');
    assert.equal(bindingsAfter, bindingsBefore, 'vendor bindings untouched');
  });

  it('6: ACTIVE → INACTIVE (state preserved + history)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await boundProfileFixture();
    const context = await handymanWorkerContextService
      .createHandymanWorkerContext(
        {
          handymanProviderContextId: f.providerContext.id,
          workforceProfileId: f.profile.id,
        },
        adminUserId,
      );
    const dormant = await handymanWorkerContextService
      .setHandymanWorkerContextStatus(context.id, 'INACTIVE', adminUserId);
    assert.equal(dormant.status, 'INACTIVE');
    const journal = await q(
      `SELECT event_type, metadata FROM operational_events
        WHERE entity_type = 'HANDYMAN_WORKER_CONTEXT' AND entity_id = $1
        ORDER BY occurred_at ASC, created_at ASC`,
      [context.id],
    );
    assert.deepEqual(
      journal.rows.map((r: { event_type: string }) => r.event_type),
      [
        'HANDYMAN_WORKER_CONTEXT_CREATED',
        'HANDYMAN_WORKER_CONTEXT_STATUS_CHANGED',
      ],
    );
    assert.equal(journal.rows[1].metadata.fromStatus, 'ACTIVE');
    assert.equal(journal.rows[1].metadata.toStatus, 'INACTIVE');
  });

  it('7: INACTIVE → ACTIVE works; invalid/same-state rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await boundProfileFixture();
    const context = await handymanWorkerContextService
      .createHandymanWorkerContext(
        {
          handymanProviderContextId: f.providerContext.id,
          workforceProfileId: f.profile.id,
        },
        adminUserId,
      );
    await handymanWorkerContextService.setHandymanWorkerContextStatus(
      context.id, 'INACTIVE', adminUserId);
    const back = await handymanWorkerContextService
      .setHandymanWorkerContextStatus(context.id, 'ACTIVE', adminUserId);
    assert.equal(back.status, 'ACTIVE');
    await assert.rejects(
      handymanWorkerContextService.setHandymanWorkerContextStatus(
        context.id, 'ACTIVE', adminUserId),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_WORKER_CONTEXT_INVALID_STATUS',
    );
    await assert.rejects(
      handymanWorkerContextService.setHandymanWorkerContextStatus(
        context.id, 'SUSPENDED', adminUserId),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_WORKER_CONTEXT_INVALID_STATUS',
    );
  });

  it('8: actor/context smuggling cannot become authority', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await boundProfileFixture();
    const foreign = await providerFixture();
    const smuggled = {
      handymanProviderContextId: f.providerContext.id,
      workforceProfileId: f.profile.id,
      clientId: foreign.client.id,
      createdByUserId: foreign.providerContext.id,
      actorUserId: randomUUID(),
      vendorPicId: randomUUID(),
      tenantPicId: randomUUID(),
    } as unknown as CreateHandymanWorkerContextInput;
    const context = await handymanWorkerContextService
      .createHandymanWorkerContext(smuggled, adminUserId);
    assert.equal(context.clientId, f.client.id);
    assert.notEqual(context.clientId, foreign.client.id);
    assert.equal(context.createdByUserId, adminUserId);
    const journal = await q(
      `SELECT actor_user_id FROM operational_events
        WHERE entity_id = $1
          AND event_type = 'HANDYMAN_WORKER_CONTEXT_CREATED'`,
      [context.id],
    );
    assert.equal(journal.rows[0].actor_user_id, adminUserId);
  });

  it('9: mutation + journal atomic (failure leaves zero partial commits)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await boundProfileFixture();
    const beforeCtx = await tableCount('handyman_worker_contexts');
    const beforeEv = await tableCount('operational_events');
    const context = await handymanWorkerContextService
      .createHandymanWorkerContext(
        {
          handymanProviderContextId: f.providerContext.id,
          workforceProfileId: f.profile.id,
        },
        adminUserId,
      );
    assert.equal(await tableCount('handyman_worker_contexts'), beforeCtx + 1);
    assert.equal(await tableCount('operational_events'), beforeEv + 1);
    // forced failure (nonexistent realm actor) — zero partial commits
    await assert.rejects(
      handymanWorkerContextService.setHandymanWorkerContextStatus(
        context.id, 'INACTIVE', randomUUID()),
    );
    assert.equal(await tableCount('operational_events'), beforeEv + 1);
    const rows = await q(
      'SELECT status FROM handyman_worker_contexts WHERE id = $1',
      [context.id],
    );
    assert.equal(rows.rows[0].status, 'ACTIVE');
  });

  it('10: workforce/vendor masters + crew/assignment surfaces unchanged', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await boundProfileFixture();
    const profileBefore = await q(
      'SELECT full_name, employee_code, user_id FROM workforce_profiles WHERE id = $1',
      [f.profile.id],
    );
    const before = {
      workforce_profiles: await tableCount('workforce_profiles'),
      vendor_workforce_bindings: await tableCount('vendor_workforce_bindings'),
      vendors: await tableCount('vendors'),
      teams: await tableCount('teams'),
      work_order_assignments: await tableCount('work_order_assignments'),
    };
    const context = await handymanWorkerContextService
      .createHandymanWorkerContext(
        {
          handymanProviderContextId: f.providerContext.id,
          workforceProfileId: f.profile.id,
        },
        adminUserId,
      );
    await handymanWorkerContextService.setHandymanWorkerContextStatus(
      context.id, 'INACTIVE', adminUserId);
    await handymanWorkerContextService.setHandymanWorkerContextStatus(
      context.id, 'ACTIVE', adminUserId);
    for (const [name, count] of Object.entries(before)) {
      assert.equal(await tableCount(name), count, `${name} unchanged`);
    }
    const profileAfter = await q(
      'SELECT full_name, employee_code, user_id FROM workforce_profiles WHERE id = $1',
      [f.profile.id],
    );
    assert.deepEqual(profileAfter.rows[0], profileBefore.rows[0]);
  });
});
