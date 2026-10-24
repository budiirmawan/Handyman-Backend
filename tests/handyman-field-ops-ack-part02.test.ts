import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import {
  respondToHandymanExecutionScopeAssignment,
} from '../src/modules/handyman-scope-assignments';
import {
  assignHandymanExecutionScopeCrew,
  reassignHandymanExecutionScopeCrew,
} from '../src/modules/handyman-scope-assignments';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
  locationChain,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
} from './helpers/embedded-test-db';
import { api } from './helpers/http';

/**
 * CR-HM-FIELD-OPS-ACK-01 PART 02 — arrival challenge ISSUANCE surface.
 *
 * The PART 01 issuer (`createHandymanArrivalChallenge`) existed with no
 * HTTP exposure, so no mobile client could ever obtain the
 * `challengeToken` the CR-HM-07 PART 04C terminal command requires —
 * the arrival flow (and therefore the CR-HM-08 CHECK_IN gate that
 * depends on a VERIFIED result) was unreachable end-to-end. This suite
 * proves the new command:
 *
 *   POST /handyman/execution-scopes/{executionScopeId}/arrival-challenge
 *
 * is a THIN shell over the pre-existing PART 01 authority (no second
 * issuer, no duplicated decision logic) and that it inherits every
 * existing guard unchanged: AUTHORIZED scope gate, BE-02G exact-Building
 * access, CR-HM-04 CURRENT Crew Lead resolution, declined-assignment
 * refusal, one-live-PENDING conflict, server-derived TTL, and
 * hash-at-rest token handling. Reassignment evidence proves the
 * superseded Lead can neither re-issue nor verify, while the
 * replacement Lead can issue immediately.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

const EMBEDDED_DIR = '/tmp/hm04-arrival-challenge-issuance-pg';
const EMBEDDED_PORT = 55588;
let embedded: EmbeddedTestDatabase | null = null;

before(async () => {
  embedded = await startEmbeddedTestDatabase({
    dir: EMBEDDED_DIR,
    port: EMBEDDED_PORT,
  });
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_arrival_verification_results,
    handyman_building_geospatial_policies,
    handyman_arrival_location_identifiers,
    handyman_arrival_challenges,
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
    undefined, 'GENERAL_HANDYMAN');
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
  try {
    if (pool) await closePool(pool);
    if (embedded) await embedded.stop();
  } finally {
    pool = null;
    database = null;
    embedded = null;
  }
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

const sha256 = (v: string) => createHash('sha256').update(v, 'utf8')
  .digest('hex');

const challengePath = (scopeId: string) =>
  `/api/v1/handyman/execution-scopes/${scopeId}/arrival-challenge`;
const verifyPath = (scopeId: string) =>
  `/api/v1/handyman/execution-scopes/${scopeId}/arrival-verification`;

/** Login-capable session for an already-created user. */
async function loginAs(userId: string, email: string): Promise<string> {
  const password = `Pass${randomUUID().slice(0, 8)}`;
  await credentialService.createInitialCredential({ userId, password });
  const login = await api().post('/api/v1/auth/login').send({
    email, password,
  });
  assert.equal(login.status, 200, 'fixture login must succeed');
  return login.body.data.sessionToken as string;
}

/**
 * ACTIVE assignment + a logged-in Crew Lead. No challenge is created
 * here — every issuance case must go through the HTTP command.
 */
async function leadFixture() {
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  const token = await loginAs(crew.leadUser.id, crew.leadUser.email);
  const assignment = await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  return { ...f, crew, token, assignment, leadUserId: crew.leadUser.id };
}

const issue = (scopeId: string, token: string) =>
  api().post(challengePath(scopeId)).set('Authorization', `Bearer ${token}`);

