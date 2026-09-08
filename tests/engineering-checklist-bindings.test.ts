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
 * BE-10E — Engineering Checklist Binding focused validation.
 *
 * Covers: binding checklist templates to engineering contexts (asset, FL, or
 * both), unknown template, invalid asset/building and location/building
 * relationships, cross-client templates, measurement-UOM validation, shared
 * BE-07 execution start, execution context resolution, evidence/verification
 * reusability, BE-09 finding integration, RBAC, and isolation.
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
       engineering_checklist_bindings, log_sheet_bindings,
       meter_reading_bindings, inspection_bindings,
       checklist_executions, checklist_item_responses,
       checklist_items, checklist_templates,
       evidence_submissions, evidence_requirements,
       finding_rework_cycles, reviews, finding_assignments, findings,
       assets, functional_locations, buildings, properties,
       units_of_measure,
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
    name: 'Checklist client',
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
    assetName: 'Chiller plant asset',
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
  const flInactiveA = await createFunctionalLocation({
    buildingId: buildingA.id,
    code: `FL_${suffix()}`,
    name: 'Inactive room A',
    status: 'INACTIVE',
  });
  const flB = await createFunctionalLocation({
    buildingId: buildingB.id,
    code: `FL_${suffix()}`,
    name: 'Plant room B',
  });

  const createUom = async (clientId: string, status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') => {
    const created = await api()
      .post(`/api/v1/clients/${clientId}/uoms`)
      .set(auth())
      .send({ code: `UOM_${suffix()}`, name: 'Degree Celsius', symbol: '°C', category: 'TEMPERATURE' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const uomId = created.body.data.id as string;
    if (status === 'INACTIVE') {
      const patched = await api().patch(`/api/v1/uoms/${uomId}`).set(auth()).send({ status });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
    }
    return { id: uomId, clientId, status };
  };
  const uomA = await createUom(clientA.id);
  const uomInactive = await createUom(clientA.id, 'INACTIVE');
  const uomC = await createUom(clientC.id);

  const createTemplate = async (clientId: string, status: 'ACTIVE' | 'DRAFT' | 'INACTIVE' = 'ACTIVE') => {
    const created = await api()
      .post(`/api/v1/clients/${clientId}/checklist-templates`)
      .set(auth())
      .send({ code: `CHK_${suffix()}`, name: `Checklist ${status}` });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const templateId = created.body.data.id as string;
    const templateCode = created.body.data.code as string;
    if (status !== 'DRAFT') {
      const patched = await api()
        .patch(`/api/v1/checklist-templates/${templateId}`)
        .set(auth())
        .send({ status });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
    }
    return { id: templateId, code: templateCode, clientId, status };
  };
  const createItem = async (templateId: string, itemType: string) => {
    const item = await api()
      .post(`/api/v1/checklist-templates/${templateId}/items`)
      .set(auth())
      .send({ code: `ITM_${suffix()}`, label: `Item ${itemType}`, itemType, required: false, displayOrder: 0 });
    assert.equal(item.status, 201, JSON.stringify(item.body));
    return item.body.data.id as string;
  };
  const configureMeasurement = async (itemId: string, uomId: string) => {
    const response = await api()
      .patch(`/api/v1/checklist-items/${itemId}/measurement`)
      .set(auth())
      .send({ uomId, minimumValue: 0, maximumValue: 100 });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  };

  // Main template: numeric measurement item (valid UOM) + check item.
  const tplActive = await createTemplate(clientA.id, 'ACTIVE');
  const numericItem = await createItem(tplActive.id, 'NUMBER');
  await configureMeasurement(numericItem, uomA.id);
  const checkItem = await createItem(tplActive.id, 'CHECK');

  // Unusable templates.
  const tplDraft = await createTemplate(clientA.id, 'DRAFT');
  const tplInactive = await createTemplate(clientA.id, 'INACTIVE');
  const tplC = await createTemplate(clientC.id, 'ACTIVE');

  // Measurement-UOM validation fixtures.
  // BE-07 rejects attaching an INACTIVE UOM through its own measurement
  // endpoint, so the inactive-UOM state is set directly as a fixture row
  // (the binding must still reject it).
  const tplBadUom = await createTemplate(clientA.id, 'ACTIVE');
  const badUomItem = await createItem(tplBadUom.id, 'NUMBER');
  await configureMeasurement(badUomItem, uomA.id);
  await pool!.query(
    `UPDATE checklist_items SET uom_id = $1, updated_at = NOW() WHERE id = $2`,
    [uomInactive.id, badUomItem],
  );

  // BE-07's measurement endpoint checks status but not client ownership, so
  // a cross-client UOM can be attached — the binding must still reject it.
  const tplForeignUom = await createTemplate(clientA.id, 'ACTIVE');
  const foreignUomItem = await createItem(tplForeignUom.id, 'NUMBER');
  await configureMeasurement(foreignUomItem, uomC.id);

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
    flInactiveA,
    flB,
    uomA,
    uomC,
    tplActive,
    tplDraft,
    tplInactive,
    tplC,
    tplBadUom,
    tplForeignUom,
    numericItem,
    checkItem,
  };
}

