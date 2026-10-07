import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { assetService } from '../src/modules/assets';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { findingService } from '../src/modules/findings';
import { createFunctionalLocation } from '../src/modules/functional-locations';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-10B — Equipment Inspection Binding focused validation.
 *
 * Covers: binding templates to assets, unknown asset/template, unusable
 * templates, inactive/retired assets, cross-building locations, cross-client
 * templates, duplicate active bindings, shared BE-07 execution start,
 * execution context resolution, BE-07 evidence reusability, BE-09 finding
 * integration, RBAC, and Client / Building isolation.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerToken = '';
let managerUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       inspection_bindings, checklist_executions, checklist_item_responses,
       checklist_items, checklist_templates,
       evidence_submissions, evidence_requirements,
       finding_rework_cycles, reviews, finding_assignments, findings,
       assets, functional_locations, buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  const manager = await createAdminUser();
  managerToken = manager.token;
  managerUserId = manager.userId;
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = managerToken) => ({ Authorization: `Bearer ${token}` });

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Inspection client',
  });
  const propertyA = await propertyService.createProperty({
    clientId: clientA.id,
    code: `P_${suffix()}`,
    name: 'Property A',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building A',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building B',
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingB.id,
  });

  const clientC = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Other client',
  });
  const propertyC = await propertyService.createProperty({
    clientId: clientC.id,
    code: `P_${suffix()}`,
    name: 'Property C',
  });
  const buildingC = await buildingService.createBuilding({
    propertyId: propertyC.id,
    code: `B_${suffix()}`,
    name: 'Building C',
  });

  const assetA = await assetService.createAsset({
    buildingId: buildingA.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Chiller unit A',
  });
  const assetInactive = await assetService.createAsset({
    buildingId: buildingA.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Inactive asset',
  });
  await assetService.updateAssetStatus(assetInactive.id, {
    status: 'INACTIVE',
    reason: 'Fixture',
  });
  const assetRetired = await assetService.createAsset({
    buildingId: buildingA.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Retired asset',
  });
  await assetService.updateAssetStatus(assetRetired.id, {
    status: 'RETIRED',
    reason: 'Fixture',
  });
  const assetB = await assetService.createAsset({
    buildingId: buildingB.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Building B asset',
  });

  const flA = await createFunctionalLocation({
    buildingId: buildingA.id,
    code: `FL_${suffix()}`,
    name: 'Plant room A',
  });
  const flB = await createFunctionalLocation({
    buildingId: buildingB.id,
    code: `FL_${suffix()}`,
    name: 'Plant room B',
  });

  // BE-07 checklist templates through the shared BE-07 endpoints.
  const createTemplate = async (clientId: string, status: 'ACTIVE' | 'DRAFT' | 'INACTIVE') => {
    const created = await api()
      .post(`/api/v1/clients/${clientId}/checklist-templates`)
      .set(auth())
      .send({ code: `CHK_${suffix()}`, name: `Checklist ${status}` });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const templateId = created.body.data.id as string;
    if (status !== 'DRAFT') {
      const patched = await api()
        .patch(`/api/v1/checklist-templates/${templateId}`)
        .set(auth())
        .send({ status });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
    }
    return { id: templateId, clientId, status };
  };

  const tplActiveA = await createTemplate(clientA.id, 'ACTIVE');
  const tplDraftA = await createTemplate(clientA.id, 'DRAFT');
  const tplInactiveA = await createTemplate(clientA.id, 'INACTIVE');
  const tplActiveC = await createTemplate(clientC.id, 'ACTIVE');

  return {
    clientA,
    clientC,
    buildingA,
    buildingB,
    buildingC,
    assetA,
    assetInactive,
    assetRetired,
    assetB,
    flA,
    flB,
    tplActiveA,
    tplDraftA,
    tplInactiveA,
    tplActiveC,
  };
}

async function bind(assetId: string, body: Record<string, unknown>, token = managerToken) {
  return api()
    .post(`/api/v1/assets/${assetId}/inspection-bindings`)
    .set(auth(token))
    .send(body);
}

