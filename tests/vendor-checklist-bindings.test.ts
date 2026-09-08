import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { vendorAssignmentService } from '../src/modules/vendor-assignments';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import { vendorWorkService } from '../src/modules/vendor-work';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-15C — Vendor Checklist Binding focused tests.
 *
 * Covers only binding BE-07 Checklist Templates to a BE-15B Vendor Work
 * context: valid binding, invalid Vendor Work, invalid Checklist Template,
 * Building (cross-client) mismatch, shared BE-07 execution start, execution
 * context resolution, RBAC, and Client / Building isolation. Work Permit
 * Readiness and later BE-15 PARTs are deliberately absent.
 */

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
    `TRUNCATE vendor_checklist_bindings, vendor_works, vendor_assignments,
      work_orders, work_requests, vendor_workforce_bindings,
      vendor_building_relationships, vendors,
      checklist_executions, checklist_item_responses,
      checklist_items, checklist_templates,
      workforce_building_assignments, workforce_profiles, teams, positions,
      departments, organizations, users, roles, clients, properties,
      buildings CASCADE`,
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

function suffix(): string {
  return randomUUID().slice(0, 8).toUpperCase();
}

async function createClient() {
  return clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Vendor Checklist Client',
  });
}

async function createBuildingFor(clientId: string, assignTo?: string | null) {
  const property = await propertyService.createProperty({
    clientId,
    code: `PROP_${suffix()}`,
    name: 'Vendor Checklist Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Vendor Checklist Building',
  });
  if (assignTo) {
    await buildingAssignmentService.createAssignment(assignTo, {
      buildingId: building.id,
    });
  }
  return building;
}

async function createVendor(clientId: string) {
  return vendorService.createVendor({
    clientId,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Checklist Vendor',
  });
}

async function createWorkOrderVia(buildingId: string, clientId: string) {
  return workOrderService.createWorkOrder({
    clientId,
    buildingId,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Vendor Checklist Work Order',
    workType: 'REPAIR',
    createdByUserId: adminUserId,
  });
}

/** Creates a full vendor-work fixture: client, building, vendor, work order, assignment, work. */
async function vendorWorkSetup() {
  const client = await createClient();
  const building = await createBuildingFor(client.id, adminUserId);
  const vendor = await createVendor(client.id);
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: building.id,
  });
  const wo = await createWorkOrderVia(building.id, client.id);
  const assignment = await vendorAssignmentService.assignVendor({
    vendorId: vendor.id,
    workOrderId: wo.id,
    assignedByUserId: adminUserId,
  });
  const { work } = await vendorWorkService.resolveVendorWork(assignment.id);
  return { client, building, vendor, wo, assignment, work };
}

