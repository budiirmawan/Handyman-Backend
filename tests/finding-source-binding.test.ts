import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { resolveAuthoritativeChecklistSourceContext } from '../src/modules/checklist-executions/checklist-execution.service';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE findings, users, roles, clients CASCADE');
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
  database = db;
});
after(async () => { if (pool) await closePool(pool); pool = null; database = null; });
function ready(t: TestContext): boolean {
  if (!database || !pool) { t.skip('test database unavailable'); return false; }
  return true;
}
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });

async function fixture(assignTo: string | null = userId) {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const client = await clientService.createClient({ code: `C_${suffix}`, name: 'Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix}`, name: 'Building' });
  if (assignTo) await buildingAssignmentService.createAssignment(assignTo, { buildingId: building.id });
  return { client, building };
}
async function createFinding(buildingId: string, clientId: string, value = token) {
  return api().post(`/api/v1/buildings/${buildingId}/findings`).set(auth(value)).send({
    clientId,
    findingNumber: `FND_${randomUUID().slice(0, 8)}`,
    title: 'Source-bound finding',
  });
}
async function formInstance(clientId: string): Promise<string> {
  const sourceFormId = randomUUID(), templateId = randomUUID(), versionId = randomUUID(), instanceId = randomUUID();
  await pool!.query(`INSERT INTO source_forms (id, client_id, code, name, source_type) VALUES ($1,$2,$3,'Source','INTERNAL')`, [sourceFormId, clientId, `SRC_${randomUUID().slice(0, 8)}`]);
  await pool!.query(`INSERT INTO form_templates (id, source_form_id, client_id, code, name) VALUES ($1,$2,$3,$4,'Template')`, [templateId, sourceFormId, clientId, `TPL_${randomUUID().slice(0, 8)}`]);
  await pool!.query(`INSERT INTO form_template_versions (id, form_template_id, version_number) VALUES ($1,$2,1)`, [versionId, templateId]);
  await pool!.query(`INSERT INTO form_instances (id, client_id, form_template_version_id) VALUES ($1,$2,$3)`, [instanceId, clientId, versionId]);
  return instanceId;
}
async function checklistExecution(clientId: string): Promise<string> {
  const templateId = randomUUID(), executionId = randomUUID();
  await pool!.query(`INSERT INTO checklist_templates (id, client_id, code, name, status) VALUES ($1,$2,$3,'Checklist','ACTIVE')`, [templateId, clientId, `CHK_${randomUUID().slice(0, 8)}`]);
  await pool!.query(`INSERT INTO checklist_executions (id, client_id, checklist_template_id) VALUES ($1,$2,$3)`, [executionId, clientId, templateId]);
  return executionId;
}
async function workOrder(buildingId: string, clientId: string, value = token) {
  return api().post(`/api/v1/buildings/${buildingId}/work-orders`).set(auth(value)).send({
    clientId,
    workOrderNumber: `WO_${randomUUID().slice(0, 8)}`,
    title: 'Source work order',
    workType: 'GENERAL',
  });
}
async function bind(findingId: string, sourceType: string | null, sourceId: string | null, value = token) {
  return api().patch(`/api/v1/findings/${findingId}/source`).set(auth(value)).send({ sourceType, sourceId });
}

describe('BE-09C Finding source binding', () => {
  it('binds a Finding to a Form Instance and resolves safe context', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const finding = await createFinding(building.id, client.id);
    const sourceId = await formInstance(client.id);
    const response = await bind(finding.body.data.id, 'FORM_INSTANCE', sourceId);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.sourceType, 'FORM_INSTANCE');
    assert.equal(response.body.data.context.clientId, client.id);
    assert.equal(response.body.data.context.buildingId, null);
    assert.equal(response.body.data.context.referenceType, 'FORM_TEMPLATE_VERSION');
  });

  it('binds a Finding to a Checklist Execution', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const finding = await createFinding(building.id, client.id);
    const sourceId = await checklistExecution(client.id);
    const response = await bind(finding.body.data.id, 'CHECKLIST_EXECUTION', sourceId);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.context.sourceId, sourceId);
    assert.equal(response.body.data.context.referenceType, 'CHECKLIST_TEMPLATE');
  });

  it('binds a Finding to a Work Order with matching Building context', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const finding = await createFinding(building.id, client.id);
    const source = await workOrder(building.id, client.id);
    const response = await bind(finding.body.data.id, 'WORK_ORDER', source.body.data.id);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.context.buildingId, building.id);
    assert.equal(response.body.data.context.referenceCode, source.body.data.workOrderNumber);
    assert.equal(response.body.data.context.title, 'Source work order');
  });

  it('rejects unsupported and unknown sources', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const finding = await createFinding(building.id, client.id);
    const unsupported = await bind(finding.body.data.id, 'EVIDENCE', randomUUID());
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.body.error.code, 'VALIDATION_ERROR');
    const unknown = await bind(finding.body.data.id, 'FORM_INSTANCE', randomUUID());
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'FINDING_SOURCE_NOT_FOUND');
  });

  it('rejects cross-Client and cross-Building source binding', async (t) => {
    if (!ready(t)) return;
    const a = await fixture(), b = await fixture();
    const finding = await createFinding(a.building.id, a.client.id);
    const foreignForm = await formInstance(b.client.id);
    const crossClient = await bind(finding.body.data.id, 'FORM_INSTANCE', foreignForm);
    assert.equal(crossClient.status, 400);
    assert.equal(crossClient.body.error.code, 'FINDING_SOURCE_CLIENT_MISMATCH');

    const sameClientProperty = await propertyService.createProperty({ clientId: a.client.id, code: `P_${randomUUID().slice(0, 8)}`, name: 'Other' });
    const otherBuilding = await buildingService.createBuilding({ propertyId: sameClientProperty.id, code: `B_${randomUUID().slice(0, 8)}`, name: 'Other building' });
    await buildingAssignmentService.createAssignment(userId, { buildingId: otherBuilding.id });
    const foreignWorkOrder = await workOrder(otherBuilding.id, a.client.id);
    const crossBuilding = await bind(finding.body.data.id, 'WORK_ORDER', foreignWorkOrder.body.data.id);
    assert.equal(crossBuilding.status, 400);
    assert.equal(crossBuilding.body.error.code, 'FINDING_SOURCE_BUILDING_MISMATCH');
  });

  it('controls conflicting binding as one replaceable primary source', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const finding = await createFinding(building.id, client.id);
    const formId = await formInstance(client.id), checklistId = await checklistExecution(client.id);
    assert.equal((await bind(finding.body.data.id, 'FORM_INSTANCE', formId)).status, 200);
    const replaced = await bind(finding.body.data.id, 'CHECKLIST_EXECUTION', checklistId);
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.data.sourceType, 'CHECKLIST_EXECUTION');
    assert.equal(replaced.body.data.sourceId, checklistId);
    const row = await pool!.query('SELECT source_type, source_id FROM findings WHERE id=$1', [finding.body.data.id]);
    assert.equal(row.rows[0].source_type, 'CHECKLIST_EXECUTION');
    assert.equal(row.rows[0].source_id, checklistId);

    const partialClear = await bind(finding.body.data.id, null, checklistId);
    assert.equal(partialClear.status, 400);
    const cleared = await bind(finding.body.data.id, null, null);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.context, null);
  });

  it('gets the current source and reflects live source context', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const finding = await createFinding(building.id, client.id);
    const sourceId = await checklistExecution(client.id);
    await bind(finding.body.data.id, 'CHECKLIST_EXECUTION', sourceId);
    await pool!.query(`UPDATE checklist_executions SET status='IN_PROGRESS' WHERE id=$1`, [sourceId]);
    const response = await api().get(`/api/v1/findings/${finding.body.data.id}/source`).set(auth());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.context.status, 'IN_PROGRESS');
    assert.equal(response.body.data.context.sourceId, sourceId);
  });

  it('preserves Building isolation and Finding RBAC', async (t) => {
    if (!ready(t)) return;
    const owner = await createAdminUser();
    const target = await fixture(owner.userId);
    const finding = await createFinding(target.building.id, target.client.id, owner.token);
    const source = await formInstance(target.client.id);
    const isolated = await bind(finding.body.data.id, 'FORM_INSTANCE', source);
    assert.equal(isolated.status, 403);
    assert.equal(isolated.body.error.code, 'BUILDING_ACCESS_DENIED');

    const plain = await createPlainSession();
    const denied = await bind(finding.body.data.id, 'FORM_INSTANCE', source, plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  });
});

