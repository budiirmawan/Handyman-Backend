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
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-DOC-CONTROL-01 PART 03 — Retention Policy + Deterministic
 * Application (focused tests).
 *
 * Verifies:
 *   - policy CRUD/read under client_configuration.* with Client isolation,
 *   - Client scope + optional Building scope + validation,
 *   - deterministic specificity precedence (building +4, execution +2,
 *     evidence +1),
 *   - ambiguity (tied top score) = NO policy applied + audit event,
 *   - immutable snapshot on governed evidence (retained_until, policy
 *     identity/frozen days) written at creation on the upload path,
 *   - later policy edits do NOT rewrite governed evidence,
 *   - no matching policy = ungoverned evidence (valid state),
 *   - INACTIVE and out-of-window policies never apply,
 *   - retention hold set/clear with audit,
 *   - retention state foundation defaults (ACTIVE) and DB constraints.
 */

const STORAGE_DIR = resolve(process.env.EVIDENCE_STORAGE_DIR ?? '.data/evidence');

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let adminUserId = '';
let noConfigToken = '';

let clientA = '';
let clientB = '';
let buildingA = '';
let executionA = '';

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

/** Creates an ungoverned evidence row and uploads bytes (the governed path). */
async function createUploadedEvidence(): Promise<string> {
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
  return evidenceId;
}

/** Single-call mobile upload — runs the full creation + application seam. */
async function mobileUpload(): Promise<string> {
  const response = await api()
    .post('/api/v1/mobile/evidence')
    .set({ Authorization: `Bearer ${token}` })
    .field('evidenceType', 'PHOTO')
    .field('executionType', 'CHECKLIST_EXECUTION')
    .field('executionId', executionA)
    .attach('file', Buffer.from(`bytes-${randomUUID()}`), {
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    });
  assert.equal(response.status, 201);
  return (response.body.data.evidenceId ?? response.body.data.id) as string;
}

async function retentionRow(evidenceId: string) {
  const result = await q(
    `SELECT retention_policy_id, retention_policy_code, retention_days_snapshot,
            retention_applied_at, retained_until, retention_state,
            retention_hold, retention_hold_reason, captured_at, created_at
       FROM evidence_submissions WHERE id = $1`,
    [evidenceId],
  );
  return result.rows[0];
}

const policyBody = (overrides: Record<string, unknown> = {}) => ({
  code: `POL_${randomUUID().slice(0, 8).toUpperCase()}`,
  name: 'Retention policy',
  retentionDays: 30,
  effectiveFrom: '2020-01-01T00:00:00.000Z',
  ...overrides,
});

