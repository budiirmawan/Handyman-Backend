import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-API-01 PART 03 — Evidence File API foundation.
 *
 * Focused tests for:
 *   - authorized upload,
 *   - authorized retrieval (metadata + content),
 *   - inaccessible evidence rejected (403),
 *   - cross-Client access rejected (scope is derived from the accessible
 *     Building set; evidence rows are client-scoped, so the accessible-Client
 *     set is the authoritative scope),
 *   - invalid evidence/file requests rejected.
 */

const STORAGE_DIR = resolve(
  process.env.EVIDENCE_STORAGE_DIR ?? '.data/evidence',
);

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let adminUserId = '';

let clientA = '';
let clientB = '';
let esA = ''; // evidence in clientA (accessible scope)
let esB = ''; // evidence in clientB (cross-Client, inaccessible)
let esNoFile = ''; // evidence in clientA without a stored file (retrieval cases)
let esInvalid = ''; // evidence in clientA that never receives a stored file (invalid-request cases)

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

  rmSync(STORAGE_DIR, { recursive: true, force: true });

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, permissions, clients, properties, buildings,
      user_building_assignments, checklist_templates, checklist_executions,
      evidence_requirements, evidence_submissions
     CASCADE`,
  );

  const admin = await createAdminUser();
  token = admin.token;
  adminUserId = admin.userId;

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
  await buildingService.createBuilding({
    propertyId: propB.id,
    code: `BLD_B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Building B',
  });

  clientA = a.id;
  clientB = b.id;

  // Admin can access ONLY building A (hence only client A).
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: bA.id,
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
  const ceA = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: ctA,
  });
  const ceB = await insertRow('checklist_executions', {
    client_id: clientB,
    checklist_template_id: ctB,
  });

  const evidence = (clientId: string, executionId: string) =>
    insertRow('evidence_submissions', {
      client_id: clientId,
      execution_type: 'CHECKLIST_EXECUTION',
      execution_id: executionId,
      evidence_type: 'PHOTO',
      file_reference: `external-ref-${randomUUID()}`,
      original_file_name: 'placeholder.jpg',
      mime_type: 'image/jpeg',
      file_size: 0,
    });

  esA = await evidence(clientA, ceA);
  esB = await evidence(clientB, ceB);
  esNoFile = await evidence(clientA, ceA);
  esInvalid = await evidence(clientA, ceA);

  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe('CR-BE-API-01 PART 03 — evidence file API', () => {
  it('authorizes an upload and updates the evidence file metadata', async (t) => {
    if (!requireDatabase(t)) return;

    const bytes = Buffer.from('fake-photo-bytes-0123456789');
    const response = await api()
      .post(`/api/v1/evidence/${esA}/file`)
      .set(auth())
      .attach('file', bytes, { filename: 'photo-a.jpg', contentType: 'image/jpeg' });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.id, esA);
    assert.equal(response.body.data.fileReference, `evidence/${esA}`);
    assert.equal(response.body.data.originalFileName, 'photo-a.jpg');
    assert.equal(response.body.data.mimeType, 'image/jpeg');
    assert.equal(response.body.data.fileSize, bytes.length);

    const stored = await q(
      'SELECT file_reference, original_file_name, mime_type, file_size FROM evidence_submissions WHERE id = $1',
      [esA],
    );
    assert.equal(stored.rows[0].file_reference, `evidence/${esA}`);
    assert.equal(stored.rows[0].mime_type, 'image/jpeg');
    assert.equal(Number(stored.rows[0].file_size), bytes.length);
  });

  it('authorizes retrieval of metadata and file content', async (t) => {
    if (!requireDatabase(t)) return;

    const bytes = Buffer.from('retrievable-photo-bytes');
    await api()
      .post(`/api/v1/evidence/${esNoFile}/file`)
      .set(auth())
      .attach('file', bytes, { filename: 'photo-b.jpg', contentType: 'image/jpeg' });

    const metadata = await api()
      .get(`/api/v1/evidence/${esNoFile}/file`)
      .set(auth());
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.data.fileReference, `evidence/${esNoFile}`);
    assert.equal(metadata.body.data.mimeType, 'image/jpeg');
    assert.equal(metadata.body.data.fileSize, bytes.length);

    const content = await api()
      .get(`/api/v1/evidence/${esNoFile}/file/content`)
      .set(auth());
    assert.equal(content.status, 200);
    assert.equal(content.headers['content-type'], 'image/jpeg');
    assert.ok(Buffer.isBuffer(content.body), 'file content must be returned as bytes');
    assert.deepEqual(content.body, bytes);
  });

  it('rejects inaccessible evidence across Clients with 403', async (t) => {
    if (!requireDatabase(t)) return;

    const upload = await api()
      .post(`/api/v1/evidence/${esB}/file`)
      .set(auth())
      .attach('file', Buffer.from('x'), { filename: 'x.jpg', contentType: 'image/jpeg' });
    assert.equal(upload.status, 403, 'cross-Client upload must be denied');

    const metadata = await api().get(`/api/v1/evidence/${esB}/file`).set(auth());
    assert.equal(metadata.status, 403, 'cross-Client metadata must be denied');

    const content = await api()
      .get(`/api/v1/evidence/${esB}/file/content`)
      .set(auth());
    assert.equal(content.status, 403, 'cross-Client download must be denied');
  });

  it('rejects invalid evidence and file requests', async (t) => {
    if (!requireDatabase(t)) return;

    // Malformed evidence id → 400 VALIDATION_ERROR.
    const malformed = await api().get('/api/v1/evidence/not-a-uuid/file').set(auth());
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');

    // Unknown but valid evidence id → 404 NOT_FOUND.
    const unknown = await api()
      .get(`/api/v1/evidence/${randomUUID()}/file`)
      .set(auth());
    assert.equal(unknown.status, 404);

    // Missing multipart file field → 400 VALIDATION_ERROR.
    const missing = await api()
      .post(`/api/v1/evidence/${esInvalid}/file`)
      .set(auth())
      .field('note', 'no file here');
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');

    // MIME type not allowed for PHOTO evidence → 400 BAD_REQUEST.
    const wrongMime = await api()
      .post(`/api/v1/evidence/${esInvalid}/file`)
      .set(auth())
      .attach('file', Buffer.from('%PDF-1.4'), {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      });
    assert.equal(wrongMime.status, 400);

    // Content for a submission that never stored a backend file → 404.
    const noFile = await api()
      .get(`/api/v1/evidence/${esInvalid}/file/content`)
      .set(auth());
    assert.equal(noFile.status, 404);
    assert.equal(noFile.body.error.code, 'EVIDENCE_FILE_NOT_FOUND');
  });

  it('rejects an oversized upload', async (t) => {
    if (!requireDatabase(t)) return;

    const oversized = Buffer.alloc(52_428_801); // 1 byte over the 50 MB cap
    const response = await api()
      .post(`/api/v1/evidence/${esInvalid}/file`)
      .set(auth())
      .attach('file', oversized, { filename: 'big.jpg', contentType: 'image/jpeg' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
  });
});