// ---------------------------------------------------------------------------
// MOB-C05 PART 01 — authoritative CHECKLIST_EXECUTION source resolution.
//
// A checklist-origin Finding source is authoritative ONLY when the execution
// is bound to an exact generated task (checklist_execution.generated_task_id
// → generated_tasks → building_id). Building/Client are never derived from a
// checklist template, an occurrence, a first matching task, a title/code
// coincidence, or a client-supplied building. Unbound historical/standalone
// executions fail closed for authoritative source context; the managed web
// path keeps resolving them as loose (no Building) source context, matching
// FORM_INSTANCE parity and preserving domain (e.g. engineering) flows.
// ---------------------------------------------------------------------------

const qc = (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

async function makeTemplate(clientId: string): Promise<string> {
  const templateId = randomUUID();
  await qc(
    `INSERT INTO checklist_templates (id, client_id, code, name, status)
     VALUES ($1, $2, $3, 'Checklist', 'ACTIVE')`,
    [templateId, clientId, `CHK_${randomUUID().slice(0, 8).toUpperCase()}`],
  );
  return templateId;
}

/** Insert an unbound (standalone) checklist execution for a template. */
async function unboundExecution(clientId: string, templateId: string): Promise<string> {
  const executionId = randomUUID();
  await qc(
    `INSERT INTO checklist_executions (id, client_id, checklist_template_id)
     VALUES ($1, $2, $3)`,
    [executionId, clientId, templateId],
  );
  return executionId;
}

/** Insert a generated task (under buildingId) targeting the template. */
async function generatedTask(
  clientId: string,
  buildingId: string,
  templateId: string,
): Promise<string> {
  const taskId = randomUUID();
  const scheduleId = randomUUID();
  await qc(
    `INSERT INTO schedule_definitions
       (id, client_id, code, name, target_type, target_id, building_id,
        start_at, timezone, status)
     VALUES ($1, $2, $3, 'Schedule', 'CHECKLIST_TEMPLATE', $4, $5, NOW(),
             'Asia/Jakarta', 'ACTIVE')`,
    [scheduleId, clientId, `SCH_${randomUUID().slice(0, 8).toUpperCase()}`, templateId, buildingId],
  );
  await qc(
    `INSERT INTO generated_tasks
       (id, client_id, schedule_definition_id, occurrence_at, target_type,
        target_id, building_id, status)
     VALUES ($1, $2, $3, NOW(), 'CHECKLIST_TEMPLATE', $4, $5, 'OPEN')`,
    [taskId, clientId, scheduleId, templateId, buildingId],
  );
  return taskId;
}

/** A checklist execution bound to a generated task in `buildingId`. */
async function boundExecution(
  clientId: string,
  buildingId: string,
  templateId: string,
): Promise<{ executionId: string; taskId: string }> {
  const taskId = await generatedTask(clientId, buildingId, templateId);
  const executionId = randomUUID();
  await qc(
    `INSERT INTO checklist_executions (id, client_id, checklist_template_id, generated_task_id)
     VALUES ($1, $2, $3, $4)`,
    [executionId, clientId, templateId, taskId],
  );
  return { executionId, taskId };
}

describe('MOB-C05 PART 01 authoritative checklist source resolver', () => {
  it('resolves the exact Building and Client of a bound execution', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const templateId = await makeTemplate(client.id);
    const { executionId, taskId } = await boundExecution(client.id, building.id, templateId);
    const context = await resolveAuthoritativeChecklistSourceContext(executionId);
    assert.ok(context, 'expected authoritative context');
    assert.equal(context!.buildingId, building.id);
    assert.equal(context!.clientId, client.id);
    assert.equal(context!.taskId, taskId);
    assert.equal(context!.sourceId, executionId);
    assert.equal(context!.checklistTemplateId, templateId);
  });

  it('fails closed for an unbound (standalone) execution', async (t) => {
    if (!ready(t)) return;
    const { client } = await fixture();
    const templateId = await makeTemplate(client.id);
    const executionId = await unboundExecution(client.id, templateId);
    const context = await resolveAuthoritativeChecklistSourceContext(executionId);
    assert.equal(context, null);
  });

  it('fails closed for a bound task without a Building', async (t) => {
    if (!ready(t)) return;
    const { client } = await fixture();
    const templateId = await makeTemplate(client.id);
    // generated task with building_id NULL.
    const taskId = randomUUID();
    const scheduleId = randomUUID();
    await qc(
      `INSERT INTO schedule_definitions
         (id, client_id, code, name, target_type, target_id, building_id,
          start_at, timezone, status)
       VALUES ($1, $2, $3, 'Schedule', 'CHECKLIST_TEMPLATE', $4, NULL, NOW(),
               'Asia/Jakarta', 'ACTIVE')`,
      [scheduleId, client.id, `SCH_${randomUUID().slice(0, 8).toUpperCase()}`, templateId],
    );
    await qc(
      `INSERT INTO generated_tasks
         (id, client_id, schedule_definition_id, occurrence_at, target_type,
          target_id, building_id, status)
       VALUES ($1, $2, $3, NOW(), 'CHECKLIST_TEMPLATE', $4, NULL, 'OPEN')`,
      [taskId, client.id, scheduleId, templateId],
    );
    const executionId = randomUUID();
    await qc(
      `INSERT INTO checklist_executions (id, client_id, checklist_template_id, generated_task_id)
       VALUES ($1, $2, $3, $4)`,
      [executionId, client.id, templateId, taskId],
    );
    assert.equal(await resolveAuthoritativeChecklistSourceContext(executionId), null);
  });

  it('fails closed for a cross-Client execution/task binding', async (t) => {
    if (!ready(t)) return;
    const a = await fixture();
    const b = await fixture();
    const templateA = await makeTemplate(a.client.id);
    const templateB = await makeTemplate(b.client.id);
    // A client-B generated task bound onto a client-A execution is a forged /
    // cross-Client binding and must fail closed. The task is not otherwise
    // bound to any execution (one execution per task), so this can be built.
    const taskB = await generatedTask(b.client.id, b.building.id, templateB);
    const executionId = randomUUID();
    await qc(
      `INSERT INTO checklist_executions (id, client_id, checklist_template_id, generated_task_id)
       VALUES ($1, $2, $3, $4)`,
      [executionId, a.client.id, templateA, taskB],
    );
    assert.equal(await resolveAuthoritativeChecklistSourceContext(executionId), null);
  });

  it('is unaffected by a reused template across multiple Buildings (exact task wins)', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const otherProperty = await propertyService.createProperty({
      clientId: client.id,
      code: `P_${randomUUID().slice(0, 8)}`,
      name: 'Other property',
    });
    const otherBuilding = await buildingService.createBuilding({
      propertyId: otherProperty.id,
      code: `B_${randomUUID().slice(0, 8)}`,
      name: 'Other building',
    });
    const templateId = await makeTemplate(client.id);
    // Two executions share the SAME template but bind to tasks in different Buildings.
    const exA = await boundExecution(client.id, building.id, templateId);
    const exB = await boundExecution(client.id, otherBuilding.id, templateId);
    const ctxA = await resolveAuthoritativeChecklistSourceContext(exA.executionId);
    const ctxB = await resolveAuthoritativeChecklistSourceContext(exB.executionId);
    assert.equal(ctxA!.buildingId, building.id);
    assert.equal(ctxB!.buildingId, otherBuilding.id);
  });
});

