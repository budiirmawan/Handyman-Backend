import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { floorService } from '../src/modules/floors';
import { areaService } from '../src/modules/areas';
import { roomService } from '../src/modules/rooms';
import { functionalLocationService } from '../src/modules/functional-locations';
import { cleaningAreaService } from '../src/modules/cleaning-areas';
import { findingService } from '../src/modules/findings';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, permissions, role_permission_assignments,
      user_role_assignments, clients, properties, buildings,
      user_building_assignments, floors, areas, rooms, spaces,
      functional_locations, checklist_executions, checklist_item_responses,
      checklist_items, checklist_templates, evidence_submissions,
      evidence_requirements, reviews, findings, finding_assignments,
      cleaning_areas, toilet_inspection_bindings,
      public_area_inspection_bindings CASCADE`,
  );
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function authHeaders(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function createStructureFixture(options?: {
  assignUserId?: string | null;
}) {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const client = await clientService.createClient({
    code: `CLI_${suffix}`,
    name: 'Public Area Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix}`,
    name: 'Public Area Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix}`,
    name: 'Public Area Building',
  });

  const assignUserId =
    options?.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `L1_${suffix}`,
    name: 'Ground Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `LOBBY_${suffix}`,
    name: 'Main Lobby',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `WAITING_${suffix}`,
    name: 'Waiting Lounge',
  });
  const functionalLocation =
    await functionalLocationService.createFunctionalLocation({
      buildingId: building.id,
      code: `FL_LOBBY_${suffix}`,
      name: 'Lobby Atrium FL',
    });

  const cleaningArea = await cleaningAreaService.createCleaningArea({
    buildingId: building.id,
    code: `CA_LOBBY_${suffix}`,
    name: 'Main Lobby Public Scope',
    cleaningAreaType: 'PUBLIC_AREA',
    floorId: floor.id,
    areaId: area.id,
    functionalLocationId: functionalLocation.id,
  });

  const ctRes = await api()
    .post(`/api/v1/clients/${client.id}/checklist-templates`)
    .set(authHeaders())
    .send({
      code: `CT_${suffix}`,
      name: 'Public Area Cleanliness Checklist',
    });
  const checklistTemplateId = ctRes.body.data.id;
  await api()
    .patch(`/api/v1/checklist-templates/${checklistTemplateId}`)
    .set(authHeaders())
    .send({ status: 'ACTIVE' });

  return {
    client,
    property,
    building,
    floor,
    area,
    room,
    functionalLocation,
    cleaningArea,
    checklistTemplateId,
  };
}

const PUBLIC_PUBLIC_AREA_BINDING_KEYS = [
  'area',
  'areaId',
  'buildingId',
  'checklistTemplate',
  'checklistTemplateId',
  'cleaningArea',
  'cleaningAreaId',
  'clientId',
  'createdAt',
  'createdByUserId',
  'description',
  'floor',
  'floorId',
  'functionalLocation',
  'functionalLocationId',
  'id',
  'room',
  'roomId',
  'status',
  'updatedAt',
];

