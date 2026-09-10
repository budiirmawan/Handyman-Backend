import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { processDueEvidenceRetention } from '../src/modules/evidence-retention-policies';
import { processDueOperationalJobs } from '../src/modules/due-job-dispatcher';
import { createEvidenceStorage } from '../src/modules/evidence/storage';
import type { EvidenceStorage } from '../src/modules/evidence/storage';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-DOC-CONTROL-01 PART 04 — Retention Lifecycle + Due Execution
 * (focused tests).
 *
 * Verifies:
 *   - governed due selection: ACTIVE → RETENTION_DUE only when
 *     retained_until elapsed; ungoverned evidence never selected,
 *   - purge: binary removed through the storage abstraction, row survives
 *     as a PURGED tombstone (hash/metadata/snapshot retained, purged_at set),
 *   - existing FKs into purged evidence stay intact,
 *   - hold blocks purge (EVIDENCE_PURGE_HELD once per hold, not per tick);
 *     clearing the hold lets the next pass purge,
 *   - purge failure: row stays RETENTION_DUE, EVIDENCE_PURGE_FAILED,
 *     natural retry succeeds later,
 *   - idempotency: a second pass marks/purges nothing new,
 *   - dispatcher integration: additive `evidenceRetention` result key,
 *   - governed events: EVIDENCE_RETENTION_DUE / EVIDENCE_PURGED,
 *   - purged tombstones reject re-upload and integrity verification,
 *     and content download reports not-found.
 */

const STORAGE_DIR = resolve(process.env.EVIDENCE_STORAGE_DIR ?? '.data/evidence');

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let adminUserId = '';

let clientA = '';
let executionA = '';
let policyId = '';

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

const auth = () => ({ Authorization: `Bearer ${token}` });

/** Uploads governed evidence, then backdates retained_until into the past. */
async function createGovernedDueEvidence(): Promise<string> {
  const response = await api()
    .post('/api/v1/mobile/evidence')
    .set(auth())
    .field('evidenceType', 'PHOTO')
    .field('executionType', 'CHECKLIST_EXECUTION')
    .field('executionId', executionA)
    .attach('file', Buffer.from(`retained-bytes-${randomUUID()}`), {
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    });
  assert.equal(response.status, 201);
  const evidenceId = (response.body.data.evidenceId ?? response.body.data.id) as string;
  const governed = await q(
    `SELECT retention_policy_id FROM evidence_submissions WHERE id = $1`,
    [evidenceId],
  );
  assert.equal(governed.rows[0].retention_policy_id, policyId, 'evidence must be governed');
  await q(
    `UPDATE evidence_submissions SET retained_until = NOW() - INTERVAL '1 day' WHERE id = $1`,
    [evidenceId],
  );
  return evidenceId;
}

async function retentionRow(evidenceId: string) {
  const result = await q(
    `SELECT retention_state, retention_hold, purged_at, retained_until,
            content_sha256, file_size, mime_type, original_file_name,
            file_reference, retention_policy_id, retention_policy_code,
            retention_days_snapshot, status
       FROM evidence_submissions WHERE id = $1`,
    [evidenceId],
  );
  return result.rows[0];
}

const storedFilePath = (evidenceId: string) => resolve(STORAGE_DIR, 'evidence', evidenceId);

