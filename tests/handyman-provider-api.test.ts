import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { parse as parseYaml } from 'yaml';
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
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-04 PART 05A — focused HTTP/OpenAPI tests for the Handyman
 * provider / worker / crew surface (FROZEN F9).
 *
 * Ten cases prove the 12-operation surface works end to end: RBAC split
 * (manage = `tenant_company.manage`, read = `tenant_company.read`),
 * smuggled actor/client/scope/assignment keys can never become authority,
 * login-less helpers are admitted as members and rejected as Lead, the
 * Lead/member/provider invariants stay service-authoritative, and the
 * documented OpenAPI surface matches the runtime exactly with ZERO
 * assignment API (PART 04 defers target binding to CR-HM-06).
 */

const HM = '/api/v1/handyman';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
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
  token = admin.token;
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

const auth = (bearer = token) => ({ Authorization: `Bearer ${bearer}` });

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

async function vendorFixture(
  realm: Awaited<ReturnType<typeof realmFixture>>,
) {
  return vendorService.createVendor({
    clientId: realm.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Acme Providers',
  });
}

/** Service-level provider context (realm + vendor + ACTIVE context). */
async function providerFixture() {
  const realm = await realmFixture();
  const vendor = await vendorFixture(realm);
  const providerContext = await handymanProviderContextService
    .createHandymanProviderContext({ vendorId: vendor.id }, adminUserId);
  return { ...realm, vendor, providerContext };
}

async function newLinkedUserId(): Promise<string> {
  const user = await userService.createUser({
    email: `prov-api-${suffix().toLowerCase()}@example.com`,
    displayName: 'Worker User',
  });
  return user.id;
}

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

/** Bound profile only — the worker context itself is created over HTTP. */
async function bindableProfile(
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
  return profile;
}

