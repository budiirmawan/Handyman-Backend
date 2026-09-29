import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  HANDYMAN_WORK_SESSION_EVENT_TYPES,
  HANDYMAN_WORK_SESSION_STATUSES,
  handymanWorkSessionRepository,
} from '../src/modules/handyman-work-sessions';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-08 PART 01 — work-session persistence foundation ONLY:
 * exact status/event contracts, authoritative FK + client
 * consistency, one-active-per-scope with CHECKED_OUT exclusion,
 * event idempotency uniqueness, append-only event/snapshot
 * immutability, and ZERO billing/arrival-mutation/FM coupling.
 * Ten focused cases; no commands/gates are exercised (none exist).
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_work_session_helper_presence,
    handyman_work_session_events, handyman_work_sessions,
    handyman_execution_scope_assignments,
    handyman_execution_scopes, handyman_quotation_decisions,
    handyman_quotation_lines, handyman_quotation_versions,
    handyman_quotations,
    handyman_crew_leads, handyman_crew_memberships,
    handyman_work_crews, handyman_worker_contexts,
    handyman_provider_contexts,
    handyman_request_diagnoses, handyman_request_inspections,
    handyman_request_triage_decisions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    handyman_discipline_service_associations, service_catalog,
    evidence_submissions, operational_events, tenant_service_requests,
    work_requests, work_orders, vendor_quotations,
    vendor_workforce_bindings, vendor_capabilities, vendor_pics,
    vendors, workforce_profiles, positions, departments, organizations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const d = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!d) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  initHandymanFixtures({
    adminUserId,
    disciplineId: d.id,
    query: async (text, params = []) => {
      if (!pool) throw new Error('db pool not initialized');
      return pool.query(text, params);
    },
  });
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

/**
 * Authority bundle: AUTHORIZED scope + ACTIVE crew assignment with
 * the CURRENT CR-HM-04 Lead identity (worker context + user).
 * No session is created here.
 */
async function authorityFixture() {
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  const assignment = await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  return {
    ...f,
    crew,
    assignmentId: assignment.id,
    leadWorkerId: crew.workerContext.id,
    leadUserId: crew.leadUser.id,
  };
}

async function openSession(
  f: Awaited<ReturnType<typeof authorityFixture>>,
) {
  const session = await handymanWorkSessionRepository
    .createWorkSession(undefined, {
      clientId: f.realm.client.id,
      executionScopeId: f.scope.id,
      assignmentId: f.assignmentId,
      leadWorkerId: f.leadWorkerId,
      leadUserId: f.leadUserId,
    });
  return session;
}

async function openSessionWithCheckInEvent(
  f: Awaited<ReturnType<typeof authorityFixture>>,
) {
  const session = await openSession(f);
  const event = await handymanWorkSessionRepository
    .appendWorkSessionEvent(undefined, {
      clientId: session.clientId,
      sessionId: session.id,
      executionScopeId: session.executionScopeId,
      eventType: 'CHECK_IN',
      idempotencyKey: `idem-${randomUUID()}`,
      actorUserId: session.leadUserId,
    });
  return { session, event };
}