describe('BE-10B equipment inspection binding', () => {
  it('binds an inspection template to an asset with derived context', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind(f.assetA.id, {
      checklistTemplateId: f.tplActiveA.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const binding = response.body.data;

    assert.equal(binding.assetId, f.assetA.id);
    assert.equal(binding.checklistTemplateId, f.tplActiveA.id);
    assert.equal(binding.buildingId, f.buildingA.id);
    assert.equal(binding.clientId, f.clientA.id);
    assert.equal(binding.status, 'ACTIVE');
    assert.equal(binding.functionalLocationId, null);

    const byAsset = await api()
      .get(`/api/v1/assets/${f.assetA.id}/inspection-bindings`)
      .set(auth());
    assert.equal(byAsset.status, 200, JSON.stringify(byAsset.body));
    assert.deepEqual(
      byAsset.body.data.map((b: any) => b.id),
      [binding.id],
    );

    const byId = await api()
      .get(`/api/v1/engineering/inspection-bindings/${binding.id}`)
      .set(auth());
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.data.id, binding.id);

    const byBuilding = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/inspection-bindings`)
      .set(auth());
    assert.equal(byBuilding.status, 200, JSON.stringify(byBuilding.body));
    assert.ok(byBuilding.body.data.some((b: any) => b.id === binding.id));
  });

  it('binds a functional location refinement within the same building', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind(f.assetA.id, {
      checklistTemplateId: f.tplActiveA.id,
      functionalLocationId: f.flA.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.functionalLocationId, f.flA.id);

    const updated = await api()
      .patch(`/api/v1/engineering/inspection-bindings/${response.body.data.id}`)
      .set(auth())
      .send({ functionalLocationId: null });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.functionalLocationId, null);
  });

  it('rejects unknown assets', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind(randomUUID(), {
      checklistTemplateId: f.tplActiveA.id,
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });

  it('rejects unknown or unusable templates', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknown = await bind(f.assetA.id, {
      checklistTemplateId: randomUUID(),
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'NOT_FOUND');

    const draft = await bind(f.assetA.id, {
      checklistTemplateId: f.tplDraftA.id,
    });
    assert.equal(draft.status, 400);
    assert.equal(draft.body.error.code, 'BAD_REQUEST');

    const inactive = await bind(f.assetA.id, {
      checklistTemplateId: f.tplInactiveA.id,
    });
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'BAD_REQUEST');
  });

  it('handles inactive and retired assets consistently', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const inactive = await bind(f.assetInactive.id, {
      checklistTemplateId: f.tplActiveA.id,
    });
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'BAD_REQUEST');

    const retired = await bind(f.assetRetired.id, {
      checklistTemplateId: f.tplActiveA.id,
    });
    assert.equal(retired.status, 409);
    assert.equal(retired.body.error.code, 'ASSET_RETIRED');
  });

  it('rejects cross-building functional locations', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind(f.assetA.id, {
      checklistTemplateId: f.tplActiveA.id,
      functionalLocationId: f.flB.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INSPECTION_LOCATION_BUILDING_MISMATCH');
  });

  it('rejects cross-client templates', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind(f.assetA.id, {
      checklistTemplateId: f.tplActiveC.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INSPECTION_TEMPLATE_CLIENT_MISMATCH');
  });

  it('prevents duplicate active bindings and allows re-binding after deactivation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const first = await bind(f.assetA.id, {
      checklistTemplateId: f.tplActiveA.id,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const duplicate = await bind(f.assetA.id, {
      checklistTemplateId: f.tplActiveA.id,
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'INSPECTION_BINDING_ALREADY_EXISTS');

    const deactivated = await api()
      .patch(`/api/v1/engineering/inspection-bindings/${first.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const rebound = await bind(f.assetA.id, {
      checklistTemplateId: f.tplActiveA.id,
    });
    assert.equal(rebound.status, 201, JSON.stringify(rebound.body));
  });

  it('starts the shared BE-07 execution from a binding', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind(f.assetA.id, {
      checklistTemplateId: f.tplActiveA.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    const started = await api()
      .post(`/api/v1/engineering/inspection-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const execution = started.body.data;
    assert.equal(execution.checklistTemplateId, f.tplActiveA.id);
    assert.equal(execution.inspectionBindingId, binding.body.data.id);
    assert.equal(execution.status, 'DRAFT');

    // The execution is a first-class BE-07 record: the shared checklist
    // execution endpoint reads it without any inspection-specific logic.
    const shared = await api()
      .get(`/api/v1/checklist-executions/${execution.id}`)
      .set(auth());
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.data.id, execution.id);
    assert.equal(shared.body.data.status, 'DRAFT');

    // An INACTIVE binding cannot start executions.
    const deactivated = await api()
      .patch(`/api/v1/engineering/inspection-bindings/${binding.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));

    const rejected = await api()
      .post(`/api/v1/engineering/inspection-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'INSPECTION_BINDING_INACTIVE');
  });

  it('resolves the inspection execution context to the correct asset and building', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind(f.assetA.id, {
      checklistTemplateId: f.tplActiveA.id,
      functionalLocationId: f.flA.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    const started = await api()
      .post(`/api/v1/engineering/inspection-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const executionId = started.body.data.id as string;

    const context = await api()
      .get(`/api/v1/engineering/inspection-executions/${executionId}`)
      .set(auth());
    assert.equal(context.status, 200, JSON.stringify(context.body));
    const data = context.body.data;

    assert.equal(data.execution.id, executionId);
    assert.equal(data.execution.inspectionBindingId, binding.body.data.id);
    assert.equal(data.asset.id, f.assetA.id);
    assert.equal(data.asset.assetCode, f.assetA.assetCode);
    assert.equal(data.asset.status, 'ACTIVE');
    assert.equal(data.building.id, f.buildingA.id);
    assert.equal(data.building.code, f.buildingA.code);
    assert.equal(data.functionalLocation.id, f.flA.id);
    assert.equal(data.functionalLocation.code, f.flA.code);

    // Unknown executions are not inspection executions.
    const unknown = await api()
      .get(`/api/v1/engineering/inspection-executions/${randomUUID()}`)
      .set(auth());
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'INSPECTION_EXECUTION_NOT_FOUND');

    // A plain BE-07 execution (no binding) resolves no inspection context.
    const plain = await api()
      .post(`/api/v1/checklist-templates/${f.tplActiveA.id}/executions`)
      .set(auth());
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    const plainContext = await api()
      .get(`/api/v1/engineering/inspection-executions/${plain.body.data.id}`)
      .set(auth());
    assert.equal(plainContext.status, 404);
    assert.equal(plainContext.body.error.code, 'INSPECTION_EXECUTION_NOT_FOUND');
  });

  it('keeps BE-07 evidence and verification engines reusable', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind(f.assetA.id, {
      checklistTemplateId: f.tplActiveA.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    const started = await api()
      .post(`/api/v1/engineering/inspection-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));

    // BE-07 evidence requirements still bind to the same template untouched.
    const evidence = await api()
      .post('/api/v1/evidence-requirements')
      .set(auth())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: f.tplActiveA.id,
        evidenceType: 'PHOTO',
        required: true,
      });
    assert.equal(evidence.status, 201, JSON.stringify(evidence.body));

    // BE-07 execution lifecycle still drives the inspection execution:
    // start → responses → complete all flow through the shared engine.
    const executionId = started.body.data.id as string;
    const startedExecution = await api()
      .post(`/api/v1/checklist-executions/${executionId}/start`)
      .set(auth());
    assert.equal(startedExecution.status, 200, JSON.stringify(startedExecution.body));
    assert.equal(startedExecution.body.data.status, 'IN_PROGRESS');

    const completed = await api()
      .post(`/api/v1/checklist-executions/${executionId}/complete`)
      .set(auth());
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.data.status, 'COMPLETED');
  });

  it('routes inspection findings through BE-09', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind(f.assetA.id, {
      checklistTemplateId: f.tplActiveA.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    const started = await api()
      .post(`/api/v1/engineering/inspection-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const executionId = started.body.data.id as string;

    const finding = await findingService.createFinding({
      clientId: f.clientA.id,
      buildingId: f.buildingA.id,
      findingNumber: `FND_${suffix()}`,
      title: 'Inspection finding',
      reportedByUserId: managerUserId,
    });

    // BE-09 owns the finding → inspection execution binding, no Engineering
    // finding engine. The shared source type CHECKLIST_EXECUTION is reused.
    const sourceResponse = await api()
      .patch(`/api/v1/findings/${finding.id}/source`)
      .set(auth())
      .send({ sourceType: 'CHECKLIST_EXECUTION', sourceId: executionId });
    assert.equal(sourceResponse.status, 200, JSON.stringify(sourceResponse.body));

    const source = await api()
      .get(`/api/v1/findings/${finding.id}/source`)
      .set(auth());
    assert.equal(source.status, 200, JSON.stringify(source.body));
    assert.equal(source.body.data.sourceType, 'CHECKLIST_EXECUTION');
    assert.equal(source.body.data.sourceId, executionId);
    assert.equal(source.body.data.context.referenceType, 'CHECKLIST_TEMPLATE');
    assert.equal(source.body.data.context.referenceId, f.tplActiveA.id);

    // Backend-authoritative available actions stay BE-09's.
    const actions = await api()
      .get(`/api/v1/findings/${finding.id}/available-actions`)
      .set(auth());
    assert.equal(actions.status, 200, JSON.stringify(actions.body));
    assert.ok(Array.isArray(actions.body.data.availableActions));
    assert.equal(actions.body.data.state, 'OPEN');
  });

  it('enforces RBAC on every inspection endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const binding = await bind(f.assetA.id, {
      checklistTemplateId: f.tplActiveA.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const bindingId = binding.body.data.id as string;

    const plainToken = await createPlainSession();

    const unauthCreate = await api()
      .post(`/api/v1/assets/${f.assetA.id}/inspection-bindings`)
      .send({ checklistTemplateId: f.tplActiveA.id });
    assert.equal(unauthCreate.status, 401);
    assert.equal(unauthCreate.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbiddenCreate = await bind(
      f.assetA.id,
      { checklistTemplateId: f.tplActiveA.id },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenRead = await api()
      .get(`/api/v1/engineering/inspection-bindings/${bindingId}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get(`/api/v1/assets/${f.assetA.id}/inspection-bindings`)
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const forbiddenStart = await api()
      .post(`/api/v1/engineering/inspection-bindings/${bindingId}/start`)
      .set(auth(plainToken));
    assert.equal(forbiddenStart.status, 403);
    assert.equal(forbiddenStart.body.error.code, 'PERMISSION_DENIED');
  });

  it('isolates buildings and clients', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const bindingA = await bind(f.assetA.id, {
      checklistTemplateId: f.tplActiveA.id,
    });
    assert.equal(bindingA.status, 201, JSON.stringify(bindingA.body));

    const bindingB = await bind(f.assetB.id, {
      checklistTemplateId: f.tplActiveA.id,
    });
    assert.equal(bindingB.status, 201, JSON.stringify(bindingB.body));

    // A user assigned only to Building B cannot touch Building A bindings.
    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedCreate = await bind(
      f.assetA.id,
      { checklistTemplateId: f.tplActiveA.id },
      bOnly.token,
    );
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedRead = await api()
      .get(`/api/v1/engineering/inspection-bindings/${bindingA.body.data.id}`)
      .set(auth(bOnly.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedBuildingList = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/inspection-bindings`)
      .set(auth(bOnly.token));
    assert.equal(deniedBuildingList.status, 403);
    assert.equal(deniedBuildingList.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Building B's own list contains only Building B's bindings.
    const buildingBList = await api()
      .get(`/api/v1/buildings/${f.buildingB.id}/engineering/inspection-bindings`)
      .set(auth(bOnly.token));
    assert.equal(buildingBList.status, 200, JSON.stringify(buildingBList.body));
    assert.deepEqual(
      buildingBList.body.data.map((b: any) => b.id),
      [bindingB.body.data.id],
    );

    // Cross-client asset: the asset path resolves through the asset's own
    // client, and the client C template can never bind to client A's asset.
    const crossClient = await bind(f.assetA.id, {
      checklistTemplateId: f.tplActiveC.id,
    });
    assert.equal(crossClient.status, 400);
    assert.equal(crossClient.body.error.code, 'INSPECTION_TEMPLATE_CLIENT_MISMATCH');
  });
});
