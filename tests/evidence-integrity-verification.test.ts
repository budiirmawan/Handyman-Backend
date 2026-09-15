import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-DOC-CONTROL-01 PART 02 — Integrity Verification + Audit
 * (focused tests).
 *
 * Verifies:
 *   - VERIFIED when the stored bytes still match the upload-time hash,
 *   - MISMATCH when the stored object was changed outside Asentra,
 *   - NOT_HASHED for legacy/unhashed evidence (no storage read needed),
 *   - FILE_UNAVAILABLE when the stored object is missing,
 *   - last_integrity_status / last_integrity_checked_at persisted per outcome,
 *   - verification NEVER mutates evidence (hash, file metadata, status),
 *   - EVIDENCE_INTEGRITY_VERIFIED / EVIDENCE_INTEGRITY_FAILED audit events,
 *   - access control: evidence.manage required, cross-Client denied.
 */

const STORAGE_DIR = resolve(process.env.EVIDENCE_STORAGE_DIR ?? '.data/evidence');

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let adminUserId = '';
let readOnlyToken = '';

let clientA = '';
let clientB = '';
let executionA = '';
let executionB = '';
let esVerified = ''; // uploaded, untouched → VERIFIED
let esTampered = ''; // uploaded, file replaced on disk → MISMATCH
let esMissing = ''; // uploaded, file removed on disk → FILE_UNAVAILABLE
let esLegacy = ''; // metadata-contract row, never hashed → NOT_HASHED
let esCross = ''; // evidence in client B → 403

