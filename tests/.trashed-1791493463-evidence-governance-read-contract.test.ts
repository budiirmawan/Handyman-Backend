import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import YAML from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { processDueEvidenceRetention } from '../src/modules/evidence-retention-policies';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-DOC-CONTROL-01 PART 05 — Read API + OpenAPI + Governance Closure
 * (focused tests).
 *
 * Verifies:
 *   - evidence read payloads expose the additive integrity + retention
 *     fields on the metadata endpoints (upload response, GET file metadata,
 *     GET /evidence/:id),
 *   - legacy/unhashed + ungoverned evidence reads null integrity fields,
 *     retentionState ACTIVE and retentionHold false (additive defaults),
 *   - purged tombstone reads: metadata 200 with retentionState PURGED +
 *     purgedAt + preserved hash, content 404,
 *   - OpenAPI documents the new fields, schemas and paths, and every
 *     documented new operation matches the runtime surface.
 */

const STORAGE_DIR = resolve(process.env.EVIDENCE_STORAGE_DIR ?? '.data/evidence');
const OPENAPI_PATH = resolve(__dirname, '../docs/api/openapi.yaml');

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
const sha256hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const GOVERNANCE_FIELDS = [
  'contentSha256',
  'contentHashedAt',
  'hashAlgorithm',
  'lastIntegrityStatus',
  'lastIntegrityCheckedAt',
  'retentionPolicyId',
  'retentionPolicyCode',
  'retentionDaysSnapshot',
  'retentionAppliedAt',
  'retainedUntil',
  'retentionState',
  'retentionHold',
  'retentionHoldReason',
  'purgedAt',
] as const;

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
    name: 'Read Contract Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Read Contract Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Read Contract Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  clientA = client.id;

  const template = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `CT_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Read Contract Checklist',
    status: 'ACTIVE',
  });
  executionA = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: template,
  });

  const created = await api()
    .post(`/api/v1/clients/${clientA}/evidence-retention-policies`)
    .set({ Authorization: `Bearer ${admin.token}` })
    .send({
      code: `READ_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Read contract retention policy',
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

