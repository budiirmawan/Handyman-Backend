import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { REVIEW_TARGET_UNION } from '../src/database/migrations/0213_restore_review_target_union';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { correctiveActionVerificationRepository } from '../src/modules/corrective-action-verifications';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-21J — Corrective Action Verification.
 *
 * Focused validation only: the three decisions, non-reviewable context,
 * unauthorized reviewer, final-decision protection, RBAC, and Client/Building
 * isolation.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE reviews, corrective_action_responsibilities,
    corrective_actions, immediate_actions,
    finding_escalation_incidents, asset_failure_incidents,
    operational_incidents, incidents, operational_events, buildings,
    properties, users, roles, permissions, clients CASCADE`);
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

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function structure(options: { client?: PublicClient; assign?: boolean } = {}) {
  const client = options.client ?? await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Verification Client',
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
  if (options.assign !== false) {
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: building.id,
    });
  }
  return { client, building };
}

async function incident(buildingId: string, value = token) {
  const response = await api()
    .post('/api/v1/incidents')
    .set(auth(value))
    .send({
      buildingId,
      incidentNumber: `INC_${suffix()}`,
      incidentType: 'OPERATIONAL',
      title: 'Recurring pump seal failure',
    });
  assert.equal(response.status, 201);
  return response.body.data;
}

async function fixture(options: Parameters<typeof structure>[0] = {}) {
  const context = await structure(options);
  const parent = await incident(context.building.id);
  return { ...context, incident: parent };
}

const act = (id: string, verb: string, payload: unknown = {}, value = token) =>
  api()
    .post(`/api/v1/corrective-actions/${id}/${verb}`)
    .set(auth(value))
    .send(payload);

const readAction = (id: string, value = token) =>
  api().get(`/api/v1/corrective-actions/${id}`).set(auth(value));

const context = (id: string, value = token) =>
  api().get(`/api/v1/corrective-actions/${id}/verification`).set(auth(value));

const open = (id: string, payload: unknown = {}, value = token) =>
  api()
    .post(`/api/v1/corrective-actions/${id}/verification`)
    .set(auth(value))
    .send(payload);

const decide = (id: string, payload: unknown, value = token) =>
  api()
    .post(`/api/v1/corrective-actions/${id}/verification/decision`)
    .set(auth(value))
    .send(payload);

const latest = (id: string, value = token) =>
  api()
    .get(`/api/v1/corrective-actions/${id}/verification/latest`)
    .set(auth(value));

const history = (id: string, value = token) =>
  api()
    .get(`/api/v1/corrective-actions/${id}/verification/history`)
    .set(auth(value));

/** A corrective action created by `token`, left in PROPOSED. */
async function proposed(incidentId: string) {
  const created = await api()
    .post('/api/v1/corrective-actions')
    .set(auth())
    .send({
      incidentId,
      actionType: 'REPLACEMENT',
      description: 'Replace the pump seal with the upgraded specification.',
    });
  assert.equal(created.status, 201);
  return created.body.data.id as string;
}

/**
 * A corrective action driven to COMPLETED — the only verifiable state.
 *
 * `completer` does the work so that the default actor stays independent and
 * may verify it. Verification requires a second person by design.
 */
async function completedAction(incidentId: string, completerToken: string) {
  const id = await proposed(incidentId);
  assert.equal((await act(id, 'approve', {}, completerToken)).status, 200);
  assert.equal((await act(id, 'start', {}, completerToken)).status, 200);
  assert.equal(
    (await act(id, 'complete', { completionNotes: 'Seal replaced.' }, completerToken)).status,
    200,
  );
  return id;
}

/** A second admin assigned to the same Building, to act as the doer. */
async function doer(buildingId: string) {
  const admin = await createAdminUser();
  await buildingAssignmentService.createAssignment(admin.userId, { buildingId });
  return admin;
}

describe('BE-21J — reuses the shared review primitive', () => {
  it('stores verifications in the shared reviews table, not a new one', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);

    assert.equal((await open(id)).status, 201);

    // The verification IS a row in the BE-07 reviews table.
    const row = await pool!.query(
      `SELECT target_type, target_id, reviewer_user_id, status, decision
       FROM reviews WHERE target_id = $1`,
      [id],
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].target_type, 'CORRECTIVE_ACTION');
    assert.equal(row.rows[0].reviewer_user_id, userId);
    assert.equal(row.rows[0].status, 'PENDING');
    assert.equal(row.rows[0].decision, null);

    // No parallel verification engine was introduced.
    const tables = await pool!.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND (table_name LIKE '%corrective_action_verif%'
              OR table_name LIKE '%incident_verif%'
              OR table_name LIKE '%incident_review%')`,
    );
    assert.equal(tables.rowCount, 0);
  });

  it('adds CORRECTIVE_ACTION to the target union without removing any', async (t) => {
    if (!ready(t)) return;
    const { client } = await structure();

    // The 0213 forward rule: ADD to the union, never restate a subset.
    for (const targetType of [...REVIEW_TARGET_UNION, 'CORRECTIVE_ACTION']) {
      const inserted = await pool!.query(
        `INSERT INTO reviews
           (id, client_id, target_type, target_id, reviewer_user_id, status)
         VALUES ($1, $2, $3, $4, $5, 'PENDING')
         RETURNING target_type`,
        [randomUUID(), client.id, targetType, randomUUID(), userId],
      );
      assert.equal(inserted.rows[0].target_type, targetType);
    }

    // FINDING in particular must survive — the 0163 regression.
    const definition = await pool!.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE conname = 'review_target'`,
    );
    assert.ok(definition.rows[0].definition.includes("'FINDING'"));
    assert.ok(definition.rows[0].definition.includes("'CORRECTIVE_ACTION'"));
    // BE-21K has not happened yet.
    assert.ok(!definition.rows[0].definition.includes("'INCIDENT'"));
  });

  it('reuses the shared decision vocabulary', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);
    assert.equal((await open(id)).status, 201);

    const invalid = await decide(id, { decision: 'LOOKS_FINE' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.details[0].field, 'decision');
    // The message enumerates the shared vocabulary.
    assert.match(invalid.body.error.details[0].message, /APPROVED/);
    assert.match(invalid.body.error.details[0].message, /REWORK_REQUIRED/);

    assert.equal((await decide(id, {})).status, 400);
  });
});

describe('BE-21J — APPROVED', () => {
  it('verifies the corrective action and records the decision', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);

    const opened = await open(id, { notes: 'Scheduled for site check.' });
    assert.equal(opened.status, 201);
    assert.equal(opened.body.data.status, 'PENDING');
    assert.equal(opened.body.data.reviewerUserId, userId);

    const response = await decide(id, {
      decision: 'APPROVED',
      notes: 'Seal holding under pressure test.',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.verification.decision, 'APPROVED');
    assert.equal(response.body.data.verification.status, 'COMPLETED');
    assert.ok(response.body.data.verification.reviewedAt);
    // The BACKEND applies the lifecycle outcome.
    assert.equal(response.body.data.correctiveActionStatus, 'VERIFIED');

    const action = await readAction(id);
    assert.equal(action.body.data.status, 'VERIFIED');
    assert.equal(action.body.data.verifiedByUserId, userId);
    assert.ok(action.body.data.verifiedAt);
    // Completion metadata survives verification — a verified action WAS
    // completed, and the CHECK constraint requires it to still say so.
    assert.equal(action.body.data.completedByUserId, worker.userId);
    assert.ok(action.body.data.completedAt);
    // VERIFIED is terminal in this PART; closure is BE-21K.
    assert.deepEqual(action.body.data.availableActions, []);

    const events = await pool!.query(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'CORRECTIVE_ACTION' AND entity_id = $1
         AND event_type LIKE '%VERIF%'
       ORDER BY occurred_at ASC, id ASC`,
      [id],
    );
    assert.deepEqual(
      events.rows.map((row) => row.event_type),
      [
        'CORRECTIVE_ACTION_VERIFICATION_OPENED',
        'CORRECTIVE_ACTION_VERIFICATION_SUBMITTED',
        'CORRECTIVE_ACTION_VERIFIED',
      ],
    );
  });
});