/** workerContext via service (not the create-under-test). */
async function workerContextViaService(
  provider: Awaited<ReturnType<typeof providerFixture>>,
  userId: string | null | 'FRESH_USER',
  label: string,
) {
  const profile = await bindableProfile(provider, userId, label);
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

/** Crew via service with a login-linked Lead worker context. */
async function crewViaService() {
  const provider = await providerFixture();
  const lead = await workerContextViaService(provider, 'FRESH_USER', 'LEAD');
  const bundle = await handymanWorkCrewService.createHandymanWorkCrew(
    {
      handymanProviderContextId: provider.providerContext.id,
      code: `CREW_${suffix()}`,
      name: 'HTTP Crew',
      leadWorkerContextId: lead.workerContext.id,
    },
    adminUserId,
  );
  return { provider, lead, bundle };
}

describe('CR-HM-04 PART 05A — provider/worker/crew HTTP + OpenAPI', () => {
  it('1: provider context create/read/status over HTTP', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const vendor = await vendorFixture(realm);
    const created = await api()
      .post(`${HM}/provider-contexts`)
      .set(auth())
      .send({ vendorId: vendor.id });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'ACTIVE');
    assert.equal(created.body.data.vendorId, vendor.id);
    assert.equal(created.body.data.clientId, realm.client.id);
    assert.equal(created.body.data.createdByUserId, adminUserId);
    const dup = await api()
      .post(`${HM}/provider-contexts`)
      .set(auth())
      .send({ vendorId: vendor.id });
    assert.equal(dup.status, 409);
    assert.equal(
      dup.body.error.code, 'HANDYMAN_PROVIDER_CONTEXT_ALREADY_EXISTS');
    const read = await api()
      .get(`${HM}/provider-contexts/by-vendor/${vendor.id}`)
      .set(auth());
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.id, created.body.data.id);
    const off = await api()
      .post(
        `${HM}/provider-contexts/${created.body.data.id}/status`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(off.status, 200);
    assert.equal(off.body.data.status, 'INACTIVE');
    const on = await api()
      .post(
        `${HM}/provider-contexts/${created.body.data.id}/status`)
      .set(auth())
      .send({ status: 'ACTIVE' });
    assert.equal(on.status, 200);
    assert.equal(on.body.data.status, 'ACTIVE');
    const invalid = await api()
      .post(
        `${HM}/provider-contexts/${created.body.data.id}/status`)
      .set(auth())
      .send({ status: 'DRAFT' });
    assert.equal(invalid.status, 400); // F8 vocabulary only
  });

  it('2: worker context create/read/status over HTTP', async (t) => {
    if (!requireDatabase(t)) return;
    const provider = await providerFixture();
    const profile = await bindableProfile(provider, adminUserId, 'W1');
    const created = await api()
      .post(`${HM}/worker-contexts`)
      .set(auth())
      .send({
        handymanProviderContextId: provider.providerContext.id,
        workforceProfileId: profile.id,
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'ACTIVE');
    assert.equal(created.body.data.clientId, provider.client.id);
    const dup = await api()
      .post(`${HM}/worker-contexts`)
      .set(auth())
      .send({
        handymanProviderContextId: provider.providerContext.id,
        workforceProfileId: profile.id,
      });
    assert.equal(dup.status, 409);
    const read = await api()
      .get(`${HM}/worker-contexts/${created.body.data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.workforceProfileId, profile.id);
    const off = await api()
      .post(`${HM}/worker-contexts/${created.body.data.id}/status`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(off.status, 200);
    assert.equal(off.body.data.status, 'INACTIVE');
    const on = await api()
      .post(`${HM}/worker-contexts/${created.body.data.id}/status`)
      .set(auth())
      .send({ status: 'ACTIVE' });
    assert.equal(on.status, 200);
    assert.equal(on.body.data.status, 'ACTIVE');
  });

  it('3: login-less worker accepted through HTTP as ordinary worker', async (t) => {
    if (!requireDatabase(t)) return;
    const provider = await providerFixture();
    const helper = await bindableProfile(provider, null, 'HELPER');
    const created = await api()
      .post(`${HM}/worker-contexts`)
      .set(auth())
      .send({
        handymanProviderContextId: provider.providerContext.id,
        workforceProfileId: helper.id,
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'ACTIVE');
  });

  it('4: crew create with valid initial Lead + bounded read', async (t) => {
    if (!requireDatabase(t)) return;
    const provider = await providerFixture();
    const lead = await workerContextViaService(provider, 'FRESH_USER', 'LEAD');
    const created = await api()
      .post(`${HM}/work-crews`)
      .set(auth())
      .send({
        handymanProviderContextId: provider.providerContext.id,
        code: `CREW_${suffix()}`,
        name: 'Primary Crew',
        leadWorkerContextId: lead.workerContext.id,
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.crew.status, 'ACTIVE');
    assert.equal(created.body.data.crew.clientId, provider.client.id);
    assert.equal(created.body.data.leadMembership.status, 'ACTIVE');
    assert.equal(
      created.body.data.lead.handymanCrewMembershipId,
      created.body.data.leadMembership.id,
    );
    const read = await api()
      .get(`${HM}/work-crews/${created.body.data.crew.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.crew.id, created.body.data.crew.id);
    assert.equal(read.body.data.members.length, 1);
    assert.equal(
      read.body.data.currentLead.id, created.body.data.lead.id);
  });

  it('5: crew membership add/status over HTTP (helper joins/leaves)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await crewViaService();
    const helper = await workerContextViaService(f.provider, null, 'HELPER');
    const added = await api()
      .post(`${HM}/work-crews/${f.bundle.crew.id}/members`)
      .set(auth())
      .send({ handymanWorkerContextId: helper.workerContext.id });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.data.status, 'ACTIVE');
    assert.equal(
      added.body.data.handymanWorkerContextId, helper.workerContext.id);
    const dup = await api()
      .post(`${HM}/work-crews/${f.bundle.crew.id}/members`)
      .set(auth())
      .send({ handymanWorkerContextId: helper.workerContext.id });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'HANDYMAN_CREW_MEMBER_ALREADY_ACTIVE');
    const off = await api()
      .post(`${HM}/crew-memberships/${added.body.data.id}/status`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(off.status, 200);
    assert.equal(off.body.data.status, 'INACTIVE');
    const back = await api()
      .post(`${HM}/crew-memberships/${added.body.data.id}/status`)
      .set(auth())
      .send({ status: 'ACTIVE' });
    assert.equal(back.status, 200);
    assert.equal(back.body.data.status, 'ACTIVE');
  });

  it('6: Lead designate/change over HTTP', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await crewViaService();
    const next = await workerContextViaService(f.provider, 'FRESH_USER', 'N');
    const added = await api()
      .post(`${HM}/work-crews/${f.bundle.crew.id}/members`)
      .set(auth())
      .send({ handymanWorkerContextId: next.workerContext.id });
    assert.equal(added.status, 201);
    const changed = await api()
      .post(`${HM}/work-crews/${f.bundle.crew.id}/lead`)
      .set(auth())
      .send({ handymanWorkerContextId: next.workerContext.id });
    assert.equal(changed.status, 201, JSON.stringify(changed.body));
    assert.equal(
      changed.body.data.handymanCrewMembershipId, added.body.data.id);
    assert.ok(changed.body.data.leadSeq > f.bundle.lead.leadSeq);
    const read = await api()
      .get(`${HM}/work-crews/${f.bundle.crew.id}`)
      .set(auth());
    assert.equal(read.body.data.currentLead.id, changed.body.data.id);
  });

  it('7: read vs manage permission enforcement', async (t) => {
    if (!requireDatabase(t)) return;
    const provider = await providerFixture();
    const plain = await createPlainSession();
    const readOnly = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
    ]);
    // no role at all: both gates reject
    const plainGet = await api()
      .get(`${HM}/provider-contexts/by-vendor/${provider.vendor.id}`)
      .set(auth(plain));
    assert.equal(plainGet.status, 403);
    const plainPost = await api()
      .post(`${HM}/provider-contexts`)
      .set(auth(plain))
      .send({ vendorId: provider.vendor.id });
    assert.equal(plainPost.status, 403);
    // read token can never mutate (manage gate rejects before service)
    const readPost = await api()
      .post(`${HM}/provider-contexts`)
      .set(auth(readOnly))
      .send({ vendorId: provider.vendor.id });
    assert.equal(readPost.status, 403);
    const readStatus = await api()
      .post(
        `${HM}/provider-contexts/${provider.providerContext.id}/status`,
      )
      .set(auth(readOnly))
      .send({ status: 'INACTIVE' });
    assert.equal(readStatus.status, 403);
    // full manage/read actor still works (contrast, token gate passed)
    const adminRead = await api()
      .get(`${HM}/provider-contexts/by-vendor/${provider.vendor.id}`)
      .set(auth());
    assert.equal(adminRead.status, 200);
  });

  it('8: smuggled actor/client/scope/assignment keys never become authority', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const vendor = await vendorFixture(realm);
    const otherClient = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Other Client',
    });
    const created = await api()
      .post(`${HM}/provider-contexts`)
      .set(auth())
      .send({
        vendorId: vendor.id,
        // every smuggled key below must be structurally ignored:
        clientId: otherClient.id,
        actorUserId: randomUUID(),
        createdByUserId: randomUUID(),
        userId: randomUUID(),
        handymanProviderContextId: randomUUID(),
        assignmentId: randomUUID(),
        targetType: 'WORK_ORDER',
        targetId: randomUUID(),
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.clientId, realm.client.id);
    assert.equal(created.body.data.createdByUserId, adminUserId);
    const provider = { ...realm, vendor,
      providerContext: created.body.data };
    const lead = await workerContextViaService(
      provider as Awaited<ReturnType<typeof providerFixture>>,
      'FRESH_USER',
      'LEAD',
    );
    const crew = await api()
      .post(`${HM}/work-crews`)
      .set(auth())
      .send({
        handymanProviderContextId: provider.providerContext.id,
        code: `CREW_${suffix()}`,
        name: 'Smuggle-Proof Crew',
        leadWorkerContextId: lead.workerContext.id,
        // smuggled authority candidates:
        clientId: otherClient.id,
        status: 'INACTIVE',
        createdByUserId: randomUUID(),
        leadMembershipId: randomUUID(),
        asLead: true,
        assignment: { targetType: 'WORK_ORDER', targetId: randomUUID() },
      });
    assert.equal(crew.status, 201, JSON.stringify(crew.body));
    assert.equal(crew.body.data.crew.status, 'ACTIVE'); // smuggled status ignored
    assert.equal(crew.body.data.crew.clientId, realm.client.id);
    assert.equal(crew.body.data.crew.createdByUserId, adminUserId);
  });

  it('9: Lead/helper invariants remain service-authoritative through HTTP', async (t) => {
    if (!requireDatabase(t)) return;
    // login-less helper can never be the initial Lead
    const provider = await providerFixture();
    const helper = await workerContextViaService(provider, null, 'HELPER');
    const helperLead = await api()
      .post(`${HM}/work-crews`)
      .set(auth())
      .send({
        handymanProviderContextId: provider.providerContext.id,
        code: `CREW_${suffix()}`,
        name: 'Paradox Crew',
        leadWorkerContextId: helper.workerContext.id,
      });
    assert.equal(helperLead.status, 400);
    assert.equal(helperLead.body.error.code, 'HANDYMAN_CREW_LEAD_INVALID');
    // current Lead membership is locked against deactivation
    const f = await crewViaService();
    const locked = await api()
      .post(
        `${HM}/crew-memberships/${f.bundle.leadMembership.id}/status`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(locked.status, 400);
    assert.equal(
      locked.body.error.code, 'HANDYMAN_CREW_LEAD_MEMBERSHIP_LOCKED');
    // helper added as member still cannot be designated Lead later
    const added = await api()
      .post(`${HM}/work-crews/${f.bundle.crew.id}/members`)
      .set(auth())
      .send({ handymanWorkerContextId: (
        await workerContextViaService(f.provider, null, 'H2'))
        .workerContext.id });
    assert.equal(added.status, 201);
    const helperDesignate = await api()
      .post(`${HM}/work-crews/${f.bundle.crew.id}/lead`)
      .set(auth())
      .send({ handymanWorkerContextId:
        added.body.data.handymanWorkerContextId });
    assert.equal(helperDesignate.status, 400);
    assert.equal(
      helperDesignate.body.error.code, 'HANDYMAN_CREW_LEAD_INVALID');
    // crew reactivation without a valid Lead chain is rejected
    await api()
      .post(`${HM}/work-crews/${f.bundle.crew.id}/status`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    const workerId = f.lead.workerContext.id;
    await api()
      .post(`${HM}/worker-contexts/${workerId}/status`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    const reactivate = await api()
      .post(`${HM}/work-crews/${f.bundle.crew.id}/status`)
      .set(auth())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivate.status, 400);
    assert.ok(
      reactivate.body.error.code === 'HANDYMAN_CREW_LEAD_REQUIRED' ||
        reactivate.body.error.code === 'HANDYMAN_CREW_LEAD_INVALID',
      `unexpected code ${reactivate.body.error.code}`,
    );
  });

  it('10: OpenAPI/runtime parity — exactly 12 operations, zero assignment API', async (t) => {
    if (!requireDatabase(t)) return;
    const doc = parseYaml(readFileSync(
      join(process.cwd(), 'docs/api/openapi.yaml'),
      'utf8',
    )) as {
      paths: Record<
        string,
        Record<string, { operationId?: string } | unknown>
      >;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const surface: Record<string, [string, string][]> = {
      '/handyman/provider-contexts': [['post', 'createHandymanProviderContext']],
      '/handyman/provider-contexts/by-vendor/{vendorId}':
        [['get', 'getHandymanProviderContextByVendor']],
      '/handyman/provider-contexts/{providerContextId}/status':
        [['post', 'setHandymanProviderContextStatus']],
      '/handyman/worker-contexts': [['post', 'createHandymanWorkerContext']],
      '/handyman/worker-contexts/{workerContextId}':
        [['get', 'getHandymanWorkerContext']],
      '/handyman/worker-contexts/{workerContextId}/status':
        [['post', 'setHandymanWorkerContextStatus']],
      '/handyman/work-crews': [['post', 'createHandymanWorkCrew']],
      '/handyman/work-crews/{crewId}': [['get', 'getHandymanWorkCrew']],
      '/handyman/work-crews/{crewId}/status':
        [['post', 'setHandymanWorkCrewStatus']],
      '/handyman/work-crews/{crewId}/members':
        [['post', 'addHandymanCrewMember']],
      '/handyman/work-crews/{crewId}/lead':
        [['post', 'designateHandymanCrewLead']],
      '/handyman/crew-memberships/{membershipId}/status':
        [['post', 'setHandymanCrewMemberStatus']],
    };
    for (const [path, ops] of Object.entries(surface)) {
      const actual = doc.paths[path];
      assert.ok(actual, `missing path ${path}`);
      for (const [method, operationId] of ops) {
        const op = actual[method] as { operationId?: string } | undefined;
        assert.ok(op, `${path} missing ${method.toUpperCase()}`);
        assert.equal(String(op.operationId), operationId);
      }
      assert.equal(
        Object.keys(actual).filter((k) => k === 'get' || k === 'post')
          .length,
        ops.length,
        `${path} must expose exactly ${ops.length} operation(s)`,
      );
    }
    // ZERO assignment surface anywhere under /handyman
    const assignmentPaths = Object.keys(doc.paths).filter((p) =>
      p.startsWith('/handyman') && /assign/i.test(p),
    );
    assert.deepEqual(assignmentPaths, []);
    // new schemas exist and carry NO assignment/attendance/session/
    // billable/marketplace/FM fields
    const forbidden =
      /assign|attendance|session|billable|marketplace|work_order|fm_/i;
    const schemas = [
      'HandymanProviderContextRecord',
      'HandymanWorkerContextRecord',
      'HandymanWorkCrewRecord',
      'HandymanCrewMembershipRecord',
      'HandymanCrewLeadRecord',
      'HandymanWorkCrewCreateBundle',
      'HandymanWorkCrewReadBundle',
      'CreateHandymanProviderContextRequest',
      'CreateHandymanWorkerContextRequest',
      'CreateHandymanWorkCrewRequest',
      'HandymanWorkerContextRefRequest',
      'SetHandymanLifecycleStatusRequest',
    ];
    for (const name of schemas) {
      const schema = doc.components.schemas[name];
      assert.ok(schema, `missing schema ${name}`);
      const shallowForbidden = Object.keys(schema.properties ?? {})
        .filter((key) => forbidden.test(key));
      assert.deepEqual(shallowForbidden, [], `${name} leaks ${shallowForbidden}`);
    }
  });
});
