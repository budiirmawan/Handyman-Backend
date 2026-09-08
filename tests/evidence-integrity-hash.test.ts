import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { computeEvidenceSha256, EVIDENCE_HASH_ALGORITHM } from '../src/modules/evidence';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-DOC-CONTROL-01 PART 01 — Evidence Integrity Metadata + Hash
 * Foundation (focused tests).
 *
 * Verifies:
 *   - the persisted content_sha256 is the SHA-256 of the actual uploaded
 *     bytes on BOTH authoritative upload paths
 *     (POST /evidence/:id/file and POST /mobile/evidence),
 *   - hash metadata consistency (content_hashed_at + hash_algorithm are
 *     persisted together with the hash),
 *   - different bytes produce different hashes,
 *   - legacy/unhashed evidence rows remain valid (NULL hash, metadata and
 *     content endpoints unchanged),
 *   - existing upload behavior (metadata, storage key, content download)
 *     is not broken,
 *   - an EVIDENCE_INTEGRITY_HASH_RECORDED operational event is recorded.
 */

const STORAGE_DIR = resolve(process.env.EVIDENCE_STORAGE_DIR ?? '.data/evidence');

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let adminUserId = '';

let clientA = '';
let executionA = '';
let esUploadA = ''; // evidence receiving bytes via POST /evidence/:id/file
let esUploadB = ''; // second evidence for different-bytes comparison
let esLegacy = ''; // legacy row: metadata contract only, never hashed

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

async function insertRow(table: string, values: Record<string, unknown>): Promise<string> {
  const rowId = randomUUID();
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
      evidence_requirements, evidence_submissions, operational_events
     CASCADE`,
  );

  const admin = await createAdminUser();
  token = admin.token;
  adminUserId = admin.userId;

  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Integrity Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Integrity Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Integrity Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  clientA = client.id;

  const template = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `CT_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Integrity Checklist',
    status: 'ACTIVE',
  });
  executionA = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: template,
  });

  const evidence = () =>
    insertRow('evidence_submissions', {
      client_id: clientA,
      execution_type: 'CHECKLIST_EXECUTION',
      execution_id: executionA,
      evidence_type: 'PHOTO',
      file_reference: `external-ref-${randomUUID()}`,
      original_file_name: 'placeholder.jpg',
      mime_type: 'image/jpeg',
      file_size: 0,
    });

  esUploadA = await evidence();
  esUploadB = await evidence();
  esLegacy = await evidence();

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