describe('BE-21J — REJECTED', () => {
  it('records the failed check without moving the action', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);
    assert.equal((await open(id)).status, 201);

    const response = await decide(id, {
      decision: 'REJECTED',
      notes: 'Wrong seal specification fitted.',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.verification.decision, 'REJECTED');
    // REJECTED records that THIS check failed; it does not assert the remedy
    // can be redone. That judgement is REWORK_REQUIRED.
    assert.equal(response.body.data.correctiveActionStatus, 'COMPLETED');

    const action = await readAction(id);
    assert.equal(action.body.data.status, 'COMPLETED');
    assert.equal(action.body.data.verifiedAt, null);
    assert.equal(action.body.data.verifiedByUserId, null);

    // The result is recorded and final.
    const result = await latest(id);
    assert.equal(result.body.data.decision, 'REJECTED');
    assert.equal((await context(id)).body.data.finalized, false);
  });
});

describe('BE-21J — REWORK_REQUIRED', () => {
  it('returns the action to IN_PROGRESS and withdraws the completion claim', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);
    assert.equal((await open(id)).status, 201);

    const response = await decide(id, {
      decision: 'REWORK_REQUIRED',
      notes: 'Redo with the upgraded seal.',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.correctiveActionStatus, 'IN_PROGRESS');

    const action = await readAction(id);
    assert.equal(action.body.data.status, 'IN_PROGRESS');
    // The completion claim has been withdrawn, so its metadata is cleared —
    // leaving a stale completedAt would misreport when the work finished.
    assert.equal(action.body.data.completedAt, null);
    assert.equal(action.body.data.completedByUserId, null);
    // Approval metadata survives: the remedy is still an approved plan.
    assert.equal(action.body.data.approvedByUserId, worker.userId);
    // Back in flight, so the action is editable and re-completable again.
    assert.ok(action.body.data.availableActions.includes('COMPLETE'));
    assert.ok(action.body.data.availableActions.includes('UPDATE_DETAILS'));

    // Nothing is lost: the rework decision is preserved in the history.
    const past = await history(id);
    assert.equal(past.body.data.length, 1);
    assert.equal(past.body.data[0].decision, 'REWORK_REQUIRED');

    // The work can be redone and verified on a second pass — and the earlier
    // attempt is preserved rather than replaced.
    assert.equal(
      (await act(id, 'complete', { completionNotes: 'Redone.' }, worker.token)).status,
      200,
    );
    assert.equal((await open(id)).status, 201);
    const second = await decide(id, { decision: 'APPROVED' });
    assert.equal(second.status, 200);
    assert.equal(second.body.data.correctiveActionStatus, 'VERIFIED');

    const full = await history(id);
    assert.deepEqual(
      full.body.data.map((row: { decision: string }) => row.decision),
      ['REWORK_REQUIRED', 'APPROVED'],
    );
    // "Latest" means the most recent decision, not the first.
    assert.equal((await latest(id)).body.data.decision, 'APPROVED');
  });
});

