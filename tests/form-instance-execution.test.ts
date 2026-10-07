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
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const DB_PORT = 55492;
const DATA_DIR = '/tmp/asentra-mob-c07-p01a-pg';
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
 * MOB-C07 PART 01A — generic Form Instance execution after service extraction.
 *
 * Proves the HTTP contract is unchanged: create / start / responses /
 * complete / cancel still use form_template.manage|read and the previous
 * lifecycle and validation rules.
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
       form_responses, form_instances,
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
  if (pool) await closePool(pool);
  pool = null;
  database = null;
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

async function seedPublishedForm(options: { required?: boolean } = {}) {
  const required = options.required ?? true;
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Form instance client',
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
  await buildingAssignmentService.createAssignment(userId, {
    buildingId: building.id,
  });

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
    .send({ code: `TPL_${suffix()}`, name: 'Template', status: 'ACTIVE' });
  assert.equal(template.status, 201, JSON.stringify(template.body));

  const section = await api()
    .post(`/api/v1/form-templates/${template.body.data.id}/sections`)
    .set(auth())
    .send({ code: `SEC_${suffix()}`, title: 'Section', displayOrder: 0 });
  assert.equal(section.status, 201, JSON.stringify(section.body));

  const field = await api()
    .post(`/api/v1/form-sections/${section.body.data.id}/fields`)
    .set(auth())
    .send({
      code: `FLD_${suffix()}`,
      label: 'Notes',
      fieldType: 'TEXT',
      required,
      displayOrder: 0,
    });
  assert.equal(field.status, 201, JSON.stringify(field.body));

  const version = await api()
    .post(`/api/v1/form-templates/${template.body.data.id}/versions`)
    .set(auth())
    .send({ versionNumber: 1 });
  assert.equal(version.status, 201, JSON.stringify(version.body));
  const published = await api()
    .post(`/api/v1/form-template-versions/${version.body.data.id}/publish`)
    .set(auth());
  assert.equal(published.status, 200, JSON.stringify(published.body));

  const versionField = await pool!.query<{ id: string }>(
    `SELECT f.id
       FROM form_template_version_fields f
       JOIN form_template_version_sections s ON s.id = f.version_section_id
      WHERE s.version_id = $1
      ORDER BY f.display_order, f.id
      LIMIT 1`,
    [version.body.data.id],
  );

  return {
    clientId: client.id,
    versionId: version.body.data.id as string,
    versionFieldId: versionField.rows[0].id,
    liveFieldId: field.body.data.id as string,
  };
}

