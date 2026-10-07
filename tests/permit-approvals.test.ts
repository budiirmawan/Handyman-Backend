import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantContractorService } from '../src/modules/tenant-contractors';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const REQUESTED_AT = '2026-09-15T08:00:00+07:00';
const PLANNED_START = '2026-09-20T08:00:00+07:00';
const PLANNED_END = '2026-09-20T17:00:00+07:00';
const WORK_TYPE = 'ELECTRICAL_MAINTENANCE';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE permit_approval_bindings,
    permit_safety_requirements, permit_work_contexts, permit_applications,
    permits, operational_events, reviews, tenant_contractor_relationships,
    tenant_building_contexts, tenant_space_relationships, tenant_companies,
    vendor_building_relationships, vendors, spaces, rooms, areas, floors,
    buildings, properties, users, roles, permissions, clients CASCADE`);
  const manager = await createAdminUser();
  token = manager.token;
  userId = manager.userId;
  database = db;
});

after(async () => {
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

async function hierarchy(options: {
  client?: PublicClient;
  assignUserId?: string;
} = {}) {
  const client = options.client ?? await clientService.createClient({
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
  await buildingAssignmentService.createAssignment(
    options.assignUserId ?? userId,
    { buildingId: building.id },
  );
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
    name: 'Space',
  });
  return { client, building, floor, area, room, space };
}

async function vendorFixture() {
  const structure = await hierarchy();
  const vendor = await vendorService.createVendor({
    clientId: structure.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Vendor Contractor',
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: structure.building.id,
  });
  return { ...structure, vendor };
}

async function tenantFixture() {
  const structure = await hierarchy();
  const tenant = await tenantCompanyService.createTenantCompany({
    clientId: structure.client.id,
    tenantCode: `T_${suffix()}`,
    tenantName: 'Tenant Company',
  }, userId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: tenant.id,
    buildingId: structure.building.id,
    spaceId: structure.space.id,
  }, userId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: tenant.id,
    buildingId: structure.building.id,
  }, userId);
  const vendor = await vendorService.createVendor({
    clientId: structure.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Tenant Contractor Vendor',
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: structure.building.id,
  });
  const relationship =
    await tenantContractorService.createTenantContractorRelationship({
      tenantCompanyId: tenant.id,
      contractorVendorId: vendor.id,
      buildingId: structure.building.id,
      spaceId: structure.space.id,
      relationshipType: 'MAINTENANCE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    }, userId);
  return { ...structure, tenant, vendor, relationship };
}

type ApprovalSetup = {
  fixture: Record<string, any>;
  permit: Record<string, any>;
  application: Record<string, any>;
  safetyRequirement: Record<string, any>;
};

async function setupApprovalContext(options: {
  tenant?: boolean;
  safetyReady?: boolean;
  submit?: boolean;
} = {}): Promise<ApprovalSetup> {
  const fixture = options.tenant ? await tenantFixture() : await vendorFixture();
  const tenant = options.tenant === true;
  const permit = await api()
    .post('/api/v1/permits')
    .set(auth())
    .send({
      buildingId: fixture.building.id,
      permitNumber: `PTW-${suffix()}`,
      permitType: tenant ? 'TENANT_WORK' : 'GENERAL_WORK',
      title: tenant ? 'Tenant work' : 'Vendor work',
      workDescription: 'Perform controlled electrical maintenance.',
      applicantReference: tenant ? 'TENANT-APPLICANT' : 'VENDOR-APPLICANT',
      contractorContextType: tenant
        ? 'TENANT_CONTRACTOR'
        : 'VENDOR_CONTRACTOR',
      contractorContextId: tenant
        ? fixture.relationship.id
        : fixture.vendor.id,
    });
  assert.equal(permit.status, 201, JSON.stringify(permit.body));
  const application = await api()
    .post('/api/v1/permit-applications')
    .set(auth())
    .send({ permitId: permit.body.data.id, requestedWorkAt: REQUESTED_AT });
  assert.equal(application.status, 201, JSON.stringify(application.body));
  assert.equal((await api()
    .put(`/api/v1/permit-applications/${application.body.data.id}/work-location`)
    .set(auth())
    .send({
      locationType: 'AREA',
      locationId: fixture.area.id,
      plannedStartAt: PLANNED_START,
      plannedEndAt: PLANNED_END,
    })).status, 200);
  assert.equal((await api()
    .put(`/api/v1/permit-applications/${application.body.data.id}/work-type`)
    .set(auth())
    .send({ workType: WORK_TYPE })).status, 200);
  const safetyRequirement = await api()
    .post(`/api/v1/permit-applications/${application.body.data.id}/safety-requirements`)
    .set(auth())
    .send({
      buildingId: fixture.building.id,
      workType: WORK_TYPE,
      requirementType: `PPE_${suffix()}`,
      requirementDescription: 'PPE must be verified before approval.',
      required: true,
    });
  assert.equal(
    safetyRequirement.status,
    201,
    JSON.stringify(safetyRequirement.body),
  );
  if (options.safetyReady !== false) {
    const safetyReady = await api()
      .patch(`/api/v1/safety-requirements/${safetyRequirement.body.data.id}/readiness`)
      .set(auth())
      .send({ readinessStatus: 'READY', decisionNotes: 'Safety verified.' });
    assert.equal(safetyReady.status, 200, JSON.stringify(safetyReady.body));
  }
  if (options.submit !== false) {
    const submitted = await api()
      .post(`/api/v1/permit-applications/${application.body.data.id}/submit`)
      .set(auth())
      .send({});
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    application.body.data = submitted.body.data;
  }
  return {
    fixture,
    permit: permit.body.data,
    application: application.body.data,
    safetyRequirement: safetyRequirement.body.data,
  };
}

async function createApproval(
  setup: ApprovalSetup,
  approverUserId = userId,
  extra: Record<string, unknown> = {},
  withToken = token,
) {
  return api()
    .post(`/api/v1/permit-applications/${setup.application.id}/approvals`)
    .set(auth(withToken))
    .send({
      approvalStage: 'SAFETY_REVIEW',
      approvalType: 'PERMIT_AUTHORIZATION',
      approverUserId,
      notes: 'Review assigned.',
      ...extra,
    });
}

describe('BE-20F Approval Binding', () => {
  it('approves a valid Vendor Contractor Permit through shared reviews', async (t) => {
    if (!ready(t)) return;
    const setup = await setupApprovalContext();
    const created = await createApproval(setup);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.approvalStatus, 'PENDING');
    assert.equal(created.body.data.approverUserId, userId);

    const actions = await api()
      .get(`/api/v1/permit-approvals/${created.body.data.id}/available-actions`)
      .set(auth());
    assert.equal(actions.status, 200, JSON.stringify(actions.body));
    assert.deepEqual(actions.body.data.availableActions, [
      'APPROVE',
      'REJECT',
      'REQUEST_REWORK',
    ]);
    assert.equal(actions.body.data.safetyReadinessStatus, 'READY');

    const approved = await api()
      .post(`/api/v1/permit-approvals/${created.body.data.id}/approve`)
      .set(auth())
      .send({ decisionNotes: 'All prerequisites satisfied.' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.data.approvalStatus, 'APPROVED');
    assert.ok(approved.body.data.decisionAt);

    const review = await pool!.query(
      `SELECT target_type, target_id, decision, status
       FROM reviews WHERE id = $1`,
      [approved.body.data.reviewId],
    );
    assert.deepEqual(review.rows[0], {
      target_type: 'PERMIT_APPLICATION',
      target_id: setup.application.id,
      decision: 'APPROVED',
      status: 'COMPLETED',
    });
  });

  it('rejects a Tenant Contractor Permit', async (t) => {
    if (!ready(t)) return;
    const setup = await setupApprovalContext({ tenant: true });
    const created = await createApproval(setup);
    const rejected = await api()
      .post(`/api/v1/permit-approvals/${created.body.data.id}/reject`)
      .set(auth())
      .send({ decisionNotes: 'Application details are insufficient.' });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.data.approvalStatus, 'REJECTED');
    assert.equal(
      rejected.body.data.contractorContextType,
      'TENANT_CONTRACTOR',
    );
  });

  it('records REWORK_REQUIRED as a final shared-review decision', async (t) => {
    if (!ready(t)) return;
    const setup = await setupApprovalContext();
    const created = await createApproval(setup);
    const rework = await api()
      .post(`/api/v1/permit-approvals/${created.body.data.id}/request-rework`)
      .set(auth())
      .send({ decisionNotes: 'Revise the isolation procedure.' });
    assert.equal(rework.status, 200, JSON.stringify(rework.body));
    assert.equal(rework.body.data.approvalStatus, 'REWORK_REQUIRED');
  });

  it('blocks APPROVE while required Safety Readiness is not ready', async (t) => {
    if (!ready(t)) return;
    const setup = await setupApprovalContext({ safetyReady: false });
    const created = await createApproval(setup);
    const actions = await api()
      .get(`/api/v1/permit-approvals/${created.body.data.id}/available-actions`)
      .set(auth());
    assert.deepEqual(actions.body.data.availableActions, [
      'REJECT',
      'REQUEST_REWORK',
    ]);
    assert.equal(actions.body.data.safetyReadinessStatus, 'PENDING');

    const blocked = await api()
      .post(`/api/v1/permit-approvals/${created.body.data.id}/approve`)
      .set(auth())
      .send({});
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error.code, 'PERMIT_APPROVAL_SAFETY_NOT_READY');
  });

  it('rejects a decision by anyone except the assigned approver', async (t) => {
    if (!ready(t)) return;
    const setup = await setupApprovalContext();
    const assigned = await createAdminUser();
    await buildingAssignmentService.createAssignment(assigned.userId, {
      buildingId: setup.fixture.building.id,
    });
    const created = await createApproval(setup, assigned.userId);

    const unauthorized = await api()
      .post(`/api/v1/permit-approvals/${created.body.data.id}/approve`)
      .set(auth())
      .send({});
    assert.equal(unauthorized.status, 403);
    assert.equal(
      unauthorized.body.error.code,
      'PERMIT_APPROVAL_UNAUTHORIZED_APPROVER',
    );

    const authorized = await api()
      .post(`/api/v1/permit-approvals/${created.body.data.id}/approve`)
      .set(auth(assigned.token))
      .send({});
    assert.equal(authorized.status, 200, JSON.stringify(authorized.body));
  });

  it('rejects invalid or non-submitted Permit Applications', async (t) => {
    if (!ready(t)) return;
    const invalid = await api()
      .post(`/api/v1/permit-applications/${randomUUID()}/approvals`)
      .set(auth())
      .send({
        approvalStage: 'SAFETY_REVIEW',
        approvalType: 'PERMIT_AUTHORIZATION',
        approverUserId: userId,
      });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'PERMIT_APPROVAL_CONTEXT_INVALID');

    const draft = await setupApprovalContext({ submit: false });
    const notSubmitted = await createApproval(draft);
    assert.equal(notSubmitted.status, 400);
    assert.equal(
      notSubmitted.body.error.code,
      'PERMIT_APPROVAL_CONTEXT_INVALID',
    );
  });

  it('protects duplicate bindings and final decisions', async (t) => {
    if (!ready(t)) return;
    const setup = await setupApprovalContext();
    const created = await createApproval(setup);
    const duplicate = await createApproval(setup);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'PERMIT_APPROVAL_ALREADY_EXISTS');

    assert.equal((await api()
      .post(`/api/v1/permit-approvals/${created.body.data.id}/approve`)
      .set(auth())
      .send({})).status, 200);
    const overwrite = await api()
      .post(`/api/v1/permit-approvals/${created.body.data.id}/reject`)
      .set(auth())
      .send({ decisionNotes: 'Overwrite attempt.' });
    assert.equal(overwrite.status, 409);
    assert.equal(overwrite.body.error.code, 'PERMIT_APPROVAL_ALREADY_DECIDED');
  });

  it('keeps pending lists, approval context, and available_actions consistent', async (t) => {
    if (!ready(t)) return;
    const setup = await setupApprovalContext();
    const created = await createApproval(setup);
    const pending = await api()
      .get('/api/v1/permit-approvals/pending')
      .query({
        buildingId: setup.fixture.building.id,
        approverUserId: userId,
        approvalStage: 'SAFETY_REVIEW',
      })
      .set(auth());
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    assert.equal(pending.body.data.length, 1);
    assert.equal(pending.body.data[0].id, created.body.data.id);

    const context = await api()
      .get(`/api/v1/permit-applications/${setup.application.id}/approval-context`)
      .set(auth());
    assert.equal(context.status, 200, JSON.stringify(context.body));
    assert.equal(context.body.data.safetyReadiness.ready, true);
    assert.equal(context.body.data.approvals.length, 1);

    await api()
      .post(`/api/v1/permit-approvals/${created.body.data.id}/approve`)
      .set(auth())
      .send({});
    const actions = await api()
      .get(`/api/v1/permit-approvals/${created.body.data.id}/available-actions`)
      .set(auth());
    assert.deepEqual(actions.body.data.availableActions, []);
    assert.equal((await api()
      .get('/api/v1/permit-approvals/pending')
      .set(auth())).body.data.some((item: { id: string }) =>
        item.id === created.body.data.id), false);
  });

  it('enforces RBAC', async (t) => {
    if (!ready(t)) return;
    const setup = await setupApprovalContext();
    const plain = await createPlainSession();
    const deniedCreate = await createApproval(setup, userId, {}, plain);
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'PERMISSION_DENIED');
    const deniedPending = await api()
      .get('/api/v1/permit-approvals/pending')
      .set(auth(plain));
    assert.equal(deniedPending.status, 403);
    assert.equal(deniedPending.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Client and Building isolation', async (t) => {
    if (!ready(t)) return;
    const setup = await setupApprovalContext();
    const created = await createApproval(setup);
    const other = await createAdminUser();
    await hierarchy({ assignUserId: other.userId });

    const denied = await api()
      .get(`/api/v1/permit-approvals/${created.body.data.id}`)
      .set(auth(other.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
    const pending = await api()
      .get('/api/v1/permit-approvals/pending')
      .set(auth(other.token));
    assert.equal(pending.status, 200);
    assert.equal(
      pending.body.data.some((item: { id: string }) =>
        item.id === created.body.data.id),
      false,
    );
  });
});
