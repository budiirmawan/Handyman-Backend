import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { createAdminUser } from './helpers/access';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { baseFixture, initHandymanFixtures }
  from './helpers/handyman-fixtures';
import { userService } from '../src/modules/users';
import { AppError, ERROR_CODES } from '../src/shared/errors';
import {
  acceptHandymanBast,
  issueHandymanBast,
  prepareHandymanBast,
  rejectHandymanBast,
  voidHandymanBast,
} from '../src/modules/handyman-bast';
import {
  startHandymanServiceWarranty,
  expireHandymanServiceWarranty,
  evaluateHandymanServiceWarrantyEligibility,
  HANDYMAN_NOT_SERVICE_WARRANTY_START,
  HANDYMAN_SERVICE_WARRANTY_START_SOURCES,
  HANDYMAN_SERVICE_WARRANTY_COVERAGE_TYPES,
  HANDYMAN_SERVICE_WARRANTY_EVENT_TYPES,
  HANDYMAN_SERVICE_WARRANTY_PART01_STATUSES,
  HANDYMAN_SERVICE_WARRANTY_STATUSES,
  nextHandymanServiceWarrantyStatus,
  isNotServiceWarrantyStartAlias,
} from '../src/modules/handyman-service-warranties';

/**
 * CR-HM-15 PART 01 — service warranty FOUNDATION only.
 * Eligibility/start derives from ACCEPTED BAST; the original BAST and
 * service history stay untouched. No claim/rework execution, no
 * pricing/payment/settlement, no FM/SaaS, no HTTP.
 */

const DIR = '/tmp/hm15-part01-pg';
const PORT = 55497;
Object.assign(process.env, {
  NODE_ENV: 'test', LOG_LEVEL: 'error', DB_NAME: 'asentra_test',
  DB_HOST: '127.0.0.1', DB_PORT: String(PORT), DB_USER: 'postgres',
  DB_PASSWORD: 'postgres', DB_SSL: 'false',
});
let pg: EmbeddedPostgres;
let pool: Pool;
let actor: string;
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
const id = () => randomUUID();
const hasCode = (code: string) =>
  (err: unknown) => err instanceof AppError && err.code === code;

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  pg = new EmbeddedPostgres({ databaseDir: DIR, port: PORT,
    user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
  await pg.initialise();
  await pg.start();
  const admin = pg.getPgClient('postgres', '127.0.0.1');
  await admin.connect();
  await admin.query('CREATE DATABASE asentra_test');
  await admin.end();
  const { ensureTestDatabase } = await import('./helpers/postgres');
  const config = await ensureTestDatabase();
  assert.ok(config, 'embedded PostgreSQL must be available');
  pool = await initDatabase(config);
  await migrateUp(pool);
  actor = (await createAdminUser()).userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined, 'GENERAL_HANDYMAN');
  assert.ok(discipline);
  initHandymanFixtures({ adminUserId: actor, disciplineId: discipline.id,
    query: q });
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
});

const bastRow = async (bastId: string) =>
  (await q(`SELECT status, accepted_at, rejected_at, voided_at, client_id,
                   execution_scope_id
              FROM handyman_bast_documents WHERE id=$1`, [bastId])).rows[0];

/** A scope whose BAST is advanced to the requested status. */
async function bastFixture(
  status: 'DRAFT' | 'ISSUED' | 'ACCEPTED' | 'REJECTED' | 'VOID' = 'ACCEPTED',
) {
  const { realm, scope } = await baseFixture();
  const prepared = await prepareHandymanBast(actor, {
    executionScopeId: scope.id, idempotencyKey: id(),
  });
  if (status === 'DRAFT') return { realm, scope, bast: prepared.bast };
  await issueHandymanBast(actor, {
    bastId: prepared.bast.id, idempotencyKey: id(),
  });
  if (status === 'ISSUED') return { realm, scope, bast: prepared.bast };
  if (status === 'VOID') {
    await voidHandymanBast(actor, {
      bastId: prepared.bast.id, idempotencyKey: id(),
    });
    return { realm, scope, bast: prepared.bast };
  }
  const signed = status === 'ACCEPTED'
    ? await acceptHandymanBast(actor, { bastId: prepared.bast.id,
      idempotencyKey: id(), signatureDigest: `sig-${id()}` })
    : await rejectHandymanBast(actor, { bastId: prepared.bast.id,
      idempotencyKey: id(), signatureDigest: '' });
  return { realm, scope, bast: signed.bast };
}

