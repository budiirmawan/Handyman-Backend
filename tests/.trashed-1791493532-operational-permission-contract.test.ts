import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-API-01 PART 04 — Operational permission & contract consistency.
 *
 * Proves the checklist / task / evidence / schedule / review / UOM /
 * operational-event surfaces now use their dedicated permission codes:
 *   - authorized access works with the aligned permissions,
 *   - missing permission is rejected with the standard 403 PERMISSION_DENIED
 *     envelope,
 *   - the reused `form_template.*` permission no longer grants access to
 *     those surfaces (while the form-template domain keeps it),
 *   - Client / Building scope enforcement is preserved.
 */

const FORM_ONLY_PERMISSIONS = [
  { code: 'form_template.read', name: 'Read Form Templates' },
  { code: 'form_template.manage', name: 'Manage Form Templates' },
] as const;

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let plainToken = '';
let formOnlyToken = '';

let clientA = '';
let clientB = '';
let buildingA1 = '';
let sfA = '';
let ceA = '';
let ceB = '';
let esA = '';
let esB = '';
let gtA = '';
let sdA = '';
let rvA = '';
let uomA = '';

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

const id = () => randomUUID();

async function insertRow(table: string, values: Record<string, unknown>): Promise<string> {
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
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, permissions, clients, properties, buildings,
      user_building_assignments, source_forms, form_templates,
      checklist_templates, checklist_executions, evidence_submissions,
      schedule_definitions, generated_tasks, reviews, units_of_measure,
      operational_events
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  plainToken = await createPlainSession();
  formOnlyToken = await createSessionWithPermissions(FORM_ONLY_PERMISSIONS);

  const a = await clientService.createClient({
    code: `CLI_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Client A',
  });
  const propA = await propertyService.createProperty({
    clientId: a.id,
    code: `PROP_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Property A',
  });
  const bA = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BLD_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Building A',
  });
  const b = await clientService.createClient({
    code: `CLI_B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Client B',
  });
  const propB = await propertyService.createProperty({
    clientId: b.id,
    code: `PROP_B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Property B',
  });
  const bB = await buildingService.createBuilding({
    propertyId: propB.id,
    code: `BLD_B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Building B',
  });

  clientA = a.id;
  clientB = b.id;
  buildingA1 = bA.id;

  // Admin can access ONLY building A (hence only client A).
  await buildingAssignmentService.createAssignment(admin.userId, {
    buildingId: buildingA1,
  });

  // Positive-control fixture for the form-template domain.
  sfA = await insertRow('source_forms', {
    client_id: clientA,
    code: `SF_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Source A',
    source_type: 'INTERNAL',
  });

  const ctA = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `CT_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Checklist A',
    status: 'ACTIVE',
  });
  const ctB = await insertRow('checklist_templates', {
    client_id: clientB,
    code: `CT_B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Checklist B',
    status: 'ACTIVE',
  });

  ceA = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: ctA,
  });
  ceB = await insertRow('checklist_executions', {
    client_id: clientB,
    checklist_template_id: ctB,
  });

  esA = await insertRow('evidence_submissions', {
    client_id: clientA,
    execution_type: 'CHECKLIST_EXECUTION',
    execution_id: ceA,
    evidence_type: 'PHOTO',
    file_reference: 'ref-a',
    original_file_name: 'a.jpg',
    mime_type: 'image/jpeg',
    file_size: 1,
  });
  esB = await insertRow('evidence_submissions', {
    client_id: clientB,
    execution_type: 'CHECKLIST_EXECUTION',
    execution_id: ceB,
    evidence_type: 'PHOTO',
    file_reference: 'ref-b',
    original_file_name: 'b.jpg',
    mime_type: 'image/jpeg',
    file_size: 1,
  });

  sdA = await insertRow('schedule_definitions', {
    client_id: clientA,
    code: `SCH_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Schedule A',
    target_type: 'FORM_TEMPLATE',
    target_id: randomUUID(),
    building_id: buildingA1,
    start_at: new Date().toISOString(),
    timezone: 'UTC',
  });

  gtA = await insertRow('generated_tasks', {
    client_id: clientA,
    schedule_definition_id: sdA,
    occurrence_at: new Date().toISOString(),
    target_type: 'FORM_TEMPLATE',
    target_id: randomUUID(),
    building_id: buildingA1,
  });

  rvA = await insertRow('reviews', {
    client_id: clientA,
    target_type: 'FORM_INSTANCE',
    target_id: randomUUID(),
    reviewer_user_id: admin.userId,
  });

  uomA = await insertRow('units_of_measure', {
    client_id: clientA,
    code: `UOM_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Unit A',
    symbol: 'u',
    category: 'COUNT',
  });

  await insertRow('operational_events', {
    client_id: clientA,
    event_type: 'TEST_EVENT',
    entity_type: 'ASSET',
    entity_id: randomUUID(),
    actor_user_id: admin.userId,
    building_id: buildingA1,
    summary: 'event a',
  });

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

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

