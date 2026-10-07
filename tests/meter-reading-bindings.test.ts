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
 * BE-10C — Meter Reading Binding focused validation.
 *
 * Covers: binding meter-reading definitions to assets, unknown asset/field,
 * non-numeric fields, invalid/inactive UOMs, cross-building locations,
 * cross-client field/UOM, range tightening, shared BE-07 execution start,
 * numeric reading submission with min/max/precision rules, execution
 * context resolution, BE-09 finding integration, RBAC, and isolation.
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
       meter_reading_bindings, form_responses, form_instances,
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
    name: 'Meter reading client',
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
    assetName: 'Electricity meter asset',
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
    name: 'Electrical room A',
  });
  const flB = await createFunctionalLocation({
    buildingId: buildingB.id,
    code: `FL_${suffix()}`,
    name: 'Electrical room B',
  });

  // BE-07 UOMs through the shared endpoints.
  const createUom = async (clientId: string, status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') => {
    const created = await api()
      .post(`/api/v1/clients/${clientId}/uoms`)
      .set(auth())
      .send({ code: `UOM_${suffix()}`, name: 'Kilowatt hour', symbol: 'kWh', category: 'ENERGY' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const uomId = created.body.data.id as string;
    const uomCode = created.body.data.code as string;
    if (status === 'INACTIVE') {
      const patched = await api().patch(`/api/v1/uoms/${uomId}`).set(auth()).send({ status });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
    }
    return { id: uomId, code: uomCode, clientId, status };
  };
  const uomA = await createUom(clientA.id);
  const uomInactive = await createUom(clientA.id, 'INACTIVE');
  const uomC = await createUom(clientC.id);

  // BE-07 reading definitions (form templates → sections → NUMBER fields).
  const createSourceForm = async (clientId: string) => {
    const created = await api()
      .post(`/api/v1/clients/${clientId}/source-forms`)
      .set(auth())
      .send({ code: `SRC_${suffix()}`, name: 'Meter reading form', sourceType: 'INTERNAL' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.data.id as string;
  };
  const createTemplate = async (clientId: string) => {
    const sourceFormId = await createSourceForm(clientId);
    const created = await api()
      .post(`/api/v1/source-forms/${sourceFormId}/templates`)
      .set(auth())
      .send({ code: `TPL_${suffix()}`, name: 'Meter reading template', status: 'ACTIVE' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return { id: created.body.data.id as string, clientId };
  };
  const createField = async (
    templateId: string,
    fieldType: string,
    options: { status?: string } = {},
  ) => {
    const section = await api()
      .post(`/api/v1/form-templates/${templateId}/sections`)
      .set(auth())
      .send({ code: `SEC_${suffix()}`, title: 'Readings', displayOrder: 0 });
    assert.equal(section.status, 201, JSON.stringify(section.body));
    const sectionId = section.body.data.id as string;
    const field = await api()
      .post(`/api/v1/form-sections/${sectionId}/fields`)
      .set(auth())
      .send({
        code: `FLD_${suffix()}`,
        label: 'Reading value',
        fieldType,
        required: false,
        displayOrder: 0,
        ...(options.status ? { status: options.status } : {}),
      });
    assert.equal(field.status, 201, JSON.stringify(field.body));
    return { id: field.body.data.id as string, sectionId, fieldType };
  };

  const templateA = await createTemplate(clientA.id);
  const fieldConfigured = await createField(templateA.id, 'NUMBER');
  const measurement = await api()
    .patch(`/api/v1/form-fields/${fieldConfigured.id}/measurement`)
    .set(auth())
    .send({ uomId: uomA.id, minimumValue: 0, maximumValue: 1000, decimalPrecision: 2 });
  assert.equal(measurement.status, 200, JSON.stringify(measurement.body));

  const fieldWithoutUom = await createField(templateA.id, 'NUMBER');
  const textField = await createField(templateA.id, 'TEXT');

  const templateNoVersion = await createTemplate(clientA.id);
  const fieldNoVersion = await createField(templateNoVersion.id, 'NUMBER');

  const templateC = await createTemplate(clientC.id);
  const fieldC = await createField(templateC.id, 'NUMBER');

  // Publish a version for the main template (BE-07 snapshot flow).
  const publish = async (templateId: string) => {
    const version = await api()
      .post(`/api/v1/form-templates/${templateId}/versions`)
      .set(auth())
      .send({ versionNumber: 1 });
    assert.equal(version.status, 201, JSON.stringify(version.body));
    const published = await api()
      .post(`/api/v1/form-template-versions/${version.body.data.id}/publish`)
      .set(auth());
    assert.equal(published.status, 200, JSON.stringify(published.body));
    return version.body.data.id as string;
  };
  const versionId = await publish(templateA.id);

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
    uomInactive,
    uomC,
    fieldConfigured,
    fieldWithoutUom,
    textField,
    fieldNoVersion,
    fieldC,
    versionId,
  };
}

async function bind(assetId: string, body: Record<string, unknown>, token = managerToken) {
  return api()
    .post(`/api/v1/assets/${assetId}/meter-reading-bindings`)
    .set(auth(token))
    .send(body);
}

describe('BE-10C meter reading binding', () => {
  it('binds a meter reading definition to an asset with derived context', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind(f.assetA.id, { formFieldId: f.fieldConfigured.id });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const binding = response.body.data;

    assert.equal(binding.assetId, f.assetA.id);
    assert.equal(binding.formFieldId, f.fieldConfigured.id);
    assert.equal(binding.uomId, f.uomA.id);
    assert.equal(binding.buildingId, f.buildingA.id);
    assert.equal(binding.clientId, f.clientA.id);
    // The binding stores only its own range tightening; the field's BE-07
    // configured range (0..1000) is applied at submission time.
    assert.equal(binding.minimumValue, null);
    assert.equal(binding.maximumValue, null);
    assert.equal(binding.status, 'ACTIVE');

    const byAsset = await api()
      .get(`/api/v1/assets/${f.assetA.id}/meter-reading-bindings`)
      .set(auth());
    assert.equal(byAsset.status, 200, JSON.stringify(byAsset.body));
    assert.deepEqual(byAsset.body.data.map((b: any) => b.id), [binding.id]);

    const byId = await api()
      .get(`/api/v1/engineering/meter-reading-bindings/${binding.id}`)
      .set(auth());
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.data.id, binding.id);

    const byBuilding = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/meter-reading-bindings`)
      .set(auth());
    assert.equal(byBuilding.status, 200, JSON.stringify(byBuilding.body));
    assert.ok(byBuilding.body.data.some((b: any) => b.id === binding.id));
  });

  it('supports binding-level UOM, range tightening, and functional location', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind(f.assetA.id, {
      formFieldId: f.fieldWithoutUom.id,
      uomId: f.uomA.id,
      functionalLocationId: f.flA.id,
      minimumValue: 100,
      maximumValue: 500,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.uomId, f.uomA.id);
    assert.equal(response.body.data.functionalLocationId, f.flA.id);
    assert.equal(response.body.data.minimumValue, 100);
    assert.equal(response.body.data.maximumValue, 500);

    // Range may be tightened further but never widened beyond the field's range.
    const widened = await bind(f.assetA.id, {
      formFieldId: f.fieldConfigured.id,
      minimumValue: -50,
    });
    assert.equal(widened.status, 400);
    assert.equal(widened.body.error.code, 'BAD_REQUEST');

    const widenedMax = await bind(f.assetA.id, {
      formFieldId: f.fieldConfigured.id,
      maximumValue: 2000,
    });
    assert.equal(widenedMax.status, 400);
    assert.equal(widenedMax.body.error.code, 'BAD_REQUEST');
  });

  it('rejects unknown assets, unknown fields, and non-numeric fields', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknownAsset = await bind(randomUUID(), { formFieldId: f.fieldConfigured.id });
    assert.equal(unknownAsset.status, 404);
    assert.equal(unknownAsset.body.error.code, 'ASSET_NOT_FOUND');

    const unknownField = await bind(f.assetA.id, { formFieldId: randomUUID() });
    assert.equal(unknownField.status, 404);
    assert.equal(unknownField.body.error.code, 'NOT_FOUND');

    const nonNumeric = await bind(f.assetA.id, { formFieldId: f.textField.id });
    assert.equal(nonNumeric.status, 400);
    assert.equal(nonNumeric.body.error.code, 'BAD_REQUEST');
  });

  it('handles inactive and retired assets consistently', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const inactive = await bind(f.assetInactive.id, { formFieldId: f.fieldConfigured.id });
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'BAD_REQUEST');

    const retired = await bind(f.assetRetired.id, { formFieldId: f.fieldConfigured.id });
    assert.equal(retired.status, 409);
    assert.equal(retired.body.error.code, 'ASSET_RETIRED');
  });

  it('rejects invalid and inactive UOMs', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknownUom = await bind(f.assetA.id, {
      formFieldId: f.fieldWithoutUom.id,
      uomId: randomUUID(),
    });
    assert.equal(unknownUom.status, 404);
    assert.equal(unknownUom.body.error.code, 'NOT_FOUND');

    const inactiveUom = await bind(f.assetA.id, {
      formFieldId: f.fieldWithoutUom.id,
      uomId: f.uomInactive.id,
    });
    assert.equal(inactiveUom.status, 400);
    assert.equal(inactiveUom.body.error.code, 'METER_READING_UOM_INACTIVE');

    const missingUom = await bind(f.assetA.id, {
      formFieldId: f.fieldWithoutUom.id,
    });
    assert.equal(missingUom.status, 400);
    assert.equal(missingUom.body.error.code, 'BAD_REQUEST');
  });

  it('rejects cross-building locations and cross-client fields and UOMs', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const crossBuilding = await bind(f.assetA.id, {
      formFieldId: f.fieldConfigured.id,
      functionalLocationId: f.flB.id,
    });
    assert.equal(crossBuilding.status, 400);
    assert.equal(crossBuilding.body.error.code, 'METER_READING_LOCATION_BUILDING_MISMATCH');

    const crossClientField = await bind(f.assetA.id, { formFieldId: f.fieldC.id });
    assert.equal(crossClientField.status, 400);
    assert.equal(crossClientField.body.error.code, 'METER_READING_FIELD_CLIENT_MISMATCH');

    const crossClientUom = await bind(f.assetA.id, {
      formFieldId: f.fieldWithoutUom.id,
      uomId: f.uomC.id,
    });
    assert.equal(crossClientUom.status, 400);
    assert.equal(crossClientUom.body.error.code, 'METER_READING_UOM_CLIENT_MISMATCH');
  });

  it('prevents duplicate active bindings and allows re-binding after deactivation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const first = await bind(f.assetA.id, { formFieldId: f.fieldConfigured.id });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const duplicate = await bind(f.assetA.id, { formFieldId: f.fieldConfigured.id });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'METER_READING_BINDING_ALREADY_EXISTS');

    const deactivated = await api()
      .patch(`/api/v1/engineering/meter-reading-bindings/${first.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));

    const rebound = await bind(f.assetA.id, { formFieldId: f.fieldConfigured.id });
    assert.equal(rebound.status, 201, JSON.stringify(rebound.body));
  });

  it('starts the shared BE-07 form instance as the reading execution', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind(f.assetA.id, { formFieldId: f.fieldConfigured.id });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    const started = await api()
      .post(`/api/v1/engineering/meter-reading-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const execution = started.body.data;
    assert.equal(execution.formTemplateVersionId, f.versionId);
    assert.equal(execution.meterReadingBindingId, binding.body.data.id);
    assert.equal(execution.status, 'DRAFT');

    // The execution is a first-class BE-07 form instance.
    const shared = await api().get(`/api/v1/form-instances/${execution.id}`).set(auth());
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.data.id, execution.id);

    // A template without a published version cannot start.
    const noVersionBinding = await bind(f.assetA.id, {
      formFieldId: f.fieldNoVersion.id,
      uomId: f.uomA.id,
    });
    assert.equal(noVersionBinding.status, 201, JSON.stringify(noVersionBinding.body));
    const noVersionStart = await api()
      .post(`/api/v1/engineering/meter-reading-bindings/${noVersionBinding.body.data.id}/start`)
      .set(auth());
    assert.equal(noVersionStart.status, 400);
    assert.equal(noVersionStart.body.error.code, 'BAD_REQUEST');

    // INACTIVE bindings cannot start.
    const deactivated = await api()
      .patch(`/api/v1/engineering/meter-reading-bindings/${binding.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    const rejected = await api()
      .post(`/api/v1/engineering/meter-reading-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'METER_READING_BINDING_INACTIVE');
  });

  it('accepts valid numeric readings and enforces min/max and precision', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind(f.assetA.id, { formFieldId: f.fieldConfigured.id });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    const started = await api()
      .post(`/api/v1/engineering/meter-reading-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const executionId = started.body.data.id as string;

    // Valid reading within the BE-07 configured range (0..1000).
    const reading = await api()
      .put(`/api/v1/engineering/meter-reading-executions/${executionId}/reading`)
      .set(auth())
      .send({ value: 250.5, notes: 'Morning reading' });
    assert.equal(reading.status, 200, JSON.stringify(reading.body));
    assert.equal(reading.body.data.value, 250.5);
    assert.equal(reading.body.data.minimumValue, 0);
    assert.equal(reading.body.data.maximumValue, 1000);
    assert.equal(reading.body.data.uom.id, f.uomA.id);
    assert.equal(reading.body.data.uom.symbol, 'kWh');

    // The reading lives in BE-07's own response store.
    const responses = await api()
      .get(`/api/v1/form-instances/${executionId}/responses`)
      .set(auth());
    assert.equal(responses.status, 200, JSON.stringify(responses.body));
    assert.equal(responses.body.data.length, 1);
    assert.equal(Number(responses.body.data[0].value), 250.5);

    // Out of range readings are rejected by the backend.
    const tooHigh = await api()
      .put(`/api/v1/engineering/meter-reading-executions/${executionId}/reading`)
      .set(auth())
      .send({ value: 1500 });
    assert.equal(tooHigh.status, 400);
    assert.equal(tooHigh.body.error.code, 'METER_READING_OUT_OF_RANGE');

    const tooLow = await api()
      .put(`/api/v1/engineering/meter-reading-executions/${executionId}/reading`)
      .set(auth())
      .send({ value: -1 });
    assert.equal(tooLow.status, 400);
    assert.equal(tooLow.body.error.code, 'METER_READING_OUT_OF_RANGE');

    // Precision rule from the BE-07 field config (2 decimals).
    const imprecise = await api()
      .put(`/api/v1/engineering/meter-reading-executions/${executionId}/reading`)
      .set(auth())
      .send({ value: 250.1234 });
    assert.equal(imprecise.status, 400);
    assert.equal(imprecise.body.error.code, 'BAD_REQUEST');

    // Non-numeric values fail validation.
    const nonNumeric = await api()
      .put(`/api/v1/engineering/meter-reading-executions/${executionId}/reading`)
      .set(auth())
      .send({ value: 'abc' });
    assert.equal(nonNumeric.status, 400);
    assert.equal(nonNumeric.body.error.code, 'VALIDATION_ERROR');

    // Binding-tightened ranges are enforced at submission.
    const tightened = await bind(f.assetA.id, {
      formFieldId: f.fieldWithoutUom.id,
      uomId: f.uomA.id,
      minimumValue: 500,
      maximumValue: 600,
    });
    assert.equal(tightened.status, 201, JSON.stringify(tightened.body));
    const tightenedStart = await api()
      .post(`/api/v1/engineering/meter-reading-bindings/${tightened.body.data.id}/start`)
      .set(auth());
    assert.equal(tightenedStart.status, 201, JSON.stringify(tightenedStart.body));
    const outOfTightRange = await api()
      .put(`/api/v1/engineering/meter-reading-executions/${tightenedStart.body.data.id}/reading`)
      .set(auth())
      .send({ value: 100 });
    assert.equal(outOfTightRange.status, 400);
    assert.equal(outOfTightRange.body.error.code, 'METER_READING_OUT_OF_RANGE');
  });

  it('resolves the execution context to the correct asset, building, and UOM', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind(f.assetA.id, {
      formFieldId: f.fieldConfigured.id,
      functionalLocationId: f.flA.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    const started = await api()
      .post(`/api/v1/engineering/meter-reading-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const executionId = started.body.data.id as string;

    const reading = await api()
      .put(`/api/v1/engineering/meter-reading-executions/${executionId}/reading`)
      .set(auth())
      .send({ value: 300 });
    assert.equal(reading.status, 200, JSON.stringify(reading.body));

    const context = await api()
      .get(`/api/v1/engineering/meter-reading-executions/${executionId}`)
      .set(auth());
    assert.equal(context.status, 200, JSON.stringify(context.body));
    const data = context.body.data;

    assert.equal(data.execution.id, executionId);
    assert.equal(data.asset.id, f.assetA.id);
    assert.equal(data.asset.assetCode, f.assetA.assetCode);
    assert.equal(data.building.id, f.buildingA.id);
    assert.equal(data.functionalLocation.id, f.flA.id);
    assert.equal(data.uom.id, f.uomA.id);
    assert.equal(data.uom.code, f.uomA.code);
    assert.equal(data.minimumValue, 0);
    assert.equal(data.maximumValue, 1000);
    assert.equal(data.currentValue, 300);

    // Unknown or plain BE-07 instances carry no reading context.
    const unknown = await api()
      .get(`/api/v1/engineering/meter-reading-executions/${randomUUID()}`)
      .set(auth());
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'METER_READING_EXECUTION_NOT_FOUND');

    const plain = await api()
      .post(`/api/v1/form-template-versions/${f.versionId}/instances`)
      .set(auth());
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    const plainContext = await api()
      .get(`/api/v1/engineering/meter-reading-executions/${plain.body.data.id}`)
      .set(auth());
    assert.equal(plainContext.status, 404);
    assert.equal(plainContext.body.error.code, 'METER_READING_EXECUTION_NOT_FOUND');
  });

  it('routes abnormal-reading findings through BE-09', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await bind(f.assetA.id, { formFieldId: f.fieldConfigured.id });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const started = await api()
      .post(`/api/v1/engineering/meter-reading-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const executionId = started.body.data.id as string;

    const finding = await findingService.createFinding({
      clientId: f.clientA.id,
      buildingId: f.buildingA.id,
      findingNumber: `FND_${suffix()}`,
      title: 'Abnormal meter reading finding',
      reportedByUserId: managerUserId,
    });

    // BE-09 owns the finding → form instance binding (FORM_INSTANCE source).
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

    // Backend-authoritative available actions stay BE-09's.
    const actions = await api()
      .get(`/api/v1/findings/${finding.id}/available-actions`)
      .set(auth());
    assert.equal(actions.status, 200, JSON.stringify(actions.body));
    assert.ok(Array.isArray(actions.body.data.availableActions));
    assert.equal(actions.body.data.state, 'OPEN');
  });

  it('enforces RBAC on every meter reading endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const binding = await bind(f.assetA.id, { formFieldId: f.fieldConfigured.id });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const bindingId = binding.body.data.id as string;

    const plainToken = await createPlainSession();

    const unauthCreate = await api()
      .post(`/api/v1/assets/${f.assetA.id}/meter-reading-bindings`)
      .send({ formFieldId: f.fieldConfigured.id });
    assert.equal(unauthCreate.status, 401);
    assert.equal(unauthCreate.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbiddenCreate = await bind(
      f.assetA.id,
      { formFieldId: f.fieldConfigured.id },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenRead = await api()
      .get(`/api/v1/engineering/meter-reading-bindings/${bindingId}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenStart = await api()
      .post(`/api/v1/engineering/meter-reading-bindings/${bindingId}/start`)
      .set(auth(plainToken));
    assert.equal(forbiddenStart.status, 403);
    assert.equal(forbiddenStart.body.error.code, 'PERMISSION_DENIED');
  });

  it('isolates buildings and clients', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const bindingA = await bind(f.assetA.id, { formFieldId: f.fieldConfigured.id });
    assert.equal(bindingA.status, 201, JSON.stringify(bindingA.body));
    const bindingB = await bind(f.assetB.id, {
      formFieldId: f.fieldWithoutUom.id,
      uomId: f.uomA.id,
    });
    assert.equal(bindingB.status, 201, JSON.stringify(bindingB.body));

    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedCreate = await bind(
      f.assetA.id,
      { formFieldId: f.fieldConfigured.id },
      bOnly.token,
    );
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedRead = await api()
      .get(`/api/v1/engineering/meter-reading-bindings/${bindingA.body.data.id}`)
      .set(auth(bOnly.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedBuildingList = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/meter-reading-bindings`)
      .set(auth(bOnly.token));
    assert.equal(deniedBuildingList.status, 403);
    assert.equal(deniedBuildingList.body.error.code, 'BUILDING_ACCESS_DENIED');

    const buildingBList = await api()
      .get(`/api/v1/buildings/${f.buildingB.id}/engineering/meter-reading-bindings`)
      .set(auth(bOnly.token));
    assert.equal(buildingBList.status, 200, JSON.stringify(buildingBList.body));
    assert.deepEqual(
      buildingBList.body.data.map((b: any) => b.id),
      [bindingB.body.data.id],
    );
  });
});
