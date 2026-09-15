import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-MOB-CONTRACT-01 PART 04 — Checklist, Measurement & Evidence contract.
 *
 * Verifies the backend-authoritative checklist / measurement / UOM / evidence
 * chain is published in OpenAPI and enforces the documented RBAC, Building
 * isolation, and deterministic validation behavior. Binary evidence upload is
 * exercised via the existing Web upload path (no new infra is invented).
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

const DB_PORT = 55443;
const DATA_DIR = '/tmp/asentra-mob-p04-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';
let clientId = '';

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

const id = () => randomUUID();

async function insertRow(
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const rowId = id();
  const entries = Object.entries(values);
  const columns = entries.map(([column]) => column).join(', ');
  const placeholders = entries.map((_, index) => `$${index + 2}`).join(', ');
  await q(
    `INSERT INTO ${table} (id, ${columns}) VALUES ($1, ${placeholders})`,
    [rowId, ...entries.map(([, value]) => value)],
  );
  return rowId;
}

before(async () => {
  if (EMBEDDED_DATABASE) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: DB_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }

  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  database = db;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, permissions, clients, properties, buildings,
       user_building_assignments, checklist_templates, checklist_items,
       checklist_executions, checklist_item_responses, units_of_measure,
       evidence_requirements, evidence_submissions, form_templates,
       form_template_versions, form_template_version_sections,
       form_template_version_fields CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'P04 Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'P04 Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'P04 Building',
  });
  clientId = client.id;
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
});

