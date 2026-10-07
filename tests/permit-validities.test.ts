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
const VALID_FROM = '2026-08-15T00:00:00Z';
const VALID_UNTIL = '2026-08-20T00:00:00Z';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE permit_validities, permit_approval_bindings,
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

type ValiditySetup = {
  fixture: Record<string, any>;
  permit: Record<string, any>;
  application: Record<string, any>;
  approval: Record<string, any> | null;
};

async function setupValidityContext(options: {
  tenant?: boolean;
  approved?: boolean;
} = {}): Promise<ValiditySetup> {
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

  let approval: Record<string, any> | null = null;
  if (options.approved !== false) {
    const created = await api()
      .post(`/api/v1/permit-applications/${application.body.data.id}/approvals`)
      .set(auth())
      .send({
        approvalStage: 'FINAL_REVIEW',
        approvalType: 'PERMIT_AUTHORIZATION',
        approverUserId: userId,
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const approved = await api()
      .post(`/api/v1/permit-approvals/${created.body.data.id}/approve`)
      .set(auth())
      .send({ decisionNotes: 'Approved for validity.' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    approval = approved.body.data;
  }
  return {
    fixture,
    permit: permit.body.data,
    application: submitted.body.data,
    approval,
  };
}

function validityBody(
  setup: ValiditySetup,
  extra: Record<string, unknown> = {},
) {
  return {
    permitApplicationId: setup.application.id,
    buildingId: setup.fixture.building.id,
    validFrom: VALID_FROM,
    validUntil: VALID_UNTIL,
    notes: 'Authorized validity period.',
    ...extra,
  };
}

async function setValidity(
  setup: ValiditySetup,
  extra: Record<string, unknown> = {},
  withToken = token,
) {
  return api()
    .post(`/api/v1/permits/${setup.permit.id}/validity`)
    .set(auth(withToken))
    .send(validityBody(setup, extra));
}

describe('BE-20G Permit Validity', () => {
  it('sets VALID validity for an approved Vendor Contractor Permit', async (t) => {
    if (!ready(t)) return;
    const setup = await setupValidityContext();
    const created = await setValidity(setup);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'VALID');
    assert.equal(created.body.data.active, true);
    assert.ok(created.body.data.activatedAt);
    assert.equal(created.body.data.contractorContextType, 'VENDOR_CONTRACTOR');

    const state = await api()
      .get(`/api/v1/permits/${setup.permit.id}/validity`)
      .set(auth());
    assert.equal(state.status, 200, JSON.stringify(state.body));
    assert.equal(state.body.data.currentValidity.status, 'VALID');
    assert.equal(state.body.data.currentValidity.active, true);
  });

  it('rejects an unapproved Permit Application', async (t) => {
    if (!ready(t)) return;
    const setup = await setupValidityContext({ approved: false });
    const response = await setValidity(setup);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PERMIT_VALIDITY_CONTEXT_INVALID');
  });

  it('rejects an invalid validity date range', async (t) => {
    if (!ready(t)) return;
    const setup = await setupValidityContext();
    const response = await setValidity(setup, {
      validFrom: VALID_UNTIL,
      validUntil: VALID_FROM,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('resolves current VALID status and filters Permits by status/date', async (t) => {
    if (!ready(t)) return;
    const setup = await setupValidityContext();
    const created = await setValidity(setup);
    const fetched = await api()
      .get(`/api/v1/permit-validities/${created.body.data.id}`)
      .set(auth());
    assert.equal(fetched.body.data.status, 'VALID');
    assert.equal(fetched.body.data.active, true);

    const list = await api()
      .get('/api/v1/permit-validities')
      .query({
        status: 'VALID',
        validAt: '2026-08-16T12:00:00Z',
      })
      .set(auth());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.some((item: { id: string }) =>
      item.id === created.body.data.id), true);

    const permits = await api()
      .get('/api/v1/permits')
      .query({
        validityStatus: 'VALID',
        validAt: '2026-08-16T12:00:00Z',
      })
      .set(auth());
    assert.equal(permits.status, 200, JSON.stringify(permits.body));
    assert.equal(permits.body.data.some((item: { id: string }) =>
      item.id === setup.permit.id), true);
  });

  it('resolves EXPIRED validity as inactive for a Tenant Contractor Permit', async (t) => {
    if (!ready(t)) return;
    const setup = await setupValidityContext({ tenant: true });
    const created = await setValidity(setup, {
      validFrom: '2026-08-01T00:00:00Z',
      validUntil: '2026-08-02T00:00:00Z',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'EXPIRED');
    assert.equal(created.body.data.active, false);
    assert.ok(created.body.data.expiredAt);
    assert.equal(created.body.data.contractorContextType, 'TENANT_CONTRACTOR');
  });

  it('revokes active validity and never resolves it as active again', async (t) => {
    if (!ready(t)) return;
    const setup = await setupValidityContext();
    const created = await setValidity(setup);
    const revoked = await api()
      .post(`/api/v1/permit-validities/${created.body.data.id}/revoke`)
      .set(auth())
      .send({ revocationNotes: 'Site conditions changed.' });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.data.status, 'REVOKED');
    assert.equal(revoked.body.data.active, false);
    assert.ok(revoked.body.data.revokedAt);

    const current = await api()
      .get(`/api/v1/permits/${setup.permit.id}/validity/current`)
      .set(auth());
    assert.equal(current.body.data.currentValidity.status, 'REVOKED');
    assert.equal(current.body.data.currentValidity.active, false);
    const second = await api()
      .post(`/api/v1/permit-validities/${created.body.data.id}/revoke`)
      .set(auth())
      .send({});
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, 'PERMIT_VALIDITY_REVOKE_NOT_ALLOWED');
  });

  it('rejects a Building mismatch', async (t) => {
    if (!ready(t)) return;
    const setup = await setupValidityContext();
    const other = await hierarchy({ client: setup.fixture.client });
    const response = await setValidity(setup, {
      buildingId: other.building.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PERMIT_VALIDITY_BUILDING_MISMATCH');
  });

  it('enforces Permit RBAC', async (t) => {
    if (!ready(t)) return;
    const setup = await setupValidityContext();
    const plain = await createPlainSession();
    const denied = await setValidity(setup, {}, plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
    const list = await api()
      .get('/api/v1/permit-validities')
      .set(auth(plain));
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Client and Building isolation', async (t) => {
    if (!ready(t)) return;
    const setup = await setupValidityContext();
    const created = await setValidity(setup);
    const other = await createAdminUser();
    await hierarchy({ assignUserId: other.userId });

    const denied = await api()
      .get(`/api/v1/permit-validities/${created.body.data.id}`)
      .set(auth(other.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
    const list = await api()
      .get('/api/v1/permit-validities')
      .set(auth(other.token));
    assert.equal(list.status, 200);
    assert.equal(list.body.data.some((item: { id: string }) =>
      item.id === created.body.data.id), false);
  });
});