/** An ACCEPTED BAST reached after the scope's first BAST was VOID. */
async function acceptedBastAfterVoid() {
  const { realm, scope } = await baseFixture();
  const first = await prepareHandymanBast(actor, {
    executionScopeId: scope.id, idempotencyKey: id(),
  });
  await issueHandymanBast(actor, {
    bastId: first.bast.id, idempotencyKey: id(),
  });
  await voidHandymanBast(actor, {
    bastId: first.bast.id, idempotencyKey: id(),
  });
  const second = await prepareHandymanBast(actor, {
    executionScopeId: scope.id, idempotencyKey: id(),
  });
  await issueHandymanBast(actor, {
    bastId: second.bast.id, idempotencyKey: id(),
  });
  const signed = await acceptHandymanBast(actor, {
    bastId: second.bast.id, idempotencyKey: id(),
    signatureDigest: `sig-${id()}`,
  });
  return { realm, scope, bast: signed.bast };
}

describe('CR-HM-15 PART 01 service warranty lifecycle guards', () => {
  it('freezes vocabulary', () => {
    assert.deepEqual([...HANDYMAN_SERVICE_WARRANTY_STATUSES], [
      'INELIGIBLE', 'ACTIVE', 'CLAIM_OPEN', 'CLAIM_APPROVED',
      'CLAIM_REJECTED', 'REWORK_IN_PROGRESS', 'REWORK_COMPLETE', 'EXPIRED',
    ]);
    assert.deepEqual([...HANDYMAN_SERVICE_WARRANTY_PART01_STATUSES],
      ['ACTIVE', 'EXPIRED']);
    assert.deepEqual([...HANDYMAN_SERVICE_WARRANTY_COVERAGE_TYPES],
      ['WORKMANSHIP', 'MATERIAL']);
    assert.deepEqual([...HANDYMAN_SERVICE_WARRANTY_EVENT_TYPES],
      ['START', 'EXPIRE']);
    assert.deepEqual([...HANDYMAN_SERVICE_WARRANTY_START_SOURCES],
      ['ACCEPTED_BAST']);
  });

  it('derives eligibility ONLY from ACCEPTED BAST', () => {
    assert.equal(evaluateHandymanServiceWarrantyEligibility('ACCEPTED'),
      'ELIGIBLE');
    for (const status of ['DRAFT', 'ISSUED', 'REJECTED', 'VOID'] as const) {
      assert.equal(
        evaluateHandymanServiceWarrantyEligibility(status), 'INELIGIBLE');
    }
    // Session COMPLETE / CHECK_OUT / quotation approval / QC PASS / FM
    // asset warranty are never a warranty-start source.
    for (const alias of HANDYMAN_NOT_SERVICE_WARRANTY_START) {
      assert.equal(isNotServiceWarrantyStartAlias(alias), true);
    }
    assert.equal(isNotServiceWarrantyStartAlias('ACCEPTED_BAST'), false);
  });

  it('START is legal only from INELIGIBLE; EXPIRE only from ACTIVE', () => {
    assert.equal(nextHandymanServiceWarrantyStatus('INELIGIBLE', 'START'),
      'ACTIVE');
    assert.equal(nextHandymanServiceWarrantyStatus('ACTIVE', 'EXPIRE'),
      'EXPIRED');
    for (const from of ['ACTIVE', 'CLAIM_OPEN', 'EXPIRED'] as const) {
      assert.throws(() => nextHandymanServiceWarrantyStatus(from, 'START'),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_ILLEGAL_TRANSITION));
    }
    for (const from of ['INELIGIBLE', 'CLAIM_OPEN', 'CLAIM_APPROVED',
      'REWORK_IN_PROGRESS', 'EXPIRED'] as const) {
      assert.throws(() => nextHandymanServiceWarrantyStatus(from, 'EXPIRE'),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_ILLEGAL_TRANSITION));
    }
    // Claim/rework execution does not exist in PART 01.
    assert.throws(
      () => nextHandymanServiceWarrantyStatus('ACTIVE', 'CLAIM_SUBMIT'),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_ILLEGAL_TRANSITION));
    assert.throws(
      () => nextHandymanServiceWarrantyStatus('ACTIVE', 'REWORK_START'),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_ILLEGAL_TRANSITION));
  });
});