async function eventsFor(evidenceId: string, types: string[]) {
  const result = await q(
    `SELECT event_type FROM operational_events
      WHERE entity_type = 'EVIDENCE_SUBMISSION' AND entity_id = $1
        AND event_type = ANY($2::text[])
      ORDER BY occurred_at, created_at`,
    [evidenceId, types],
  );
  return result.rows.map((r) => r.event_type as string);
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
      evidence_requirements, evidence_submissions, evidence_retention_policies,
      operational_events
     CASCADE`,
  );

  const admin = await createAdminUser();
  token = admin.token;
  adminUserId = admin.userId;

  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Retention Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Retention Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Retention Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  clientA = client.id;

  const template = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `CT_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Retention Checklist',
    status: 'ACTIVE',
  });
  executionA = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: template,
  });

  // One governing client-wide policy for all uploads in this suite.
  const created = await api()
    .post(`/api/v1/clients/${clientA}/evidence-retention-policies`)
    .set({ Authorization: `Bearer ${admin.token}` })
    .send({
      code: `RET_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Suite retention policy',
      retentionDays: 30,
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
  assert.equal(created.status, 201);
  policyId = created.body.data.id as string;

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

describe('CR-BE-DOC-CONTROL-01 PART 04 — retention lifecycle + due execution', () => {
  it('marks due governed evidence, purges the binary, and leaves a tombstone row', async (t) => {
    if (!requireDatabase(t)) return;

    const evidenceId = await createGovernedDueEvidence();
    const beforeRow = await retentionRow(evidenceId);
    assert.equal(beforeRow.retention_state, 'ACTIVE');
    assert.ok(existsSync(storedFilePath(evidenceId)), 'binary must exist before purge');

    const result = await processDueEvidenceRetention();
    assert.ok(result.dueMarked >= 1);
    assert.ok(result.purged >= 1);
    assert.equal(result.failures, 0);

    const row = await retentionRow(evidenceId);
    // Tombstone: state + purged_at set, everything else preserved.
    assert.equal(row.retention_state, 'PURGED');
    assert.ok(row.purged_at);
    assert.equal(row.content_sha256, beforeRow.content_sha256);
    assert.equal(row.file_size, beforeRow.file_size);
    assert.equal(row.mime_type, beforeRow.mime_type);
    assert.equal(row.original_file_name, beforeRow.original_file_name);
    assert.equal(row.file_reference, beforeRow.file_reference);
    assert.equal(row.retention_policy_id, policyId);
    assert.equal(row.retention_days_snapshot, 30);
    assert.equal(row.status, 'ACTIVE', 'BE-07 status is untouched by retention');

    // Binary disposed through the storage abstraction.
    assert.ok(!existsSync(storedFilePath(evidenceId)), 'binary must be removed');

    // Governed events in order.
    const events = await eventsFor(evidenceId, ['EVIDENCE_RETENTION_DUE', 'EVIDENCE_PURGED']);
    assert.deepEqual(events, ['EVIDENCE_RETENTION_DUE', 'EVIDENCE_PURGED']);

    // Purged tombstone behavior on existing surfaces.
    const metadata = await api().get(`/api/v1/evidence/${evidenceId}/file`).set(auth());
    assert.equal(metadata.status, 200, 'tombstone metadata stays readable');
    const content = await api().get(`/api/v1/evidence/${evidenceId}/file/content`).set(auth());
    assert.equal(content.status, 404, 'purged content is gone');
    const reupload = await api()
      .post(`/api/v1/evidence/${evidenceId}/file`)
      .set(auth())
      .attach('file', Buffer.from('x'), { filename: 'x.jpg', contentType: 'image/jpeg' });
    assert.equal(reupload.status, 400, 'a purged tombstone can never regain a file');
    const verify = await api()
      .post(`/api/v1/evidence/${evidenceId}/integrity-verification`)
      .set(auth());
    assert.equal(verify.status, 400, 'purged evidence is not integrity-verifiable');
    const hold = await api()
      .post(`/api/v1/evidence/${evidenceId}/retention-hold`)
      .set(auth())
      .send({ reason: 'too late' });
    assert.equal(hold.status, 400, 'purged evidence cannot be placed on hold');
  });

  it('never selects ungoverned evidence and is idempotent across passes', async (t) => {
    if (!requireDatabase(t)) return;

    // Ungoverned legacy-style row (no snapshot).
    const legacyId = await insertRow('evidence_submissions', {
      client_id: clientA,
      execution_type: 'CHECKLIST_EXECUTION',
      execution_id: executionA,
      evidence_type: 'PHOTO',
      file_reference: `external-ref-${randomUUID()}`,
      original_file_name: 'legacy.jpg',
      mime_type: 'image/jpeg',
      file_size: 0,
    });
    // Governed but not yet due.
    const futureId = await createGovernedDueEvidence();
    await q(
      `UPDATE evidence_submissions SET retained_until = NOW() + INTERVAL '10 days' WHERE id = $1`,
      [futureId],
    );

    const first = await processDueEvidenceRetention();
    const second = await processDueEvidenceRetention();
    assert.equal(second.dueMarked, 0, 'second pass must mark nothing new');
    assert.equal(second.purged, 0, 'second pass must purge nothing new');
    assert.equal(second.failures, 0);

    assert.equal((await retentionRow(legacyId)).retention_state, 'ACTIVE');
    assert.equal((await retentionRow(futureId)).retention_state, 'ACTIVE');
    // Cleanup: purge the future row later in other tests is not needed.
    void first;
  });

  it('hold blocks purge (event once per hold) and clearing the hold releases it', async (t) => {
    if (!requireDatabase(t)) return;

    const evidenceId = await createGovernedDueEvidence();
    const held = await api()
      .post(`/api/v1/evidence/${evidenceId}/retention-hold`)
      .set(auth())
      .send({ reason: 'Litigation hold' });
    assert.equal(held.status, 200);

    // Two passes: due marking happens (due-ness is a fact), purge is blocked.
    const first = await processDueEvidenceRetention();
    assert.ok(first.dueMarked >= 1);
    assert.ok(first.held >= 1);
    const second = await processDueEvidenceRetention();
    assert.ok(second.held >= 1);

    let row = await retentionRow(evidenceId);
    assert.equal(row.retention_state, 'RETENTION_DUE');
    assert.ok(existsSync(storedFilePath(evidenceId)), 'held binary must survive');

    // EVIDENCE_PURGE_HELD recorded once per hold, not per tick.
    const heldEvents = await eventsFor(evidenceId, ['EVIDENCE_PURGE_HELD']);
    assert.equal(heldEvents.length, 1);

    // Clearing the hold lets the next pass purge.
    const cleared = await api()
      .delete(`/api/v1/evidence/${evidenceId}/retention-hold`)
      .set(auth());
    assert.equal(cleared.status, 200);

    const third = await processDueEvidenceRetention();
    assert.ok(third.purged >= 1);
    row = await retentionRow(evidenceId);
    assert.equal(row.retention_state, 'PURGED');
    assert.ok(!existsSync(storedFilePath(evidenceId)));
  });

  it('isolates purge failures, keeps the row RETENTION_DUE, and retries successfully', async (t) => {
    if (!requireDatabase(t)) return;

    const evidenceId = await createGovernedDueEvidence();

    const real = createEvidenceStorage();
    const failingStorage: EvidenceStorage = {
      put: (key, input) => real.put(key, input),
      get: (key) => real.get(key),
      remove: async () => {
        throw new Error('storage backend unavailable');
      },
    };

    const failed = await processDueEvidenceRetention(new Date(), failingStorage);
    assert.ok(failed.dueMarked >= 1);
    assert.ok(failed.failures >= 1);
    assert.equal(failed.purged, 0);

    let row = await retentionRow(evidenceId);
    assert.equal(row.retention_state, 'RETENTION_DUE', 'failed purge must not tombstone');
    assert.equal(row.purged_at, null);
    assert.ok(existsSync(storedFilePath(evidenceId)), 'binary must survive a failed purge');

    const failEvents = await eventsFor(evidenceId, ['EVIDENCE_PURGE_FAILED']);
    assert.equal(failEvents.length, 1);

    // Natural retry with healthy storage succeeds.
    const retried = await processDueEvidenceRetention();
    assert.ok(retried.purged >= 1);
    row = await retentionRow(evidenceId);
    assert.equal(row.retention_state, 'PURGED');
    assert.ok(!existsSync(storedFilePath(evidenceId)));
  });

  it('preserves FK references into purged evidence', async (t) => {
    if (!requireDatabase(t)) return;

    const evidenceId = await createGovernedDueEvidence();

    // Simulate the existing FK consumer (utility_meter_ocr_candidates,
    // migration 0281: evidence_id REFERENCES evidence_submissions) via
    // direct inserts against the real constraint chain.
    const buildingId = (await q(`SELECT id FROM buildings LIMIT 1`)).rows[0].id;
    const uomId = await insertRow('units_of_measure', {
      client_id: clientA,
      code: `UOM_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Kilowatt hour',
      symbol: 'kWh',
      category: 'ENERGY',
      status: 'ACTIVE',
    });
    const meterId = await insertRow('utility_meters', {
      client_id: clientA,
      building_id: buildingId,
      uom_id: uomId,
      code: `MTR_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Meter',
      utility_type: 'ELECTRICITY',
      status: 'ACTIVE',
    });
    const candidateId = await insertRow('utility_meter_ocr_candidates', {
      client_id: clientA,
      building_id: buildingId,
      meter_id: meterId,
      evidence_id: evidenceId,
      candidate_reading_value: 42,
      status: 'PENDING_REVIEW',
      created_by_user_id: adminUserId,
    });

    const result = await processDueEvidenceRetention();
    assert.ok(result.purged >= 1);
    assert.equal((await retentionRow(evidenceId)).retention_state, 'PURGED');

    // The FK consumer still resolves its evidence row (tombstone).
    const joined = await q(
      `SELECT es.retention_state FROM utility_meter_ocr_candidates c
        JOIN evidence_submissions es ON es.id = c.evidence_id
       WHERE c.id = $1`,
      [candidateId],
    );
    assert.equal(joined.rows[0].retention_state, 'PURGED');
  });

  it('runs as an additive dispatcher domain', async (t) => {
    if (!requireDatabase(t)) return;

    const evidenceId = await createGovernedDueEvidence();
    const result = await processDueOperationalJobs(new Date());

    assert.ok(result.evidenceRetention, 'dispatcher must expose the retention domain');
    assert.ok(result.evidenceRetention.dueMarked >= 1);
    assert.ok(result.evidenceRetention.purged >= 1);
    assert.equal(result.evidenceRetention.failures, 0);
    // Earlier domains keep reporting.
    assert.ok(result.reminders);
    assert.ok(result.outboundDeliveries);

    assert.equal((await retentionRow(evidenceId)).retention_state, 'PURGED');
  });
});
