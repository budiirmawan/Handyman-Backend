import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const DB_PORT = 55495;
const DATA_DIR = '/tmp/asentra-mob-c07-p01d-pg';
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

/**
 * MOB-C07 PART 01D — FORM_VERSION schedule create authority.
 *
 * FORM_VERSION must resolve parent form_templates.client_id (versions have
 * no client_id), require PUBLISHED + ACTIVE parent, and copy the exact
 * version id onto generated tasks. FORM_TEMPLATE create and PATCH retarget
 * stay unchanged.
 */

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

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
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       generated_tasks, schedule_recurrence, schedule_definitions,
       form_template_version_fields, form_template_version_sections,
       form_template_versions, form_fields, form_sections, form_templates,
       source_forms, user_building_assignments, buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pool = null;
  database = null;
  pg = null;
});

const ok = (t: TestContext): boolean => {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
};

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const today = () => new Date().toISOString().slice(0, 10);

async function seedForm(options?: {
  assign?: boolean;
  templateStatus?: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
}) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Schedule client',
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
  if (options?.assign !== false) {
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: building.id,
    });
  }
  const source = await api()
    .post(`/api/v1/clients/${client.id}/source-forms`)
    .set(auth())
    .send({
      code: `SRC_${suffix()}`,
      name: 'Source',
      sourceType: 'INTERNAL',
    });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const template = await api()
    .post(`/api/v1/source-forms/${source.body.data.id}/templates`)
    .set(auth())
    .send({
      code: `TPL_${suffix()}`,
      name: 'Template',
      status: options?.templateStatus ?? 'ACTIVE',
    });
  assert.equal(template.status, 201, JSON.stringify(template.body));
  const version = await api()
    .post(`/api/v1/form-templates/${template.body.data.id}/versions`)
    .set(auth())
    .send({ versionNumber: 1 });
  assert.equal(version.status, 201, JSON.stringify(version.body));
  return {
    clientId: client.id,
    buildingId: building.id,
    templateId: template.body.data.id as string,
    versionId: version.body.data.id as string,
  };
}

async function publish(versionId: string) {
  const published = await api()
    .post(`/api/v1/form-template-versions/${versionId}/publish`)
    .set(auth());
  assert.equal(published.status, 200, JSON.stringify(published.body));
}

function scheduleBody(targetType: string, targetId: string) {
  return {
    code: `SCH_${suffix()}`,
    name: 'Form schedule',
    targetType,
    targetId,
    startAt: `${today()}T00:00:00.000Z`,
    timezone: 'Asia/Jakarta',
  };
}