describe('MOB-C05 PART 01 checklist finding source binding', () => {
  it('resolves an authoritative Building when binding to a bound execution', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const finding = await createFinding(building.id, client.id);
    const templateId = await makeTemplate(client.id);
    const { executionId } = await boundExecution(client.id, building.id, templateId);
    const response = await bind(finding.body.data.id, 'CHECKLIST_EXECUTION', executionId);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.context.sourceType, 'CHECKLIST_EXECUTION');
    assert.equal(response.body.data.context.buildingId, building.id);
    assert.equal(response.body.data.context.referenceType, 'CHECKLIST_TEMPLATE');
  });

  it('rejects binding to a bound execution whose Building differs (client cannot redirect)', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const otherProperty = await propertyService.createProperty({
      clientId: client.id,
      code: `P_${randomUUID().slice(0, 8)}`,
      name: 'Redirect property',
    });
    const otherBuilding = await buildingService.createBuilding({
      propertyId: otherProperty.id,
      code: `B_${randomUUID().slice(0, 8)}`,
      name: 'Redirect building',
    });
    const finding = await createFinding(building.id, client.id);
    const templateId = await makeTemplate(client.id);
    const { executionId } = await boundExecution(client.id, otherBuilding.id, templateId);
    const response = await bind(finding.body.data.id, 'CHECKLIST_EXECUTION', executionId);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'FINDING_SOURCE_BUILDING_MISMATCH');
  });

  it('rejects a cross-Client bound execution source', async (t) => {
    if (!ready(t)) return;
    const a = await fixture();
    const b = await fixture();
    const finding = await createFinding(a.building.id, a.client.id);
    const templateB = await makeTemplate(b.client.id);
    const { executionId } = await boundExecution(b.client.id, b.building.id, templateB);
    const response = await bind(finding.body.data.id, 'CHECKLIST_EXECUTION', executionId);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'FINDING_SOURCE_CLIENT_MISMATCH');
  });

  it('keeps unbound checklist execution binding loose (no Building) for the managed path', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const finding = await createFinding(building.id, client.id);
    const templateId = await makeTemplate(client.id);
    const executionId = await unboundExecution(client.id, templateId);
    const response = await bind(finding.body.data.id, 'CHECKLIST_EXECUTION', executionId);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.context.buildingId, null);
    assert.equal(response.body.data.context.referenceType, 'CHECKLIST_TEMPLATE');
  });
});
