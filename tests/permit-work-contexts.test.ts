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
import { functionalLocationService } from '../src/modules/functional-locations';
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

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE permit_work_contexts, permit_applications,
    permits, operational_events, tenant_contractor_relationships,
    tenant_building_contexts, tenant_space_relationships, tenant_companies,
    vendor_building_relationships, vendors, functional_locations, spaces,
    rooms, areas, floors, buildings, properties, users, roles, permissions,
    clients CASCADE`);
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
  const functionalLocation =
    await functionalLocationService.createFunctionalLocation({
      buildingId: building.id,
      spaceId: space.id,
      code: `FL_${suffix()}`,
      name: 'Operational Point',
    });
  return {
    client,
    building,
    floor,
    area,
    room,
    space,
    functionalLocation,
  };
}

async function vendorFixture(options: { assignUserId?: string } = {}) {
  const structure = await hierarchy(options);
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

async function createVendorPermitApplication(
  fixture: Awaited<ReturnType<typeof vendorFixture>>,
  withToken = token,
) {
  const permit = await api()
    .post('/api/v1/permits')
    .set(auth(withToken))
    .send({
      buildingId: fixture.building.id,
      permitNumber: `PTW-${suffix()}`,
      permitType: 'GENERAL_WORK',
      title: 'Vendor work',
      workDescription: 'Perform controlled vendor work.',
      applicantReference: 'VENDOR-APPLICANT',
      contractorContextType: 'VENDOR_CONTRACTOR',
      contractorContextId: fixture.vendor.id,
    });
  assert.equal(permit.status, 201, JSON.stringify(permit.body));
  const application = await api()
    .post('/api/v1/permit-applications')
    .set(auth(withToken))
    .send({
      permitId: permit.body.data.id,
      requestedWorkAt: REQUESTED_AT,
      notes: 'Draft vendor application.',
    });
  assert.equal(application.status, 201, JSON.stringify(application.body));
  return { permit: permit.body.data, application: application.body.data };
}

async function createTenantPermitApplication(
  fixture: Awaited<ReturnType<typeof tenantFixture>>,
) {
  const permit = await api()
    .post('/api/v1/permits')
    .set(auth())
    .send({
      buildingId: fixture.building.id,
      permitNumber: `PTW-${suffix()}`,
      permitType: 'TENANT_WORK',
      title: 'Tenant work',
      workDescription: 'Perform controlled Tenant Contractor work.',
      applicantReference: 'TENANT-APPLICANT',
      contractorContextType: 'TENANT_CONTRACTOR',
      contractorContextId: fixture.relationship.id,
    });
  assert.equal(permit.status, 201, JSON.stringify(permit.body));
  const application = await api()
    .post('/api/v1/permit-applications')
    .set(auth())
    .send({ permitId: permit.body.data.id, requestedWorkAt: REQUESTED_AT });
  assert.equal(application.status, 201, JSON.stringify(application.body));
  return { permit: permit.body.data, application: application.body.data };
}

function locationBody(locationType: string, locationId: string) {
  return {
    locationType,
    locationId,
    plannedStartAt: PLANNED_START,
    plannedEndAt: PLANNED_END,
    accessRestrictionNotes: 'Restricted access; coordinate with Security.',
    workDescription: 'Location-specific work instructions.',
  };
}

async function assignLocation(
  applicationId: string,
  body: object,
  withToken = token,
) {
  return api()
    .put(`/api/v1/permit-applications/${applicationId}/work-location`)
    .set(auth(withToken))
    .send(body);
}

async function assignType(
  applicationId: string,
  body: object,
  withToken = token,
) {
  return api()
    .put(`/api/v1/permit-applications/${applicationId}/work-type`)
    .set(auth(withToken))
    .send(body);
}

describe('BE-20D Work Location / Type', () => {
  it('assigns authoritative Building, Area, Room, and Functional Location references', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorFixture();
    const { application, permit } = await createVendorPermitApplication(fixture);
    const locations = [
      ['BUILDING', fixture.building.id],
      ['AREA', fixture.area.id],
      ['ROOM', fixture.room.id],
      ['FUNCTIONAL_LOCATION', fixture.functionalLocation.id],
    ] as const;
    for (const [locationType, locationId] of locations) {
      const assigned = await assignLocation(
        application.id,
        locationBody(locationType, locationId),
      );
      assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
      assert.equal(assigned.body.data.locationType, locationType);
      assert.equal(assigned.body.data.locationId, locationId);
      assert.equal(assigned.body.data.buildingId, fixture.building.id);
      assert.equal(assigned.body.data.permitId, permit.id);
    }

    const updated = await api()
      .patch(`/api/v1/permit-applications/${application.id}/work-context`)
      .set(auth())
      .send({ accessRestrictionNotes: 'Escort required at all times.' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(
      updated.body.data.accessRestrictionNotes,
      'Escort required at all times.',
    );

    const fetched = await api()
      .get(`/api/v1/permits/${permit.id}/work-context`)
      .set(auth());
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.locationType, 'FUNCTIONAL_LOCATION');

    const filteredPermits = await api()
      .get('/api/v1/permits')
      .query({
        locationType: 'FUNCTIONAL_LOCATION',
        locationId: fixture.functionalLocation.id,
      })
      .set(auth());
    assert.equal(filteredPermits.status, 200, JSON.stringify(filteredPermits.body));
    assert.equal(
      filteredPermits.body.data.some((item: { id: string }) => item.id === permit.id),
      true,
    );
  });

  it('rejects an invalid location reference', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorFixture();
    const { application } = await createVendorPermitApplication(fixture);
    const response = await assignLocation(
      application.id,
      locationBody('AREA', randomUUID()),
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PERMIT_WORK_LOCATION_INVALID');
  });

  it('rejects a location from another Building', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorFixture();
    const foreign = await hierarchy({ client: fixture.client });
    const { application } = await createVendorPermitApplication(fixture);
    const response = await assignLocation(
      application.id,
      locationBody('ROOM', foreign.room.id),
    );
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PERMIT_WORK_LOCATION_BUILDING_MISMATCH',
    );
  });

  it('assigns and filters by a controlled Work Type', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorFixture();
    const { application, permit } = await createVendorPermitApplication(fixture);
    const assigned = await assignType(application.id, {
      workType: ' electrical_maintenance ',
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.data.workType, 'ELECTRICAL_MAINTENANCE');

    const contexts = await api()
      .get('/api/v1/permit-work-contexts')
      .query({
        buildingId: fixture.building.id,
        workType: 'ELECTRICAL_MAINTENANCE',
      })
      .set(auth());
    assert.equal(contexts.status, 200, JSON.stringify(contexts.body));
    assert.equal(contexts.body.data.length, 1);

    const permits = await api()
      .get('/api/v1/permits')
      .query({ workType: 'ELECTRICAL_MAINTENANCE' })
      .set(auth());
    assert.equal(permits.status, 200, JSON.stringify(permits.body));
    assert.equal(permits.body.data.some((item: { id: string }) => item.id === permit.id), true);
  });

  it('rejects an invalid Work Type', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorFixture();
    const { application } = await createVendorPermitApplication(fixture);
    const response = await assignType(application.id, {
      workType: 'invalid work type!',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('validates planned start/end date and time', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorFixture();
    const { application } = await createVendorPermitApplication(fixture);
    const malformed = await assignLocation(application.id, {
      ...locationBody('AREA', fixture.area.id),
      plannedStartAt: 'not-a-date',
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');

    const reversed = await assignLocation(application.id, {
      ...locationBody('AREA', fixture.area.id),
      plannedStartAt: PLANNED_END,
      plannedEndAt: PLANNED_START,
    });
    assert.equal(reversed.status, 400);
    assert.equal(
      reversed.body.error.code,
      'PERMIT_WORK_PLANNED_PERIOD_INVALID',
    );
  });

  it('protects submitted location/type context from overwrite', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorFixture();
    const { application } = await createVendorPermitApplication(fixture);
    await assignLocation(
      application.id,
      locationBody('ROOM', fixture.room.id),
    );
    await assignType(application.id, { workType: 'GENERAL_MAINTENANCE' });
    const submitted = await api()
      .post(`/api/v1/permit-applications/${application.id}/submit`)
      .set(auth())
      .send({});
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

    const locationOverwrite = await assignLocation(
      application.id,
      locationBody('AREA', fixture.area.id),
    );
    assert.equal(locationOverwrite.status, 400);
    assert.equal(
      locationOverwrite.body.error.code,
      'PERMIT_WORK_CONTEXT_UPDATE_NOT_ALLOWED',
    );
    const typeOverwrite = await assignType(application.id, {
      workType: 'OTHER_WORK',
    });
    assert.equal(typeOverwrite.status, 400);
    assert.equal(
      typeOverwrite.body.error.code,
      'PERMIT_WORK_CONTEXT_UPDATE_NOT_ALLOWED',
    );

    const preserved = await api()
      .get(`/api/v1/permit-applications/${application.id}/work-context`)
      .set(auth());
    assert.equal(preserved.status, 200);
    assert.equal(preserved.body.data.locationType, 'ROOM');
    assert.equal(preserved.body.data.workType, 'GENERAL_MAINTENANCE');
    assert.equal(preserved.body.data.applicationStatus, 'SUBMITTED');
  });

  it('supports a Tenant Contractor Permit Application', async (t) => {
    if (!ready(t)) return;
    const fixture = await tenantFixture();
    const { application } = await createTenantPermitApplication(fixture);
    assert.equal((await assignLocation(
      application.id,
      locationBody('AREA', fixture.area.id),
    )).status, 200);
    const assigned = await assignType(application.id, {
      workType: 'TENANT_FIT_OUT',
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.data.workType, 'TENANT_FIT_OUT');
  });

  it('supports a Vendor Contractor Permit Application', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorFixture();
    const { application } = await createVendorPermitApplication(fixture);
    const assigned = await assignLocation(
      application.id,
      locationBody('BUILDING', fixture.building.id),
    );
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.data.locationType, 'BUILDING');
  });

  it('enforces Permit RBAC', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorFixture();
    const { application } = await createVendorPermitApplication(fixture);
    const plainToken = await createPlainSession();
    const denied = await assignLocation(
      application.id,
      locationBody('AREA', fixture.area.id),
      plainToken,
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const deniedList = await api()
      .get('/api/v1/permit-work-contexts')
      .set(auth(plainToken));
    assert.equal(deniedList.status, 403);
    assert.equal(deniedList.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Client and Building isolation', async (t) => {
    if (!ready(t)) return;
    const owner = await vendorFixture();
    const { application } = await createVendorPermitApplication(owner);
    const assigned = await assignLocation(
      application.id,
      locationBody('AREA', owner.area.id),
    );
    const otherManager = await createAdminUser();
    await hierarchy({ assignUserId: otherManager.userId });

    const denied = await api()
      .get(`/api/v1/permit-applications/${application.id}/work-context`)
      .set(auth(otherManager.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get('/api/v1/permit-work-contexts')
      .set(auth(otherManager.token));
    assert.equal(list.status, 200);
    assert.equal(
      list.body.data.some((item: { id: string }) => item.id === assigned.body.data.id),
      false,
    );
  });
});