describe('CR-HM-15 PART 01 service warranty persistence', () => {
  it('starts ONLY from an ACCEPTED BAST and binds the acceptance instant',
    async () => {
      const { scope, bast } = await bastFixture('ACCEPTED');
      const before = await bastRow(bast.id);
      const result = await startHandymanServiceWarranty(
        { executionScopeId: scope.id, idempotencyKey: id() }, actor);
      assert.equal(result.replayed, false);
      assert.equal(result.warranty.status, 'ACTIVE');
      assert.equal(result.warranty.bastId, bast.id);
      assert.equal(result.warranty.executionScopeId, scope.id);
      // The start boundary IS the recorded acceptance instant.
      assert.equal(result.warranty.startsAt.getTime(),
        result.warranty.bastAcceptedAt.getTime());
      assert.equal(result.warranty.startsAt.getTime(),
        new Date(before.accepted_at).getTime());
      assert.equal(result.warranty.expiredAt, null);
      assert.deepEqual(
        result.coverages.map((c) => c.coverageType).sort(),
        ['MATERIAL', 'WORKMANSHIP']);
      assert.equal(result.event.eventType, 'START');
      // The original BAST / service history is untouched.
      assert.deepEqual(await bastRow(bast.id), before);
      const reloaded = (await q(
        `SELECT id FROM handyman_service_warranties
          WHERE execution_scope_id=$1`, [scope.id])).rows[0];
      assert.equal(reloaded?.id, result.warranty.id);
    });

  it('never starts from DRAFT / ISSUED / REJECTED / VOID BAST', async () => {
    for (const status of ['DRAFT', 'ISSUED', 'REJECTED', 'VOID'] as const) {
      const { scope, bast } = await bastFixture(status);
      const before = await bastRow(bast.id);
      await assert.rejects(
        startHandymanServiceWarranty(
          { executionScopeId: scope.id, idempotencyKey: id() }, actor),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_NOT_ELIGIBLE),
        `status=${status}`,
      );
      assert.equal(
        (await q(`SELECT count(*)::int AS n FROM handyman_service_warranties
                   WHERE execution_scope_id=$1`, [scope.id])).rows[0].n, 0,
        `status=${status}`);
      assert.equal(
        (await q(`SELECT id FROM handyman_service_warranties
                   WHERE execution_scope_id=$1`, [scope.id])).rows.length, 0,
        `status=${status}`);
      assert.deepEqual(await bastRow(bast.id), before, `status=${status}`);
    }
  });

  it('is idempotent, one warranty per scope, and one per BAST', async () => {
    const { scope, bast } = await bastFixture('ACCEPTED');
    const before = await bastRow(bast.id);
    const key = id();
    const first = await startHandymanServiceWarranty(
      { executionScopeId: scope.id, idempotencyKey: key }, actor);
    const replay = await startHandymanServiceWarranty(
      { executionScopeId: scope.id, idempotencyKey: key }, actor);
    assert.equal(replay.replayed, true);
    assert.equal(replay.warranty.id, first.warranty.id);
    assert.equal(replay.event.id, first.event.id);
    assert.equal(replay.coverages.length, 2);
    await assert.rejects(startHandymanServiceWarranty(
      { executionScopeId: scope.id, idempotencyKey: id() }, actor),
    hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_ACTIVE_CONFLICT));
    assert.equal(
      (await q(`SELECT count(*)::int AS n FROM handyman_service_warranties
                 WHERE execution_scope_id=$1`, [scope.id])).rows[0].n, 1);
    assert.equal(
      (await q(`SELECT count(*)::int AS n
                  FROM handyman_service_warranty_coverages WHERE warranty_id=$1`,
      [first.warranty.id])).rows[0].n, 2);
    // ONE warranty per BAST is structural (UNIQUE index).
    const unique = await q(
      `SELECT count(*)::int AS n FROM pg_indexes
        WHERE tablename='handyman_service_warranties'
          AND indexdef ILIKE '%bast_id%' AND indexdef ILIKE '%unique%'`);
    assert.ok(unique.rows[0].n >= 1);
    assert.deepEqual(await bastRow(bast.id), before);
  });

  it('requires a caller with client access', async () => {
    const { scope } = await bastFixture('ACCEPTED');
    const outsider = await userService.createUser({
      email: `outsider-${id().slice(0, 8)}@example.com`,
      displayName: 'Outsider',
    });
    await assert.rejects(
      startHandymanServiceWarranty(
        { executionScopeId: scope.id, idempotencyKey: id() }, outsider.id),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_NOT_AUTHORIZED),
    );
    assert.equal(
      (await q(`SELECT count(*)::int AS n FROM handyman_service_warranties
                 WHERE execution_scope_id=$1`, [scope.id])).rows[0].n, 0);
  });

  it('requires BOTH coverages, append-only history and immutable identity',
    async () => {
      const { realm, scope, bast } = await bastFixture('ACCEPTED');
      const started = await startHandymanServiceWarranty(
        { executionScopeId: scope.id, idempotencyKey: id() }, actor);
      const warrantyId = started.warranty.id;

      // A warranty that never receives its two coverage rows can never
      // become durable (deferred law at COMMIT). Client, scope and the
      // start boundary are read from the BAST row, as the command does.
      const other = await acceptedBastAfterVoid();
      await assert.rejects(q(
        `INSERT INTO handyman_service_warranties
           (id, client_id, execution_scope_id, bast_id, bast_accepted_at,
            status, starts_at, started_by_user_id)
         SELECT $1, b.client_id, b.execution_scope_id, b.id, b.accepted_at,
                'ACTIVE', b.accepted_at, $2
           FROM handyman_bast_documents b WHERE b.id = $3`,
        [id(), actor, other.bast.id]),
      /BOTH workmanship and material coverage/);
      // Only ONE coverage is not enough either.
      await assert.rejects(q(
        `WITH w AS (
           INSERT INTO handyman_service_warranties
             (id, client_id, execution_scope_id, bast_id, bast_accepted_at,
              status, starts_at, started_by_user_id)
           SELECT $1, b.client_id, b.execution_scope_id, b.id, b.accepted_at,
                  'ACTIVE', b.accepted_at, $2
             FROM handyman_bast_documents b WHERE b.id = $3
           RETURNING id, client_id, execution_scope_id)
         INSERT INTO handyman_service_warranty_coverages
           (id, client_id, warranty_id, execution_scope_id, coverage_type)
         SELECT $4, client_id, id, execution_scope_id, 'WORKMANSHIP' FROM w`,
        [id(), actor, other.bast.id, id()]),
      /BOTH workmanship and material coverage/);

      // Non-ACCEPTED BAST cannot anchor a warranty even by raw SQL.
      const rejected = await bastFixture('REJECTED');
      assert.equal(rejected.bast.status, 'REJECTED');
      await assert.rejects(q(
        `INSERT INTO handyman_service_warranties
           (id, client_id, execution_scope_id, bast_id, bast_accepted_at,
            status, starts_at, started_by_user_id)
         SELECT $1, b.client_id, b.execution_scope_id, b.id, b.accepted_at,
                'ACTIVE', b.accepted_at, $2
           FROM handyman_bast_documents b WHERE b.id = $3`,
        [id(), actor, rejected.bast.id]),
      /ACCEPTED BAST/);

      // Coverages and events are append-only.
      await assert.rejects(q(
        `UPDATE handyman_service_warranty_coverages
            SET coverage_type='MATERIAL' WHERE id=$1`,
        [started.coverages[0].id]), /append-only/);
      await assert.rejects(q(
        `DELETE FROM handyman_service_warranty_coverages WHERE id=$1`,
        [started.coverages[0].id]), /append-only/);
      await assert.rejects(q(
        `UPDATE handyman_service_warranty_events SET event_type='EXPIRE'
          WHERE id=$1`, [started.event.id]), /append-only/);
      await assert.rejects(q(
        `DELETE FROM handyman_service_warranty_events WHERE id=$1`,
        [started.event.id]), /append-only/);

      // Identity is immutable and the head can never be deleted.
      await assert.rejects(q(
        `UPDATE handyman_service_warranties SET starts_at=NOW()
          WHERE id=$1`, [warrantyId]), /immutable/);
      await assert.rejects(q(
        `UPDATE handyman_service_warranties SET bast_id=$2 WHERE id=$1`,
        [warrantyId, id()]), /immutable/);
      await assert.rejects(q(
        `DELETE FROM handyman_service_warranties WHERE id=$1`,
        [warrantyId]), /preserved/);

      // Frozen status vocabulary: no invented status value.
      await assert.rejects(q(
        `UPDATE handyman_service_warranties SET status='REWORK_CHARGEABLE'
          WHERE id=$1`, [warrantyId]), /handyman_service_warranty_status_check/);

      // Service history: the accepted BAST is unchanged by all of this.
      const bastAfter = await bastRow(bast.id);
      assert.equal(bastAfter.status, 'ACCEPTED');
      assert.ok(bastAfter.accepted_at);
    });

  it('expires ACTIVE → EXPIRED as an append-only, idempotent fact',
    async () => {
      const { scope } = await bastFixture('ACCEPTED');
      const started = await startHandymanServiceWarranty(
        { executionScopeId: scope.id, idempotencyKey: id() }, actor);
      const key = id();
      const expired = await expireHandymanServiceWarranty(
        { warrantyId: started.warranty.id, idempotencyKey: key }, actor);
      assert.equal(expired.replayed, false);
      assert.equal(expired.warranty.status, 'EXPIRED');
      assert.ok(expired.warranty.expiredAt instanceof Date);
      assert.equal(expired.event.eventType, 'EXPIRE');
      assert.equal(expired.coverages.length, 2);
      const replay = await expireHandymanServiceWarranty(
        { warrantyId: started.warranty.id, idempotencyKey: key }, actor);
      assert.equal(replay.replayed, true);
      assert.equal(replay.event.id, expired.event.id);
      await assert.rejects(expireHandymanServiceWarranty(
        { warrantyId: started.warranty.id, idempotencyKey: id() }, actor),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_ILLEGAL_TRANSITION));
      const reloaded = (await q(
        `SELECT status, starts_at FROM handyman_service_warranties
          WHERE execution_scope_id=$1`, [scope.id])).rows[0];
      assert.equal(reloaded?.status, 'EXPIRED');
      assert.equal(new Date(reloaded?.starts_at).getTime(),
        started.warranty.startsAt.getTime());
      assert.equal(
        (await q(`SELECT count(*)::int AS n FROM handyman_service_warranty_events
                   WHERE warranty_id=$1 AND event_type='EXPIRE'`,
        [started.warranty.id])).rows[0].n, 1);
    });

  it('keeps zero FM / SaaS coupling and no ledger vocabulary', async () => {
    const fks = await q(
      `SELECT c.conrelid::regclass::text AS tbl,
              c.confrelid::regclass::text AS target
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid::regclass::text IN (
            'handyman_service_warranties',
            'handyman_service_warranty_coverages',
            'handyman_service_warranty_events')`);
    assert.ok(fks.rows.length > 0);
    for (const row of fks.rows) {
      assert.ok(
        /^(handyman_(service_warrant(y|ies)|bast_documents|execution_scopes)|clients|users)$/
          .test(row.target),
        `unexpected FK target ${row.tbl} -> ${row.target}`);
    }
    // Scoped to PART 01's OWN tables (the same three as the FK scan
    // above): later PARTs legitimately own claim_id / rework_id columns
    // in their own families, and this law must never read them as PART
    // 01 vocabulary.
    const columns = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN (
          'handyman_service_warranties',
          'handyman_service_warranty_coverages',
          'handyman_service_warranty_events')`);
    for (const name of columns.rows.map((r) => r.column_name)) {
      assert.ok(
        !/amount|price|currency|charge|payment|settle|claim|rework|invoice|asset/
          .test(name),
        `firewall vocabulary leaked into column ${name}`);
    }
  });
});