describe('CR-HM-08 PART 01 — work session persistence foundation', () => {
  it('1: session status contract is exactly the frozen six values', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    assert.deepEqual([...HANDYMAN_WORK_SESSION_STATUSES], [
      'CHECKED_IN', 'IN_PROGRESS', 'PAUSED',
      'MATERIAL_RUN', 'COMPLETED', 'CHECKED_OUT',
    ]);
    // One session WALKS the full frozen status ladder (the
    // one-active index forbids parallel active rows per scope, so
    // a single row proves every contract value with its matching
    // timestamp columns).
    const session = await openSession(f);
    const ladder: Array<[string, string]> = [
      ['IN_PROGRESS',
        `SET status = 'IN_PROGRESS', started_work_at = NOW()`],
      ['PAUSED', `SET status = 'PAUSED'`],
      ['MATERIAL_RUN', `SET status = 'MATERIAL_RUN'`],
      ['COMPLETED', `SET status = 'COMPLETED', completed_at = NOW()`],
      ['CHECKED_OUT',
        `SET status = 'CHECKED_OUT', checked_out_at = NOW()`],
    ];
    assert.equal(session.status, 'CHECKED_IN');
    assert.ok(session.checkedInAt instanceof Date);
    for (const [status, set] of ladder) {
      await q(
        `UPDATE handyman_work_sessions ${set}, updated_at = NOW()
          WHERE id = $1`,
        [session.id]);
      const row = await q(
        `SELECT status FROM handyman_work_sessions WHERE id = $1`,
        [session.id]);
      assert.equal(row.rows[0].status, status);
    }
    // Timestamp guards reject incoherent combinations.
    await assert.rejects(async () => q(
      `INSERT INTO handyman_work_sessions (
         id, client_id, execution_scope_id, assignment_id,
         lead_worker_id, lead_user_id, status, checked_in_at,
         started_work_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'CHECKED_IN', NOW(), NOW())`,
      [randomUUID(), f.realm.client.id, f.scope.id, f.assignmentId,
        f.leadWorkerId, f.leadUserId],
    ), (error: unknown) => errorCode(error) === '23514');
    // A NON-frozen status is rejected.
    await assert.rejects(async () => q(
      `INSERT INTO handyman_work_sessions (
         id, client_id, execution_scope_id, assignment_id,
         lead_worker_id, lead_user_id, status, checked_in_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ON_HOLD', NOW())`,
      [randomUUID(), f.realm.client.id, f.scope.id, f.assignmentId,
        f.leadWorkerId, f.leadUserId],
    ), (error: unknown) => errorCode(error) === '23514');
  });

  it('2: event type contract is exactly the frozen seven values', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const created = await openSessionWithCheckInEvent(f);
    // Fresh scopes per event: one CHECK_IN event exists already; the
    // remaining six types insert fine against the same session.
    assert.deepEqual([...HANDYMAN_WORK_SESSION_EVENT_TYPES], [
      'CHECK_IN', 'START_WORK', 'PAUSE', 'MATERIAL_RUN',
      'RESUME', 'COMPLETE', 'CHECK_OUT',
    ]);
    for (const type of HANDYMAN_WORK_SESSION_EVENT_TYPES) {
      if (type === 'CHECK_IN') continue; // already appended above
      const e = await handymanWorkSessionRepository
        .appendWorkSessionEvent(undefined, {
          clientId: created.session.clientId,
          sessionId: created.session.id,
          executionScopeId: created.session.executionScopeId,
          eventType: type,
          idempotencyKey: `idem-${randomUUID()}`,
          actorUserId: created.session.leadUserId,
        });
      assert.equal(e.eventType, type);
    }
    await assert.rejects(async () => q(
      `INSERT INTO handyman_work_session_events (
         id, client_id, session_id, execution_scope_id, event_type,
         idempotency_key, actor_user_id
       ) VALUES ($1, $2, $3, $4, 'BREAK', $5, $6)`,
      [randomUUID(), created.session.clientId, created.session.id,
        created.session.executionScopeId, `idem-${randomUUID()}`,
        created.session.leadUserId],
    ), (error: unknown) => errorCode(error) === '23514');
  });

  it('3: authoritative FKs and client consistency are DB-enforced', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    // Cross-client session (scope belongs to realm A) is blocked by
    // the client-consistency trigger even though FK targets exist.
    const otherRealm = await (async () => {
      const build = await baseFixture();
      return build;
    })();
    await assert.rejects(async () => q(
      `INSERT INTO handyman_work_sessions (
         id, client_id, execution_scope_id, assignment_id,
         lead_worker_id, lead_user_id, status, checked_in_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'CHECKED_IN', NOW())`,
      [randomUUID(), otherRealm.realm.client.id, f.scope.id,
        f.assignmentId, f.leadWorkerId, f.leadUserId],
    ));
    // Unknown FKs are rejected by the FK constraints.
    await assert.rejects(async () => q(
      `INSERT INTO handyman_work_sessions (
         id, client_id, execution_scope_id, assignment_id,
         lead_worker_id, lead_user_id, status, checked_in_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'CHECKED_IN', NOW())`,
      [randomUUID(), f.realm.client.id, randomUUID(), f.assignmentId,
        f.leadWorkerId, f.leadUserId],
    ), (error: unknown) => errorCode(error) === '23503');
    await assert.rejects(async () => q(
      `INSERT INTO handyman_work_sessions (
         id, client_id, execution_scope_id, assignment_id,
         lead_worker_id, lead_user_id, status, checked_in_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'CHECKED_IN', NOW())`,
      [randomUUID(), f.realm.client.id, f.scope.id, randomUUID(),
        f.leadWorkerId, f.leadUserId],
    ), (error: unknown) => errorCode(error) === '23503');
    // Event child binding: event client/scope MUST equal the
    // session's (never merely some consistent triple).
    const created = await openSessionWithCheckInEvent(f);
    await assert.rejects(async () => q(
      `INSERT INTO handyman_work_session_events (
         id, client_id, session_id, execution_scope_id, event_type,
         idempotency_key, actor_user_id
       ) VALUES ($1, $2, $3, $4, 'PAUSE', $5, $6)`,
      [randomUUID(), created.session.clientId, created.session.id,
        otherRealm.scope.id, `idem-${randomUUID()}`,
        created.session.leadUserId],
    ));
  });

  it('4: at most ONE non-CHECKED_OUT session per execution scope', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const first = await openSession(f);
    assert.equal(first.status, 'CHECKED_IN');
    // Every ACTIVE status combination still collides.
    await assert.rejects(async () =>
      handymanWorkSessionRepository.createWorkSession(undefined, {
        clientId: f.realm.client.id,
        executionScopeId: f.scope.id,
        assignmentId: f.assignmentId,
        leadWorkerId: f.leadWorkerId,
        leadUserId: f.leadUserId,
      }),
    (error: unknown) =>
      (error as { code?: string }).code
        === 'HANDYMAN_WORK_SESSION_ACTIVE_CONFLICT');
    // Moving the live session to another ACTIVE status does NOT free
    // the scope.
    await q(
      `UPDATE handyman_work_sessions
          SET status = 'IN_PROGRESS', started_work_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [first.id],
    );
    await assert.rejects(async () => q(
      `INSERT INTO handyman_work_sessions (
         id, client_id, execution_scope_id, assignment_id,
         lead_worker_id, lead_user_id, status, checked_in_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'CHECKED_IN', NOW())`,
      [randomUUID(), f.realm.client.id, f.scope.id, f.assignmentId,
        f.leadWorkerId, f.leadUserId],
    ), (error: unknown) => errorCode(error) === '23505');
  });

  it('5: CHECKED_OUT sessions do NOT block a new active session', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const first = await openSession(f);
    await q(
      `UPDATE handyman_work_sessions
          SET status = 'CHECKED_OUT', started_work_at = NOW(),
              completed_at = NOW(), checked_out_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [first.id],
    );
    const second = await openSession(f);
    assert.equal(second.status, 'CHECKED_IN');
    assert.notEqual(second.id, first.id);
    // The repository finds only the NEW active row.
    const active = await handymanWorkSessionRepository
      .findActiveWorkSessionByExecutionScope(undefined, f.scope.id);
    assert.equal(active?.id, second.id);
  });

  it('6: event idempotency is unique per (session, type, key)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const { session } = await openSessionWithCheckInEvent(f);
    const key = `idem-${randomUUID()}`;
    const first = await handymanWorkSessionRepository
      .appendWorkSessionEvent(undefined, {
        clientId: session.clientId,
        sessionId: session.id,
        executionScopeId: session.executionScopeId,
        eventType: 'START_WORK',
        idempotencyKey: key,
        actorUserId: session.leadUserId,
      });
    // Same (session, type, key) → unique violation; zero second row.
    await assert.rejects(async () =>
      handymanWorkSessionRepository.appendWorkSessionEvent(undefined, {
        clientId: session.clientId,
        sessionId: session.id,
        executionScopeId: session.executionScopeId,
        eventType: 'START_WORK',
        idempotencyKey: key,
        actorUserId: session.leadUserId,
      }), (error: unknown) => errorCode(error) === '23505');
    // Replay lookup returns the ORIGINAL row.
    const replay = await handymanWorkSessionRepository
      .findWorkSessionEventByIdempotency(undefined, session.id,
        'START_WORK', key);
    assert.equal(replay?.id, first.id);
    // Same key under a DIFFERENT action on the SAME session is legal.
    const other = await handymanWorkSessionRepository
      .appendWorkSessionEvent(undefined, {
        clientId: session.clientId,
        sessionId: session.id,
        executionScopeId: session.executionScopeId,
        eventType: 'PAUSE',
        idempotencyKey: key,
        actorUserId: session.leadUserId,
      });
    assert.equal(other.eventType, 'PAUSE');
    const count = await q(
      `SELECT count(*)::int AS n FROM handyman_work_session_events
        WHERE session_id = $1`,
      [session.id]);
    assert.equal(count.rows[0].n, 3); // CHECK_IN + START_WORK + PAUSE
  });

  it('7: events are immutable — UPDATE is blocked', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const { event } = await openSessionWithCheckInEvent(f);
    await assert.rejects(async () => q(
      `UPDATE handyman_work_session_events
          SET idempotency_key = 'tampered' WHERE id = $1`,
      [event.id],
    ));
    const row = await q(
      `SELECT idempotency_key FROM handyman_work_session_events
        WHERE id = $1`,
      [event.id]);
    assert.equal(row.rows[0].idempotency_key, event.idempotencyKey);
  });

  it('8: events are immutable — DELETE is blocked', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const { event } = await openSessionWithCheckInEvent(f);
    await assert.rejects(async () => q(
      `DELETE FROM handyman_work_session_events WHERE id = $1`,
      [event.id],
    ));
    const row = await q(
      `SELECT id FROM handyman_work_session_events WHERE id = $1`,
      [event.id]);
    assert.equal(row.rows.length, 1);
  });

  it('9: helper snapshot store is append-only with NO billing fields', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const { session, event } = await openSessionWithCheckInEvent(f);
    // Snapshot rows are server-side store input: helper identity
    // rows bind session/event; login identity may be absent.
    const snapshot = await handymanWorkSessionRepository
      .insertWorkSessionHelperPresence(undefined, {
        clientId: session.clientId,
        sessionId: session.id,
        eventId: event.id,
        executionScopeId: session.executionScopeId,
        helperWorkerId: f.crew.workerContext.id,
        helperUserId: null,
      });
    assert.equal(snapshot.helperUserId, null);
    const listed = await handymanWorkSessionRepository
      .listWorkSessionHelperPresenceBySession(undefined, session.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, snapshot.id);
    // Append-only: UPDATE and DELETE are both blocked.
    await assert.rejects(async () => q(
      `UPDATE handyman_work_session_helper_presence
          SET helper_user_id = NULL WHERE id = $1`,
      [snapshot.id],
    ));
    await assert.rejects(async () => q(
      `DELETE FROM handyman_work_session_helper_presence
        WHERE id = $1`,
      [snapshot.id],
    ));
    // NO billing material exists: no billable/rate/price/amount/
    // duration/payment columns on ANY PART 01 table.
    const cols = await q(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN (
          'handyman_work_sessions', 'handyman_work_session_events',
          'handyman_work_session_helper_presence')
          AND (column_name ILIKE '%bill%'
               OR column_name ILIKE '%rate%'
               OR column_name ILIKE '%price%'
               OR column_name ILIKE '%amount%'
               OR column_name ILIKE '%payment%'
               OR column_name ILIKE '%wage%'
               OR column_name ILIKE '%cost%'
               OR column_name ILIKE '%manpower%')`);
    assert.deepEqual(cols.rows, []);
  });

  it('10: zero arrival-mutation/work_order/material/QC/BAST/payment/FM coupling', async () => {
    const strip = (src: string) => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const moduleFiles = [
      'handyman-work-session.types.ts',
      'handyman-work-session.errors.ts',
      'handyman-work-session.repository.ts',
      'index.ts',
    ];
    for (const file of moduleFiles) {
      const src = strip(readFileSync(
        `src/modules/handyman-work-sessions/${file}`, 'utf8'))
        .toLowerCase();
      for (const token of ['work_order', 'work-order', 'arrival',
        'reverse-geocode', 'api.co.id', 'bast', 'payment', 'pricing',
        'warranty', 'rectification', 'checklist']) {
        assert.equal(src.includes(token), false,
          `zero ${token} in ${file}`);
      }
      // No arrival-module imports: the foundation mutates NOTHING of
      // CR-HM-07 and consumes no arrival authority.
      assert.equal(/from '.*arrival/.test(src), false,
        `zero arrival import in ${file}`);
    }
    const migration = strip(readFileSync(
      'src/database/migrations/0401_create_handyman_work_sessions.ts',
      'utf8')).toLowerCase();
    for (const token of ['references work_orders', 'checklist',
      'billable', 'payment', 'bast']) {
      assert.equal(migration.includes(token), false,
        `zero ${token} in migration 0401`);
    }
    // Migration is registered in the global migration index.
    const index = readFileSync(
      'src/database/migrations/index.ts', 'utf8');
    assert.ok(index.includes('migration0401CreateHandymanWorkSessions'));
    // The module is ONLY persistence: zero service/controller/routes
    // files exist.
    const serviceFiles = readdirSync(
      'src/modules/handyman-work-sessions')
      .filter((name) => /service|controller|routes/.test(name)).length;
    assert.equal(serviceFiles, 0);
  });
});
