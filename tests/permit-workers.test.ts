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
import { departmentService } from '../src/modules/departments';
import { floorService } from '../src/modules/floors';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantContractorService } from '../src/modules/tenant-contractors';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { vendorService } from '../src/modules/vendors';
import { workforceService } from '../src/modules/workforce';
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
const VALID_FROM = '2026-08-15T00:00:00Z';
const VALID_UNTIL = '2026-08-20T00:00:00Z';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE permit_workers, permit_validities,
    permit_approval_bindings, permit_safety_requirements, permit_work_contexts,
    permit_applications, permits, operational_events, reviews,
    tenant_contractor_relationships, tenant_building_contexts,
    tenant_space_relationships, tenant_companies, vendor_workforce_bindings,
    workforce_profiles, positions, departments, organizations,
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
  return { client, building, area, room, space };
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

type WorkerSetup = {
  fixture: Record<string, any>;
  permit: Record<string, any>;
  application: Record<string, any>;
  validity: Record<string, any>;
};

async function setupPermit(tenant = false): Promise<WorkerSetup> {
  const fixture = tenant ? await tenantFixture() : await vendorFixture();
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
  const safety = await api()
    .post(`/api/v1/permit-applications/${application.body.data.id}/safety-requirements`)
    .set(auth())
    .send({
      buildingId: fixture.building.id,
      workType: WORK_TYPE,
      requirementType: `PPE_${suffix()}`,
      requirementDescription: 'Required PPE verified.',
      required: true,
    });
  assert.equal(safety.status, 201, JSON.stringify(safety.body));
  assert.equal((await api()
    .patch(`/api/v1/safety-requirements/${safety.body.data.id}/readiness`)
    .set(auth())
    .send({ readinessStatus: 'READY' })).status, 200);
  const submitted = await api()
    .post(`/api/v1/permit-applications/${application.body.data.id}/submit`)
    .set(auth())
    .send({});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const approval = await api()
    .post(`/api/v1/permit-applications/${application.body.data.id}/approvals`)
    .set(auth())
    .send({
      approvalStage: 'FINAL_REVIEW',
      approvalType: 'PERMIT_AUTHORIZATION',
      approverUserId: userId,
    });
  assert.equal(approval.status, 201, JSON.stringify(approval.body));
  assert.equal((await api()
    .post(`/api/v1/permit-approvals/${approval.body.data.id}/approve`)
    .set(auth())
    .send({})).status, 200);
  const validity = await api()
    .post(`/api/v1/permits/${permit.body.data.id}/validity`)
    .set(auth())
    .send({
      permitApplicationId: application.body.data.id,
      buildingId: fixture.building.id,
      validFrom: VALID_FROM,
      validUntil: VALID_UNTIL,
    });
  assert.equal(validity.status, 201, JSON.stringify(validity.body));
  return {
    fixture,
    permit: permit.body.data,
    application: submitted.body.data,
    validity: validity.body.data,
  };
}