describe('CR-HM-FIELD-OPS-ACK-01 PART 02 — arrival challenge issuance', () => {
  it('1: CURRENT Lead issues => 201 PENDING, hash-only at rest, and the token drives the terminal command', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await leadFixture();

    const res = await issue(f.scope.id, f.token);
    assert.equal(res.status, 201);
    const d = res.body.data;
    assert.equal(d.status, 'PENDING');
    assert.equal(d.executionScopeId, f.scope.id);
    assert.ok(typeof d.challengeToken === 'string' && d.challengeToken.length > 0);
    assert.ok(typeof d.id === 'string');
    // Bounded projection ONLY: no internal binding ids, no token material.
    assert.deepEqual(Object.keys(d).sort(), [
      'challengeToken', 'executionScopeId', 'expiresAt', 'id', 'status',
    ]);

    const row = await q(
      `SELECT id, client_id, assignment_id, actor_user_id, token_hash,
              status, consumed_at,
              EXTRACT(EPOCH FROM (expires_at - created_at))::int AS ttl
         FROM handyman_arrival_challenges WHERE id = $1`,
      [d.id],
    );
    assert.equal(row.rows[0].status, 'PENDING');
    assert.equal(row.rows[0].consumed_at, null);
    // Server-derived binding: session actor + the ACTIVE assignment.
    assert.equal(row.rows[0].actor_user_id, f.leadUserId);
    assert.equal(row.rows[0].assignment_id, f.assignment.id);
    assert.equal(row.rows[0].client_id, f.realm.client.id);
    // Frozen PART 01 TTL, caller-influenceable nowhere.
    assert.equal(row.rows[0].ttl, 120);
    // Hash at rest: the raw token is never stored.
    assert.equal(row.rows[0].token_hash, sha256(d.challengeToken));
    assert.notEqual(row.rows[0].token_hash, d.challengeToken);
    const plain = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_challenges
        WHERE token_hash = $1`, [d.challengeToken]);
    assert.equal(plain.rows[0].n, 0);

    // The issued token is the SAME one the PART 04C terminal command
    // consumes (QR/geofence deliberately absent → MANUAL_REVIEW, which
    // is a normal 200 evaluation response, never an HTTP failure).
    const verify = await api()
      .post(verifyPath(f.scope.id))
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        challengeToken: d.challengeToken,
        // No identifier is registered for this Building in PART 02, so the
        // QR signal is UNKNOWN — a normal 200 evaluation, never an error.
        qrOpaqueCode: `unregistered-${randomUUID()}`,
      });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.data.status, 'MANUAL_REVIEW_REQUIRED');
    assert.equal(verify.body.data.primaryReason, 'QR_UNKNOWN');
    const after = await q(
      `SELECT status FROM handyman_arrival_challenges WHERE id = $1`,
      [d.id],
    );
    assert.equal(after.rows[0].status, 'CONSUMED');
  });

  it('2: a second issuance while one is live => 409 LIVE_CONFLICT and exactly one PENDING row', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await leadFixture();
    assert.equal((await issue(f.scope.id, f.token)).status, 201);

    const again = await issue(f.scope.id, f.token);
    assert.equal(again.status, 409);
    assert.equal(
      again.body.error.code,
      'HANDYMAN_ARRIVAL_CHALLENGE_LIVE_CONFLICT',
    );
    const rows = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_challenges
        WHERE execution_scope_id = $1 AND actor_user_id = $2
          AND status = 'PENDING'`,
      [f.scope.id, f.leadUserId],
    );
    assert.equal(rows.rows[0].n, 1);
  });

  it('3: an authenticated NON-Lead in the same Building => 403 NOT_AUTHORIZED', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await leadFixture();
    const bystander = await loginAs(...await (async () => {
      const { userService } = await import('../src/modules/users');
      const suffix = randomUUID().slice(0, 8).toLowerCase();
      const user = await userService.createUser({
        email: `bystander-${suffix}@example.com`,
        displayName: 'Bystander Worker',
      });
      await buildingAssignmentService.createAssignment(user.id, {
        buildingId: f.realm.building.id,
      });
      return [user.id, user.email] as const;
    })());

    const res = await issue(f.scope.id, bystander);
    assert.equal(res.status, 403);
    assert.equal(
      res.body.error.code,
      'HANDYMAN_ARRIVAL_CHALLENGE_NOT_AUTHORIZED',
    );
    const rows = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_challenges
        WHERE execution_scope_id = $1`, [f.scope.id]);
    assert.equal(rows.rows[0].n, 0);
  });

  it('4: an authenticated user without exact-Building access => 403 BUILDING_ACCESS_DENIED', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await leadFixture();
    const { userService } = await import('../src/modules/users');
    const outsider = await userService.createUser({
      email: `outsider-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Outsider',
    });
    const token = await loginAs(outsider.id, outsider.email);

    const res = await issue(f.scope.id, token);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('5: reassignment supersedes the Lead — stale token cannot verify, old Lead cannot re-issue, new Lead issues immediately', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await leadFixture();
    const first = await issue(f.scope.id, f.token);
    assert.equal(first.status, 201);
    const staleToken = first.body.data.challengeToken as string;

    // Operations reassigns the scope to a different ACTIVE crew.
    const replacement = await crewFixture(f.realm);
    await reassignHandymanExecutionScopeCrew({
      executionScopeId: f.scope.id,
      providerContextId: replacement.providerContext.id,
      crewId: replacement.crew.id,
      reason: 'PART 02 supersede evidence',
      expectedVersion: f.assignment.version,
      idempotencyKey: `reassign-${randomUUID()}`,
    }, adminUserId);
    const replacementToken = await loginAs(
      replacement.leadUser.id, replacement.leadUser.email,
    );

    // (a) Stale challenge: the superseded Lead can never reach VERIFIED.
    const verify = await api()
      .post(verifyPath(f.scope.id))
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        challengeToken: staleToken,
        qrOpaqueCode: `unregistered-${randomUUID()}`,
      });
    assert.equal(verify.status, 200);
    assert.notEqual(verify.body.data.status, 'VERIFIED');
    assert.equal(verify.body.data.primaryReason, 'ACTOR_ASSIGNMENT_INVALID');

    // (b) Old Lead may not issue a replacement challenge.
    const oldAgain = await issue(f.scope.id, f.token);
    assert.equal(oldAgain.status, 403);
    assert.equal(
      oldAgain.body.error.code,
      'HANDYMAN_ARRIVAL_CHALLENGE_NOT_AUTHORIZED',
    );

    // (c) The replacement Lead issues immediately: the one-live-PENDING
    //     index is per (scope, actor), so a stale row for the previous
    //     actor never blocks the new authority.
    const fresh = await issue(f.scope.id, replacementToken);
    assert.equal(fresh.status, 201);
    assert.equal(fresh.body.data.status, 'PENDING');
    const bound = await q(
      `SELECT actor_user_id, assignment_id FROM handyman_arrival_challenges
        WHERE id = $1`, [fresh.body.data.id]);
    assert.equal(bound.rows[0].actor_user_id, replacement.leadUser.id);
    assert.notEqual(bound.rows[0].assignment_id, f.assignment.id);
  });

  it('6: TTL and binding are server-derived — smuggled authority keys cannot influence issuance', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await leadFixture();
    const res = await api()
      .post(challengePath(f.scope.id))
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        challengeToken: 'caller-supplied-token',
        tokenHash: 'spoofed',
        actorUserId: randomUUID(),
        workerId: randomUUID(),
        crewId: randomUUID(),
        assignmentId: randomUUID(),
        clientId: randomUUID(),
        status: 'CONSUMED',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        ttlSeconds: 86400,
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'PENDING');
    assert.equal(res.body.data.status === 'PENDING', true);
    const row = await q(
      `SELECT actor_user_id, client_id, assignment_id, token_hash,
              status, EXTRACT(EPOCH FROM (expires_at - created_at))::int AS ttl
         FROM handyman_arrival_challenges WHERE id = $1`,
      [res.body.data.id],
    );
    assert.equal(row.rows[0].actor_user_id, f.leadUserId);
    assert.equal(row.rows[0].client_id, f.realm.client.id);
    assert.equal(row.rows[0].assignment_id, f.assignment.id);
    assert.equal(row.rows[0].status, 'PENDING');
    assert.equal(row.rows[0].ttl, 120);
    assert.notEqual(row.rows[0].token_hash, 'spoofed');
    assert.notEqual(
      row.rows[0].token_hash,
      res.body.data.challengeToken,
    );
  });

  it('7: a declined assignment (TIDAK_BISA) cannot issue an arrival challenge', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await leadFixture();
    await respondToHandymanExecutionScopeAssignment({
      executionScopeId: f.scope.id,
      assignmentId: f.assignment.id,
      responseStatus: 'TIDAK_BISA',
      declineReason: 'PART 02 decline evidence',
    }, f.leadUserId);

    const res = await issue(f.scope.id, f.token);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'HANDYMAN_ASSIGNMENT_DECLINED');
  });

  it('8: unauthenticated 401, invalid scope uuid 400, unknown scope 404', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await leadFixture();

    const anon = await api().post(challengePath(f.scope.id));
    assert.equal(anon.status, 401);

    const badUuid = await issue('not-a-uuid', f.token);
    assert.equal(badUuid.status, 400);
    assert.equal(badUuid.body.error.code, 'VALIDATION_ERROR');

    const unknown = await issue(randomUUID(), f.token);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND');
  });

  it('9: OpenAPI documents the issuance command as a bounded contract (no secret fields)', async () => {
    const spec = parseYaml(
      readFileSync('docs/api/openapi.yaml', 'utf8'),
    ) as any;
    const path = spec.paths[
      '/handyman/execution-scopes/{executionScopeId}/arrival-challenge'
    ];
    assert.ok(path, 'issuance path must be documented');
    const op = path.post;
    assert.equal(op.operationId, 'createHandymanArrivalChallenge');
    assert.deepEqual(op.tags, ['Handyman Arrival Verification']);
    assert.ok(op['x-error-codes'].includes('HANDYMAN_ARRIVAL_CHALLENGE_LIVE_CONFLICT'));
    assert.ok(op['x-error-codes'].includes('HANDYMAN_ARRIVAL_CHALLENGE_NOT_AUTHORIZED'));
    assert.ok(op.responses['201'], 'issuance returns 201');
    assert.ok(op.responses['409'], 'live conflict is a 409');
    const schema = spec.components.schemas.HandymanArrivalChallengeIssued;
    assert.deepEqual(
      Object.keys(schema.properties).sort(),
      ['challengeToken', 'executionScopeId', 'expiresAt', 'id', 'status'],
    );
    // No token/hash/secret material is ever projected.
    assert.equal(schema.properties.tokenHash, undefined);
    assert.equal(schema.properties.actorUserId, undefined);
    assert.equal(schema.properties.assignmentId, undefined);
  });
});
