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
 * BE-10D — Equipment Log Sheet Binding focused validation.
 *
 * Covers: binding log sheet templates/versions to assets, unknown
 * asset/template/version, inactive/retired assets, cross-building locations,
 * cross-client template/UOM, measurement-field UOM validity, duplicate
 * prevention, shared BE-07 execution start, BE-07 numeric response
 * validation, execution history references, context resolution, BE-09
 * finding integration, RBAC, and isolation.
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
       log_sheet_bindings, meter_reading_bindings, inspection_bindings,
       form_responses, form_instances,
       form_template_version_fields, form_template_version_sections,
       form_template_versions, form_fields, form_sections, form_templates,
       source_forms, units_of_measure,
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
    name: 'Log sheet client',
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
    assetName: 'Cooling tower asset',
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
    name: 'Mechanical room A',
  });
  const flB = await createFunctionalLocation({
    buildingId: buildingB.id,
    code: `FL_${suffix()}`,
    name: 'Mechanical room B',
  });

  const createUom = async (clientId: string) => {
    const created = await api()
      .post(`/api/v1/clients/${clientId}/uoms`)
      .set(auth())
      .send({ code: `UOM_${suffix()}`, name: 'Kilowatt hour', symbol: 'kWh', category: 'ENERGY' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return { id: created.body.data.id as string, clientId };
  };
  const uomA = await createUom(clientA.id);
  const uomC = await createUom(clientC.id);

  const createSourceForm = async (clientId: string) => {
    const created = await api()
      .post(`/api/v1/clients/${clientId}/source-forms`)
      .set(auth())
      .send({ code: `SRC_${suffix()}`, name: 'Log sheet source form', sourceType: 'INTERNAL' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.data.id as string;
  };
  const createTemplate = async (clientId: string, status: 'ACTIVE' | 'DRAFT' | 'INACTIVE' = 'ACTIVE') => {
    const sourceFormId = await createSourceForm(clientId);
    const created = await api()
      .post(`/api/v1/source-forms/${sourceFormId}/templates`)
      .set(auth())
      .send({ code: `TPL_${suffix()}`, name: `Log sheet template ${status}`, status: 'ACTIVE' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const templateId = created.body.data.id as string;
    if (status !== 'ACTIVE') {
      const patched = await api()
        .patch(`/api/v1/form-templates/${templateId}`)
        .set(auth())
        .send({ status });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
    }
    return { id: templateId, clientId, status };
  };
  const createField = async (
    templateId: string,
    fieldType: string,
    options: { status?: string } = {},
  ) => {
    const section = await api()
      .post(`/api/v1/form-templates/${templateId}/sections`)
      .set(auth())
      .send({ code: `SEC_${suffix()}`, title: 'Log entries', displayOrder: 0 });
    assert.equal(section.status, 201, JSON.stringify(section.body));
    const sectionId = section.body.data.id as string;
    const field = await api()
      .post(`/api/v1/form-sections/${sectionId}/fields`)
      .set(auth())
      .send({
        code: `FLD_${suffix()}`,
        label: 'Log value',
        fieldType,
        required: false,
        displayOrder: 0,
        ...(options.status ? { status: options.status } : {}),
      });
    assert.equal(field.status, 201, JSON.stringify(field.body));
    return { id: field.body.data.id as string, sectionId, fieldType };
  };
  const configureMeasurement = async (fieldId: string, uomId: string) => {
    const response = await api()
      .patch(`/api/v1/form-fields/${fieldId}/measurement`)
      .set(auth())
      .send({ uomId, minimumValue: 0, maximumValue: 1000, decimalPrecision: 2 });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  };
  const publish = async (templateId: string, versionNumber = 1) => {
    const version = await api()
      .post(`/api/v1/form-templates/${templateId}/versions`)
      .set(auth())
      .send({ versionNumber });
    assert.equal(version.status, 201, JSON.stringify(version.body));
    const published = await api()
      .post(`/api/v1/form-template-versions/${version.body.data.id}/publish`)
      .set(auth());
    assert.equal(published.status, 200, JSON.stringify(published.body));
    return version.body.data.id as string;
  };
  const versionFields = async (versionId: string) => {
    const result = await pool!.query<{ id: string; field_type: string; code: string }>(
      `SELECT vf.id, vf.field_type, vf.code
       FROM form_template_version_fields vf
       JOIN form_template_version_sections vs ON vs.id = vf.version_section_id
       WHERE vs.version_id = $1
       ORDER BY vf.display_order, vf.id`,
      [versionId],
    );
    return result.rows;
  };

  // Main template: ACTIVE, one measured NUMBER field + one TEXT field.
  const tplActive = await createTemplate(clientA.id, 'ACTIVE');
  const measuredField = await createField(tplActive.id, 'NUMBER');
  await configureMeasurement(measuredField.id, uomA.id);
  const textField = await createField(tplActive.id, 'TEXT');
  const version1 = await publish(tplActive.id, 1);
  const versionFields1 = await versionFields(version1);
  const numericVersionField = versionFields1.find((f) => f.field_type === 'NUMBER');

  // A second DRAFT version of the same template (invalid to bind).
  const draftVersion = await api()
    .post(`/api/v1/form-templates/${tplActive.id}/versions`)
    .set(auth())
    .send({ versionNumber: 2 });
  assert.equal(draftVersion.status, 201, JSON.stringify(draftVersion.body));

  // Unusable templates.
  const tplDraft = await createTemplate(clientA.id, 'DRAFT');
  const tplInactive = await createTemplate(clientA.id, 'INACTIVE');

  // ACTIVE template with no published version.
  const tplNoVersion = await createTemplate(clientA.id, 'ACTIVE');
  await createField(tplNoVersion.id, 'NUMBER');

  // Other-client template with a published version.
  const tplC = await createTemplate(clientC.id, 'ACTIVE');
  await createField(tplC.id, 'NUMBER');
  const versionC = await publish(tplC.id, 1);

  // Measurement field whose UOM is later deactivated.
  const tplBadUom = await createTemplate(clientA.id, 'ACTIVE');
  const badUomField = await createField(tplBadUom.id, 'NUMBER');
  const uomThenInactive = await createUom(clientA.id);
  await configureMeasurement(badUomField.id, uomThenInactive.id);
  const versionBadUom = await publish(tplBadUom.id, 1);
  const deactivate = await api()
    .patch(`/api/v1/uoms/${uomThenInactive.id}`)
    .set(auth())
    .send({ status: 'INACTIVE' });
  assert.equal(deactivate.status, 200, JSON.stringify(deactivate.body));

  // Measurement field configured with another client's UOM.
  const tplForeignUom = await createTemplate(clientA.id, 'ACTIVE');
  const foreignUomField = await createField(tplForeignUom.id, 'NUMBER');
  await configureMeasurement(foreignUomField.id, uomC.id);
  const versionForeignUom = await publish(tplForeignUom.id, 1);

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
    uomA,
    uomC,
    tplActive,
    tplDraft,
    tplInactive,
    tplNoVersion,
    tplC,
    tplBadUom,
    tplForeignUom,
    version1,
    draftVersion: draftVersion.body.data.id as string,
    versionC,
    versionBadUom,
    versionForeignUom,
    numericVersionField,
  };
}

async function bind(assetId: string, body: Record<string, unknown>, token = managerToken) {
  return api()
    .post(`/api/v1/assets/${assetId}/log-sheet-bindings`)
    .set(auth(token))
    .send(body);
}

describe('BE-10D equipment log sheet binding', () => {
  it('binds a log sheet template to an asset with derived context', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind(f.assetA.id, { formTemplateId: f.tplActive.id });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const binding = response.body.data;

    assert.equal(binding.assetId, f.assetA.id);
    assert.equal(binding.formTemplateId, f.tplActive.id);
    assert.equal(binding.formTemplateVersionId, null);
    assert.equal(binding.buildingId, f.buildingA.id);
    assert.equal(binding.clientId, f.clientA.id);
    assert.equal(binding.functionalLocationId, null);
    assert.equal(binding.status, 'ACTIVE');

    const byAsset = await api()
      .get(`/api/v1/assets/${f.assetA.id}/log-sheet-bindings`)
      .set(auth());
    assert.equal(byAsset.status, 200, JSON.stringify(byAsset.body));
    assert.deepEqual(byAsset.body.data.map((b: any) => b.id), [binding.id]);

    const byId = await api()
      .get(`/api/v1/engineering/log-sheet-bindings/${binding.id}`)
      .set(auth());
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.data.id, binding.id);

    const byBuilding = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/log-sheet-bindings`)
      .set(auth());
    assert.equal(byBuilding.status, 200, JSON.stringify(byBuilding.body));
    assert.ok(byBuilding.body.data.some((b: any) => b.id === binding.id));
  });

  it('binds a specific published version and functional location, then updates', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind(f.assetA.id, {
      formTemplateId: f.tplActive.id,
      formTemplateVersionId: f.version1,
      functionalLocationId: f.flA.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const binding = response.body.data;
    assert.equal(binding.formTemplateVersionId, f.version1);
    assert.equal(binding.functionalLocationId, f.flA.id);

    const cleared = await api()
      .patch(`/api/v1/engineering/log-sheet-bindings/${binding.id}`)
      .set(auth())
      .send({ functionalLocationId: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.data.functionalLocationId, null);

    const versionCleared = await api()
      .patch(`/api/v1/engineering/log-sheet-bindings/${binding.id}`)
      .set(auth())
      .send({ formTemplateVersionId: null });
    assert.equal(versionCleared.status, 200, JSON.stringify(versionCleared.body));
    assert.equal(versionCleared.body.data.formTemplateVersionId, null);
  });

  it('rejects unknown assets', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind(randomUUID(), { formTemplateId: f.tplActive.id });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });

  it('rejects invalid templates', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknown = await bind(f.assetA.id, { formTemplateId: randomUUID() });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'NOT_FOUND');

    const draft = await bind(f.assetA.id, { formTemplateId: f.tplDraft.id });
    assert.equal(draft.status, 400);
    assert.equal(draft.body.error.code, 'BAD_REQUEST');

    const inactive = await bind(f.assetA.id, { formTemplateId: f.tplInactive.id });
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'BAD_REQUEST');

    const crossClient = await bind(f.assetA.id, { formTemplateId: f.tplC.id });
    assert.equal(crossClient.status, 400);
    assert.equal(crossClient.body.error.code, 'LOG_SHEET_TEMPLATE_CLIENT_MISMATCH');
  });

  it('rejects invalid template versions', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknown = await bind(f.assetA.id, {
      formTemplateId: f.tplActive.id,
      formTemplateVersionId: randomUUID(),
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'NOT_FOUND');

    const otherTemplate = await bind(f.assetA.id, {
      formTemplateId: f.tplActive.id,
      formTemplateVersionId: f.versionC,
    });
    assert.equal(otherTemplate.status, 400);
    assert.equal(otherTemplate.body.error.code, 'LOG_SHEET_VERSION_TEMPLATE_MISMATCH');

    const draft = await bind(f.assetA.id, {
      formTemplateId: f.tplActive.id,
      formTemplateVersionId: f.draftVersion,
    });
    assert.equal(draft.status, 400);
    assert.equal(draft.body.error.code, 'BAD_REQUEST');
  });

  it('handles inactive and retired assets consistently', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const inactive = await bind(f.assetInactive.id, { formTemplateId: f.tplActive.id });
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'BAD_REQUEST');

    const retired = await bind(f.assetRetired.id, { formTemplateId: f.tplActive.id });
    assert.equal(retired.status, 409);
    assert.equal(retired.body.error.code, 'ASSET_RETIRED');
  });

  it('rejects cross-building functional locations', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind(f.assetA.id, {
      formTemplateId: f.tplActive.id,
      functionalLocationId: f.flB.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'LOG_SHEET_LOCATION_BUILDING_MISMATCH');
  });

  it('validates measurement field UOMs for the bound version', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const inactiveUom = await bind(f.assetA.id, {
      formTemplateId: f.tplBadUom.id,
      formTemplateVersionId: f.versionBadUom,
    });
    assert.equal(inactiveUom.status, 400);
    assert.equal(inactiveUom.body.error.code, 'LOG_SHEET_UOM_INACTIVE');

    const foreignUom = await bind(f.assetA.id, {
      formTemplateId: f.tplForeignUom.id,
      formTemplateVersionId: f.versionForeignUom,
    });
    assert.equal(foreignUom.status, 400);
    assert.equal(foreignUom.body.error.code, 'LOG_SHEET_UOM_CLIENT_MISMATCH');
  });

  it('prevents duplicate active bindings and allows re-binding after deactivation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const first = await bind(f.assetA.id, { formTemplateId: f.tplActive.id });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const duplicate = await bind(f.assetA.id, { formTemplateId: f.tplActive.id });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'LOG_SHEET_BINDING_ALREADY_EXISTS');

    const deactivated = await api()
      .patch(`/api/v1/engineering/log-sheet-bindings/${first.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));

    const rebound = await bind(f.assetA.id, { formTemplateId: f.tplActive.id });
    assert.equal(rebound.status, 201, JSON.stringify(rebound.body));
  });

  it('starts the shared BE-07 form instance as the log sheet execution', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind(f.assetA.id, {
      formTemplateId: f.tplActive.id,
      formTemplateVersionId: f.version1,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    const started = await api()
      .post(`/api/v1/engineering/log-sheet-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const execution = started.body.data;
    assert.equal(execution.formTemplateVersionId, f.version1);
    assert.equal(execution.logSheetBindingId, binding.body.data.id);
    assert.equal(execution.status, 'DRAFT');

    // The execution is a first-class BE-07 form instance.
    const shared = await api().get(`/api/v1/form-instances/${execution.id}`).set(auth());
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.data.id, execution.id);

    // A template without a published version cannot start.
    const noVersionBinding = await bind(f.assetA.id, {
      formTemplateId: f.tplNoVersion.id,
    });
    assert.equal(noVersionBinding.status, 201, JSON.stringify(noVersionBinding.body));
    const noVersionStart = await api()
      .post(`/api/v1/engineering/log-sheet-bindings/${noVersionBinding.body.data.id}/start`)
      .set(auth());
    assert.equal(noVersionStart.status, 400);
    assert.equal(noVersionStart.body.error.code, 'BAD_REQUEST');

    // INACTIVE bindings cannot start.
    const deactivated = await api()
      .patch(`/api/v1/engineering/log-sheet-bindings/${binding.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    const rejected = await api()
      .post(`/api/v1/engineering/log-sheet-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'LOG_SHEET_BINDING_INACTIVE');
  });

  it('keeps numeric responses validated by BE-07', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind(f.assetA.id, { formTemplateId: f.tplActive.id });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const started = await api()
      .post(`/api/v1/engineering/log-sheet-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const executionId = started.body.data.id as string;

    // BE-07 rejects a non-numeric value for the NUMBER measurement field.
    const nonNumeric = await api()
      .put(`/api/v1/form-instances/${executionId}/responses`)
      .set(auth())
      .send([{ fieldId: f.numericVersionField!.id, value: 'not-a-number' }]);
    assert.equal(nonNumeric.status, 400);
    assert.equal(nonNumeric.body.error.code, 'BAD_REQUEST');

    // A valid numeric response is persisted by BE-07.
    const numeric = await api()
      .put(`/api/v1/form-instances/${executionId}/responses`)
      .set(auth())
      .send([{ fieldId: f.numericVersionField!.id, value: 42.5 }]);
    assert.equal(numeric.status, 200, JSON.stringify(numeric.body));

    const responses = await api()
      .get(`/api/v1/form-instances/${executionId}/responses`)
      .set(auth());
    assert.equal(responses.status, 200, JSON.stringify(responses.body));
    const saved = responses.body.data.find(
      (r: any) => r.version_field_id === f.numericVersionField!.id,
    );
    assert.ok(saved, 'reading response must be persisted');
    assert.equal(Number(saved.value), 42.5);
  });

  it('keeps historical executions referenceable', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind(f.assetA.id, { formTemplateId: f.tplActive.id });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const bindingId = binding.body.data.id as string;

    const first = await api()
      .post(`/api/v1/engineering/log-sheet-bindings/${bindingId}/start`)
      .set(auth());
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await api()
      .post(`/api/v1/engineering/log-sheet-bindings/${bindingId}/start`)
      .set(auth());
    assert.equal(second.status, 201, JSON.stringify(second.body));

    const history = await api()
      .get(`/api/v1/engineering/log-sheet-bindings/${bindingId}/executions`)
      .set(auth());
    assert.equal(history.status, 200, JSON.stringify(history.body));
    const ids = history.body.data.map((e: any) => e.id);
    assert.deepEqual(ids, [second.body.data.id, first.body.data.id]);
    assert.ok(history.body.data.every((e: any) => e.logSheetBindingId === bindingId));
  });

  it('resolves the execution context to the correct asset, building, and version', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind(f.assetA.id, {
      formTemplateId: f.tplActive.id,
      formTemplateVersionId: f.version1,
      functionalLocationId: f.flA.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const started = await api()
      .post(`/api/v1/engineering/log-sheet-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const executionId = started.body.data.id as string;

    const context = await api()
      .get(`/api/v1/engineering/log-sheet-executions/${executionId}`)
      .set(auth());
    assert.equal(context.status, 200, JSON.stringify(context.body));
    const data = context.body.data;

    assert.equal(data.execution.id, executionId);
    assert.equal(data.asset.id, f.assetA.id);
    assert.equal(data.asset.assetCode, f.assetA.assetCode);
    assert.equal(data.building.id, f.buildingA.id);
    assert.equal(data.functionalLocation.id, f.flA.id);
    assert.equal(data.template.id, f.tplActive.id);
    assert.equal(data.version.id, f.version1);
    assert.equal(data.version.versionNumber, 1);
    assert.equal(data.version.status, 'PUBLISHED');

    // Unknown or plain BE-07 instances carry no log sheet context.
    const unknown = await api()
      .get(`/api/v1/engineering/log-sheet-executions/${randomUUID()}`)
      .set(auth());
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'LOG_SHEET_EXECUTION_NOT_FOUND');

    const plain = await api()
      .post(`/api/v1/form-template-versions/${f.version1}/instances`)
      .set(auth());
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    const plainContext = await api()
      .get(`/api/v1/engineering/log-sheet-executions/${plain.body.data.id}`)
      .set(auth());
    assert.equal(plainContext.status, 404);
    assert.equal(plainContext.body.error.code, 'LOG_SHEET_EXECUTION_NOT_FOUND');
  });

  it('routes abnormal-condition findings through BE-09', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind(f.assetA.id, { formTemplateId: f.tplActive.id });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const started = await api()
      .post(`/api/v1/engineering/log-sheet-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const executionId = started.body.data.id as string;

    const finding = await findingService.createFinding({
      clientId: f.clientA.id,
      buildingId: f.buildingA.id,
      findingNumber: `FND_${suffix()}`,
      title: 'Abnormal log sheet finding',
      reportedByUserId: managerUserId,
    });

    const sourceResponse = await api()
      .patch(`/api/v1/findings/${finding.id}/source`)
      .set(auth())
      .send({ sourceType: 'FORM_INSTANCE', sourceId: executionId });
    assert.equal(sourceResponse.status, 200, JSON.stringify(sourceResponse.body));

    const source = await api()
      .get(`/api/v1/findings/${finding.id}/source`)
      .set(auth());
    assert.equal(source.status, 200, JSON.stringify(source.body));
    assert.equal(source.body.data.sourceType, 'FORM_INSTANCE');
    assert.equal(source.body.data.sourceId, executionId);

    const actions = await api()
      .get(`/api/v1/findings/${finding.id}/available-actions`)
      .set(auth());
    assert.equal(actions.status, 200, JSON.stringify(actions.body));
    assert.ok(Array.isArray(actions.body.data.availableActions));
    assert.equal(actions.body.data.state, 'OPEN');
  });

  it('enforces RBAC on every log sheet endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const binding = await bind(f.assetA.id, { formTemplateId: f.tplActive.id });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const bindingId = binding.body.data.id as string;

    const plainToken = await createPlainSession();

    const unauthCreate = await api()
      .post(`/api/v1/assets/${f.assetA.id}/log-sheet-bindings`)
      .send({ formTemplateId: f.tplActive.id });
    assert.equal(unauthCreate.status, 401);
    assert.equal(unauthCreate.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbiddenCreate = await bind(
      f.assetA.id,
      { formTemplateId: f.tplActive.id },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenRead = await api()
      .get(`/api/v1/engineering/log-sheet-bindings/${bindingId}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenStart = await api()
      .post(`/api/v1/engineering/log-sheet-bindings/${bindingId}/start`)
      .set(auth(plainToken));
    assert.equal(forbiddenStart.status, 403);
    assert.equal(forbiddenStart.body.error.code, 'PERMISSION_DENIED');

    const forbiddenHistory = await api()
      .get(`/api/v1/engineering/log-sheet-bindings/${bindingId}/executions`)
      .set(auth(plainToken));
    assert.equal(forbiddenHistory.status, 403);
    assert.equal(forbiddenHistory.body.error.code, 'PERMISSION_DENIED');
  });

  it('isolates buildings and clients', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const bindingA = await bind(f.assetA.id, { formTemplateId: f.tplActive.id });
    assert.equal(bindingA.status, 201, JSON.stringify(bindingA.body));
    const bindingB = await bind(f.assetB.id, { formTemplateId: f.tplActive.id });
    assert.equal(bindingB.status, 201, JSON.stringify(bindingB.body));

    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedCreate = await bind(
      f.assetA.id,
      { formTemplateId: f.tplActive.id },
      bOnly.token,
    );
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedRead = await api()
      .get(`/api/v1/engineering/log-sheet-bindings/${bindingA.body.data.id}`)
      .set(auth(bOnly.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedBuildingList = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/log-sheet-bindings`)
      .set(auth(bOnly.token));
    assert.equal(deniedBuildingList.status, 403);
    assert.equal(deniedBuildingList.body.error.code, 'BUILDING_ACCESS_DENIED');

    const buildingBList = await api()
      .get(`/api/v1/buildings/${f.buildingB.id}/engineering/log-sheet-bindings`)
      .set(auth(bOnly.token));
    assert.equal(buildingBList.status, 200, JSON.stringify(buildingBList.body));
    assert.deepEqual(
      buildingBList.body.data.map((b: any) => b.id),
      [bindingB.body.data.id],
    );
  });
});