describe('CR-BE-DOC-CONTROL-01 PART 05 — evidence governance read contract', () => {
  it('exposes integrity + retention fields on governed uploaded evidence reads', async (t) => {
    if (!requireDatabase(t)) return;

    const evidenceId = await insertRow('evidence_submissions', {
      client_id: clientA,
      execution_type: 'CHECKLIST_EXECUTION',
      execution_id: executionA,
      evidence_type: 'PHOTO',
      file_reference: `external-ref-${randomUUID()}`,
      original_file_name: 'placeholder.jpg',
      mime_type: 'image/jpeg',
      file_size: 0,
    });

    const bytes = Buffer.from('read-contract-photo-bytes');
    const upload = await api()
      .post(`/api/v1/evidence/${evidenceId}/file`)
      .set(auth())
      .attach('file', bytes, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    assert.equal(upload.status, 201);

    // The upload response already carries the additive fields.
    for (const field of GOVERNANCE_FIELDS) {
      assert.ok(field in upload.body.data, `upload payload must expose ${field}`);
    }
    assert.equal(upload.body.data.contentSha256, sha256hex(bytes));
    assert.equal(upload.body.data.hashAlgorithm, 'SHA-256');
    assert.ok(upload.body.data.contentHashedAt);
    assert.equal(upload.body.data.retentionState, 'ACTIVE');
    assert.equal(upload.body.data.retentionHold, false);
    assert.equal(upload.body.data.purgedAt, null);

    // GET metadata + shared BE-07 read agree (single mapper).
    const metadata = await api().get(`/api/v1/evidence/${evidenceId}/file`).set(auth());
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.data.contentSha256, sha256hex(bytes));
    const be07 = await api().get(`/api/v1/evidence/${evidenceId}`).set(auth());
    assert.equal(be07.status, 200);
    assert.equal(be07.body.data.contentSha256, sha256hex(bytes));
    assert.equal(be07.body.data.retentionState, 'ACTIVE');

    // Verification outcome becomes readable.
    const verify = await api()
      .post(`/api/v1/evidence/${evidenceId}/integrity-verification`)
      .set(auth());
    assert.equal(verify.status, 200);
    assert.equal(verify.body.data.outcome, 'VERIFIED');
    const afterVerify = await api().get(`/api/v1/evidence/${evidenceId}/file`).set(auth());
    assert.equal(afterVerify.body.data.lastIntegrityStatus, 'VERIFIED');
    assert.ok(afterVerify.body.data.lastIntegrityCheckedAt);
  });

  it('reads legacy/ungoverned evidence with additive null defaults', async (t) => {
    if (!requireDatabase(t)) return;

    // Deactivate the policy so this row stays ungoverned.
    await q(`UPDATE evidence_retention_policies SET status = 'INACTIVE' WHERE id = $1`, [policyId]);
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
    await q(`UPDATE evidence_retention_policies SET status = 'ACTIVE' WHERE id = $1`, [policyId]);

    const read = await api().get(`/api/v1/evidence/${legacyId}/file`).set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.contentSha256, null);
    assert.equal(read.body.data.hashAlgorithm, null);
    assert.equal(read.body.data.lastIntegrityStatus, null);
    assert.equal(read.body.data.retentionPolicyId, null);
    assert.equal(read.body.data.retainedUntil, null);
    assert.equal(read.body.data.retentionState, 'ACTIVE');
    assert.equal(read.body.data.retentionHold, false);
    assert.equal(read.body.data.purgedAt, null);
  });

  it('reads a PURGED tombstone: metadata 200 with preserved hash, content 404', async (t) => {
    if (!requireDatabase(t)) return;

    const upload = await api()
      .post('/api/v1/mobile/evidence')
      .set(auth())
      .field('evidenceType', 'PHOTO')
      .field('executionType', 'CHECKLIST_EXECUTION')
      .field('executionId', executionA)
      .attach('file', Buffer.from('tombstone-read-bytes'), {
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      });
    assert.equal(upload.status, 201);
    const evidenceId = (upload.body.data.evidenceId ?? upload.body.data.id) as string;

    await q(
      `UPDATE evidence_submissions SET retained_until = NOW() - INTERVAL '1 day' WHERE id = $1`,
      [evidenceId],
    );
    const result = await processDueEvidenceRetention();
    assert.ok(result.purged >= 1);

    const metadata = await api().get(`/api/v1/evidence/${evidenceId}/file`).set(auth());
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.data.retentionState, 'PURGED');
    assert.ok(metadata.body.data.purgedAt);
    assert.equal(
      metadata.body.data.contentSha256,
      sha256hex(Buffer.from('tombstone-read-bytes')),
      'tombstone keeps the upload-time hash',
    );
    assert.equal(metadata.body.data.status, 'ACTIVE', 'BE-07 status is not retention state');

    const content = await api()
      .get(`/api/v1/evidence/${evidenceId}/file/content`)
      .set(auth());
    assert.equal(content.status, 404);
  });

  it('OpenAPI documents the governance fields, schemas and paths aligned with runtime', async () => {
    const spec = YAML.parse(readFileSync(OPENAPI_PATH, 'utf8'), { maxAliasCount: -1 });

    // Additive fields on the evidence metadata schema.
    const properties = spec.components.schemas.EvidenceFileMetadata.properties;
    for (const field of GOVERNANCE_FIELDS) {
      assert.ok(properties[field], `OpenAPI EvidenceFileMetadata must document ${field}`);
    }
    assert.deepEqual(properties.retentionState.enum, ['ACTIVE', 'RETENTION_DUE', 'PURGED']);
    assert.deepEqual(properties.lastIntegrityStatus.enum, [
      'VERIFIED',
      'MISMATCH',
      'NOT_HASHED',
      'FILE_UNAVAILABLE',
    ]);

    // New schemas.
    for (const schema of [
      'EvidenceIntegrityVerification',
      'EvidenceRetentionPolicy',
      'EvidenceRetentionPolicyCreateRequest',
      'EvidenceRetentionPolicyUpdateRequest',
    ]) {
      assert.ok(spec.components.schemas[schema], `OpenAPI must define ${schema}`);
    }
    assert.deepEqual(spec.components.schemas.EvidenceIntegrityVerification.properties.outcome.enum, [
      'VERIFIED',
      'MISMATCH',
      'NOT_HASHED',
      'FILE_UNAVAILABLE',
    ]);

    // New paths and their methods match the runtime routers exactly.
    assert.deepEqual(
      Object.keys(spec.paths['/evidence/{evidenceId}/integrity-verification']),
      ['post'],
    );
    assert.deepEqual(
      Object.keys(spec.paths['/evidence/{evidenceId}/retention-hold']).sort(),
      ['delete', 'post'],
    );
    assert.deepEqual(
      Object.keys(spec.paths['/clients/{clientId}/evidence-retention-policies']).sort(),
      ['get', 'post'],
    );
    assert.deepEqual(
      Object.keys(spec.paths['/evidence-retention-policies/{id}']).sort(),
      ['get', 'patch'],
    );

    // Verification accepts no request body — no manual/trusted hash input.
    assert.equal(
      spec.paths['/evidence/{evidenceId}/integrity-verification'].post.requestBody,
      undefined,
    );

    // Tombstone semantics are documented on the content endpoint.
    const contentDescription: string =
      spec.paths['/evidence/{evidenceId}/file/content'].get.description;
    assert.match(contentDescription, /PURGED/);
  });

  it('OpenAPI new operations resolve against the live router', async (t) => {
    if (!requireDatabase(t)) return;

    // Unauthenticated probes must hit the route (401), not a 404 —
    // documented paths exist in the runtime.
    const probes: Array<[string, string]> = [
      ['post', `/api/v1/evidence/${randomUUID()}/integrity-verification`],
      ['post', `/api/v1/evidence/${randomUUID()}/retention-hold`],
      ['delete', `/api/v1/evidence/${randomUUID()}/retention-hold`],
      ['post', `/api/v1/clients/${randomUUID()}/evidence-retention-policies`],
      ['get', `/api/v1/clients/${randomUUID()}/evidence-retention-policies`],
      ['get', `/api/v1/evidence-retention-policies/${randomUUID()}`],
      ['patch', `/api/v1/evidence-retention-policies/${randomUUID()}`],
    ];
    for (const [method, path] of probes) {
      const response = await (api() as any)[method](path);
      assert.equal(response.status, 401, `${method.toUpperCase()} ${path} must be a live route`);
    }
  });
});