async function createBoundWorker(
  setup: WorkerSetup,
  options: { vendorId?: string; status?: 'ACTIVE' | 'INACTIVE' } = {},
) {
  const organization = await organizationService.createOrganization({
    clientId: setup.fixture.client.id,
    code: `ORG_${suffix()}`,
    name: 'Contractor Workforce Organization',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Technicians',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Technician',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Permit Worker',
    workforceType: 'EXTERNAL',
    status: options.status ?? 'ACTIVE',
  });
  const vendorId = options.vendorId ?? setup.fixture.vendor.id;
  const binding = await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VP-${suffix()}`,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveUntil: new Date('2026-12-31T00:00:00.000Z'),
    status: options.status ?? 'ACTIVE',
  });
  return { profile, binding };
}

function workerBody(
  setup: WorkerSetup,
  worker: Awaited<ReturnType<typeof createBoundWorker>>,
  extra: Record<string, unknown> = {},
) {
  return {
    permitApplicationId: setup.application.id,
    buildingId: setup.fixture.building.id,
    workforceProfileId: worker.profile.id,
    vendorWorkforceBindingId: worker.binding.id,
    roleTrade: 'ELECTRICIAN',
    notes: 'Authorized Permit worker.',
    ...extra,
  };
}

async function addWorker(
  setup: WorkerSetup,
  worker: Awaited<ReturnType<typeof createBoundWorker>>,
  extra: Record<string, unknown> = {},
  withToken = token,
) {
  return api()
    .post(`/api/v1/permits/${setup.permit.id}/workers`)
    .set(auth(withToken))
    .send(workerBody(setup, worker, extra));
}

describe('BE-20H Permit Worker List', () => {
  it('adds and resolves a valid Vendor Contractor worker', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const worker = await createBoundWorker(setup);
    const created = await addWorker(setup, worker);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.contractorContextType, 'VENDOR_CONTRACTOR');
    assert.equal(created.body.data.workerPersonReference, worker.profile.id);
    assert.equal(created.body.data.workerName, worker.profile.fullName);
    assert.equal(
      created.body.data.identificationReference,
      worker.binding.vendorPersonnelCode,
    );
    assert.equal(created.body.data.roleTrade, 'ELECTRICIAN');
    assert.equal(created.body.data.eligibleForActiveWork, true);

    const active = await api()
      .get(`/api/v1/permits/${setup.permit.id}/workers/active`)
      .set(auth());
    assert.equal(active.status, 200, JSON.stringify(active.body));
    assert.equal(active.body.data.workerCount, 1);
    assert.equal(active.body.data.workers[0].id, created.body.data.id);
  });

  it('adds a valid Tenant Contractor worker using the same Workforce binding', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit(true);
    const worker = await createBoundWorker(setup);
    const created = await addWorker(setup, worker);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.contractorContextType, 'TENANT_CONTRACTOR');
    assert.equal(created.body.data.contractorVendorId, setup.fixture.vendor.id);
    assert.equal(created.body.data.workforceProfileId, worker.profile.id);
    const byContractor = await api()
      .get('/api/v1/permit-workers')
      .query({ contractorContextId: setup.fixture.relationship.id })
      .set(auth());
    assert.equal(byContractor.status, 200, JSON.stringify(byContractor.body));
    assert.equal(byContractor.body.data.length, 1);
    assert.equal(byContractor.body.data[0].id, created.body.data.id);
  });

  it('rejects invalid Contractor and Worker contexts', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit(true);
    const worker = await createBoundWorker(setup);
    await tenantContractorService.updateTenantContractorRelationship(
      setup.fixture.relationship.id,
      { status: 'INACTIVE' },
      userId,
    );
    const invalidContractor = await addWorker(setup, worker);
    assert.equal(invalidContractor.status, 400);
    assert.equal(
      invalidContractor.body.error.code,
      'PERMIT_WORKER_CONTRACTOR_INVALID',
    );

    const validSetup = await setupPermit();
    const invalidWorker = await api()
      .post(`/api/v1/permits/${validSetup.permit.id}/workers`)
      .set(auth())
      .send({
        permitApplicationId: validSetup.application.id,
        buildingId: validSetup.fixture.building.id,
        workforceProfileId: randomUUID(),
        roleTrade: 'ELECTRICIAN',
      });
    assert.equal(invalidWorker.status, 400);
    assert.equal(invalidWorker.body.error.code, 'PERMIT_WORKER_INVALID');
  });

  it('rejects a Worker bound to a different Contractor', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const otherVendor = await vendorService.createVendor({
      clientId: setup.fixture.client.id,
      vendorCode: `V_${suffix()}`,
      vendorName: 'Other Vendor',
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: otherVendor.id,
      buildingId: setup.fixture.building.id,
    });
    const worker = await createBoundWorker(setup, { vendorId: otherVendor.id });
    const response = await addWorker(setup, worker);
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PERMIT_WORKER_CONTRACTOR_MISMATCH',
    );
  });

  it('rejects a duplicate ACTIVE Worker entry', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const worker = await createBoundWorker(setup);
    assert.equal((await addWorker(setup, worker)).status, 201);
    const duplicate = await addWorker(setup, worker);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'PERMIT_WORKER_ALREADY_ACTIVE');
  });

  it('validates Worker dates against Permit and Workforce validity', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const worker = await createBoundWorker(setup);
    const reversed = await addWorker(setup, worker, {
      validFrom: '2026-08-19T00:00:00Z',
      validUntil: '2026-08-18T00:00:00Z',
    });
    assert.equal(reversed.status, 400);
    assert.equal(reversed.body.error.code, 'VALIDATION_ERROR');

    const outside = await addWorker(setup, worker, {
      validFrom: '2026-08-14T00:00:00Z',
      validUntil: '2026-08-19T00:00:00Z',
    });
    assert.equal(outside.status, 400);
    assert.equal(outside.body.error.code, 'PERMIT_WORKER_INVALID_VALIDITY');
  });

  it('rejects inactive Workforce and preserves deactivate/update history', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const inactiveWorker = await createBoundWorker(setup);
    await workforceService.updateWorkforceProfile(inactiveWorker.profile.id, {
      status: 'INACTIVE',
    });
    const inactive = await addWorker(setup, inactiveWorker);
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'PERMIT_WORKER_INACTIVE');

    const activeWorker = await createBoundWorker(setup);
    const created = await addWorker(setup, activeWorker);
    const updated = await api()
      .patch(`/api/v1/permit-workers/${created.body.data.id}`)
      .set(auth())
      .send({ roleTrade: 'LEAD_ELECTRICIAN' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.roleTrade, 'LEAD_ELECTRICIAN');
    const deactivated = await api()
      .post(`/api/v1/permit-workers/${created.body.data.id}/deactivate`)
      .set(auth())
      .send({});
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(deactivated.body.data.status, 'INACTIVE');
    assert.equal(deactivated.body.data.eligibleForActiveWork, false);

    const history = await api()
      .get(`/api/v1/permits/${setup.permit.id}/workers`)
      .set(auth());
    assert.equal(history.status, 200);
    assert.equal(history.body.data.some((item: { id: string; status: string }) =>
      item.id === created.body.data.id && item.status === 'INACTIVE'), true);
  });

  it('enforces Permit RBAC', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const worker = await createBoundWorker(setup);
    const plain = await createPlainSession();
    const denied = await addWorker(setup, worker, {}, plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
    const list = await api()
      .get('/api/v1/permit-workers')
      .set(auth(plain));
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Client and Building isolation', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const worker = await createBoundWorker(setup);
    const created = await addWorker(setup, worker);
    const other = await createAdminUser();
    await hierarchy({ assignUserId: other.userId });

    const denied = await api()
      .get(`/api/v1/permit-workers/${created.body.data.id}`)
      .set(auth(other.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
    const list = await api()
      .get('/api/v1/permit-workers')
      .set(auth(other.token));
    assert.equal(list.status, 200);
    assert.equal(list.body.data.some((item: { id: string }) =>
      item.id === created.body.data.id), false);
  });
});
