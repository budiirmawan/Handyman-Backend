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
const FUTURE_WORK_AT = '2026-09-15T08:00:00+07:00';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE permit_applications, permits, operational_events,
    tenant_contractor_relationships, tenant_building_contexts,
    tenant_space_relationships, tenant_companies,
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

async function structure(options: {
  client?: PublicClient;
  assignUserId?: string;
  withSpace?: boolean;
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
  if (!options.withSpace) return { client, building, space: null };

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
    name: 'Tenant Space',
  });
  return { client, building, space };
}

async function vendorContext(options: { assignUserId?: string } = {}) {
  const context = await structure(options);
  const vendor = await vendorService.createVendor({
    clientId: context.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Vendor Contractor',
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: context.building.id,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  });
  return { ...context, vendor };
}

async function tenantContext() {
  const context = await structure({ withSpace: true });
  assert.ok(context.space);
  const tenant = await tenantCompanyService.createTenantCompany({
    clientId: context.client.id,
    tenantCode: `T_${suffix()}`,
    tenantName: 'Tenant Company',
  }, userId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: tenant.id,
    buildingId: context.building.id,
    spaceId: context.space.id,
  }, userId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: tenant.id,
    buildingId: context.building.id,
  }, userId);
  const vendor = await vendorService.createVendor({
    clientId: context.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Tenant Contractor Vendor',
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: context.building.id,
  });
  const relationship =
    await tenantContractorService.createTenantContractorRelationship({
      tenantCompanyId: tenant.id,
      contractorVendorId: vendor.id,
      buildingId: context.building.id,
      spaceId: context.space.id,
      relationshipType: 'MAINTENANCE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    }, userId);
  return { ...context, tenant, vendor, relationship };
}

async function createPermit(
  context: Awaited<ReturnType<typeof vendorContext>>,
  extra: Record<string, unknown> = {},
  withToken = token,
) {
  return api()
    .post('/api/v1/permits')
    .set(auth(withToken))
    .send({
      buildingId: context.building.id,
      permitNumber: `PTW-${suffix()}`,
      permitType: 'HOT_WORK',
      title: 'Welding repair',
      workDescription: 'Repair the damaged steel support by welding.',
      applicantReference: 'APPLICANT-001',
      contractorContextType: 'VENDOR_CONTRACTOR',
      contractorContextId: context.vendor.id,
      ...extra,
    });
}

async function createTenantPermit(
  context: Awaited<ReturnType<typeof tenantContext>>,
) {
  return api()
    .post('/api/v1/permits')
    .set(auth())
    .send({
      buildingId: context.building.id,
      permitNumber: `PTW-${suffix()}`,
      permitType: 'GENERAL_WORK',
      title: 'Tenant fit-out work',
      workDescription: 'Install approved interior partition framing.',
      applicantReference: 'TENANT-APPLICANT-01',
      contractorContextType: 'TENANT_CONTRACTOR',
      contractorContextId: context.relationship.id,
    });
}

function applicationBody(
  permit: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    permitId: permit.id,
    applicantReference: permit.applicantReference,
    contractorContextType: permit.contractorContextType,
    contractorContextId: permit.contractorContextId,
    workDescription: permit.workDescription,
    requestedWorkAt: FUTURE_WORK_AT,
    notes: 'Coordinate access with Building operations.',
    ...extra,
  };
}

async function createApplication(body: object, withToken = token) {
  return api()
    .post('/api/v1/permit-applications')
    .set(auth(withToken))
    .send(body);
}