const createPolicy = (clientId: string, body: Record<string, unknown>, bearer = token) =>
  api()
    .post(`/api/v1/clients/${clientId}/evidence-retention-policies`)
    .set({ Authorization: `Bearer ${bearer}` })
    .send(body);

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
  noConfigToken = await createSessionWithPermissions([
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
  buildingA = bA.id;

  // Admin can access ONLY building A (hence only client A).
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: bA.id,
  });

  const template = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `CT_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Checklist A',
    status: 'ACTIVE',
  });
  executionA = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: template,
  });

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

/** Deactivate every policy so tests stay independent. */
async function deactivateAllPolicies(): Promise<void> {
  await q(`UPDATE evidence_retention_policies SET status = 'INACTIVE', updated_at = NOW()`);
}

describe('CR-BE-DOC-CONTROL-01 PART 03 — retention policy administration', () => {
  it('creates, reads, lists and updates a policy under client_configuration permissions', async (t) => {
    if (!requireDatabase(t)) return;

    const body = policyBody({ evidenceType: 'PHOTO', retentionDays: 90 });
    const created = await createPolicy(clientA, body);
    assert.equal(created.status, 201);
    assert.equal(created.body.data.clientId, clientA);
    assert.equal(created.body.data.buildingId, null);
    assert.equal(created.body.data.retentionDays, 90);
    assert.equal(created.body.data.status, 'ACTIVE');

    const policyId = created.body.data.id as string;

    const fetched = await api()
      .get(`/api/v1/evidence-retention-policies/${policyId}`)
      .set(auth());
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.data.code, body.code);

    const listed = await api()
      .get(`/api/v1/clients/${clientA}/evidence-retention-policies`)
      .set(auth());
    assert.equal(listed.status, 200);
    assert.ok(listed.body.data.some((p: { id: string }) => p.id === policyId));

    const updated = await api()
      .patch(`/api/v1/evidence-retention-policies/${policyId}`)
      .set(auth())
      .send({ retentionDays: 120, status: 'INACTIVE' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.retentionDays, 120);
    assert.equal(updated.body.data.status, 'INACTIVE');

    // Policy CRUD is audited.
    const events = await q(
      `SELECT event_type FROM operational_events
        WHERE entity_type = 'EVIDENCE_RETENTION_POLICY' AND entity_id = $1
        ORDER BY occurred_at`,
      [policyId],
    );
    assert.deepEqual(
      events.rows.map((r) => r.event_type),
      ['EVIDENCE_RETENTION_POLICY_CREATED', 'EVIDENCE_RETENTION_POLICY_UPDATED'],
    );
  });

  it('enforces permissions, Client isolation and validation', async (t) => {
    if (!requireDatabase(t)) return;

    // Missing client_configuration.manage.
    const forbidden = await createPolicy(clientA, policyBody(), noConfigToken);
    assert.equal(forbidden.status, 403);

    // Cross-Client (inaccessible client B).
    const cross = await createPolicy(clientB, policyBody());
    assert.equal(cross.status, 403);

    // Invalid values.
    const badDays = await createPolicy(clientA, policyBody({ retentionDays: 0 }));
    assert.equal(badDays.status, 400);
    const badType = await createPolicy(clientA, policyBody({ evidenceType: 'VIDEO' }));
    assert.equal(badType.status, 400);
    const badExecution = await createPolicy(clientA, policyBody({ executionType: 'NOT_A_KIND' }));
    assert.equal(badExecution.status, 400);
    const badWindow = await createPolicy(
      clientA,
      policyBody({ effectiveFrom: '2024-01-02T00:00:00.000Z', effectiveTo: '2024-01-01T00:00:00.000Z' }),
    );
    assert.equal(badWindow.status, 400);

    // Duplicate code within the client → 409.
    const body = policyBody();
    assert.equal((await createPolicy(clientA, body)).status, 201);
    assert.equal((await createPolicy(clientA, body)).status, 409);

    await deactivateAllPolicies();
  });
});

describe('CR-BE-DOC-CONTROL-01 PART 03 — deterministic application + snapshot', () => {
  it('applies the single matching policy and freezes an immutable snapshot', async (t) => {
    if (!requireDatabase(t)) return;
    await deactivateAllPolicies();

    const created = await createPolicy(
      clientA,
      policyBody({ retentionDays: 30, evidenceType: 'PHOTO' }),
    );
    assert.equal(created.status, 201);
    const policyId = created.body.data.id as string;
    const policyCode = created.body.data.code as string;

    const evidenceId = await mobileUpload();
    const row = await retentionRow(evidenceId);
    assert.equal(row.retention_policy_id, policyId);
    assert.equal(row.retention_policy_code, policyCode);
    assert.equal(row.retention_days_snapshot, 30);
    assert.ok(row.retention_applied_at);
    assert.equal(row.retention_state, 'ACTIVE');
    assert.equal(row.retention_hold, false);

    // retained_until = anchor (captured_at ?? created_at) + 30 days.
    const anchor = new Date(row.captured_at ?? row.created_at).getTime();
    const expected = anchor + 30 * 24 * 60 * 60 * 1000;
    assert.equal(new Date(row.retained_until).getTime(), expected);

    // Application is audited.
    const events = await q(
      `SELECT metadata FROM operational_events
        WHERE event_type = 'EVIDENCE_RETENTION_APPLIED' AND entity_id = $1`,
      [evidenceId],
    );
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0].metadata.policyId, policyId);
    assert.equal(events.rows[0].metadata.retentionDays, 30);

    // Later policy edits NEVER rewrite governed history.
    const edited = await api()
      .patch(`/api/v1/evidence-retention-policies/${policyId}`)
      .set(auth())
      .send({ retentionDays: 500 });
    assert.equal(edited.status, 200);
    const after = await retentionRow(evidenceId);
    assert.equal(after.retention_days_snapshot, 30, 'snapshot must stay frozen');
    assert.equal(
      new Date(after.retained_until).getTime(),
      expected,
      'retained_until must stay frozen',
    );

    await deactivateAllPolicies();
  });

  it('resolves precedence deterministically by specificity score', async (t) => {
    if (!requireDatabase(t)) return;
    await deactivateAllPolicies();

    // Client-wide catch-all (specificity 0) vs execution-scoped (2) vs
    // execution+evidence-scoped (3): the most specific must win.
    await createPolicy(clientA, policyBody({ retentionDays: 10 }));
    await createPolicy(
      clientA,
      policyBody({ retentionDays: 20, executionType: 'CHECKLIST_EXECUTION' }),
    );
    const top = await createPolicy(
      clientA,
      policyBody({
        retentionDays: 40,
        executionType: 'CHECKLIST_EXECUTION',
        evidenceType: 'PHOTO',
      }),
    );
    assert.equal(top.status, 201);

    const evidenceId = await mobileUpload();
    const row = await retentionRow(evidenceId);
    assert.equal(row.retention_policy_id, top.body.data.id);
    assert.equal(row.retention_days_snapshot, 40);

    await deactivateAllPolicies();
  });

  it('a tied top score applies NO policy and records an ambiguity event', async (t) => {
    if (!requireDatabase(t)) return;
    await deactivateAllPolicies();

    // Two distinct specificity-1 policies (evidence-scoped) both match.
    const p1 = await createPolicy(clientA, policyBody({ retentionDays: 10, evidenceType: 'PHOTO' }));
    const p2 = await createPolicy(clientA, policyBody({ retentionDays: 99, evidenceType: 'PHOTO' }));
    assert.equal(p1.status, 201);
    assert.equal(p2.status, 201);

    const evidenceId = await mobileUpload();
    const row = await retentionRow(evidenceId);
    assert.equal(row.retention_policy_id, null, 'ambiguity must never guess a policy');
    assert.equal(row.retained_until, null);
    assert.equal(row.retention_state, 'ACTIVE');

    const events = await q(
      `SELECT metadata FROM operational_events
        WHERE event_type = 'EVIDENCE_RETENTION_AMBIGUOUS' AND entity_id = $1`,
      [evidenceId],
    );
    assert.equal(events.rowCount, 1);
    const candidates = events.rows[0].metadata.candidatePolicyIds as string[];
    assert.ok(candidates.includes(p1.body.data.id));
    assert.ok(candidates.includes(p2.body.data.id));

    await deactivateAllPolicies();
  });

  it('no matching, INACTIVE, or out-of-window policy leaves evidence ungoverned', async (t) => {
    if (!requireDatabase(t)) return;
    await deactivateAllPolicies();

    // INACTIVE policy that would otherwise match.
    await createPolicy(clientA, policyBody({ status: 'INACTIVE' }));
    // Effective window entirely in the past.
    await createPolicy(
      clientA,
      policyBody({
        effectiveFrom: '2019-01-01T00:00:00.000Z',
        effectiveTo: '2019-12-31T00:00:00.000Z',
      }),
    );
    // Applicability that does not match (SIGNATURE-only).
    await createPolicy(clientA, policyBody({ evidenceType: 'SIGNATURE' }));

    const evidenceId = await mobileUpload();
    const row = await retentionRow(evidenceId);
    assert.equal(row.retention_policy_id, null);
    assert.equal(row.retained_until, null);
    assert.equal(row.retention_state, 'ACTIVE', 'ungoverned evidence is a valid state');

    // Pre-existing (legacy) evidence is untouched by policy activation —
    // application is prospective only.
    const legacyId = await createUploadedEvidence();
    const legacy = await retentionRow(legacyId);
    assert.equal(legacy.retention_policy_id, null);
    assert.equal(legacy.retained_until, null);

    await deactivateAllPolicies();
  });

  it('building-scoped policies require the hierarchy and never leak across clients', async (t) => {
    if (!requireDatabase(t)) return;
    await deactivateAllPolicies();

    // Building-scoped policy on an accessible building is accepted.
    const scoped = await createPolicy(
      clientA,
      policyBody({ buildingId: buildingA, retentionDays: 15 }),
    );
    assert.equal(scoped.status, 201);
    assert.equal(scoped.body.data.buildingId, buildingA);

    // Checklist executions carry no building — the building-scoped policy
    // must NOT match them (client-wide only).
    const evidenceId = await mobileUpload();
    const row = await retentionRow(evidenceId);
    assert.equal(row.retention_policy_id, null);

    // A policy of client B can never be created by this admin.
    const cross = await createPolicy(clientB, policyBody({ retentionDays: 5 }));
    assert.equal(cross.status, 403);

    await deactivateAllPolicies();
  });
});

describe('CR-BE-DOC-CONTROL-01 PART 03 — retention hold + state foundation', () => {
  it('sets and clears a retention hold with audit', async (t) => {
    if (!requireDatabase(t)) return;

    const evidenceId = await createUploadedEvidence();

    // Reason is required.
    const missingReason = await api()
      .post(`/api/v1/evidence/${evidenceId}/retention-hold`)
      .set(auth())
      .send({});
    assert.equal(missingReason.status, 400);

    const set = await api()
      .post(`/api/v1/evidence/${evidenceId}/retention-hold`)
      .set(auth())
      .send({ reason: 'Litigation hold — incident #42' });
    assert.equal(set.status, 200);

    let row = await retentionRow(evidenceId);
    assert.equal(row.retention_hold, true);
    assert.equal(row.retention_hold_reason, 'Litigation hold — incident #42');

    // Double set is rejected.
    const again = await api()
      .post(`/api/v1/evidence/${evidenceId}/retention-hold`)
      .set(auth())
      .send({ reason: 'again' });
    assert.equal(again.status, 400);

    const cleared = await api()
      .delete(`/api/v1/evidence/${evidenceId}/retention-hold`)
      .set(auth());
    assert.equal(cleared.status, 200);

    row = await retentionRow(evidenceId);
    assert.equal(row.retention_hold, false);
    assert.equal(row.retention_hold_reason, null);

    // Clear without hold is rejected.
    const clearAgain = await api()
      .delete(`/api/v1/evidence/${evidenceId}/retention-hold`)
      .set(auth());
    assert.equal(clearAgain.status, 400);

    const events = await q(
      `SELECT event_type FROM operational_events
        WHERE entity_id = $1
          AND event_type IN ('EVIDENCE_RETENTION_HOLD_SET', 'EVIDENCE_RETENTION_HOLD_CLEARED')
        ORDER BY occurred_at`,
      [evidenceId],
    );
    assert.deepEqual(
      events.rows.map((r) => r.event_type),
      ['EVIDENCE_RETENTION_HOLD_SET', 'EVIDENCE_RETENTION_HOLD_CLEARED'],
    );

    // Hold requires evidence.manage.
    const forbidden = await api()
      .post(`/api/v1/evidence/${evidenceId}/retention-hold`)
      .set({ Authorization: `Bearer ${noConfigToken}` })
      .send({ reason: 'nope' });
    assert.equal(forbidden.status, 403);
  });

  it('database constraints protect snapshot, state and hold consistency', async (t) => {
    if (!requireDatabase(t)) return;

    const evidenceId = await createUploadedEvidence();

    // Partial snapshot is impossible.
    await assert.rejects(
      q(`UPDATE evidence_submissions SET retained_until = NOW() WHERE id = $1`, [evidenceId]),
      /evidence_retention_snapshot_consistency/,
    );
    // Unknown retention state is impossible.
    await assert.rejects(
      q(`UPDATE evidence_submissions SET retention_state = 'DELETED' WHERE id = $1`, [evidenceId]),
      /evidence_retention_state_check/,
    );
    // Non-ACTIVE state without governance is impossible.
    await assert.rejects(
      q(`UPDATE evidence_submissions SET retention_state = 'RETENTION_DUE' WHERE id = $1`, [
        evidenceId,
      ]),
      /evidence_retention_state_governed_check/,
    );
    // Hold flag without reason is impossible.
    await assert.rejects(
      q(`UPDATE evidence_submissions SET retention_hold = true WHERE id = $1`, [evidenceId]),
      /evidence_retention_hold_consistency/,
    );
  });
});
