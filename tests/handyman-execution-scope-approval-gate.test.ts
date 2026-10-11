import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool, PoolClient } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { migration0438HandymanQuotationDecisionActorIdentity as actorMigration }
  from '../src/database/migrations/0438_handyman_quotation_decision_actor_identity';
import { migration0442HandymanQuotationPicSessionLedgerLink as sessionLinkMigration }
  from '../src/database/migrations/0442_handyman_quotation_pic_session_ledger_link';
import { migration0443HandymanExecutionScopeApprovalGate as gateMigration }
  from '../src/database/migrations/0443_handyman_execution_scope_approval_gate';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { submitPicQuotationDecision } from '../src/modules/handyman-pic-portal';
import { decideHandymanQuotation } from '../src/modules/handyman-quotations';
import { handymanExecutionScopeRepository as scopes }
  from '../src/modules/handyman-quotations/handyman-execution-scope.repository';
import { buildExecutionScopeInput }
  from '../src/modules/handyman-quotations/handyman-execution-scope.service';
import type { NewHandymanExecutionScope }
  from '../src/modules/handyman-quotations/handyman-execution-scope.types';
import { createAdminUser } from './helpers/access';
import {
  initHandymanFixtures, locationChain, quotationFixture, realmFixture,
} from './helpers/handyman-fixtures';
import { admitFixturePic, bindAndAdmitFixturePic } from './helpers/handyman-pic-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/** 03F only: live PostgreSQL scope gate, controlled migration, replay and races. */
const embedded = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
if (embedded) {
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_PORT: '55503', DB_USER: 'postgres',
    DB_PASSWORD: '', DB_NAME: 'asentra_test', DB_SSL: 'false',
  });
}
let pg: EmbeddedPostgres | undefined;
let dataDir: string | undefined;
let pool: Pool | undefined;
let adminUserId = '';