after(async () => {
  try {
    if (pool) {
      await closePool(pool);
    }
    if (pg) {
      await pg.stop();
    }
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pool = null;
  database = null;
  pg = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function loadSpec(): Record<string, any> {
  return parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;
}

// --------------------------------------------------------------------------
// Layer 1 — OpenAPI contract (no database)
// --------------------------------------------------------------------------
describe('CR-BE-MOB-CONTRACT-01 PART 04 — checklist/measurement/evidence OpenAPI', () => {
  const spec = loadSpec();

  it('publishes the checklist execution + definition paths', () => {
    for (const [path, method] of [
      ['/checklist-templates/{templateId}/executions', 'post'],
      ['/clients/{clientId}/checklist-templates', 'get'],
      ['/checklist-templates/{checklistTemplateId}', 'get'],
      ['/checklist-templates/{checklistTemplateId}/items', 'get'],
      ['/checklist-executions/{executionId}/responses', 'put'],
    ] as Array<[string, string]>) {
      const op = spec.paths?.[path]?.[method];
      assert.ok(op, `${method.toUpperCase()} ${path} must be documented`);
    }
  });

  it('publishes the UOM + measurement binding paths', () => {
    for (const [path, method] of [
      ['/clients/{clientId}/uoms', 'get'],
      ['/uoms/{uomId}', 'get'],
      ['/checklist-items/{checklistItemId}/measurement', 'patch'],
      ['/form-fields/{formFieldId}/measurement', 'patch'],
    ] as Array<[string, string]>) {
      assert.ok(
        spec.paths?.[path]?.[method],
        `${method.toUpperCase()} ${path} must be documented`,
      );
    }
  });

  it('publishes the evidence submission + requirement paths', () => {
    for (const [path, method] of [
      ['/evidence', 'post'],
      ['/evidence/{evidenceId}', 'patch'],
      ['/evidence-requirements', 'get'],
      ['/evidence-requirements', 'post'],
      ['/evidence-requirements/{evidenceRequirementId}', 'get'],
    ] as Array<[string, string]>) {
      assert.ok(
        spec.paths?.[path]?.[method],
        `${method.toUpperCase()} ${path} must be documented`,
      );
    }
  });

  it('publishes checklist/UOM/evidence-requirement schemas', () => {
    const schemas = spec.components.schemas;
    assert.ok(schemas.ChecklistTemplate, 'ChecklistTemplate required');
    assert.deepEqual(schemas.ChecklistTemplateStatus.enum, ['DRAFT', 'ACTIVE', 'INACTIVE']);

    assert.ok(schemas.ChecklistItem, 'ChecklistItem required');
    assert.deepEqual(schemas.ChecklistItemType.enum, ['CHECK', 'BOOLEAN', 'TEXT', 'NUMBER', 'SELECT']);
    assert.ok(schemas.ChecklistItem.required.includes('required'), 'item.required required');

    assert.ok(schemas.Uom, 'Uom required');
    assert.deepEqual(schemas.UomStatus.enum, ['ACTIVE', 'INACTIVE']);

    assert.ok(schemas.EvidenceRequirement, 'EvidenceRequirement required');
    assert.ok(schemas.EvidenceRequirement.required.includes('required'));
    assert.ok(schemas.EvidenceRequirement.required.includes('minimumCount'));
    assert.ok(schemas.EvidenceRequirement.required.includes('maximumCount'));

    assert.ok(schemas.SubmitEvidenceRequest, 'SubmitEvidenceRequest required');
    assert.ok(schemas.ChecklistResponsesRequest, 'ChecklistResponsesRequest required');
    assert.ok(schemas.BindMeasurementRequest, 'BindMeasurementRequest required');
  });

  it('documents binary upload as an existing capability (not a gap)', () => {
    assert.ok(spec.paths['/evidence/{evidenceId}/file'], 'binary upload path documented');
    assert.ok(spec.paths['/mobile/evidence'], 'single-call mobile upload documented');
  });
});

// --------------------------------------------------------------------------
// Layer 2 — runtime read/mutation + validation + isolation (embedded PG)
// --------------------------------------------------------------------------
describe('CR-BE-MOB-CONTRACT-01 PART 04 — checklist/measurement/evidence runtime', () => {
  async function fixture() {
    const templateId = await insertRow('checklist_templates', {
      client_id: clientId,
      code: `TPL_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Runtime Template',
      status: 'ACTIVE',
    });
    const uomId = await insertRow('units_of_measure', {
      client_id: clientId,
      code: `UOM_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Degree Celsius',
      symbol: '°C',
      category: 'TEMPERATURE',
      status: 'ACTIVE',
    });
    const itemCheckId = await insertRow('checklist_items', {
      checklist_template_id: templateId,
      code: 'CHK',
      label: 'Check',
      item_type: 'CHECK',
      required: true,
      display_order: 0,
      status: 'ACTIVE',
    });
    const itemNumberId = await insertRow('checklist_items', {
      checklist_template_id: templateId,
      code: 'TEMP',
      label: 'Temperature',
      item_type: 'NUMBER',
      required: true,
      display_order: 1,
      status: 'ACTIVE',
      uom_id: uomId,
      minimum_value: 10,
      maximum_value: 40,
      decimal_precision: 1,
    });
    return { templateId, uomId, itemCheckId, itemNumberId };
  }

  it('reads checklist templates and their ordered items + UOM list', async (t) => {
    if (!requireDatabase(t)) return;
    const { templateId, itemCheckId, itemNumberId } = await fixture();

    const templates = await api()
      .get(`${API_PREFIX}/clients/${clientId}/checklist-templates`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(templates.status, 200);
    assert.ok(templates.body.data.some((tpl: any) => tpl.id === templateId));

    const items = await api()
      .get(`${API_PREFIX}/checklist-templates/${templateId}/items`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(items.status, 200);
    assert.equal(items.body.data.length, 2);
    const numberItem = items.body.data.find((i: any) => i.id === itemNumberId);
    assert.equal(numberItem.itemType, 'NUMBER');
    assert.equal(numberItem.required, true);
    const checkItem = items.body.data.find((i: any) => i.id === itemCheckId);
    assert.equal(checkItem.required, true);

    const uoms = await api()
      .get(`${API_PREFIX}/clients/${clientId}/uoms`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(uoms.status, 200);
    assert.ok(uoms.body.data.length >= 1);
  });

  it('creates a checklist execution and saves valid responses', async (t) => {
    if (!requireDatabase(t)) return;
    const { templateId, itemCheckId } = await fixture();

    const create = await api()
      .post(`${API_PREFIX}/checklist-templates/${templateId}/executions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    assert.equal(create.status, 201);
    assert.equal(create.body.data.status, 'DRAFT');
    const executionId = create.body.data.id;

    const save = await api()
      .put(`${API_PREFIX}/checklist-executions/${executionId}/responses`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send([{ itemId: itemCheckId, value: true }]);
    assert.equal(save.status, 200);
    assert.deepEqual(save.body.data, {});
  });

  it('rejects a type-mismatched response with 400 (deterministic validation)', async (t) => {
    if (!requireDatabase(t)) return;
    const { templateId, itemCheckId } = await fixture();

    const create = await api()
      .post(`${API_PREFIX}/checklist-templates/${templateId}/executions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    const executionId = create.body.data.id;

    // CHECK item requires a boolean, not a string.
    const save = await api()
      .put(`${API_PREFIX}/checklist-executions/${executionId}/responses`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send([{ itemId: itemCheckId, value: 'not-a-boolean' }]);
    assert.equal(save.status, 400);
    assert.equal(save.body.error.code, 'BAD_REQUEST');
  });

  it('submits evidence metadata and removes it (REMOVED status)', async (t) => {
    if (!requireDatabase(t)) return;
    const { templateId } = await fixture();
    const create = await api()
      .post(`${API_PREFIX}/checklist-templates/${templateId}/executions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    const executionId = create.body.data.id;

    const submit = await api()
      .post(`${API_PREFIX}/evidence`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        evidenceType: 'PHOTO',
        executionType: 'CHECKLIST_EXECUTION',
        executionId,
        fileReference: 'evidence/00000000-0000-0000-0000-000000000000',
        originalFileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1234,
      });
    assert.equal(submit.status, 201);
    assert.equal(submit.body.data.evidenceType, 'PHOTO');
    assert.equal(submit.body.data.status, 'ACTIVE');
    const evidenceId = submit.body.data.id;

    const remove = await api()
      .patch(`${API_PREFIX}/evidence/${evidenceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    assert.equal(remove.status, 200);
    assert.equal(remove.body.data.status, 'REMOVED');
  });

  it('rejects an invalid evidence submission with 400 VALIDATION_ERROR', async (t) => {
    if (!requireDatabase(t)) return;
    const submit = await api()
      .post(`${API_PREFIX}/evidence`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ evidenceType: 'PHOTO' }); // missing required fields
    assert.equal(submit.status, 400);
    assert.equal(submit.body.error.code, 'VALIDATION_ERROR');
  });

  it('lists evidence requirements with their required/min/max rules', async (t) => {
    if (!requireDatabase(t)) return;
    const { templateId } = await fixture();
    await insertRow('evidence_requirements', {
      client_id: clientId,
      target_type: 'CHECKLIST_TEMPLATE',
      target_id: templateId,
      evidence_type: 'PHOTO',
      required: true,
      minimum_count: 1,
      maximum_count: 3,
      description: 'Photo required',
      status: 'ACTIVE',
    });

    const list = await api()
      .get(`${API_PREFIX}/evidence-requirements?targetType=CHECKLIST_TEMPLATE&targetId=${templateId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].required, true);
    assert.equal(list.body.data[0].minimumCount, 1);
    assert.equal(list.body.data[0].maximumCount, 3);
  });

  it('denies checklist reads without permission (403 PERMISSION_DENIED)', async (t) => {
    if (!requireDatabase(t)) return;
    const token = await createPlainSession();
    const response = await api()
      .get(`${API_PREFIX}/clients/${clientId}/checklist-templates`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies cross-Client checklist execution access (403 BUILDING_ACCESS_DENIED)', async (t) => {
    if (!requireDatabase(t)) return;
    const { templateId } = await fixture();
    // Create a client the admin has no access to.
    const other = await clientService.createClient({
      code: `CLI_X_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Other Client',
    });
    const otherTemplate = await insertRow('checklist_templates', {
      client_id: other.id,
      code: `TPL_X_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Other Template',
      status: 'ACTIVE',
    });
    const otherExecution = await insertRow('checklist_executions', {
      client_id: other.id,
      checklist_template_id: otherTemplate,
      status: 'DRAFT',
    });

    const response = await api()
      .get(`${API_PREFIX}/checklist-executions/${otherExecution}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