describe('BE-11F Public Area Inspection Binding operations', () => {
  it('binds a Public Area Inspection to Cleaning Area and location with derived context', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post('/api/v1/housekeeping/public-area-inspection-bindings')
      .set(authHeaders())
      .send({
        cleaningAreaId: fixture.cleaningArea.id,
        checklistTemplateId: fixture.checklistTemplateId,
        floorId: fixture.floor.id,
        areaId: fixture.area.id,
        functionalLocationId: fixture.functionalLocation.id,
        description: 'Daily public lobby audit',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_PUBLIC_AREA_BINDING_KEYS,
    );
    assert.equal(response.body.data.cleaningAreaId, fixture.cleaningArea.id);
    assert.equal(
      response.body.data.checklistTemplateId,
      fixture.checklistTemplateId,
    );
    assert.equal(response.body.data.floorId, fixture.floor.id);
    assert.equal(response.body.data.areaId, fixture.area.id);
    assert.equal(
      response.body.data.functionalLocationId,
      fixture.functionalLocation.id,
    );
    assert.equal(response.body.data.buildingId, fixture.building.id);
    assert.equal(response.body.data.clientId, fixture.client.id);
    assert.equal(response.body.data.status, 'ACTIVE');

    // Context projection
    assert.equal(
      response.body.data.cleaningArea.code,
      fixture.cleaningArea.code,
    );
    assert.equal(
      response.body.data.checklistTemplate.id,
      fixture.checklistTemplateId,
    );
    assert.equal(response.body.data.floor.id, fixture.floor.id);
    assert.equal(response.body.data.area.id, fixture.area.id);
    assert.equal(
      response.body.data.functionalLocation.id,
      fixture.functionalLocation.id,
    );
  });

  it('rejects duplicate active binding for same cleaning area and checklist template', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const first = await api()
      .post('/api/v1/housekeeping/public-area-inspection-bindings')
      .set(authHeaders())
      .send({
        cleaningAreaId: fixture.cleaningArea.id,
        checklistTemplateId: fixture.checklistTemplateId,
      });
    assert.equal(first.status, 201);

    const dup = await api()
      .post('/api/v1/housekeeping/public-area-inspection-bindings')
      .set(authHeaders())
      .send({
        cleaningAreaId: fixture.cleaningArea.id,
        checklistTemplateId: fixture.checklistTemplateId,
      });
    assert.equal(dup.status, 409);
    assert.equal(
      dup.body.error.code,
      'PUBLIC_AREA_INSPECTION_BINDING_ALREADY_EXISTS',
    );
  });

  it('rejects unknown cleaning area and inactive cleaning area', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const unknown = await api()
      .post('/api/v1/housekeeping/public-area-inspection-bindings')
      .set(authHeaders())
      .send({
        cleaningAreaId: randomUUID(),
        checklistTemplateId: fixture.checklistTemplateId,
      });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'CLEANING_AREA_NOT_FOUND');

    // Deactivate cleaning area
    await api()
      .patch(`/api/v1/housekeeping/cleaning-areas/${fixture.cleaningArea.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const inactive = await api()
      .post('/api/v1/housekeeping/public-area-inspection-bindings')
      .set(authHeaders())
      .send({
        cleaningAreaId: fixture.cleaningArea.id,
        checklistTemplateId: fixture.checklistTemplateId,
      });
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'CLEANING_AREA_INACTIVE');
  });

  it('rejects cross-Client and cross-Building location mismatches', async (t) => {
    if (!requireDatabase(t)) return;

    const f1 = await createStructureFixture();
    const f2 = await createStructureFixture();

    // Cross-client checklist template
    const crossClient = await api()
      .post('/api/v1/housekeeping/public-area-inspection-bindings')
      .set(authHeaders())
      .send({
        cleaningAreaId: f1.cleaningArea.id,
        checklistTemplateId: f2.checklistTemplateId,
      });
    assert.equal(crossClient.status, 400);
    assert.equal(
      crossClient.body.error.code,
      'PUBLIC_AREA_INSPECTION_TEMPLATE_CLIENT_MISMATCH',
    );

    // Cross-building floor
    const crossFloor = await api()
      .post('/api/v1/housekeeping/public-area-inspection-bindings')
      .set(authHeaders())
      .send({
        cleaningAreaId: f1.cleaningArea.id,
        checklistTemplateId: f1.checklistTemplateId,
        floorId: f2.floor.id,
      });
    assert.equal(crossFloor.status, 400);
    assert.equal(
      crossFloor.body.error.code,
      'PUBLIC_AREA_INSPECTION_LOCATION_MISMATCH',
    );
  });

  it('starts a shared BE-07 checklist execution from a public area inspection binding', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const bindingRes = await api()
      .post('/api/v1/housekeeping/public-area-inspection-bindings')
      .set(authHeaders())
      .send({
        cleaningAreaId: fixture.cleaningArea.id,
        checklistTemplateId: fixture.checklistTemplateId,
        floorId: fixture.floor.id,
        areaId: fixture.area.id,
      });
    assert.equal(bindingRes.status, 201);
    const binding = bindingRes.body.data;

    // Start execution
    const startRes = await api()
      .post(
        `/api/v1/housekeeping/public-area-inspection-bindings/${binding.id}/start`,
      )
      .set(authHeaders());

    assert.equal(startRes.status, 201);
    const execContext = startRes.body.data;
    assert.equal(
      execContext.execution.checklistTemplateId,
      fixture.checklistTemplateId,
    );
    assert.equal(
      execContext.execution.publicAreaInspectionBindingId,
      binding.id,
    );
    assert.equal(execContext.execution.status, 'DRAFT');
    assert.equal(
      execContext.publicAreaInspectionBinding.id,
      binding.id,
    );
    assert.equal(
      execContext.publicAreaInspectionBinding.cleaningArea.id,
      fixture.cleaningArea.id,
    );

    // Resolve execution context by ID
    const getExecRes = await api()
      .get(
        `/api/v1/housekeeping/public-area-inspection-executions/${execContext.execution.id}`,
      )
      .set(authHeaders());
    assert.equal(getExecRes.status, 200);
    assert.equal(
      getExecRes.body.data.execution.id,
      execContext.execution.id,
    );
  });

  it('re-uses shared BE-07 Evidence, Reviews, and BE-09 Findings without duplicating engines', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const bindingRes = await api()
      .post('/api/v1/housekeeping/public-area-inspection-bindings')
      .set(authHeaders())
      .send({
        cleaningAreaId: fixture.cleaningArea.id,
        checklistTemplateId: fixture.checklistTemplateId,
      });
    const binding = bindingRes.body.data;

    const startRes = await api()
      .post(
        `/api/v1/housekeeping/public-area-inspection-bindings/${binding.id}/start`,
      )
      .set(authHeaders());
    const executionId = startRes.body.data.execution.id;

    // BE-07 evidence requirements
    const evidence = await api()
      .post('/api/v1/evidence-requirements')
      .set(authHeaders())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: fixture.checklistTemplateId,
        evidenceType: 'PHOTO',
        required: true,
      });
    assert.equal(evidence.status, 201);

    // BE-07 start execution lifecycle
    const started = await api()
      .post(`/api/v1/checklist-executions/${executionId}/start`)
      .set(authHeaders());
    assert.equal(started.status, 200);
    assert.equal(started.body.data.status, 'IN_PROGRESS');

    // BE-09 Finding routing
    const finding = await findingService.createFinding({
      clientId: fixture.client.id,
      buildingId: fixture.building.id,
      findingNumber: `FND_${randomUUID().slice(0, 8).toUpperCase()}`,
      title: 'Stain on lobby carpet detected during public area inspection',
      reportedByUserId: adminUserId,
    });
    assert.ok(finding.id);

    const sourceRes = await api()
      .patch(`/api/v1/findings/${finding.id}/source`)
      .set(authHeaders())
      .send({ sourceType: 'CHECKLIST_EXECUTION', sourceId: executionId });
    assert.equal(sourceRes.status, 200);
    assert.equal(sourceRes.body.data.sourceType, 'CHECKLIST_EXECUTION');
    assert.equal(sourceRes.body.data.sourceId, executionId);
  });

  it('enforces RBAC and Building isolation', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const unauth = await api().post(
      '/api/v1/housekeeping/public-area-inspection-bindings',
    );
    assert.equal(unauth.status, 401);

    const plainToken = await createPlainSession();
    const denied = await api()
      .post('/api/v1/housekeeping/public-area-inspection-bindings')
      .set(authHeaders(plainToken))
      .send({
        cleaningAreaId: fixture.cleaningArea.id,
        checklistTemplateId: fixture.checklistTemplateId,
      });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    // Outsider across building isolation boundary
    const outsider = await createAdminUser();
    const crossRes = await api()
      .post('/api/v1/housekeeping/public-area-inspection-bindings')
      .set(authHeaders(outsider.token))
      .send({
        cleaningAreaId: fixture.cleaningArea.id,
        checklistTemplateId: fixture.checklistTemplateId,
      });
    assert.equal(crossRes.status, 403);
    assert.equal(crossRes.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
