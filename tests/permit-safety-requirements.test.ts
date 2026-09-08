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
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantContractorService } from '../src/modules/tenant-contractors';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { spaceService } from '../src/modules/spaces';
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
  await pool.query(`TRUNCATE permit_safety_requirements,
    permit_work_contexts, permit_applications, permits, operational_events,
    evidence_submissions, evidence_requirements, checklist_item_responses,
    checklist_executions, checklist_items, checklist_templates,
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

type PermitSetup = {
  permit: Record<string, any>;
  application: Record<string, any>;
  fixture: Record<string, any>;
};

async function setupVendorPermit(
  suppliedFixture?: Awaited<ReturnType<typeof vendorFixture>>,
): Promise<PermitSetup> {
  const fixture = suppliedFixture ?? await vendorFixture();
  const permit = await api()
    .post('/api/v1/permits')
    .set(auth())
    .send({
      buildingId: fixture.building.id,
      permitNumber: `PTW-${suffix()}`,
      permitType: 'GENERAL_WORK',
      title: 'Electrical work',
      workDescription: 'Perform controlled electrical maintenance.',
      applicantReference: 'VENDOR-APPLICANT',
      contractorContextType: 'VENDOR_CONTRACTOR',
      contractorContextId: fixture.vendor.id,
    });
  assert.equal(permit.status, 201, JSON.stringify(permit.body));
  const application = await api()
    .post('/api/v1/permit-applications')
    .set(auth())
    .send({
      permitId: permit.body.data.id,
      requestedWorkAt: REQUESTED_AT,
    });
  assert.equal(application.status, 201, JSON.stringify(application.body));
  await configureWorkContext(application.body.data.id, fixture);
  return {
    permit: permit.body.data,
    application: application.body.data,
    fixture,
  };
}

async function setupTenantPermit(): Promise<PermitSetup> {
  const fixture = await tenantFixture();
  const permit = await api()
    .post('/api/v1/permits')
    .set(auth())
    .send({
      buildingId: fixture.building.id,
      permitNumber: `PTW-${suffix()}`,
      permitType: 'TENANT_WORK',
      title: 'Tenant electrical work',
      workDescription: 'Perform Tenant Contractor electrical work.',
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
  await configureWorkContext(application.body.data.id, fixture);
  return {
    permit: permit.body.data,
    application: application.body.data,
    fixture,
  };
}

async function configureWorkContext(applicationId: string, fixture: Record<string, any>) {
  const location = await api()
    .put(`/api/v1/permit-applications/${applicationId}/work-location`)
    .set(auth())
    .send({
      locationType: 'AREA',
      locationId: fixture.area.id,
      plannedStartAt: PLANNED_START,
      plannedEndAt: PLANNED_END,
    });
  assert.equal(location.status, 200, JSON.stringify(location.body));
  const type = await api()
    .put(`/api/v1/permit-applications/${applicationId}/work-type`)
    .set(auth())
    .send({ workType: WORK_TYPE });
  assert.equal(type.status, 200, JSON.stringify(type.body));
}

function requirementBody(
  setup: PermitSetup,
  extra: Record<string, unknown> = {},
) {
  return {
    buildingId: setup.fixture.building.id,
    workType: WORK_TYPE,
    requirementType: `PPE_${suffix()}`,
    requirementDescription: 'Wear helmet, gloves, and arc-rated protection.',
    required: true,
    notes: 'Verify before work begins.',
    reference: 'PTW-SAFETY-REF',
    ...extra,
  };
}

async function createRequirement(
  setup: PermitSetup,
  extra: Record<string, unknown> = {},
  withToken = token,
) {
  return api()
    .post(`/api/v1/permit-applications/${setup.application.id}/safety-requirements`)
    .set(auth(withToken))
    .send(requirementBody(setup, extra));
}

describe('BE-20E Safety Requirement', () => {
  it('creates, gets, and lists a valid data-driven Safety Requirement', async (t) => {
    if (!ready(t)) return;
    const setup = await setupVendorPermit();
    const created = await createRequirement(setup, {
      requirementType: 'PPE_REQUIREMENT',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.permitId, setup.permit.id);
    assert.equal(created.body.data.workType, WORK_TYPE);
    assert.equal(created.body.data.requirementType, 'PPE_REQUIREMENT');
    assert.equal(created.body.data.readinessStatus, 'PENDING');
    assert.equal(created.body.data.resolvedReadinessStatus, 'PENDING');

    const fetched = await api()
      .get(`/api/v1/safety-requirements/${created.body.data.id}`)
      .set(auth());
    assert.equal(fetched.status, 200);
    const byPermit = await api()
      .get(`/api/v1/permits/${setup.permit.id}/safety-requirements`)
      .set(auth());
    assert.equal(byPermit.status, 200);
    assert.equal(byPermit.body.data.length, 1);
    const byWorkType = await api()
      .get('/api/v1/safety-requirements')
      .query({ workType: WORK_TYPE })
      .set(auth());
    assert.equal(byWorkType.status, 200);
    assert.equal(
      byWorkType.body.data.some((item: { id: string }) =>
        item.id === created.body.data.id),
      true,
    );
  });

  it('handles required and not-required controls authoritatively', async (t) => {
    if (!ready(t)) return;
    const setup = await setupTenantPermit();
    const required = await createRequirement(setup, {
      requirementType: 'LOTO_READINESS',
    });
    assert.equal(required.status, 201);
    const optional = await createRequirement(setup, {
      requirementType: 'CONFINED_SPACE_READINESS',
      required: false,
    });
    assert.equal(optional.status, 201, JSON.stringify(optional.body));
    assert.equal(optional.body.data.readinessStatus, 'NOT_REQUIRED');
    assert.equal(optional.body.data.resolvedReadinessStatus, 'NOT_REQUIRED');

    const pending = await api()
      .get(`/api/v1/permits/${setup.permit.id}/safety-readiness`)
      .set(auth());
    assert.equal(pending.status, 200);
    assert.equal(pending.body.data.readinessStatus, 'PENDING');
    assert.equal(pending.body.data.requiredCount, 1);

    const readyUpdate = await api()
      .patch(`/api/v1/safety-requirements/${required.body.data.id}/readiness`)
      .set(auth())
      .send({ readinessStatus: 'READY', reference: 'LOTO-CHECKED' });
    assert.equal(readyUpdate.status, 200, JSON.stringify(readyUpdate.body));
    const resolved = await api()
      .get(`/api/v1/permits/${setup.permit.id}/safety-readiness`)
      .set(auth());
    assert.equal(resolved.body.data.ready, true);
    assert.equal(resolved.body.data.readinessStatus, 'READY');
  });

  it('validates readiness statuses and required/status consistency', async (t) => {
    if (!ready(t)) return;
    const setup = await setupVendorPermit();
    const invalid = await createRequirement(setup, {
      readinessStatus: 'APPROVED',
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');

    const inconsistent = await createRequirement(setup, {
      requirementType: 'BARRICADE_SIGNAGE',
      required: false,
      readinessStatus: 'READY',
    });
    assert.equal(inconsistent.status, 400);
    assert.equal(inconsistent.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an invalid Permit reference', async (t) => {
    if (!ready(t)) return;
    const setup = await setupVendorPermit();
    const response = await api()
      .post(`/api/v1/permits/${randomUUID()}/safety-requirements`)
      .set(auth())
      .send(requirementBody(setup));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PERMIT_SAFETY_PERMIT_INVALID');
  });

  it('rejects a Work Type mismatch', async (t) => {
    if (!ready(t)) return;
    const setup = await setupVendorPermit();
    const response = await createRequirement(setup, {
      workType: 'HOT_WORK',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PERMIT_SAFETY_CONTEXT_MISMATCH');
  });

  it('rejects a Building mismatch', async (t) => {
    if (!ready(t)) return;
    const setup = await setupVendorPermit();
    const other = await hierarchy({ client: setup.fixture.client });
    const response = await createRequirement(setup, {
      buildingId: other.building.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PERMIT_SAFETY_CONTEXT_MISMATCH');
  });

  it('reuses shared Checklist and Evidence prerequisites', async (t) => {
    if (!ready(t)) return;
    const setup = await setupVendorPermit();
    const template = await api()
      .post(`/api/v1/clients/${setup.fixture.client.id}/checklist-templates`)
      .set(auth())
      .send({
        code: `PTW_CHECK_${suffix()}`,
        name: 'PTW Safety Checklist',
        status: 'ACTIVE',
      });
    assert.equal(template.status, 201, JSON.stringify(template.body));
    const execution = await api()
      .post(`/api/v1/checklist-templates/${template.body.data.id}/executions`)
      .set(auth())
      .send({});
    assert.equal(execution.status, 201, JSON.stringify(execution.body));
    assert.equal((await api()
      .post(`/api/v1/checklist-executions/${execution.body.data.id}/start`)
      .set(auth())
      .send({})).status, 200);
    const evidenceRequirement = await api()
      .post('/api/v1/evidence-requirements')
      .set(auth())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: template.body.data.id,
        evidenceType: 'PHOTO',
        required: true,
        minimumCount: 1,
        maximumCount: 2,
        description: 'Photo of installed safety controls.',
      });
    assert.equal(
      evidenceRequirement.status,
      201,
      JSON.stringify(evidenceRequirement.body),
    );

    const created = await createRequirement(setup, {
      requirementType: 'FIRE_PROTECTION_READINESS',
      checklistTemplateId: template.body.data.id,
      checklistExecutionId: execution.body.data.id,
      evidenceRequirementId: evidenceRequirement.body.data.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const premature = await api()
      .patch(`/api/v1/safety-requirements/${created.body.data.id}/readiness`)
      .set(auth())
      .send({ readinessStatus: 'READY' });
    assert.equal(premature.status, 400);
    assert.equal(
      premature.body.error.code,
      'PERMIT_SAFETY_PREREQUISITE_NOT_MET',
    );

    const evidence = await api()
      .post('/api/v1/evidence')
      .set(auth())
      .send({
        evidenceRequirementId: evidenceRequirement.body.data.id,
        executionType: 'CHECKLIST_EXECUTION',
        executionId: execution.body.data.id,
        evidenceType: 'PHOTO',
        fileReference: `safety/${suffix()}.jpg`,
        originalFileName: 'safety-control.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
      });
    assert.equal(evidence.status, 201, JSON.stringify(evidence.body));
    assert.equal((await api()
      .post(`/api/v1/checklist-executions/${execution.body.data.id}/complete`)
      .set(auth())
      .send({})).status, 200);

    const readyUpdate = await api()
      .patch(`/api/v1/safety-requirements/${created.body.data.id}/readiness`)
      .set(auth())
      .send({ readinessStatus: 'READY' });
    assert.equal(readyUpdate.status, 200, JSON.stringify(readyUpdate.body));
    assert.equal(readyUpdate.body.data.checklistStatus, 'COMPLETED');
    assert.equal(readyUpdate.body.data.evidenceReady, true);
    assert.equal(readyUpdate.body.data.resolvedReadinessStatus, 'READY');
  });

  it('preserves readiness history in shared operational events', async (t) => {
    if (!ready(t)) return;
    const setup = await setupVendorPermit();
    const created = await createRequirement(setup, {
      requirementType: 'WORK_AT_HEIGHT_READINESS',
    });
    const updated = await api()
      .patch(`/api/v1/safety-requirements/${created.body.data.id}/readiness`)
      .set(auth())
      .send({ readinessStatus: 'NOT_READY', notes: 'Harness inspection pending.' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const events = await pool!.query<{ event_type: string }>(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'PERMIT_SAFETY_REQUIREMENT' AND entity_id = $1
       ORDER BY occurred_at, created_at`,
      [created.body.data.id],
    );
    assert.deepEqual(events.rows.map((row) => row.event_type), [
      'PERMIT_SAFETY_REQUIREMENT_CREATED',
      'PERMIT_SAFETY_READINESS_UPDATED',
    ]);
  });

  it('enforces Permit RBAC', async (t) => {
    if (!ready(t)) return;
    const setup = await setupVendorPermit();
    const plain = await createPlainSession();
    const denied = await createRequirement(setup, {}, plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
    const list = await api()
      .get('/api/v1/safety-requirements')
      .set(auth(plain));
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Client and Building isolation', async (t) => {
    if (!ready(t)) return;
    const setup = await setupVendorPermit();
    const created = await createRequirement(setup);
    const otherManager = await createAdminUser();
    await hierarchy({ assignUserId: otherManager.userId });

    const denied = await api()
      .get(`/api/v1/safety-requirements/${created.body.data.id}`)
      .set(auth(otherManager.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
    const list = await api()
      .get('/api/v1/safety-requirements')
      .set(auth(otherManager.token));
    assert.equal(list.status, 200);
    assert.equal(
      list.body.data.some((item: { id: string }) => item.id === created.body.data.id),
      false,
    );
  });
});
