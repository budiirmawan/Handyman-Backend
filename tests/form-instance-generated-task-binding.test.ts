import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const DB_PORT = 55493;
const DATA_DIR = '/tmp/asentra-mob-c07-p01b-pg';
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
 * MOB-C07 PART 01B — form_instances.generated_task_id schema foundation.
 *
 * Persistence only: generic create stays unbound, one bound instance per
 * generated task, multiple NULL rows remain legal, unknown task ids are
 * rejected by the FK. No mobile routes and no client-supplied binding.
 */

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
let clientId = '';
let buildingId = '';
let versionId = '';

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
       source_forms, generated_tasks, schedule_definitions,
       user_building_assignments, buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
  database = db;

  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Form instance binding client',
  });
  clientId = client.id;
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
  buildingId = building.id;
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
      required: false,
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
  versionId = version.body.data.id as string;
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
const pgCode = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'NO_CODE';

async function createGenericInstance(): Promise<string> {
  const created = await api()
    .post(`/api/v1/form-template-versions/${versionId}/instances`)
    .set(auth());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.status, 'DRAFT');
  assert.equal(created.body.data.generatedTaskId, undefined);
  return created.body.data.id as string;
}

async function createGeneratedTask(occurrenceAt: string): Promise<string> {
  const scheduleId = randomUUID();
  await pool!.query(
    `INSERT INTO schedule_definitions (
       id, client_id, code, name, target_type, target_id, building_id,
       start_at, timezone, status
     ) VALUES ($1, $2, $3, $4, 'FORM_TEMPLATE', $5, $6, $7, 'Asia/Jakarta', 'ACTIVE')`,
    [
      scheduleId,
      clientId,
      `SD_${suffix()}`,
      'Binding schedule',
      versionId,
      buildingId,
      '2026-08-01T00:00:00Z',
    ],
  );
  const taskId = randomUUID();
  await pool!.query(
    `INSERT INTO generated_tasks (
       id, client_id, schedule_definition_id, occurrence_at,
       target_type, target_id, building_id, status
     ) VALUES ($1, $2, $3, $4, 'FORM_TEMPLATE', $5, $6, 'OPEN')`,
    [taskId, clientId, scheduleId, occurrenceAt, versionId, buildingId],
  );
  return taskId;
}