describe('BE-21J — invalid / non-reviewable context rejected', () => {
  it('rejects an unknown or malformed corrective action', async (t) => {
    if (!ready(t)) return;
    const missing = randomUUID();
    assert.equal((await context(missing)).status, 404);
    assert.equal((await open(missing)).status, 404);
    assert.equal((await decide(missing, { decision: 'APPROVED' })).status, 404);
    assert.equal((await latest(missing)).status, 404);

    assert.equal((await context('not-a-uuid')).status, 400);
    assert.equal((await open('not-a-uuid')).status, 400);
  });

  it('refuses to verify work that has not been completed', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);

    // PROPOSED — nothing has been done, so there is nothing to confirm.
    const proposedId = await proposed(parent.id);
    const proposedContext = await context(proposedId);
    assert.equal(proposedContext.status, 200);
    assert.equal(proposedContext.body.data.verifiable, false);
    assert.match(proposedContext.body.data.blockers[0], /COMPLETED/);
    const refused = await open(proposedId);
    assert.equal(refused.status, 400);
    assert.equal(
      refused.body.error.code,
      'CORRECTIVE_ACTION_VERIFICATION_NOT_REVIEWABLE',
    );

    // IN_PROGRESS — still not a completion claim.
    const inProgressId = await proposed(parent.id);
    assert.equal((await act(inProgressId, 'approve', {}, worker.token)).status, 200);
    assert.equal((await act(inProgressId, 'start', {}, worker.token)).status, 200);
    assert.equal((await open(inProgressId)).status, 400);

    // CANCELLED / REJECTED — settled, nothing left to verify.
    const cancelledId = await proposed(parent.id);
    assert.equal((await act(cancelledId, 'cancel', {}, worker.token)).status, 200);
    assert.equal((await open(cancelledId)).status, 400);

    const rejectedId = await proposed(parent.id);
    assert.equal(
      (await act(rejectedId, 'reject', { rejectionReason: 'Not viable.' }, worker.token)).status,
      200,
    );
    assert.equal((await open(rejectedId)).status, 400);
  });

  it('refuses verification when the parent Incident is CANCELLED', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);

    const cancelled = await api()
      .post(`/api/v1/incidents/${parent.id}/cancel`)
      .set(auth())
      .send({ cancellationReason: 'Duplicate report.' });
    assert.equal(cancelled.status, 200);

    // Isolation from BE-21A is inherited, not re-derived.
    const response = await open(id);
    assert.equal(response.status, 400);
    assert.match(response.body.error.message, /CANCELLED Incident/);

    // The context still EXPLAINS it rather than hiding the record.
    const explained = await context(id);
    assert.equal(explained.status, 200);
    assert.equal(explained.body.data.verifiable, false);
    assert.match(explained.body.data.blockers[0], /CANCELLED Incident/);
  });

  it('refuses a second open verification', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);

    assert.equal((await open(id)).status, 201);
    const second = await open(id);
    assert.equal(second.status, 409);
    assert.equal(
      second.body.error.code,
      'CORRECTIVE_ACTION_VERIFICATION_ALREADY_OPEN',
    );

    // The database index — not just the service check — is the guarantee.
    await assert.rejects(
      pool!.query(
        `INSERT INTO reviews
           (id, client_id, target_type, target_id, reviewer_user_id, status)
         VALUES ($1, $2, 'CORRECTIVE_ACTION', $3, $4, 'PENDING')`,
        [randomUUID(), (await readAction(id)).body.data.clientId, id, userId],
      ),
      /corrective_action_pending_review_unique/,
    );
  });

  it('refuses a decision when no verification is open', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);

    const response = await decide(id, { decision: 'APPROVED' });
    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_VERIFICATION_NOT_FOUND',
    );
  });
});