const verifiedBytes = Buffer.from('verified-photo-bytes-0123456789');
const tamperedOriginal = Buffer.from('original-photo-bytes-before-tamper');
const missingBytes = Buffer.from('bytes-that-will-disappear');

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
  readOnlyToken = await createSessionWithPermissions([
    { code: 'evidence.read', name: 'Read Evidence' },
  ]);

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
  executionA = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: ctA,
  });
  executionB = await insertRow('checklist_executions', {
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

  esVerified = await evidence(clientA, executionA);
  esTampered = await evidence(clientA, executionA);
  esMissing = await evidence(clientA, executionA);
  esLegacy = await evidence(clientA, executionA);
  esCross = await evidence(clientB, executionB);

  const upload = (evidenceId: string, bytes: Buffer) =>
    api()
      .post(`/api/v1/evidence/${evidenceId}/file`)
      .set({ Authorization: `Bearer ${token}` })
      .attach('file', bytes, { filename: 'photo.jpg', contentType: 'image/jpeg' });

  await upload(esVerified, verifiedBytes);
  await upload(esTampered, tamperedOriginal);
  await upload(esMissing, missingBytes);

  // Simulate out-of-band changes to the stored objects.
  writeFileSync(
    resolve(STORAGE_DIR, 'evidence', esTampered),
    Buffer.from('tampered-bytes-changed-outside-asentra'),
  );
  rmSync(resolve(STORAGE_DIR, 'evidence', esMissing), { force: true });

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

const auth = () => ({ Authorization: `Bearer ${token}` });
const sha256hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const verify = (evidenceId: string, bearer = token) =>
  api()
    .post(`/api/v1/evidence/${evidenceId}/integrity-verification`)
    .set({ Authorization: `Bearer ${bearer}` });

async function persistedStatus(evidenceId: string) {
  const result = await q(
    `SELECT last_integrity_status, last_integrity_checked_at
       FROM evidence_submissions WHERE id = $1`,
    [evidenceId],
  );
  return result.rows[0];
}

async function eventsFor(evidenceId: string) {
  const result = await q(
    `SELECT event_type, metadata FROM operational_events
      WHERE entity_type = 'EVIDENCE_SUBMISSION' AND entity_id = $1
        AND event_type IN ('EVIDENCE_INTEGRITY_VERIFIED', 'EVIDENCE_INTEGRITY_FAILED')
      ORDER BY occurred_at ASC`,
    [evidenceId],
  );
  return result.rows;
}

describe('CR-BE-DOC-CONTROL-01 PART 02 — evidence integrity verification', () => {
  it('returns VERIFIED when the stored bytes match the recorded hash', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await verify(esVerified);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.outcome, 'VERIFIED');
    assert.equal(response.body.data.algorithm, 'SHA-256');
    assert.equal(response.body.data.expectedSha256, sha256hex(verifiedBytes));
    assert.equal(response.body.data.computedSha256, sha256hex(verifiedBytes));

    const persisted = await persistedStatus(esVerified);
    assert.equal(persisted.last_integrity_status, 'VERIFIED');
    assert.ok(persisted.last_integrity_checked_at);

    const events = await eventsFor(esVerified);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'EVIDENCE_INTEGRITY_VERIFIED');
    assert.equal(events[0].metadata.outcome, 'VERIFIED');
  });

  it('returns MISMATCH when the stored object changed outside Asentra and never mutates evidence', async (t) => {
    if (!requireDatabase(t)) return;

    const beforeRow = await q(
      `SELECT content_sha256, file_reference, file_size, status
         FROM evidence_submissions WHERE id = $1`,
      [esTampered],
    );

    const response = await verify(esTampered);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.outcome, 'MISMATCH');
    assert.equal(response.body.data.expectedSha256, sha256hex(tamperedOriginal));
    assert.equal(
      response.body.data.computedSha256,
      sha256hex(Buffer.from('tampered-bytes-changed-outside-asentra')),
    );

    const persisted = await persistedStatus(esTampered);
    assert.equal(persisted.last_integrity_status, 'MISMATCH');

    // No mutation of evidence: hash authority, file metadata, status and the
    // stored (tampered) object are all untouched.
    const afterRow = await q(
      `SELECT content_sha256, file_reference, file_size, status
         FROM evidence_submissions WHERE id = $1`,
      [esTampered],
    );
    assert.deepEqual(afterRow.rows[0], beforeRow.rows[0]);
    const content = await api()
      .get(`/api/v1/evidence/${esTampered}/file/content`)
      .set(auth());
    assert.equal(content.status, 200, 'stored file must not be deleted on mismatch');

    const events = await eventsFor(esTampered);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'EVIDENCE_INTEGRITY_FAILED');
    assert.equal(events[0].metadata.outcome, 'MISMATCH');
    assert.equal(events[0].metadata.expectedSha256, sha256hex(tamperedOriginal));
  });

  it('returns FILE_UNAVAILABLE when the stored object is missing', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await verify(esMissing);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.outcome, 'FILE_UNAVAILABLE');
    assert.equal(response.body.data.expectedSha256, sha256hex(missingBytes));
    assert.equal(response.body.data.computedSha256, null);

    const persisted = await persistedStatus(esMissing);
    assert.equal(persisted.last_integrity_status, 'FILE_UNAVAILABLE');

    const events = await eventsFor(esMissing);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'EVIDENCE_INTEGRITY_FAILED');
    assert.equal(events[0].metadata.outcome, 'FILE_UNAVAILABLE');
  });

  it('returns NOT_HASHED for legacy evidence without fabricating a hash', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await verify(esLegacy);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.outcome, 'NOT_HASHED');
    assert.equal(response.body.data.algorithm, null);
    assert.equal(response.body.data.expectedSha256, null);
    assert.equal(response.body.data.computedSha256, null);

    const persisted = await persistedStatus(esLegacy);
    assert.equal(persisted.last_integrity_status, 'NOT_HASHED');

    // Still no hash — verification never backfills legacy evidence.
    const row = await q(
      `SELECT content_sha256, content_hashed_at, hash_algorithm
         FROM evidence_submissions WHERE id = $1`,
      [esLegacy],
    );
    assert.equal(row.rows[0].content_sha256, null);
    assert.equal(row.rows[0].content_hashed_at, null);
    assert.equal(row.rows[0].hash_algorithm, null);

    const events = await eventsFor(esLegacy);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'EVIDENCE_INTEGRITY_FAILED');
    assert.equal(events[0].metadata.outcome, 'NOT_HASHED');
  });

  it('repeat verification refreshes the last-checked time', async (t) => {
    if (!requireDatabase(t)) return;

    const first = await persistedStatus(esVerified);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const response = await verify(esVerified);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.outcome, 'VERIFIED');

    const second = await persistedStatus(esVerified);
    assert.ok(
      new Date(second.last_integrity_checked_at).getTime() >
        new Date(first.last_integrity_checked_at).getTime(),
      'last_integrity_checked_at must advance on re-verification',
    );
  });

  it('enforces evidence.manage and Client isolation', async (t) => {
    if (!requireDatabase(t)) return;

    // Read-only permission is insufficient (verification persists state).
    const forbidden = await verify(esVerified, readOnlyToken);
    assert.equal(forbidden.status, 403);

    // Cross-Client evidence is inaccessible.
    const cross = await verify(esCross);
    assert.equal(cross.status, 403);

    // Invalid UUID is rejected without a storage read.
    const invalid = await verify('not-a-uuid');
    assert.equal(invalid.status, 400);

    // Unknown evidence id → 404.
    const missing = await verify(randomUUID());
    assert.equal(missing.status, 404);

    // Denied attempts persisted nothing on the cross-Client row.
    const persisted = await persistedStatus(esCross);
    assert.equal(persisted.last_integrity_status, null);
    assert.equal(persisted.last_integrity_checked_at, null);
  });
});