describe('MOB-C07 PART 01B form instance ↔ generated task binding', () => {
  it('adds a nullable generated_task_id with restrictive FK and indexes', async (t) => {
    if (!ok(t)) return;
    const col = await pool!.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'form_instances'
          AND column_name = 'generated_task_id'`,
    );
    assert.equal(col.rowCount, 1);
    assert.equal(col.rows[0].data_type, 'uuid');
    assert.equal(col.rows[0].is_nullable, 'YES');

    const fk = await pool!.query<{
      delete_rule: string;
      update_rule: string;
      foreign_table_name: string;
    }>(
      `SELECT rc.delete_rule, rc.update_rule, ccu.table_name AS foreign_table_name
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = rc.constraint_name
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = rc.constraint_name
        WHERE kcu.table_name = 'form_instances'
          AND kcu.column_name = 'generated_task_id'
          AND rc.constraint_name = 'form_instances_generated_task_id_fkey'`,
    );
    assert.equal(fk.rowCount, 1);
    assert.equal(fk.rows[0].foreign_table_name, 'generated_tasks');
    assert.equal(fk.rows[0].delete_rule, 'NO ACTION');
    assert.equal(fk.rows[0].update_rule, 'NO ACTION');

    const indexes = await pool!.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE tablename = 'form_instances'
          AND indexname IN (
            'form_instances_generated_task_id_idx',
            'form_instances_generated_task_unique'
          )
        ORDER BY indexname`,
    );
    assert.equal(indexes.rowCount, 2);
    const byName = Object.fromEntries(
      indexes.rows.map((row) => [row.indexname, row.indexdef]),
    );
    assert.match(byName.form_instances_generated_task_id_idx, /generated_task_id/);
    assert.match(byName.form_instances_generated_task_unique, /UNIQUE/i);
    assert.match(
      byName.form_instances_generated_task_unique,
      /WHERE \(generated_task_id IS NOT NULL\)/,
    );

    const buildingCol = await pool!.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'form_instances'
          AND column_name = 'building_id'`,
    );
    assert.equal(buildingCol.rowCount, 0);
  });

  it('generic create still succeeds and remains unbound', async (t) => {
    if (!ok(t)) return;
    const id = await createGenericInstance();
    const row = await pool!.query<{ generated_task_id: string | null }>(
      'SELECT generated_task_id FROM form_instances WHERE id = $1',
      [id],
    );
    assert.equal(row.rows[0].generated_task_id, null);
  });

  it('allows multiple unbound instances', async (t) => {
    if (!ok(t)) return;
    const first = await createGenericInstance();
    const second = await createGenericInstance();
    assert.notEqual(first, second);
    const rows = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM form_instances
        WHERE id IN ($1, $2)
          AND generated_task_id IS NULL`,
      [first, second],
    );
    assert.equal(rows.rows[0].n, 2);
  });

  it('binds one instance per generated task and rejects a duplicate', async (t) => {
    if (!ok(t)) return;
    const taskA = await createGeneratedTask('2026-08-10T01:00:00Z');
    const taskB = await createGeneratedTask('2026-08-11T01:00:00Z');
    const first = await createGenericInstance();
    const second = await createGenericInstance();
    const other = await createGenericInstance();

    await pool!.query(
      'UPDATE form_instances SET generated_task_id = $1 WHERE id = $2',
      [taskA, first],
    );
    await pool!.query(
      'UPDATE form_instances SET generated_task_id = $1 WHERE id = $2',
      [taskB, other],
    );

    let duplicateCode = 'NO_ERROR';
    try {
      await pool!.query(
        'UPDATE form_instances SET generated_task_id = $1 WHERE id = $2',
        [taskA, second],
      );
    } catch (error) {
      duplicateCode = pgCode(error);
    }
    assert.equal(duplicateCode, '23505');

    const bound = await pool!.query<{ id: string }>(
      'SELECT id FROM form_instances WHERE generated_task_id = $1',
      [taskA],
    );
    assert.equal(bound.rowCount, 1);
    assert.equal(bound.rows[0].id, first);
  });

  it('rejects an unknown generated_task_id', async (t) => {
    if (!ok(t)) return;
    const instanceId = await createGenericInstance();
    let code = 'NO_ERROR';
    try {
      await pool!.query(
        'UPDATE form_instances SET generated_task_id = $1 WHERE id = $2',
        [randomUUID(), instanceId],
      );
    } catch (error) {
      code = pgCode(error);
    }
    assert.equal(code, '23503');
  });

  it('down removes the column, FK and indexes; up restores them', async (t) => {
    if (!ok(t)) return;
    const downId = await migrateDown(pool!);
    assert.equal(downId, '0340_bind_form_instance_to_generated_task');
    const afterDown = await pool!.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'form_instances'
          AND column_name = 'generated_task_id'`,
    );
    assert.equal(afterDown.rowCount, 0);
    const indexesDown = await pool!.query(
      `SELECT indexname
         FROM pg_indexes
        WHERE tablename = 'form_instances'
          AND indexname IN (
            'form_instances_generated_task_id_idx',
            'form_instances_generated_task_unique'
          )`,
    );
    assert.equal(indexesDown.rowCount, 0);

    const applied = await migrateUp(pool!);
    assert.ok(applied.includes('0340_bind_form_instance_to_generated_task'));
    const afterUp = await pool!.query(
      `SELECT is_nullable
         FROM information_schema.columns
        WHERE table_name = 'form_instances'
          AND column_name = 'generated_task_id'`,
    );
    assert.equal(afterUp.rowCount, 1);
    assert.equal(afterUp.rows[0].is_nullable, 'YES');
  });
});