const OPERATIONAL_READS: { label: string; request: (a: Record<string, string>) => ReturnType<typeof api.get> }[] = [
  { label: 'checklist executions', request: (a) => api().get('/api/v1/checklist-executions').set(a) },
  { label: 'evidence', request: (a) => api().get('/api/v1/evidence').set(a) },
  { label: 'tasks', request: (a) => api().get('/api/v1/tasks').set(a) },
  { label: 'schedules', request: (a) => api().get('/api/v1/schedules').set(a) },
  { label: 'reviews', request: (a) => api().get('/api/v1/reviews').set(a) },
  { label: 'operational events', request: (a) => api().get('/api/v1/operational-events').set(a) },
  { label: 'units of measure', request: (a) => api().get(`/api/v1/clients/${clientA}/uoms`).set(a) },
];

describe('CR-BE-API-01 PART 04 — operational permission contract', () => {
  it('allows authorized access with the aligned permissions', async (t) => {
    if (!requireDatabase(t)) return;

    for (const { label, request } of OPERATIONAL_READS) {
      const response = await request(auth(adminToken));
      assert.equal(response.status, 200, `${label} must be readable by admin`);
    }

    const upload = await api()
      .post(`/api/v1/evidence/${esA}/file`)
      .set(auth(adminToken))
      .attach('file', Buffer.from('p4-upload'), {
        filename: 'p4.jpg',
        contentType: 'image/jpeg',
      });
    assert.equal(upload.status, 201, 'evidence.manage must allow upload by admin');
  });

  it('rejects missing permission with the standard forbidden envelope', async (t) => {
    if (!requireDatabase(t)) return;

    for (const { label, request } of OPERATIONAL_READS) {
      const response = await request(auth(plainToken));
      assert.equal(response.status, 403, `${label} must require a permission`);
      assert.equal(response.body.success, false);
      assert.equal(response.body.error.code, 'PERMISSION_DENIED');
      assert.ok(response.body.error.message, 'forbidden message must be present');
    }
  });

  it('no longer honors the reused form_template.* permission on operational surfaces', async (t) => {
    if (!requireDatabase(t)) return;

    for (const { label, request } of OPERATIONAL_READS) {
      const response = await request(auth(formOnlyToken));
      assert.equal(
        response.status,
        403,
        `${label} must not be granted by form_template.read`,
      );
      assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    }

    const upload = await api()
      .post(`/api/v1/evidence/${esA}/file`)
      .set(auth(formOnlyToken))
      .attach('file', Buffer.from('x'), { filename: 'x.jpg', contentType: 'image/jpeg' });
    assert.equal(upload.status, 403, 'evidence.manage must not be granted by form_template.manage');
  });

  it('keeps the form-template domain on form_template.* permissions', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/source-forms/${sfA}/templates`)
      .set(auth(formOnlyToken));
    assert.equal(
      response.status,
      200,
      'form_template.read must still grant the form-template domain',
    );
  });

  it('preserves Client/Building scope under the aligned permissions', async (t) => {
    if (!requireDatabase(t)) return;

    const evidence = await api().get('/api/v1/evidence').set(auth(adminToken));
    assert.equal(evidence.status, 200);
    const got = evidence.body.data.map((row: { id: string }) => row.id);
    assert.ok(got.includes(esA), 'in-scope evidence must be returned');
    assert.ok(!got.includes(esB), 'cross-Client evidence must be excluded');

    assert.equal(
      (await api().get(`/api/v1/evidence/${esB}`).set(auth(adminToken))).status,
      403,
      'cross-Client evidence read must be denied',
    );
  });
});