describe('BE-20C Permit Application', () => {
  it('creates a Tenant Contractor Application from its existing Permit', async (t) => {
    if (!ready(t)) return;
    const context = await tenantContext();
    const permitResponse = await createTenantPermit(context);
    assert.equal(permitResponse.status, 201, JSON.stringify(permitResponse.body));
    const permit = permitResponse.body.data;
    const application = await createApplication(applicationBody(permit));
    assert.equal(application.status, 201, JSON.stringify(application.body));
    assert.equal(application.body.data.permitId, permit.id);
    assert.equal(application.body.data.permitReference, permit.permitNumber);
    assert.equal(application.body.data.applicantReference, permit.applicantReference);
    assert.equal(application.body.data.contractorContextType, 'TENANT_CONTRACTOR');
    assert.equal(application.body.data.contractorContextId, context.relationship.id);
    assert.equal(application.body.data.contractorVendorId, context.vendor.id);
    assert.equal(application.body.data.workDescription, permit.workDescription);
    assert.equal(application.body.data.status, 'DRAFT');
    assert.equal(application.body.data.submittedAt, null);
  });

  it('creates, gets, and filters a Vendor Contractor Application', async (t) => {
    if (!ready(t)) return;
    const context = await vendorContext();
    const permitResponse = await createPermit(context);
    assert.equal(permitResponse.status, 201, JSON.stringify(permitResponse.body));
    const permit = permitResponse.body.data;
    const created = await createApplication(applicationBody(permit));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.contractorContextType, 'VENDOR_CONTRACTOR');
    assert.equal(created.body.data.contractorContextId, context.vendor.id);

    const fetched = await api()
      .get(`/api/v1/permit-applications/${created.body.data.id}`)
      .set(auth());
    assert.equal(fetched.status, 200);

    const list = await api()
      .get('/api/v1/permit-applications')
      .query({
        buildingId: context.building.id,
        contractorId: context.vendor.id,
        status: 'DRAFT',
        requestedWorkDate: '2026-09-15',
      })
      .set(auth());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].id, created.body.data.id);
  });

  it('rejects an invalid Permit reference', async (t) => {
    if (!ready(t)) return;
    const response = await createApplication({
      permitId: randomUUID(),
      requestedWorkAt: FUTURE_WORK_AT,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PERMIT_APPLICATION_PERMIT_INVALID');
  });

  it('rejects a Permit whose Contractor is no longer eligible', async (t) => {
    if (!ready(t)) return;
    const context = await vendorContext();
    const permitResponse = await createPermit(context);
    const permit = permitResponse.body.data;
    await vendorBuildingService.updateVendorBuildingRelationship(
      context.vendor.id,
      context.building.id,
      { status: 'INACTIVE' },
    );
    const response = await createApplication(applicationBody(permit));
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PERMIT_APPLICATION_CONTRACTOR_INVALID',
    );
  });

  it('rejects malformed and non-future requested work date/time', async (t) => {
    if (!ready(t)) return;
    const context = await vendorContext();
    const permit = (await createPermit(context)).body.data;
    const malformed = await createApplication(applicationBody(permit, {
      requestedWorkAt: 'not-a-date',
    }));
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');

    const past = await createApplication(applicationBody(permit, {
      requestedWorkAt: '2026-01-01T08:00:00+07:00',
    }));
    assert.equal(past.status, 400);
    assert.equal(past.body.error.code, 'PERMIT_APPLICATION_INVALID_WORK_DATE');
  });

  it('protects a submitted Application and preserves action history', async (t) => {
    if (!ready(t)) return;
    const context = await vendorContext();
    const permit = (await createPermit(context)).body.data;
    const created = await createApplication(applicationBody(permit));
    const id = created.body.data.id;

    const updated = await api()
      .patch(`/api/v1/permit-applications/${id}`)
      .set(auth())
      .send({
        requestedWorkAt: '2026-09-16T09:00:00+07:00',
        notes: 'Updated coordination note.',
      });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));

    const submitted = await api()
      .post(`/api/v1/permit-applications/${id}/submit`)
      .set(auth())
      .send({});
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.data.status, 'SUBMITTED');
    assert.ok(submitted.body.data.submittedAt);

    const overwrite = await api()
      .patch(`/api/v1/permit-applications/${id}`)
      .set(auth())
      .send({ notes: 'Silent overwrite attempt.' });
    assert.equal(overwrite.status, 400);
    assert.equal(
      overwrite.body.error.code,
      'PERMIT_APPLICATION_UPDATE_NOT_ALLOWED',
    );
    const permitOverwrite = await api()
      .patch(`/api/v1/permits/${permit.id}`)
      .set(auth())
      .send({ workDescription: 'Changed after submission.' });
    assert.equal(permitOverwrite.status, 400);
    assert.equal(permitOverwrite.body.error.code, 'PERMIT_UPDATE_NOT_ALLOWED');

    const history = await pool!.query<{ event_type: string }>(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'PERMIT_APPLICATION' AND entity_id = $1
       ORDER BY occurred_at, created_at`,
      [id],
    );
    assert.deepEqual(history.rows.map((row) => row.event_type), [
      'PERMIT_APPLICATION_CREATED',
      'PERMIT_APPLICATION_UPDATED',
      'PERMIT_APPLICATION_SUBMITTED',
    ]);
  });

  it('enforces backend status transitions and explicit cancellation', async (t) => {
    if (!ready(t)) return;
    const context = await vendorContext();
    const permit = (await createPermit(context)).body.data;
    const created = await createApplication(applicationBody(permit));
    const id = created.body.data.id;
    assert.equal((await api()
      .post(`/api/v1/permit-applications/${id}/submit`)
      .set(auth())
      .send({})).status, 200);

    const secondSubmit = await api()
      .post(`/api/v1/permit-applications/${id}/submit`)
      .set(auth())
      .send({});
    assert.equal(secondSubmit.status, 400);
    assert.equal(
      secondSubmit.body.error.code,
      'PERMIT_APPLICATION_SUBMIT_NOT_ALLOWED',
    );

    const cancelled = await api()
      .post(`/api/v1/permit-applications/${id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    assert.ok(cancelled.body.data.cancelledAt);
    assert.ok(cancelled.body.data.submittedAt);

    const secondCancel = await api()
      .post(`/api/v1/permit-applications/${id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(secondCancel.status, 400);
    assert.equal(
      secondCancel.body.error.code,
      'PERMIT_APPLICATION_CANCEL_NOT_ALLOWED',
    );
  });

  it('enforces Permit RBAC', async (t) => {
    if (!ready(t)) return;
    const context = await vendorContext();
    const permit = (await createPermit(context)).body.data;
    const plainToken = await createPlainSession();
    const deniedCreate = await createApplication(
      applicationBody(permit),
      plainToken,
    );
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'PERMISSION_DENIED');

    const deniedList = await api()
      .get('/api/v1/permit-applications')
      .set(auth(plainToken));
    assert.equal(deniedList.status, 403);
    assert.equal(deniedList.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Client and Building isolation', async (t) => {
    if (!ready(t)) return;
    const owner = await vendorContext();
    const permit = (await createPermit(owner)).body.data;
    const application = await createApplication(applicationBody(permit));
    const otherManager = await createAdminUser();
    await structure({ assignUserId: otherManager.userId });

    const denied = await api()
      .get(`/api/v1/permit-applications/${application.body.data.id}`)
      .set(auth(otherManager.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get('/api/v1/permit-applications')
      .set(auth(otherManager.token));
    assert.equal(list.status, 200);
    assert.equal(
      list.body.data.some((item: { id: string }) =>
        item.id === application.body.data.id),
      false,
    );
  });
});