const sha256hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('CR-BE-DOC-CONTROL-01 PART 01 — evidence integrity hash foundation', () => {
  it('computeEvidenceSha256 returns the lowercase-hex SHA-256 of the exact bytes', () => {
    const bytes = Buffer.from('integrity-helper-bytes');
    assert.equal(computeEvidenceSha256(bytes), sha256hex(bytes));
    assert.match(computeEvidenceSha256(bytes), /^[0-9a-f]{64}$/);
    assert.equal(EVIDENCE_HASH_ALGORITHM, 'SHA-256');
  });

  it('POST /evidence/:id/file persists the SHA-256 of the uploaded bytes with consistent hash metadata', async (t) => {
    if (!requireDatabase(t)) return;

    const bytes = Buffer.from('web-upload-photo-bytes-0123456789');
    const response = await api()
      .post(`/api/v1/evidence/${esUploadA}/file`)
      .set(auth())
      .attach('file', bytes, { filename: 'photo-a.jpg', contentType: 'image/jpeg' });

    assert.equal(response.status, 201);
    // Existing contract preserved.
    assert.equal(response.body.data.fileReference, `evidence/${esUploadA}`);
    assert.equal(response.body.data.fileSize, bytes.length);

    const stored = await q(
      `SELECT content_sha256, content_hashed_at, hash_algorithm,
              last_integrity_status, last_integrity_checked_at, file_size
         FROM evidence_submissions WHERE id = $1`,
      [esUploadA],
    );
    const row = stored.rows[0];
    assert.equal(row.content_sha256, sha256hex(bytes), 'hash must match the stored binary bytes');
    assert.ok(row.content_hashed_at, 'content_hashed_at must be persisted with the hash');
    assert.equal(row.hash_algorithm, 'SHA-256');
    assert.equal(row.last_integrity_status, null, 'verification is PART 02 — never set at upload');
    assert.equal(row.last_integrity_checked_at, null);
    assert.equal(Number(row.file_size), bytes.length);

    // The stored binary served back is exactly what was hashed.
    const content = await api()
      .get(`/api/v1/evidence/${esUploadA}/file/content`)
      .set(auth());
    assert.equal(content.status, 200);
    assert.equal(sha256hex(content.body as Buffer), row.content_sha256);

    // Integrity hash recording is auditable.
    const events = await q(
      `SELECT metadata FROM operational_events
        WHERE event_type = 'EVIDENCE_INTEGRITY_HASH_RECORDED'
          AND entity_type = 'EVIDENCE_SUBMISSION' AND entity_id = $1`,
      [esUploadA],
    );
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0].metadata.contentSha256, sha256hex(bytes));
    assert.equal(events.rows[0].metadata.algorithm, 'SHA-256');
  });

  it('POST /mobile/evidence persists the SHA-256 of the uploaded bytes in the same insert', async (t) => {
    if (!requireDatabase(t)) return;

    const bytes = Buffer.from('mobile-upload-photo-bytes-abcdef');
    const response = await api()
      .post('/api/v1/mobile/evidence')
      .set(auth())
      .field('evidenceType', 'PHOTO')
      .field('executionType', 'CHECKLIST_EXECUTION')
      .field('executionId', executionA)
      .attach('file', bytes, { filename: 'mobile.jpg', contentType: 'image/jpeg' });

    assert.equal(response.status, 201);
    const evidenceId = response.body.data.evidenceId ?? response.body.data.id;
    assert.ok(evidenceId, 'mobile contract must expose the evidence id');

    const stored = await q(
      `SELECT content_sha256, content_hashed_at, hash_algorithm, file_size
         FROM evidence_submissions WHERE id = $1`,
      [evidenceId],
    );
    const row = stored.rows[0];
    assert.equal(row.content_sha256, sha256hex(bytes));
    assert.ok(row.content_hashed_at);
    assert.equal(row.hash_algorithm, 'SHA-256');
    assert.equal(Number(row.file_size), bytes.length);

    const events = await q(
      `SELECT id FROM operational_events
        WHERE event_type = 'EVIDENCE_INTEGRITY_HASH_RECORDED'
          AND entity_type = 'EVIDENCE_SUBMISSION' AND entity_id = $1`,
      [evidenceId],
    );
    assert.equal(events.rowCount, 1);
  });

  it('different uploaded bytes produce different persisted hashes', async (t) => {
    if (!requireDatabase(t)) return;

    const bytesB = Buffer.from('web-upload-photo-bytes-DIFFERENT');
    const response = await api()
      .post(`/api/v1/evidence/${esUploadB}/file`)
      .set(auth())
      .attach('file', bytesB, { filename: 'photo-b.jpg', contentType: 'image/jpeg' });
    assert.equal(response.status, 201);

    const rows = await q(
      `SELECT id, content_sha256 FROM evidence_submissions WHERE id = ANY($1::uuid[])`,
      [[esUploadA, esUploadB]],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.content_sha256]));
    assert.equal(byId.get(esUploadB), sha256hex(bytesB));
    assert.ok(byId.get(esUploadA), 'first upload keeps its hash');
    assert.notEqual(byId.get(esUploadA), byId.get(esUploadB));
  });

  it('legacy/unhashed evidence remains valid with NULL integrity metadata', async (t) => {
    if (!requireDatabase(t)) return;

    const stored = await q(
      `SELECT content_sha256, content_hashed_at, hash_algorithm, status
         FROM evidence_submissions WHERE id = $1`,
      [esLegacy],
    );
    const row = stored.rows[0];
    assert.equal(row.content_sha256, null, 'legacy evidence must never be assigned a hash');
    assert.equal(row.content_hashed_at, null);
    assert.equal(row.hash_algorithm, null);
    assert.equal(row.status, 'ACTIVE');

    // Existing reads keep working for unhashed rows.
    const metadata = await api()
      .get(`/api/v1/evidence/${esLegacy}/file`)
      .set(auth());
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.data.id, esLegacy);

    // No stored file for the legacy external reference — existing behavior.
    const content = await api()
      .get(`/api/v1/evidence/${esLegacy}/file/content`)
      .set(auth());
    assert.equal(content.status, 404);

    // No fabricated integrity event exists for the legacy row.
    const events = await q(
      `SELECT id FROM operational_events
        WHERE event_type = 'EVIDENCE_INTEGRITY_HASH_RECORDED' AND entity_id = $1`,
      [esLegacy],
    );
    assert.equal(events.rowCount, 0);
  });

  it('database constraints reject fabricated or inconsistent hash metadata', async (t) => {
    if (!requireDatabase(t)) return;

    // Hash without hashed-at/algorithm violates the consistency constraint.
    await assert.rejects(
      q(
        `UPDATE evidence_submissions SET content_sha256 = $2 WHERE id = $1`,
        [esLegacy, 'a'.repeat(64)],
      ),
      /evidence_hash_consistency/,
    );

    // Non-SHA-256 hex is rejected.
    await assert.rejects(
      q(
        `UPDATE evidence_submissions
            SET content_sha256 = $2, content_hashed_at = NOW(), hash_algorithm = 'SHA-256'
          WHERE id = $1`,
        [esLegacy, 'NOT-A-HASH'],
      ),
      /evidence_content_sha256_format/,
    );

    // Unknown algorithm label is rejected.
    await assert.rejects(
      q(
        `UPDATE evidence_submissions
            SET content_sha256 = $2, content_hashed_at = NOW(), hash_algorithm = 'MD5'
          WHERE id = $1`,
        [esLegacy, 'b'.repeat(64)],
      ),
      /evidence_hash_algorithm/,
    );
  });
});