describe('BE-21J — unauthorized reviewer rejected', () => {
  it('refuses to let the completer verify their own work', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);

    // The doer marking their own homework would make COMPLETED and VERIFIED
    // the same assertion by the same party.
    const response = await open(id, {}, worker.token);
    assert.equal(response.status, 403);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_VERIFICATION_SELF_REVIEW',
    );

    // Independent reviewer succeeds on the very same action.
    assert.equal((await open(id)).status, 201);
  });

  it('refuses a decision from anyone but the assigned reviewer', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);

    // Opened by our actor...
    assert.equal((await open(id)).status, 201);

    // ...so a different, equally-permissioned reviewer cannot decide it.
    const other = await doer(building.id);
    const response = await decide(id, { decision: 'APPROVED' }, other.token);
    assert.equal(response.status, 403);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_VERIFICATION_REVIEWER_MISMATCH',
    );

    // Nothing was recorded.
    assert.equal((await latest(id)).body.data, null);
    assert.equal((await readAction(id)).body.data.status, 'COMPLETED');
  });

  it('never accepts a claimed reviewer id', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);

    // Recording a decision under someone else's name would destroy the
    // accountability that makes verification meaningful.
    const claimed = await open(id, { reviewerUserId: worker.userId });
    assert.equal(claimed.status, 400);
    assert.equal(claimed.body.error.details[0].field, 'reviewerUserId');

    assert.equal((await open(id)).status, 201);
    const claimedDecision = await decide(id, {
      decision: 'APPROVED',
      reviewerUserId: worker.userId,
    });
    assert.equal(claimedDecision.status, 400);

    // The client cannot assert the lifecycle outcome either.
    const claimedStatus = await decide(id, {
      decision: 'REJECTED',
      correctiveActionStatus: 'VERIFIED',
    });
    assert.equal(claimedStatus.status, 400);
    assert.equal(
      claimedStatus.body.error.details[0].field,
      'correctiveActionStatus',
    );
  });
});

describe('BE-21J — final decision protected', () => {
  it('refuses to overwrite a recorded decision', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);

    assert.equal((await open(id)).status, 201);
    assert.equal((await decide(id, { decision: 'APPROVED' })).status, 200);

    // A second submission conflicts with a decision on record.
    const again = await decide(id, { decision: 'REJECTED' });
    assert.equal(again.status, 409);
    assert.equal(
      again.body.error.code,
      'CORRECTIVE_ACTION_VERIFICATION_IMMUTABLE',
    );

    // And no new verification may be opened against a verified action.
    // 409, not 400: the caller is told a FINAL decision exists, rather than
    // getting a vague "not reviewable" that hides the real reason.
    const reopened = await open(id);
    assert.equal(reopened.status, 409);
    assert.equal(
      reopened.body.error.code,
      'CORRECTIVE_ACTION_VERIFICATION_IMMUTABLE',
    );

    const result = await latest(id);
    assert.equal(result.body.data.decision, 'APPROVED');
    assert.equal((await readAction(id)).body.data.status, 'VERIFIED');
    assert.equal((await context(id)).body.data.finalized, true);
  });

  it('protects the recorded decision at the database level', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);
    assert.equal((await open(id)).status, 201);

    const pending = await correctiveActionVerificationRepository
      .findPendingByCorrectiveActionId(id);
    assert.ok(pending);

    assert.equal((await decide(id, { decision: 'APPROVED' })).status, 200);

    // The service gate is unreachable here, so the repository's
    // status-pinned guard is exercised directly — the concurrent-submission
    // case. It must update NO row rather than replace the decision.
    const overwritten = await correctiveActionVerificationRepository.complete(
      pending.id,
      'REJECTED',
      'Racing submission.',
    );
    assert.equal(overwritten, null);

    const row = await pool!.query(
      'SELECT decision FROM reviews WHERE id = $1',
      [pending.id],
    );
    assert.equal(row.rows[0].decision, 'APPROVED');
  });

  it('keeps every attempt in history rather than replacing it', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);

    assert.equal((await open(id)).status, 201);
    assert.equal((await decide(id, { decision: 'REJECTED' })).status, 200);
    // REJECTED leaves the action COMPLETED, so it can be checked again.
    assert.equal((await open(id)).status, 201);
    assert.equal((await decide(id, { decision: 'APPROVED' })).status, 200);

    const past = await history(id);
    assert.deepEqual(
      past.body.data.map((row: { decision: string }) => row.decision),
      ['REJECTED', 'APPROVED'],
    );
    // Oldest first, and the earlier decision is untouched.
    assert.equal(past.body.data[0].status, 'COMPLETED');
    assert.equal((await latest(id)).body.data.decision, 'APPROVED');
  });
});