async function bind(body: Record<string, unknown>, token = managerToken) {
  return api()
    .post('/api/v1/engineering/checklist-bindings')
    .set(auth(token))
    .send(body);
}

describe('BE-10E engineering checklist binding', () => {
  it('binds a checklist template to an engineering context (asset + location)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      assetId: f.assetA.id,
      functionalLocationId: f.flA.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const binding = response.body.data;

    assert.equal(binding.buildingId, f.buildingA.id);
    assert.equal(binding.clientId, f.clientA.id);
    assert.equal(binding.checklistTemplateId, f.tplActive.id);
    assert.equal(binding.assetId, f.assetA.id);
    assert.equal(binding.functionalLocationId, f.flA.id);
    assert.equal(binding.status, 'ACTIVE');

    const byId = await api()
      .get(`/api/v1/engineering/checklist-bindings/${binding.id}`)
      .set(auth());
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.data.id, binding.id);

    const byBuilding = await api()
      .get('/api/v1/engineering/checklist-bindings')
      .query({ buildingId: f.buildingA.id })
      .set(auth());
    assert.equal(byBuilding.status, 200, JSON.stringify(byBuilding.body));
    assert.ok(byBuilding.body.data.some((b: any) => b.id === binding.id));

    const byAsset = await api()
      .get('/api/v1/engineering/checklist-bindings')
      .query({ assetId: f.assetA.id })
      .set(auth());
    assert.equal(byAsset.status, 200, JSON.stringify(byAsset.body));
    assert.deepEqual(byAsset.body.data.map((b: any) => b.id), [binding.id]);

    const all = await api().get('/api/v1/engineering/checklist-bindings').set(auth());
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.ok(all.body.data.some((b: any) => b.id === binding.id));
  });

  it('binds checklists to asset-only and location-only targets', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const assetOnly = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      assetId: f.assetA.id,
    });
    assert.equal(assetOnly.status, 201, JSON.stringify(assetOnly.body));
    assert.equal(assetOnly.body.data.assetId, f.assetA.id);
    assert.equal(assetOnly.body.data.functionalLocationId, null);

    const locationOnly = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      functionalLocationId: f.flA.id,
    });
    assert.equal(locationOnly.status, 201, JSON.stringify(locationOnly.body));
    assert.equal(locationOnly.body.data.assetId, null);
    assert.equal(locationOnly.body.data.functionalLocationId, f.flA.id);
  });

  it('rejects unknown buildings and templates', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknownBuilding = await bind({
      buildingId: randomUUID(),
      checklistTemplateId: f.tplActive.id,
      assetId: f.assetA.id,
    });
    assert.equal(unknownBuilding.status, 404);
    assert.equal(unknownBuilding.body.error.code, 'BUILDING_NOT_FOUND');

    const unknownTemplate = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: randomUUID(),
      assetId: f.assetA.id,
    });
    assert.equal(unknownTemplate.status, 404);
    assert.equal(unknownTemplate.body.error.code, 'NOT_FOUND');

    const draft = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplDraft.id,
      assetId: f.assetA.id,
    });
    assert.equal(draft.status, 400);
    assert.equal(draft.body.error.code, 'BAD_REQUEST');

    const inactive = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplInactive.id,
      assetId: f.assetA.id,
    });
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'BAD_REQUEST');
  });

  it('rejects invalid asset / building relationships', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknown = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      assetId: randomUUID(),
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'ASSET_NOT_FOUND');

    const otherBuilding = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      assetId: f.assetB.id,
    });
    assert.equal(otherBuilding.status, 400);
    assert.equal(otherBuilding.body.error.code, 'ENGINEERING_CHECKLIST_ASSET_BUILDING_MISMATCH');

    const inactive = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      assetId: f.assetInactive.id,
    });
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'BAD_REQUEST');

    const retired = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      assetId: f.assetRetired.id,
    });
    assert.equal(retired.status, 409);
    assert.equal(retired.body.error.code, 'ASSET_RETIRED');
  });

  it('rejects invalid location / building relationships', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknown = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      functionalLocationId: randomUUID(),
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'FUNCTIONAL_LOCATION_NOT_FOUND');

    const otherBuilding = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      functionalLocationId: f.flB.id,
    });
    assert.equal(otherBuilding.status, 400);
    assert.equal(otherBuilding.body.error.code, 'ENGINEERING_CHECKLIST_LOCATION_BUILDING_MISMATCH');

    const inactive = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      functionalLocationId: f.flInactiveA.id,
    });
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'BAD_REQUEST');
  });

  it('rejects bindings without an operational target', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects cross-client templates', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplC.id,
      assetId: f.assetA.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ENGINEERING_CHECKLIST_TEMPLATE_CLIENT_MISMATCH');
  });

  it('validates measurement UOMs with BE-07 rules', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const inactiveUom = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplBadUom.id,
      assetId: f.assetA.id,
    });
    assert.equal(inactiveUom.status, 400);
    assert.equal(inactiveUom.body.error.code, 'ENGINEERING_CHECKLIST_UOM_INACTIVE');

    const foreignUom = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplForeignUom.id,
      assetId: f.assetA.id,
    });
    assert.equal(foreignUom.status, 400);
    assert.equal(foreignUom.body.error.code, 'ENGINEERING_CHECKLIST_UOM_CLIENT_MISMATCH');

    // BE-07's own measurement rule: UOM requires a numeric definition.
    const nonNumeric = await api()
      .patch(`/api/v1/checklist-items/${f.checkItem}/measurement`)
      .set(auth())
      .send({ uomId: f.uomA.id });
    assert.equal(nonNumeric.status, 400);
    assert.equal(nonNumeric.body.error.code, 'BAD_REQUEST');
  });

  it('prevents duplicate active bindings and allows re-binding after deactivation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const first = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      assetId: f.assetA.id,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const duplicate = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      assetId: f.assetA.id,
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'ENGINEERING_CHECKLIST_BINDING_ALREADY_EXISTS');

    const deactivated = await api()
      .patch(`/api/v1/engineering/checklist-bindings/${first.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const rebound = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      assetId: f.assetA.id,
    });
    assert.equal(rebound.status, 201, JSON.stringify(rebound.body));
  });

  it('starts the shared BE-07 checklist execution from a binding', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      assetId: f.assetA.id,
      functionalLocationId: f.flA.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    const started = await api()
      .post(`/api/v1/engineering/checklist-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const execution = started.body.data;
    assert.equal(execution.checklistTemplateId, f.tplActive.id);
    assert.equal(execution.engineeringChecklistBindingId, binding.body.data.id);
    assert.equal(execution.status, 'DRAFT');

    // The execution is a first-class BE-07 record: the shared checklist
    // execution endpoint reads and drives it without any binding logic.
    const shared = await api()
      .get(`/api/v1/checklist-executions/${execution.id}`)
      .set(auth());
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.data.id, execution.id);

    const startedShared = await api()
      .post(`/api/v1/checklist-executions/${execution.id}/start`)
      .set(auth());
    assert.equal(startedShared.status, 200, JSON.stringify(startedShared.body));
    assert.equal(startedShared.body.data.status, 'IN_PROGRESS');

    // INACTIVE bindings cannot start executions.
    const deactivated = await api()
      .patch(`/api/v1/engineering/checklist-bindings/${binding.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    const rejected = await api()
      .post(`/api/v1/engineering/checklist-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'ENGINEERING_CHECKLIST_BINDING_INACTIVE');
  });

  it('resolves the execution context to the correct building, asset, and location', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      assetId: f.assetA.id,
      functionalLocationId: f.flA.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const started = await api()
      .post(`/api/v1/engineering/checklist-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const executionId = started.body.data.id as string;

    const context = await api()
      .get(`/api/v1/engineering/checklist-executions/${executionId}`)
      .set(auth());
    assert.equal(context.status, 200, JSON.stringify(context.body));
    const data = context.body.data;

    assert.equal(data.execution.id, executionId);
    assert.equal(data.building.id, f.buildingA.id);
    assert.equal(data.building.code, f.buildingA.code);
    assert.equal(data.template.id, f.tplActive.id);
    assert.equal(data.template.code, f.tplActive.code);
    assert.equal(data.asset.id, f.assetA.id);
    assert.equal(data.asset.assetCode, f.assetA.assetCode);
    assert.equal(data.functionalLocation.id, f.flA.id);
    assert.equal(data.functionalLocation.code, f.flA.code);

    // Unknown or plain BE-07 executions carry no engineering context.
    const unknown = await api()
      .get(`/api/v1/engineering/checklist-executions/${randomUUID()}`)
      .set(auth());
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'ENGINEERING_CHECKLIST_EXECUTION_NOT_FOUND');

    const plain = await api()
      .post(`/api/v1/checklist-templates/${f.tplActive.id}/executions`)
      .set(auth());
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    const plainContext = await api()
      .get(`/api/v1/engineering/checklist-executions/${plain.body.data.id}`)
      .set(auth());
    assert.equal(plainContext.status, 404);
    assert.equal(plainContext.body.error.code, 'ENGINEERING_CHECKLIST_EXECUTION_NOT_FOUND');
  });

  it('keeps BE-07 evidence reusable and routes findings through BE-09', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      assetId: f.assetA.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const started = await api()
      .post(`/api/v1/engineering/checklist-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const executionId = started.body.data.id as string;

    // BE-07 evidence requirements still target the shared template untouched.
    const evidence = await api()
      .post('/api/v1/evidence-requirements')
      .set(auth())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: f.tplActive.id,
        evidenceType: 'PHOTO',
        required: true,
      });
    assert.equal(evidence.status, 201, JSON.stringify(evidence.body));

    // BE-09 owns the finding → checklist execution binding.
    const finding = await findingService.createFinding({
      clientId: f.clientA.id,
      buildingId: f.buildingA.id,
      findingNumber: `FND_${suffix()}`,
      title: 'Checklist finding',
      reportedByUserId: managerUserId,
    });
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
    assert.equal(source.body.data.context.referenceId, f.tplActive.id);

    // Backend-authoritative available actions stay BE-09's.
    const actions = await api()
      .get(`/api/v1/findings/${finding.id}/available-actions`)
      .set(auth());
    assert.equal(actions.status, 200, JSON.stringify(actions.body));
    assert.ok(Array.isArray(actions.body.data.availableActions));
    assert.equal(actions.body.data.state, 'OPEN');
  });

  it('enforces RBAC on every engineering checklist endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const binding = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      assetId: f.assetA.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const bindingId = binding.body.data.id as string;

    const plainToken = await createPlainSession();

    const unauthCreate = await api()
      .post('/api/v1/engineering/checklist-bindings')
      .send({ buildingId: f.buildingA.id, checklistTemplateId: f.tplActive.id, assetId: f.assetA.id });
    assert.equal(unauthCreate.status, 401);
    assert.equal(unauthCreate.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbiddenCreate = await bind(
      {
        buildingId: f.buildingA.id,
        checklistTemplateId: f.tplActive.id,
        assetId: f.assetA.id,
      },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get('/api/v1/engineering/checklist-bindings')
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const forbiddenRead = await api()
      .get(`/api/v1/engineering/checklist-bindings/${bindingId}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenStart = await api()
      .post(`/api/v1/engineering/checklist-bindings/${bindingId}/start`)
      .set(auth(plainToken));
    assert.equal(forbiddenStart.status, 403);
    assert.equal(forbiddenStart.body.error.code, 'PERMISSION_DENIED');
  });

  it('isolates buildings and clients', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const bindingA = await bind({
      buildingId: f.buildingA.id,
      checklistTemplateId: f.tplActive.id,
      assetId: f.assetA.id,
    });
    assert.equal(bindingA.status, 201, JSON.stringify(bindingA.body));
    const bindingB = await bind({
      buildingId: f.buildingB.id,
      checklistTemplateId: f.tplActive.id,
      assetId: f.assetB.id,
    });
    assert.equal(bindingB.status, 201, JSON.stringify(bindingB.body));

    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedCreate = await bind(
      {
        buildingId: f.buildingA.id,
        checklistTemplateId: f.tplActive.id,
        assetId: f.assetA.id,
      },
      bOnly.token,
    );
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedRead = await api()
      .get(`/api/v1/engineering/checklist-bindings/${bindingA.body.data.id}`)
      .set(auth(bOnly.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedList = await api()
      .get('/api/v1/engineering/checklist-bindings')
      .query({ buildingId: f.buildingA.id })
      .set(auth(bOnly.token));
    assert.equal(deniedList.status, 403);
    assert.equal(deniedList.body.error.code, 'BUILDING_ACCESS_DENIED');

    // An unfiltered list is scoped to the caller's accessible buildings.
    const scopedList = await api()
      .get('/api/v1/engineering/checklist-bindings')
      .set(auth(bOnly.token));
    assert.equal(scopedList.status, 200, JSON.stringify(scopedList.body));
    assert.deepEqual(
      scopedList.body.data.map((b: any) => b.id),
      [bindingB.body.data.id],
    );
  });
});