describe('MOB-C07 PART 01D FORM_VERSION schedule authority', () => {
  it('creates a FORM_VERSION schedule from an accessible ACTIVE published version', async (t) => {
    if (!ok(t)) return;
    const form = await seedForm();
    await publish(form.versionId);
    const created = await api()
      .post('/api/v1/schedules')
      .set(auth())
      .send(scheduleBody('FORM_VERSION', form.versionId));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.targetType, 'FORM_VERSION');
    assert.equal(created.body.data.targetId, form.versionId);
    assert.equal(created.body.data.clientId, form.clientId);
  });

  it('copies FORM_VERSION identity onto generated tasks', async (t) => {
    if (!ok(t)) return;
    const form = await seedForm();
    await publish(form.versionId);
    const created = await api()
      .post('/api/v1/schedules')
      .set(auth())
      .send(scheduleBody('FORM_VERSION', form.versionId));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const recurrence = await api()
      .post(`/api/v1/schedules/${created.body.data.id}/recurrence`)
      .set(auth())
      .send({ frequency: 'DAILY', interval: 1, startDate: today() });
    assert.equal(recurrence.status, 201, JSON.stringify(recurrence.body));
    const generated = await api()
      .post(`/api/v1/schedules/${created.body.data.id}/generate-tasks`)
      .set(auth())
      .send({
        from: `${today()}T00:00:00.000Z`,
        to: `${today()}T23:59:59.000Z`,
      });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    assert.ok(generated.body.data.length >= 1);
    const taskId = generated.body.data[0].id as string;
    const task = await api().get(`/api/v1/tasks/${taskId}`).set(auth());
    assert.equal(task.status, 200, JSON.stringify(task.body));
    assert.equal(task.body.data.targetType, 'FORM_VERSION');
    assert.equal(task.body.data.targetId, form.versionId);
    assert.equal(task.body.data.clientId, form.clientId);
  });

  it('rejects DRAFT and RETIRED versions', async (t) => {
    if (!ok(t)) return;
    const draft = await seedForm();
    const draftRejected = await api()
      .post('/api/v1/schedules')
      .set(auth())
      .send(scheduleBody('FORM_VERSION', draft.versionId));
    assert.equal(draftRejected.status, 400);
    assert.equal(
      draftRejected.body.error.message,
      'Only published template versions can receive a schedule.',
    );

    const retired = await seedForm();
    await publish(retired.versionId);
    const retiredVersion = await api()
      .post(`/api/v1/form-template-versions/${retired.versionId}/retire`)
      .set(auth());
    assert.equal(retiredVersion.status, 200, JSON.stringify(retiredVersion.body));
    const retiredRejected = await api()
      .post('/api/v1/schedules')
      .set(auth())
      .send(scheduleBody('FORM_VERSION', retired.versionId));
    assert.equal(retiredRejected.status, 400);
    assert.equal(
      retiredRejected.body.error.message,
      'Only published template versions can receive a schedule.',
    );
  });

  it('rejects a published version whose parent template is INACTIVE', async (t) => {
    if (!ok(t)) return;
    const form = await seedForm();
    await publish(form.versionId);
    const inactive = await api()
      .patch(`/api/v1/form-templates/${form.templateId}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(inactive.status, 200, JSON.stringify(inactive.body));
    const rejected = await api()
      .post('/api/v1/schedules')
      .set(auth())
      .send(scheduleBody('FORM_VERSION', form.versionId));
    assert.equal(rejected.status, 400);
    assert.equal(
      rejected.body.error.message,
      'Inactive target cannot receive an active schedule.',
    );
  });

  it('denies a version whose parent Client is inaccessible', async (t) => {
    if (!ok(t)) return;
    const form = await seedForm({ assign: false });
    await publish(form.versionId);
    const denied = await api()
      .post('/api/v1/schedules')
      .set(auth())
      .send(scheduleBody('FORM_VERSION', form.versionId));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('rejects an unknown version id', async (t) => {
    if (!ok(t)) return;
    const rejected = await api()
      .post('/api/v1/schedules')
      .set(auth())
      .send(scheduleBody('FORM_VERSION', randomUUID()));
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.message, 'Schedule target does not exist.');
  });

  it('keeps FORM_TEMPLATE schedule create unchanged', async (t) => {
    if (!ok(t)) return;
    const form = await seedForm();
    const created = await api()
      .post('/api/v1/schedules')
      .set(auth())
      .send(scheduleBody('FORM_TEMPLATE', form.templateId));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.targetType, 'FORM_TEMPLATE');
    assert.equal(created.body.data.targetId, form.templateId);
    assert.equal(created.body.data.clientId, form.clientId);
  });

  it('does not retarget targetType or targetId on PATCH', async (t) => {
    if (!ok(t)) return;
    const form = await seedForm();
    await publish(form.versionId);
    const created = await api()
      .post('/api/v1/schedules')
      .set(auth())
      .send(scheduleBody('FORM_VERSION', form.versionId));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const patched = await api()
      .patch(`/api/v1/schedules/${created.body.data.id}`)
      .set(auth())
      .send({
        name: 'Renamed schedule',
        targetType: 'FORM_TEMPLATE',
        targetId: form.templateId,
      });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.name, 'Renamed schedule');
    assert.equal(patched.body.data.targetType, 'FORM_VERSION');
    assert.equal(patched.body.data.targetId, form.versionId);
  });
});