describe('MOB-C07 PART 01A generic form instance execution', () => {
  it('creates a DRAFT instance from a published version', async (t) => {
    if (!ok(t)) return;
    const f = await seedPublishedForm();
    const created = await api()
      .post(`/api/v1/form-template-versions/${f.versionId}/instances`)
      .set(auth());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.formTemplateVersionId, f.versionId);
    assert.equal(created.body.data.clientId, f.clientId);
    assert.equal(created.body.data.status, 'DRAFT');
    assert.equal(created.body.data.startedAt, null);
    assert.equal(created.body.data.completedAt, null);
  });

  it('rejects a non-PUBLISHED version', async (t) => {
    if (!ok(t)) return;
    const f = await seedPublishedForm();
    const draft = await api()
      .post(
        `/api/v1/form-templates/${
          (
            await pool!.query<{ form_template_id: string }>(
              'SELECT form_template_id FROM form_template_versions WHERE id = $1',
              [f.versionId],
            )
          ).rows[0].form_template_id
        }/versions`,
      )
      .set(auth())
      .send({ versionNumber: 2 });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const rejected = await api()
      .post(`/api/v1/form-template-versions/${draft.body.data.id}/instances`)
      .set(auth());
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'BAD_REQUEST');
    assert.equal(
      rejected.body.error.message,
      'Only published template versions can create instances.',
    );
  });

  it('starts a DRAFT instance and rejects a second start', async (t) => {
    if (!ok(t)) return;
    const f = await seedPublishedForm();
    const created = await api()
      .post(`/api/v1/form-template-versions/${f.versionId}/instances`)
      .set(auth());
    const id = created.body.data.id as string;
    const started = await api().post(`/api/v1/form-instances/${id}/start`).set(auth());
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.data.status, 'IN_PROGRESS');
    assert.ok(started.body.data.startedAt);
    const again = await api().post(`/api/v1/form-instances/${id}/start`).set(auth());
    assert.equal(again.status, 400);
    assert.equal(again.body.error.message, 'Only draft instances can be started.');
  });

  it('saves a valid response and rejects a field outside the pinned version', async (t) => {
    if (!ok(t)) return;
    const f = await seedPublishedForm();
    const created = await api()
      .post(`/api/v1/form-template-versions/${f.versionId}/instances`)
      .set(auth());
    const id = created.body.data.id as string;
    const saved = await api()
      .put(`/api/v1/form-instances/${id}/responses`)
      .set(auth())
      .send({ fieldId: f.versionFieldId, value: 'ok' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.data, {});
    const outside = await api()
      .put(`/api/v1/form-instances/${id}/responses`)
      .set(auth())
      .send({ fieldId: f.liveFieldId, value: 'nope' });
    assert.equal(outside.status, 400);
    assert.equal(
      outside.body.error.message,
      'Response field does not belong to this version.',
    );
  });

  it('rejects responses on a terminal instance', async (t) => {
    if (!ok(t)) return;
    const f = await seedPublishedForm({ required: false });
    const created = await api()
      .post(`/api/v1/form-template-versions/${f.versionId}/instances`)
      .set(auth());
    const id = created.body.data.id as string;
    const completed = await api()
      .post(`/api/v1/form-instances/${id}/complete`)
      .set(auth());
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    const rejected = await api()
      .put(`/api/v1/form-instances/${id}/responses`)
      .set(auth())
      .send({ fieldId: f.versionFieldId, value: 'late' });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.message, 'Terminal instances cannot be modified.');
  });

  it('completes when required fields are present and rejects when they are missing', async (t) => {
    if (!ok(t)) return;
    const f = await seedPublishedForm({ required: true });
    const created = await api()
      .post(`/api/v1/form-template-versions/${f.versionId}/instances`)
      .set(auth());
    const id = created.body.data.id as string;
    const missing = await api()
      .post(`/api/v1/form-instances/${id}/complete`)
      .set(auth());
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.message, 'Required fields are missing.');
    const saved = await api()
      .put(`/api/v1/form-instances/${id}/responses`)
      .set(auth())
      .send({ fieldId: f.versionFieldId, value: 'done' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const completed = await api()
      .post(`/api/v1/form-instances/${id}/complete`)
      .set(auth());
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.data.status, 'COMPLETED');
    assert.ok(completed.body.data.completedAt);
  });

  it('cancels a non-terminal instance and then rejects further cancel', async (t) => {
    if (!ok(t)) return;
    const f = await seedPublishedForm();
    const created = await api()
      .post(`/api/v1/form-template-versions/${f.versionId}/instances`)
      .set(auth());
    const id = created.body.data.id as string;
    const cancelled = await api()
      .post(`/api/v1/form-instances/${id}/cancel`)
      .set(auth());
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    assert.equal(cancelled.body.data.completedAt, null);
    const again = await api().post(`/api/v1/form-instances/${id}/cancel`).set(auth());
    assert.equal(again.status, 400);
    assert.equal(again.body.error.message, 'Instance is already terminal.');
  });

  it('keeps form_template.manage as the generic mutation permission', async (t) => {
    if (!ok(t)) return;
    const f = await seedPublishedForm();
    const plain = await createPlainSession();
    const denied = await api()
      .post(`/api/v1/form-template-versions/${f.versionId}/instances`)
      .set(auth(plain));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  });
});