/** Creates an ACTIVE checklist template for a client (DRAFT → ACTIVE). */
async function createTemplate(clientId: string, status: 'ACTIVE' | 'DRAFT' = 'ACTIVE') {
  const created = await api()
    .post(`/api/v1/clients/${clientId}/checklist-templates`)
    .set(authHeaders())
    .send({ code: `CHK_${suffix()}`, name: `Checklist ${status}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const templateId = created.body.data.id as string;
  if (status !== 'DRAFT') {
    const patched = await api()
      .patch(`/api/v1/checklist-templates/${templateId}`)
      .set(authHeaders())
      .send({ status });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
  }
  return { id: templateId, clientId, status };
}

function bindVia(body: object, token = adminToken) {
  return api()
    .post('/api/v1/vendor-checklist-bindings')
    .set(authHeaders(token))
    .send(body);
}

describe('create vendor checklist binding', () => {
  it('binds an active checklist template to a vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building, wo, work } = await vendorWorkSetup();
    const template = await createTemplate(client.id);

    const response = await bindVia({
      vendorWorkId: work.id,
      checklistTemplateId: template.id,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.vendorWorkId, work.id);
    assert.equal(response.body.data.checklistTemplateId, template.id);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.workOrderId, wo.id);
    assert.equal(response.body.data.checklistExecutionId, null);
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('rejects a duplicate active binding', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    const template = await createTemplate(client.id);

    const first = await bindVia({
      vendorWorkId: work.id,
      checklistTemplateId: template.id,
    });
    assert.equal(first.status, 201);

    const second = await bindVia({
      vendorWorkId: work.id,
      checklistTemplateId: template.id,
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'VENDOR_CHECKLIST_BINDING_ALREADY_EXISTS');
  });

  it('rejects an unknown vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client } = await vendorWorkSetup();
    const template = await createTemplate(client.id);

    const response = await bindVia({
      vendorWorkId: randomUUID(),
      checklistTemplateId: template.id,
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_WORK_NOT_FOUND');
  });

  it('rejects a completed vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    const template = await createTemplate(client.id);
    await vendorWorkService.transitionVendorWorkStatus(work.id, {
      status: 'IN_PROGRESS',
    });
    await vendorWorkService.transitionVendorWorkStatus(work.id, {
      status: 'COMPLETED',
    });

    const response = await bindVia({
      vendorWorkId: work.id,
      checklistTemplateId: template.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_CHECKLIST_VENDOR_WORK_COMPLETED');
  });

  it('rejects an unknown checklist template', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await bindVia({
      vendorWorkId: work.id,
      checklistTemplateId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });

  it('rejects a non-active checklist template', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    const template = await createTemplate(client.id, 'DRAFT');

    const response = await bindVia({
      vendorWorkId: work.id,
      checklistTemplateId: template.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
  });

  it('rejects a cross-client template (building mismatch)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const otherClient = await createClient();
    const foreignTemplate = await createTemplate(otherClient.id);

    const response = await bindVia({
      vendorWorkId: work.id,
      checklistTemplateId: foreignTemplate.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_CHECKLIST_BUILDING_MISMATCH');
  });
});

describe('get and list', () => {
  it('returns a binding by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    const template = await createTemplate(client.id);
    const created = await bindVia({
      vendorWorkId: work.id,
      checklistTemplateId: template.id,
    });
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/vendor-checklist-bindings/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.vendorWorkId, work.id);
  });

  it('lists by vendor work, vendor, and building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building, vendor, work } = await vendorWorkSetup();
    const templateA = await createTemplate(client.id);
    const templateB = await createTemplate(client.id);
    await bindVia({ vendorWorkId: work.id, checklistTemplateId: templateA.id });
    await bindVia({ vendorWorkId: work.id, checklistTemplateId: templateB.id });

    const byWork = await api()
      .get('/api/v1/vendor-checklist-bindings')
      .query({ vendorWorkId: work.id })
      .set(authHeaders());
    assert.equal(byWork.status, 200);
    assert.equal(byWork.body.data.length, 2);

    const byVendor = await api()
      .get('/api/v1/vendor-checklist-bindings')
      .query({ vendorId: vendor.id })
      .set(authHeaders());
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 2);

    const byBuilding = await api()
      .get('/api/v1/vendor-checklist-bindings')
      .query({ buildingId: building.id })
      .set(authHeaders());
    assert.equal(byBuilding.status, 200);
    assert.equal(byBuilding.body.data.length, 2);
  });

  it('rejects a list request without any filter', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/vendor-checklist-bindings')
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('shared checklist execution', () => {
  it('starts the shared BE-07 checklist execution from a binding', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    const template = await createTemplate(client.id);
    const binding = await bindVia({
      vendorWorkId: work.id,
      checklistTemplateId: template.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const bindingId = binding.body.data.id as string;

    const started = await api()
      .post(`/api/v1/vendor-checklist-bindings/${bindingId}/start`)
      .set(authHeaders());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(started.body.data.checklistTemplateId, template.id);
    assert.equal(started.body.data.vendorChecklistBindingId, bindingId);
    assert.equal(started.body.data.status, 'DRAFT');

    // The execution is a first-class BE-07 record: the shared checklist
    // execution endpoint reads and starts it without any binding logic.
    const shared = await api()
      .get(`/api/v1/checklist-executions/${started.body.data.id}`)
      .set(authHeaders());
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.data.id, started.body.data.id);

    const startedShared = await api()
      .post(`/api/v1/checklist-executions/${started.body.data.id}/start`)
      .set(authHeaders());
    assert.equal(startedShared.status, 200, JSON.stringify(startedShared.body));
    assert.equal(startedShared.body.data.status, 'IN_PROGRESS');
  });

  it('resolves the execution context to vendor work, building, work order, and template', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building, wo, work, vendor } = await vendorWorkSetup();
    const template = await createTemplate(client.id);
    const binding = await bindVia({
      vendorWorkId: work.id,
      checklistTemplateId: template.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const started = await api()
      .post(`/api/v1/vendor-checklist-bindings/${binding.body.data.id}/start`)
      .set(authHeaders());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const executionId = started.body.data.id as string;

    const context = await api()
      .get(`/api/v1/vendor-checklist-executions/${executionId}`)
      .set(authHeaders());
    assert.equal(context.status, 200, JSON.stringify(context.body));
    const data = context.body.data;

    assert.equal(data.execution.id, executionId);
    assert.equal(data.vendorWork.id, work.id);
    assert.equal(data.vendorWork.vendorId, vendor.id);
    assert.equal(data.building.id, building.id);
    assert.equal(data.workOrder.id, wo.id);
    assert.equal(data.template.id, template.id);

    // Unknown executions carry no vendor context.
    const unknown = await api()
      .get(`/api/v1/vendor-checklist-executions/${randomUUID()}`)
      .set(authHeaders());
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'VENDOR_CHECKLIST_EXECUTION_NOT_FOUND');

    // Plain BE-07 executions carry no vendor context either.
    const plain = await api()
      .post(`/api/v1/checklist-templates/${template.id}/executions`)
      .set(authHeaders());
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    const plainContext = await api()
      .get(`/api/v1/vendor-checklist-executions/${plain.body.data.id}`)
      .set(authHeaders());
    assert.equal(plainContext.status, 404);
    assert.equal(plainContext.body.error.code, 'VENDOR_CHECKLIST_EXECUTION_NOT_FOUND');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    const template = await createTemplate(client.id);

    const response = await api()
      .post('/api/v1/vendor-checklist-bindings')
      .send({ vendorWorkId: work.id, checklistTemplateId: template.id });
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    const template = await createTemplate(client.id);
    const plainToken = await createPlainSession();

    const response = await bindVia(
      { vendorWorkId: work.id, checklistTemplateId: template.id },
      plainToken,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies binding across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    const template = await createTemplate(client.id);
    const outsider = await createAdminUser();

    const response = await bindVia(
      { vendorWorkId: work.id, checklistTemplateId: template.id },
      outsider.token,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('scopes the list to the accessible buildings', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const accessible = await createBuildingFor(client.id, adminUserId);
    const inaccessible = await createBuildingFor(client.id);
    const vendor = await createVendor(client.id);
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: accessible.id,
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: inaccessible.id,
    });
    const woA = await createWorkOrderVia(accessible.id, client.id);
    const woB = await createWorkOrderVia(inaccessible.id, client.id);
    const assignmentA = await vendorAssignmentService.assignVendor({
      vendorId: vendor.id,
      workOrderId: woA.id,
      assignedByUserId: adminUserId,
    });
    const assignmentB = await vendorAssignmentService.assignVendor({
      vendorId: vendor.id,
      workOrderId: woB.id,
      assignedByUserId: adminUserId,
    });
    const workA = await vendorWorkService.resolveVendorWork(assignmentA.id);
    const workB = await vendorWorkService.resolveVendorWork(assignmentB.id);
    const template = await createTemplate(client.id);
    await bindVia({ vendorWorkId: workA.work.id, checklistTemplateId: template.id });
    await bindVia({ vendorWorkId: workB.work.id, checklistTemplateId: template.id });

    // Listing by the accessible building works.
    const byAccessible = await api()
      .get('/api/v1/vendor-checklist-bindings')
      .query({ buildingId: accessible.id })
      .set(authHeaders());
    assert.equal(byAccessible.status, 200);
    assert.equal(byAccessible.body.data.length, 1);

    // The inaccessible building is denied outright.
    const byInaccessible = await api()
      .get('/api/v1/vendor-checklist-bindings')
      .query({ buildingId: inaccessible.id })
      .set(authHeaders());
    assert.equal(byInaccessible.status, 403);
    assert.equal(byInaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');

    // A vendor-scoped list only returns the accessible building's bindings.
    const byVendor = await api()
      .get('/api/v1/vendor-checklist-bindings')
      .query({ vendorId: vendor.id })
      .set(authHeaders());
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 1);
    assert.equal(byVendor.body.data[0].workOrderId, woA.id);
  });
});