describe('BE-21J — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);

    assert.equal(
      (await api().get(`/api/v1/corrective-actions/${id}/verification`)).status,
      401,
    );
    assert.equal(
      (await api().post(`/api/v1/corrective-actions/${id}/verification`).send({})).status,
      401,
    );
    assert.equal(
      (await api()
        .post(`/api/v1/corrective-actions/${id}/verification/decision`)
        .send({ decision: 'APPROVED' })).status,
      401,
    );
  });

  it('denies a user without verification permissions', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);
    const plain = await createPlainSession();

    assert.equal((await context(id, plain)).status, 403);
    assert.equal((await open(id, {}, plain)).status, 403);
    assert.equal((await decide(id, { decision: 'APPROVED' }, plain)).status, 403);
    assert.equal((await latest(id, plain)).status, 403);
    assert.equal((await history(id, plain)).status, 403);
  });

  it('separates doing the work from verifying it', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);

    // The verification permissions are distinct from corrective_action.*, so
    // the two authorities can be granted to different roles.
    const permissions = await pool!.query(
      `SELECT code FROM permissions
       WHERE code LIKE 'corrective_action_verification.%'
       ORDER BY code`,
    );
    assert.deepEqual(
      permissions.rows.map((row) => row.code),
      [
        'corrective_action_verification.manage',
        'corrective_action_verification.read',
      ],
    );

    // Sanity: the flow still works for a fully-permissioned reviewer.
    assert.equal((await open(id)).status, 201);
    assert.equal((await decide(id, { decision: 'APPROVED' })).status, 200);
  });
});

describe('BE-21J — Client / Building isolation', () => {
  it('denies verification across the Building boundary', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);
    assert.equal((await open(id)).status, 201);

    // A permissioned admin with no assignment to this Building.
    const outsider = await createAdminUser();

    assert.equal((await context(id, outsider.token)).status, 403);
    assert.equal((await latest(id, outsider.token)).status, 403);
    assert.equal((await history(id, outsider.token)).status, 403);
    assert.equal(
      (await decide(id, { decision: 'APPROVED' }, outsider.token)).status,
      403,
    );

    // Nothing was recorded by the refused attempts.
    assert.equal((await latest(id)).body.data, null);
    assert.equal((await readAction(id)).body.data.status, 'COMPLETED');
  });

  it('scopes verification listings to accessible Buildings', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const id = await completedAction(parent.id, worker.token);
    assert.equal((await open(id)).status, 201);
    assert.equal((await decide(id, { decision: 'APPROVED' })).status, 200);

    const mine = await api()
      .get(`/api/v1/corrective-action-verifications?buildingId=${building.id}`)
      .set(auth());
    assert.equal(mine.status, 200);
    assert.deepEqual(
      mine.body.data.map((row: { correctiveActionId: string }) => row.correctiveActionId),
      [id],
    );

    // An outsider sees none of it...
    const outsider = await createAdminUser();
    const theirs = await api()
      .get('/api/v1/corrective-action-verifications')
      .set(auth(outsider.token));
    assert.equal(theirs.status, 200);
    assert.equal(
      theirs.body.data.some((row: { correctiveActionId: string }) => row.correctiveActionId === id),
      false,
    );

    // ...and filtering by the Building itself is a 403, not an empty list.
    assert.equal(
      (await api()
        .get(`/api/v1/corrective-action-verifications?buildingId=${building.id}`)
        .set(auth(outsider.token))).status,
      403,
    );
  });
});