before(async () => {
  if (embedded) {
    dataDir = await mkdtemp(join(tmpdir(), 'handyman-03f-'));
    pg = new EmbeddedPostgres({
      databaseDir: dataDir, port: 55503, user: 'postgres', password: '',
      persistent: true, authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
  }
  const config = await ensureTestDatabase();
  if (!config) {
    if (embedded) throw new Error('Requested embedded PostgreSQL is unavailable');
    return;
  }
  pool = await initDatabase(config);
  await migrateUp(pool);
  adminUserId = (await createAdminUser()).userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined, 'GENERAL_HANDYMAN',
  );
  assert.ok(discipline);
  initHandymanFixtures({
    adminUserId, disciplineId: discipline.id,
    query: (text, params) => pool!.query(text, params),
  });
});

after(async () => {
  if (pool) await closePool(pool);
  if (pg) await pg.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

function requireDatabase(t: TestContext): boolean {
  if (pool) return true;
  t.skip('isolated PostgreSQL unavailable');
  return false;
}
const q = (text: string, values: unknown[] = []) => pool!.query(text, values);
const hasCode = (code: string) => (error: unknown) =>
  (error as { code?: string }).code === code;

async function thread() {
  const realm = await realmFixture('03F');
  return quotationFixture(realm, await locationChain(realm));
}
async function boundThread() {
  const f = await thread();
  const session = await bindAndAdmitFixturePic({
    quotationId: f.bundle.quotation.id, tenantCompanyId: f.company.id,
    tenantPicId: f.pic.id, buildingId: f.realm.building.id,
    spaceId: f.chain.space.id, granterUserId: adminUserId,
  });
  const found = await q(
    'SELECT id FROM handyman_pic_workspace_sessions WHERE token_hash = $1',
    [createHash('sha256').update(session.workspaceToken).digest('hex')],
  );
  return { ...f, ...session, sessionId: found.rows[0].id as string };
}
type BoundThread = Awaited<ReturnType<typeof boundThread>>;

async function inRollback<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool!.connect();
  try {
    await tx.query('BEGIN');
    return await work(tx);
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
}

/** Raw ledger input exercises the live DB floor, never disables a trigger. */
async function rawDecision(
  tx: PoolClient, f: BoundThread, decision: 'APPROVE' | 'REJECT' = 'APPROVE',
  key = randomUUID(),
) {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO handyman_quotation_decisions
       (id, client_id, quotation_id, quotation_version_id, decision,
        tenant_company_id, tenant_pic_id, decided_by_user_id, idempotency_key,
        request_fingerprint, decision_actor_type, decided_by_tenant_pic_id,
        approval_binding_id, decided_by_pic_session_id, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,'TENANT_PIC',$7,$10,$11,clock_timestamp())`,
    [id, f.realm.client.id, f.bundle.quotation.id, f.version.id, decision,
      f.company.id, f.pic.id, key,
      createHash('sha256').update(JSON.stringify([f.version.id, decision])).digest('hex'),
      f.binding.id, f.sessionId],
  );
  return id;
}
async function project(tx: PoolClient, f: BoundThread, status = 'APPROVED') {
  await tx.query('UPDATE handyman_quotation_versions SET status = $2 WHERE id = $1',
    [f.version.id, status]);
}
function scopeInput(f: BoundThread, decisionId: string): NewHandymanExecutionScope {
  return {
    clientId: f.realm.client.id, handymanRequestId: f.request.id,
    channelAttributionId: f.attribution.id, quotationId: f.bundle.quotation.id,
    approvedQuotationVersionId: f.version.id, quotationDecisionId: decisionId,
    tenantCompanyId: f.company.id, tenantPicId: f.pic.id,
    buildingId: f.realm.building.id, floorId: f.chain.floor.id,
    areaId: f.chain.area.id, roomId: f.chain.room.id, spaceId: f.chain.space.id,
    actor: { kind: 'TENANT_PIC', tenantPicId: f.pic.id, picSessionId: f.sessionId },
  };
}
async function facts(f: Awaited<ReturnType<typeof thread>>) {
  const result = await q(
    `SELECT v.status,
       (SELECT count(*)::int FROM handyman_quotation_decisions WHERE quotation_version_id = v.id) AS decisions,
       (SELECT count(*)::int FROM handyman_execution_scopes WHERE approved_quotation_version_id = v.id) AS scopes,
       (SELECT count(*)::int FROM operational_events WHERE metadata->>'quotationVersionId' = v.id::text
         AND event_type IN ('HANDYMAN_QUOTATION_APPROVED', 'HANDYMAN_QUOTATION_REJECTED', 'HANDYMAN_EXECUTION_SCOPE_CREATED')) AS journals
     FROM handyman_quotation_versions v WHERE v.id = $1`, [f.version.id],
  );
  return result.rows[0];
}
const decide = (f: BoundThread, key = randomUUID(), decision: 'APPROVE' | 'REJECT' = 'APPROVE') =>
  submitPicQuotationDecision(f.workspaceToken, f.version.id, { decision }, key);

/** Only used with the actual pre-actor migrations restored, inside ROLLBACK. */
async function legacyDecision(tx: PoolClient, f: Awaited<ReturnType<typeof thread>>) {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO handyman_quotation_decisions
       (id, client_id, quotation_id, quotation_version_id, decision, tenant_company_id,
        tenant_pic_id, decided_by_user_id, idempotency_key, request_fingerprint)
     VALUES ($1,$2,$3,$4,'APPROVE',$5,$6,$7,$8,$9)`,
    [id, f.realm.client.id, f.bundle.quotation.id, f.version.id, f.company.id,
      f.pic.id, adminUserId, randomUUID(), createHash('sha256').update('legacy-history').digest('hex')],
  );
  await tx.query("UPDATE handyman_quotation_versions SET status = 'APPROVED' WHERE id = $1", [f.version.id]);
  return id;
}

describe('W03 PART 03F — controlled migration and immutable history', () => {
  it('applies once, rolls back while empty, and restores the gate without new columns', async t => {
    if (!requireDatabase(t)) return;
    assert.deepEqual(await migrateUp(pool!), []);
    const beforeColumns = await q(`SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'handyman_execution_scopes' ORDER BY ordinal_position`);
    assert.equal(await migrateDown(pool!), gateMigration.id);
    assert.deepEqual(await migrateUp(pool!), [gateMigration.id]);
    const afterColumns = await q(`SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'handyman_execution_scopes' ORDER BY ordinal_position`);
    assert.deepEqual(afterColumns.rows, beforeColumns.rows);
    const guards = await q(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
      AND tgrelid = 'handyman_execution_scopes'::regclass ORDER BY tgname`);
    assert.deepEqual(guards.rows.map(row => row.tgname), [
      'handyman_execution_scope_approval_gate', 'handyman_execution_scope_no_write',
    ]);
  });

  it('preserves USER facts but refuses any new scope from an orphaned staff approval (A8/A9/E1)', async t => {
    if (!requireDatabase(t)) return;
    const historical = await thread();
    const orphan = await thread();
    const admitted = await admitFixturePic({
      tenantCompanyId: orphan.company.id, tenantPicId: orphan.pic.id,
      buildingId: orphan.realm.building.id, spaceId: orphan.chain.space.id,
    });
    const originalSession = await q('SELECT id FROM handyman_pic_workspace_sessions WHERE token_hash = $1',
      [createHash('sha256').update(admitted.workspaceToken).digest('hex')]);
    await inRollback(async tx => {
      // A real migration timeline, not a disabled production trigger or a
      // runtime fallback. This entire historical fixture is rolled back.
      await gateMigration.down(tx);
      await sessionLinkMigration.down(tx);
      await actorMigration.down(tx);
      const oldDecision = await legacyDecision(tx, historical);
      const orphanDecision = await legacyDecision(tx, orphan);
      const scopeId = randomUUID();
      await tx.query(
        `INSERT INTO handyman_execution_scopes
           (id, client_id, handyman_request_id, channel_attribution_id, quotation_id,
            approved_quotation_version_id, quotation_decision_id, tenant_company_id,
            tenant_pic_id, building_id, floor_id, area_id, room_id, space_id, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [scopeId, historical.realm.client.id, historical.request.id, historical.attribution.id,
          historical.bundle.quotation.id, historical.version.id, oldDecision, historical.company.id,
          historical.pic.id, historical.realm.building.id, historical.chain.floor.id,
          historical.chain.area.id, historical.chain.room.id, historical.chain.space.id, adminUserId],
      );
      const snapshotSql = `SELECT d.id, d.xmin::text AS decision_xmin, d.decided_by_user_id,
          d.decided_at, s.id AS scope_id, s.xmin::text AS scope_xmin, s.created_by_user_id,
          s.quotation_decision_id, s.created_at, s.status
        FROM handyman_quotation_decisions d JOIN handyman_execution_scopes s
          ON s.quotation_decision_id = d.id WHERE s.id = $1`;
      const original = await tx.query(snapshotSql, [scopeId]);
      await actorMigration.up(tx);
      await sessionLinkMigration.up(tx);
      await gateMigration.up(tx);
      assert.deepEqual((await tx.query(snapshotSql, [scopeId])).rows, original.rows);
      const historicalRead = await scopes.findScopeById(tx, scopeId);
      assert.equal(historicalRead?.createdByActorType, 'USER');
      assert.equal(historicalRead?.createdByTenantPicId, null);
      assert.equal(historicalRead?.createdByUserId, adminUserId);
      await assert.rejects(() => decideHandymanQuotation(orphan.version.id, {
        decision: 'APPROVE', idempotencyKey: randomUUID(),
      }, adminUserId), hasCode('PERMISSION_DENIED'));
      for (const actor of [
        { kind: 'USER', userId: adminUserId },
        { kind: 'TENANT_PIC', tenantPicId: orphan.pic.id, picSessionId: originalSession.rows[0].id as string },
      ] as const) {
        await tx.query('SAVEPOINT forged_staff_scope');
        await assert.rejects(() => scopes.insertScope(tx, {
          clientId: orphan.realm.client.id, handymanRequestId: orphan.request.id,
          channelAttributionId: orphan.attribution.id, quotationId: orphan.bundle.quotation.id,
          approvedQuotationVersionId: orphan.version.id, quotationDecisionId: orphanDecision,
          tenantCompanyId: orphan.company.id, tenantPicId: orphan.pic.id,
          buildingId: orphan.realm.building.id, floorId: orphan.chain.floor.id,
          areaId: orphan.chain.area.id, roomId: orphan.chain.room.id, spaceId: orphan.chain.space.id,
          actor,
        }), hasCode('23514'));
        await tx.query('ROLLBACK TO SAVEPOINT forged_staff_scope');
        await tx.query('RELEASE SAVEPOINT forged_staff_scope');
      }
    });
  });

  it('aborts cutover for a pre-gate PIC scope with broken provenance rather than blessing it', async t => {
    if (!requireDatabase(t)) return;
    const f = await boundThread();
    const foreign = await quotationFixture(f.realm, await locationChain(f.realm));
    await inRollback(async tx => {
      await gateMigration.down(tx);
      const id = await rawDecision(tx, f);
      await project(tx, f);
      await scopes.insertScope(tx, { ...scopeInput(f, id), handymanRequestId: foreign.request.id });
      await assert.rejects(() => gateMigration.up(tx), /cutover blocked: invalid existing PIC approval provenance/);
    });
    assert.deepEqual(await facts(f), { status: 'ISSUED', decisions: 0, scopes: 0, journals: 0 });
    assert.equal((await q(`SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgname = 'handyman_execution_scope_approval_gate'`)).rows[0].n, 1);
  });

  it('accepts an unchanged pre-gate PIC approval even after its credential is revoked', async t => {
    if (!requireDatabase(t)) return;
    const f = await boundThread();
    await inRollback(async tx => {
      await gateMigration.down(tx);
      const id = await rawDecision(tx, f);
      await project(tx, f);
      const scope = await scopes.insertScope(tx, scopeInput(f, id));
      await tx.query('UPDATE handyman_pic_workspace_sessions SET revoked_at = clock_timestamp() WHERE id = $1',
        [f.sessionId]);
      await gateMigration.up(tx);
      assert.deepEqual(await scopes.findScopeById(tx, scope.id), scope);
      assert.equal(await scopes.hasValidScopeApproval(tx, scope.id, id), true);
      assert.equal(await scopes.isNewScopeApprovalValid(tx, scopeInput(f, id)), false);
    });
  });
});

describe('W03 PART 03F — service preflight and independent PostgreSQL INSERT floor', () => {
  it('re-reads the exact decision in the service, and refuses USER or fabricated approval input', async t => {
    if (!requireDatabase(t)) return;
    const f = await boundThread();
    await inRollback(async tx => {
      const id = await rawDecision(tx, f);
      await project(tx, f);
      const input = scopeInput(f, id);
      const args = {
        ...input, derivedBuildingId: input.buildingId, derivedSpaceId: input.spaceId,
        decisionTenantPicId: f.pic.id,
      };
      assert.deepEqual(await buildExecutionScopeInput(tx, args), input);
      for (const forged of [
        { ...args, quotationDecisionId: randomUUID() },
        { ...args, actor: { kind: 'USER' as const, userId: adminUserId }, decisionTenantPicId: null },
        { ...args, tenantCompanyId: randomUUID() },
        { ...args, actor: { ...input.actor, kind: 'TENANT_PIC' as const,
          tenantPicId: f.pic.id, picSessionId: randomUUID() } },
      ]) {
        await assert.rejects(() => buildExecutionScopeInput(tx, forged), hasCode('HANDYMAN_EXECUTION_SCOPE_CONFLICT'));
      }
      assert.equal((await tx.query(`SELECT count(*)::int AS n FROM handyman_execution_scopes
        WHERE approved_quotation_version_id = $1`, [f.version.id])).rows[0].n, 0);
    });
  });

  it('refuses independently valid FKs assembled into a forged scope, without calling the service', async t => {
    if (!requireDatabase(t)) return;
    const f = await boundThread();
    const foreign = await boundThread();
    const sibling = await quotationFixture(f.realm, await locationChain(f.realm));
    await inRollback(async tx => {
      const id = await rawDecision(tx, f);
      await project(tx, f);
      const input = scopeInput(f, id);
      const cases: [string, Partial<NewHandymanExecutionScope>][] = [
        ['missing decision', { quotationDecisionId: randomUUID() }],
        ['NULL decision', { quotationDecisionId: null as unknown as string }],
        ['same-client wrong quotation', { quotationId: sibling.bundle.quotation.id }],
        ['same-client wrong version', { approvedQuotationVersionId: sibling.version.id }],
        ['same-client wrong request', { handymanRequestId: sibling.request.id }],
        ['same-client wrong attribution', { channelAttributionId: sibling.attribution.id }],
        ['foreign client', { clientId: foreign.realm.client.id }],
        ['foreign tenant', { tenantCompanyId: foreign.company.id }],
        ['fabricated lineage PIC', { tenantPicId: foreign.pic.id }],
        ['erased lineage PIC', { tenantPicId: null }],
        ['foreign building', { buildingId: foreign.realm.building.id }],
        ['wrong space', { spaceId: sibling.chain.space.id }],
        ['wrong room', { roomId: sibling.chain.room.id }],
        ['wrong area', { areaId: sibling.chain.area.id }],
        ['wrong floor', { floorId: sibling.chain.floor.id }],
        ['placeholder location', { floorId: null, areaId: null, roomId: null, spaceId: null }],
        ['staff scope on PIC approval', { actor: { kind: 'USER', userId: adminUserId } }],
        ['wrong signing PIC', { actor: {
          kind: 'TENANT_PIC', tenantPicId: foreign.pic.id, picSessionId: f.sessionId,
        } }],
        ['borrowed credential', { actor: {
          kind: 'TENANT_PIC', tenantPicId: f.pic.id, picSessionId: foreign.sessionId,
        } }],
      ];
      for (const [label, changes] of cases) {
        await t.test(label, async () => {
          await tx.query('SAVEPOINT forged_scope');
          await assert.rejects(() => scopes.insertScope(tx, { ...input, ...changes }), hasCode('23514'));
          await tx.query('ROLLBACK TO SAVEPOINT forged_scope');
          await tx.query('RELEASE SAVEPOINT forged_scope');
        });
      }
      // Positive control on the very same decision: no negative result above
      // can be explained by an unusable fixture, absent FK, or duplicate scope.
      const valid = await scopes.insertScope(tx, input);
      assert.equal(valid.quotationDecisionId, id);
      assert.equal(valid.createdByUserId, null);
      assert.equal(await scopes.hasValidScopeApproval(tx, valid.id, id), true);
      await assert.rejects(() => scopes.insertScope(tx, input), hasCode('23505'));
    });
  });

  it('refuses scope creation before projection, for REJECT, and for stale quotation states/windows', async t => {
    if (!requireDatabase(t)) return;
    const f = await boundThread();
    await inRollback(async tx => {
      const id = await rawDecision(tx, f);
      for (const status of ['ISSUED', 'DRAFT', 'EXPIRED', 'SUPERSEDED']) {
        await tx.query('SAVEPOINT stale_version');
        await project(tx, f, status);
        await assert.rejects(() => scopes.insertScope(tx, scopeInput(f, id)), hasCode('23514'));
        await tx.query('ROLLBACK TO SAVEPOINT stale_version');
        await tx.query('RELEASE SAVEPOINT stale_version');
      }
      await tx.query("UPDATE handyman_quotation_versions SET valid_until = clock_timestamp() - interval '1 second' WHERE id = $1",
        [f.version.id]);
      await assert.rejects(() => project(tx, f), hasCode('23514'));
    });
    const rejected = await boundThread();
    await inRollback(async tx => {
      const id = await rawDecision(tx, rejected, 'REJECT');
      await project(tx, rejected, 'REJECTED');
      await assert.rejects(() => scopes.insertScope(tx, scopeInput(rejected, id)), hasCode('23514'));
    });
  });

  it('rechecks live session, binding, maker-checker and occupancy rather than treating snapshot IDs as authority', async t => {
    if (!requireDatabase(t)) return;
    const f = await boundThread();
    await inRollback(async tx => {
      const id = await rawDecision(tx, f);
      await project(tx, f);
      const input = scopeInput(f, id);
      const changes: [string, string, unknown[]][] = [
        ['credential revoked', 'UPDATE handyman_pic_workspace_sessions SET revoked_at = clock_timestamp() WHERE id = $1', [f.sessionId]],
        ['PIC inactive', "UPDATE tenant_pics SET status = 'INACTIVE' WHERE id = $1", [f.pic.id]],
        ['maker-checker link captured', 'UPDATE tenant_pics SET user_id = $2 WHERE id = $1', [f.pic.id, adminUserId]],
        ['tenant inactive', "UPDATE tenant_companies SET status = 'INACTIVE' WHERE id = $1", [f.company.id]],
        ['client inactive', "UPDATE clients SET status = 'INACTIVE' WHERE id = $1", [f.realm.client.id]],
        ['building occupancy lapsed', "UPDATE tenant_building_contexts SET status = 'INACTIVE' WHERE tenant_company_id = $1", [f.company.id]],
        ['space occupancy lapsed', "UPDATE tenant_space_relationships SET status = 'INACTIVE' WHERE tenant_company_id = $1", [f.company.id]],
      ];
      for (const [label, sql, params] of changes) {
        await t.test(label, async () => {
          await tx.query('SAVEPOINT authority_changed');
          await tx.query(sql, params);
          assert.equal(await scopes.isNewScopeApprovalValid(tx, input), false);
          await assert.rejects(() => scopes.insertScope(tx, input), hasCode('23514'));
          await tx.query('ROLLBACK TO SAVEPOINT authority_changed');
          await tx.query('RELEASE SAVEPOINT authority_changed');
        });
      }
      await scopes.insertScope(tx, input);
      // B18 still forbids changing the binding once its decision exists.
      await assert.rejects(() => tx.query(
        "UPDATE handyman_quotation_approval_bindings SET status = 'REVOKED', revoked_by_user_id = $2, revoked_at = clock_timestamp() WHERE id = $1",
        [f.binding.id, adminUserId],
      ), /freeze once the thread has a decision/);
    });
  });
});

describe('W03 PART 03F — atomic approval, replay and concurrency', () => {
  it('creates one PIC scope, permits replay from a new credential, and preserves operational boundaries', async t => {
    if (!requireDatabase(t)) return;
    const f = await boundThread();
    const downstream = async () => (await q(`SELECT
      (SELECT count(*) FROM work_orders) AS fm,
      (SELECT count(*) FROM handyman_execution_scope_assignments) AS assignments,
      (SELECT count(*) FROM handyman_arrival_challenges) AS arrival,
      (SELECT count(*) FROM handyman_work_sessions) AS sessions`)).rows;
    const before = await downstream();
    const key = randomUUID();
    const first = await decide(f, key);
    assert.ok(first.executionScope);
    const stored = await scopes.findScopeById(undefined, first.executionScope.executionScopeId);
    assert.equal(stored?.quotationDecisionId, first.decision.quotationDecisionId);
    assert.equal(stored?.createdByActorType, 'TENANT_PIC');
    assert.equal(stored?.createdByUserId, null);
    assert.equal(stored?.createdByTenantPicId, f.pic.id);
    assert.equal(stored?.createdByPicSessionId, f.sessionId);
    await q('UPDATE handyman_pic_workspace_sessions SET revoked_at = clock_timestamp() WHERE id = $1', [f.sessionId]);
    const fresh = await admitFixturePic({
      tenantCompanyId: f.company.id, tenantPicId: f.pic.id,
      buildingId: f.realm.building.id, spaceId: f.chain.space.id,
    });
    const replay = await submitPicQuotationDecision(fresh.workspaceToken, f.version.id, { decision: 'APPROVE' }, key);
    assert.deepEqual(replay, first);
    assert.deepEqual(await facts(f), { status: 'APPROVED', decisions: 1, scopes: 1, journals: 2 });
    assert.deepEqual(await downstream(), before);
    assert.deepEqual(await scopes.findScopeById(undefined, stored!.id), stored);
    for (const sql of [
      "UPDATE handyman_execution_scopes SET status = 'REVOKED' WHERE id = $1",
      'UPDATE handyman_execution_scopes SET quotation_decision_id = quotation_decision_id WHERE id = $1',
      'DELETE FROM handyman_execution_scopes WHERE id = $1',
    ]) {
      await assert.rejects(() => q(sql, [stored!.id]), /immutable authority records/);
    }
    for (const sql of [
      "UPDATE handyman_quotation_versions SET status = 'ISSUED' WHERE id = $1",
      "UPDATE handyman_quotation_versions SET valid_until = valid_until + interval '1 hour' WHERE id = $1",
    ]) {
      await assert.rejects(() => q(sql, [f.version.id]), hasCode('23514'));
    }
  });

  it('keeps an existing approval valid after the offer expires instead of turning it into an execution lease', async t => {
    if (!requireDatabase(t)) return;
    const f = await boundThread();
    await q("UPDATE handyman_quotation_versions SET valid_until = clock_timestamp() + interval '2 seconds' WHERE id = $1", [f.version.id]);
    const key = randomUUID();
    const approved = await decide(f, key);
    await q(`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM
      (valid_until - clock_timestamp()))) + 0.05) FROM handyman_quotation_versions WHERE id = $1`, [f.version.id]);
    assert.deepEqual(await decide(f, key), approved);
    assert.deepEqual(await facts(f), { status: 'APPROVED', decisions: 1, scopes: 1, journals: 2 });
  });

  it('never repairs an APPROVE orphan on replay or by a delayed raw INSERT', async t => {
    if (!requireDatabase(t)) return;
    const f = await boundThread();
    const key = randomUUID();
    const tx = await pool!.connect();
    let id = '';
    try {
      await tx.query('BEGIN');
      id = await rawDecision(tx, f, 'APPROVE', key);
      await project(tx, f);
      // Represents an already broken/pre-cutover fact, not a supported writer.
      await tx.query('COMMIT');
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
    const before = await facts(f);
    await assert.rejects(() => decide(f, key), hasCode('HANDYMAN_QUOTATION_DECISION_CONFLICT'));
    await inRollback(async connection => {
      assert.equal(await scopes.isNewScopeApprovalValid(connection, scopeInput(f, id)), false);
      await assert.rejects(() => scopes.insertScope(connection, scopeInput(f, id)), hasCode('23514'));
    });
    assert.deepEqual(await facts(f), before);
    assert.equal(before.scopes, 0);
  });

  it('rolls back ledger, lifecycle, scope and journals on a DB-floor refusal; same-key retry is safe', async t => {
    if (!requireDatabase(t)) return;
    const f = await boundThread();
    const foreign = await quotationFixture(f.realm, await locationChain(f.realm));
    const original = scopes.insertScope;
    const injection = t.mock.method(scopes, 'insertScope', async (tx: PoolClient, input: NewHandymanExecutionScope) =>
      original(tx, { ...input, handymanRequestId: foreign.request.id }));
    const key = randomUUID();
    const before = await facts(f);
    const preflight = t.mock.method(scopes, 'isNewScopeApprovalValid', async () => false);
    await assert.rejects(() => decide(f, key), hasCode('HANDYMAN_QUOTATION_DECISION_CONFLICT'));
    assert.equal(injection.mock.callCount(), 0, 'service refusal precedes INSERT');
    assert.deepEqual(await facts(f), before);
    preflight.mock.restore();
    await assert.rejects(() => decide(f, key), hasCode('HANDYMAN_QUOTATION_DECISION_CONFLICT'));
    assert.equal(injection.mock.callCount(), 1, 'service preflight passed before the injected bad INSERT');
    assert.deepEqual(await facts(f), before);
    injection.mock.restore();
    const retried = await decide(f, key);
    assert.ok(retried.executionScope);
    assert.deepEqual(await facts(f), { status: 'APPROVED', decisions: 1, scopes: 1, journals: 2 });
  });

  it('rechecks the actual clock at INSERT if quote validity lapses after the service preflight', async t => {
    if (!requireDatabase(t)) return;
    const f = await boundThread();
    await q("UPDATE handyman_quotation_versions SET valid_until = clock_timestamp() + interval '1 second' WHERE id = $1", [f.version.id]);
    const original = scopes.insertScope;
    const delayed = t.mock.method(scopes, 'insertScope', async (tx: PoolClient, input: NewHandymanExecutionScope) => {
      await tx.query(`SELECT pg_sleep(GREATEST(0,
        EXTRACT(EPOCH FROM (valid_until - clock_timestamp()))) + 0.05)
        FROM handyman_quotation_versions WHERE id = $1`, [f.version.id]);
      return original(tx, input);
    });
    await assert.rejects(() => decide(f), hasCode('HANDYMAN_QUOTATION_DECISION_CONFLICT'));
    assert.equal(delayed.mock.callCount(), 1);
    assert.deepEqual(await facts(f), { status: 'ISSUED', decisions: 0, scopes: 0, journals: 0 });
  });

  it('keeps REJECT scope-free and refuses forged terminal projection without a decision', async t => {
    if (!requireDatabase(t)) return;
    const f = await boundThread();
    for (const status of ['ISSUED', 'APPROVED', 'REJECTED']) {
      await assert.rejects(() => q(`INSERT INTO handyman_quotation_versions
        (id, quotation_id, version_number, status, created_by_user_id)
        VALUES ($1,$2,2,$3,$4)`, [randomUUID(), f.bundle.quotation.id, status, adminUserId]), hasCode('23514'));
    }
    await assert.rejects(() => q("UPDATE handyman_quotation_versions SET status = 'APPROVED' WHERE id = $1", [f.version.id]),
      hasCode('23514'));
    await assert.rejects(() => q("UPDATE handyman_quotation_versions SET status = 'REJECTED' WHERE id = $1", [f.version.id]),
      hasCode('23514'));
    const key = randomUUID();
    const rejected = await decide(f, key, 'REJECT');
    assert.equal(rejected.executionScope, null);
    assert.deepEqual(await decide(f, key, 'REJECT'), rejected);
    assert.deepEqual(await facts(f), { status: 'REJECTED', decisions: 1, scopes: 0, journals: 1 });
    await assert.rejects(() => decide(f, key, 'APPROVE'), hasCode('HANDYMAN_QUOTATION_DECISION_CONFLICT'));
  });

  it('serializes two live PIC credentials: same-key replay is one fact; competing decisions cannot double-authorize', async t => {
    if (!requireDatabase(t)) return;
    for (const sameKey of [true, false]) {
      const f = await boundThread();
      const other = await admitFixturePic({
        tenantCompanyId: f.company.id, tenantPicId: f.pic.id,
        buildingId: f.realm.building.id, spaceId: f.chain.space.id,
      });
      const key = randomUUID();
      const results = await Promise.allSettled([
        decide(f, key),
        submitPicQuotationDecision(other.workspaceToken, f.version.id, { decision: 'APPROVE' }, sameKey ? key : randomUUID()),
      ]);
      const winners = results.filter(result => result.status === 'fulfilled');
      const losers = results.filter(result => result.status === 'rejected');
      assert.equal(winners.length, sameKey ? 2 : 1);
      assert.equal(losers.length, sameKey ? 0 : 1);
      if (sameKey) assert.deepEqual(winners[0].value, winners[1].value);
      else assert.equal(losers[0].reason.code, 'HANDYMAN_QUOTATION_DECISION_CONFLICT');
      assert.deepEqual(await facts(f), { status: 'APPROVED', decisions: 1, scopes: 1, journals: 2 });
    }
  });

  it('blocks an unauthorized version reopen waiting behind the approval transaction', async t => {
    if (!requireDatabase(t)) return;
    const f = await boundThread();
    const written = latch();
    const release = latch();
    const original = scopes.insertScope;
    t.mock.method(scopes, 'insertScope', async (tx: PoolClient, input: NewHandymanExecutionScope) => {
      const scope = await original(tx, input);
      written.resolve();
      await release.promise;
      return scope;
    });
    const rival = await pool!.connect();
    let approval: ReturnType<typeof decide> | undefined;
    let reopened: Promise<unknown> | undefined;
    try {
      await rival.query('BEGIN');
      await rival.query("SET LOCAL statement_timeout = '8s'");
      const pid = (await rival.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      approval = decide(f);
      await Promise.race([written.promise, approval.then(() => assert.fail('scope rendezvous was not reached'))]);
      reopened = rival.query("UPDATE handyman_quotation_versions SET status = 'ISSUED' WHERE id = $1", [f.version.id])
        .catch((error: unknown) => error);
      await waitForBlock(pid);
      release.resolve();
      assert.ok((await approval).executionScope);
      assert.equal((await reopened as { code?: string }).code, '23514');
      assert.deepEqual(await facts(f), { status: 'APPROVED', decisions: 1, scopes: 1, journals: 2 });
    } finally {
      release.resolve();
      await approval?.catch(() => undefined);
      await reopened;
      await rival.query('ROLLBACK');
      rival.release();
    }
  });

  it('refuses rollback after PIC facts exist without modifying their history', async t => {
    if (!requireDatabase(t)) return;
    const before = await q('SELECT count(*)::int AS n FROM handyman_execution_scopes');
    assert.ok(before.rows[0].n > 0);
    await inRollback(async tx => {
      await assert.rejects(() => gateMigration.down(tx), /forward-fix only/);
    });
    assert.deepEqual((await q('SELECT count(*)::int AS n FROM handyman_execution_scopes')).rows, before.rows);
    // The aggregate review predicate is usable in a genuinely read-only
    // transaction, including scopes whose original credential/window lapsed.
    await inRollback(async tx => {
      await tx.query('SET TRANSACTION READ ONLY');
      const audit = await tx.query(`SELECT count(*)::int AS invalid
        FROM handyman_execution_scopes s WHERE s.created_by_actor_type = 'TENANT_PIC'
          AND NOT handyman_execution_scope_approval_valid(s, false)`);
      assert.equal(audit.rows[0].invalid, 0);
    });
    assert.deepEqual(await migrateUp(pool!), []);
  });
});

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Bounded, observed PostgreSQL lock wait, not a sleep-based race assertion. */
async function waitForBlock(pid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const blocked = await q('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid]);
    if (blocked.rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('expected a real PostgreSQL lock wait');
}
