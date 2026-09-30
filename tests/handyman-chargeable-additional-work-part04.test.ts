import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { createAdminUser } from './helpers/access';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { baseFixture, crewFixture, initHandymanFixtures }
  from './helpers/handyman-fixtures';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import { userService } from '../src/modules/users';
import { AppError, ERROR_CODES } from '../src/shared/errors';
import {
  acceptHandymanBast,
  issueHandymanBast,
  prepareHandymanBast,
} from '../src/modules/handyman-bast';
import { startHandymanServiceWarranty }
  from '../src/modules/handyman-service-warranties';
import {
  openHandymanServiceWarrantyClaim,
  submitHandymanServiceWarrantyClaim,
  approveHandymanServiceWarrantyClaim,
  rejectHandymanServiceWarrantyClaim,
} from '../src/modules/handyman-service-warranty-claims';
import { createHandymanEvidenceRecord }
  from '../src/modules/handyman-evidence-qc';
import {
  proposeHandymanServiceWarrantyRework,
  authorizeHandymanServiceWarrantyRework,
} from '../src/modules/handyman-service-warranty-reworks';
import {
  proposeHandymanChargeableAdditionalWork,
  acceptHandymanChargeableAdditionalWork,
  rejectHandymanChargeableAdditionalWork,
  getHandymanChargeableAdditionalWorkById,
  findHandymanChargeableAdditionalWorkByClaimId,
  listHandymanChargeableAdditionalWorks,
  getHandymanChargeablePaymentTrigger,
  assertHandymanChargeableAdditionalWorkIntakeEligible,
  assertHandymanChargeableAdditionalWorkFreeReworkSeparated,
  nextHandymanChargeableAdditionalWorkStatus,
  nextHandymanChargeableAdditionalWorkHeadStatus,
  isNotChargeableAdditionalWorkAuthorityAlias,
  HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_STATUSES,
  HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_EVENT_TYPES,
  HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_ACTIONS,
  HANDYMAN_NOT_CHARGEABLE_ADDITIONAL_WORK_AUTHORITY,
} from '../src/modules/handyman-chargeable-additional-works';
import { HANDYMAN_SERVICE_WARRANTY_REWORK_STATUSES }
  from '../src/modules/handyman-service-warranty-reworks';

/**
 * CR-HM-15 PART 04 — CHARGEABLE ADDITIONAL-WORK SEPARATION only: a
 * SEPARATE record family for the APPROVED-or-REJECTED claim path,
 * binding to the claim, its service warranty and ORIGINAL execution scope
 * / BAST. Free warranty rework is never converted into chargeable work
 * (B8); the warranty head is never mutated; acceptance emits the
 * separation fact + the CR-HM-13 payment trigger fact and nothing else.
 * No amount/pricing, no ledger/payment/settlement, no FM/SaaS, no HTTP.
 */

const DIR = '/tmp/hm15-part04-pg';
const PORT = 55498;
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
  (await q(`SELECT * FROM handyman_bast_documents WHERE id=$1`,
    [bastId])).rows[0];

const warrantyRow = async (warrantyId: string) =>
  (await q(`SELECT * FROM handyman_service_warranties WHERE id=$1`,
    [warrantyId])).rows[0];

const claimRow = async (claimId: string) =>
  (await q(`SELECT * FROM handyman_service_warranty_claims WHERE id=$1`,
    [claimId])).rows[0];

const reworkRows = async (claimId: string) =>
  (await q(`SELECT * FROM handyman_service_warranty_reworks
             WHERE claim_id=$1`, [claimId])).rows;

/** Runs raw SQL in ONE explicit transaction (deferred guards fire). */
async function rawTx(
  fn: (client: { query: (sql: string, params?: unknown[]) => Promise<
    { rows: unknown[] }> }) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** A started ACTIVE warranty (ACCEPTED BAST) plus the scope's crew. */
async function warrantyFixture() {
  const { realm, scope } = await baseFixture();
  const crew = await crewFixture(realm);
  await assignHandymanExecutionScopeCrew({
    executionScopeId: scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, actor);
  const prepared = await prepareHandymanBast(actor, {
    executionScopeId: scope.id, idempotencyKey: id(),
  });
  await issueHandymanBast(actor, {
    bastId: prepared.bast.id, idempotencyKey: id(),
  });
  const signed = await acceptHandymanBast(actor, {
    bastId: prepared.bast.id, idempotencyKey: id(),
    signatureDigest: `sig-${id()}`,
  });
  const started = await startHandymanServiceWarranty(
    { executionScopeId: scope.id, idempotencyKey: id() }, actor);
  return {
    realm, scope, bast: signed.bast, warranty: started.warranty,
    leadUserId: crew.leadUser.id,
  };
}

/** The claim's own CR-HM-10 evidence (read-only for CR-HM-15). */
async function claimEvidence(scopeId: string, leadUserId: string) {
  const created = await createHandymanEvidenceRecord({
    executionScopeId: scopeId,
    stage: 'DEFECT' as never,
    description: 'warranty claim evidence',
    idempotencyKey: id(),
  }, leadUserId);
  return created.record.id;
}

type WarrantyFixture = Awaited<ReturnType<typeof warrantyFixture>>;

/** Fixture + an APPROVED claim (free rework not proposed). */
async function approvedClaimFixture() {
  const f: WarrantyFixture = await warrantyFixture();
  const opened = await openHandymanServiceWarrantyClaim(actor, {
    warrantyId: f.warranty.id, idempotencyKey: id(),
    evidenceRecordId: await claimEvidence(f.scope.id, f.leadUserId),
  });
  await submitHandymanServiceWarrantyClaim(actor, {
    claimId: opened.claim.id, idempotencyKey: id(),
  });
  const approved = await approveHandymanServiceWarrantyClaim(actor, {
    claimId: opened.claim.id, idempotencyKey: id(),
    decisionNote: 'Workmanship defect confirmed.',
  });
  return { ...f, claim: approved.claim };
}

/** Fixture + a REJECTED claim ("chargeable path available"). */
async function rejectedClaimFixture() {
  const f: WarrantyFixture = await warrantyFixture();
  const opened = await openHandymanServiceWarrantyClaim(actor, {
    warrantyId: f.warranty.id, idempotencyKey: id(),
    evidenceRecordId: await claimEvidence(f.scope.id, f.leadUserId),
  });
  await submitHandymanServiceWarrantyClaim(actor, {
    claimId: opened.claim.id, idempotencyKey: id(),
  });
  const rejected = await rejectHandymanServiceWarrantyClaim(actor, {
    claimId: opened.claim.id, idempotencyKey: id(),
    decisionNote: 'Not a covered defect.',
  });
  return { ...f, claim: rejected.claim };
}

describe('CR-HM-15 PART 04 separation guards', () => {
  it('freezes vocabulary and keeps the families apart', () => {
    assert.deepEqual([...HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_STATUSES], [
      'CHARGEABLE_PROPOSED', 'CHARGEABLE_AUTHORIZED', 'CHARGEABLE_REJECTED',
    ]);
    assert.deepEqual([...HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_EVENT_TYPES], [
      'PROPOSE', 'ACCEPT', 'REJECT', 'PAYMENT_TRIGGER',
    ]);
    assert.deepEqual([...HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_ACTIONS], [
      'ACCEPT', 'REJECT',
    ]);
    // B8: the free-rework vocabulary and the chargeable vocabulary never
    // overlap — the families are structurally separate.
    for (const status of HANDYMAN_SERVICE_WARRANTY_REWORK_STATUSES) {
      assert.equal(
        (HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_STATUSES as readonly string[])
          .includes(status), false, status);
    }
    for (const status of HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_STATUSES) {
      assert.equal(
        (HANDYMAN_SERVICE_WARRANTY_REWORK_STATUSES as readonly string[])
          .includes(status), false, status);
      assert.equal(status.includes('REWORK_'), false, status);
    }
    for (const alias of HANDYMAN_NOT_CHARGEABLE_ADDITIONAL_WORK_AUTHORITY) {
      assert.equal(isNotChargeableAdditionalWorkAuthorityAlias(alias), true);
    }
    assert.equal(
      isNotChargeableAdditionalWorkAuthorityAlias('CLAIM_APPROVED'), false);
  });

  it('gates intake on payable claims and the matching warranty head', () => {
    assert.doesNotThrow(() =>
      assertHandymanChargeableAdditionalWorkIntakeEligible(
        'CLAIM_APPROVED', 'CLAIM_APPROVED'));
    assert.doesNotThrow(() =>
      assertHandymanChargeableAdditionalWorkIntakeEligible(
        'CLAIM_REJECTED', 'CLAIM_REJECTED'));
    for (const claimStatus of ['CLAIM_DRAFT', 'CLAIM_SUBMITTED',
      'CLAIM_WITHDRAWN'] as const) {
      assert.throws(() =>
        assertHandymanChargeableAdditionalWorkIntakeEligible(
          claimStatus, 'ACTIVE'),
      hasCode(ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_ELIGIBLE),
      claimStatus);
    }
    for (const warrantyStatus of ['ACTIVE', 'CLAIM_OPEN', 'EXPIRED',
      'INELIGIBLE', 'REWORK_IN_PROGRESS', 'REWORK_COMPLETE'] as const) {
      assert.throws(() =>
        assertHandymanChargeableAdditionalWorkIntakeEligible(
          'CLAIM_APPROVED', warrantyStatus),
      hasCode(ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_ELIGIBLE),
      warrantyStatus);
    }
    // An approved claim can never be carried by a rejected head.
    assert.throws(() =>
      assertHandymanChargeableAdditionalWorkIntakeEligible(
        'CLAIM_APPROVED', 'CLAIM_REJECTED'),
    hasCode(ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_ELIGIBLE));
  });

  it('freezes the decision machine and the never-moved head', () => {
    assert.equal(
      nextHandymanChargeableAdditionalWorkStatus(
        'CHARGEABLE_PROPOSED', 'ACCEPT'), 'CHARGEABLE_AUTHORIZED');
    assert.equal(
      nextHandymanChargeableAdditionalWorkStatus(
        'CHARGEABLE_PROPOSED', 'REJECT'), 'CHARGEABLE_REJECTED');
    for (const from of ['CHARGEABLE_AUTHORIZED',
      'CHARGEABLE_REJECTED'] as const) {
      for (const action of ['ACCEPT', 'REJECT']) {
        assert.throws(
          () => nextHandymanChargeableAdditionalWorkStatus(from, action),
          hasCode(ERROR_CODES
            .HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_ILLEGAL_TRANSITION),
          `${from}/${action}`);
      }
    }
    // A free-rework status is not a chargeable transition.
    for (const action of ['ACCEPT', 'REJECT']) {
      assert.throws(
        () => nextHandymanChargeableAdditionalWorkStatus(
          'REWORK_DRAFT' as never, action),
        hasCode(ERROR_CODES
          .HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_ILLEGAL_TRANSITION), action);
    }
    // The head is NEVER moved by this PART.
    for (const action of ['PROPOSE', 'ACCEPT', 'REJECT']) {
      assert.equal(
        nextHandymanChargeableAdditionalWorkHeadStatus(
          'CLAIM_APPROVED', action), 'CLAIM_APPROVED', action);
      assert.equal(
        nextHandymanChargeableAdditionalWorkHeadStatus(
          'CLAIM_REJECTED', action), 'CLAIM_REJECTED', action);
    }
    for (const head of ['ACTIVE', 'CLAIM_OPEN', 'REWORK_IN_PROGRESS',
      'REWORK_COMPLETE', 'EXPIRED', 'INELIGIBLE'] as const) {
      assert.throws(
        () => nextHandymanChargeableAdditionalWorkHeadStatus(head, 'ACCEPT'),
        hasCode(ERROR_CODES
          .HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_ILLEGAL_TRANSITION), head);
    }
    // Nothing about money is a transition here.
    assert.throws(
      () => nextHandymanChargeableAdditionalWorkHeadStatus(
        'CLAIM_APPROVED', 'PAY'),
      hasCode(ERROR_CODES
        .HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_ILLEGAL_TRANSITION));
  });

  it('never treats an accepted or executed free rework as chargeable',
    () => {
      assert.doesNotThrow(() =>
        assertHandymanChargeableAdditionalWorkFreeReworkSeparated(null));
      assert.doesNotThrow(() =>
        assertHandymanChargeableAdditionalWorkFreeReworkSeparated(
          'REWORK_DRAFT'));
      for (const status of ['REWORK_AUTHORIZED', 'REWORK_IN_PROGRESS',
        'REWORK_COMPLETE', 'REWORK_VERIFIED'] as const) {
        assert.throws(
          () => assertHandymanChargeableAdditionalWorkFreeReworkSeparated(
            status),
          hasCode(ERROR_CODES
            .HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_FREE_REWORK_CONFLICT),
          status);
      }
    });
});

describe('CR-HM-15 PART 04 separated chargeable execution', () => {
  it('binds the referral to the claim, warranty and original scope',
    async () => {
      const { scope, bast, warranty, claim } = await approvedClaimFixture();
      const bastBefore = await bastRow(bast.id);
      const warrantyBefore = await warrantyRow(warranty.id);
      const claimBefore = await claimRow(claim.id);
      const proposed = await proposeHandymanChargeableAdditionalWork(actor, {
        claimId: claim.id, idempotencyKey: id(),
        scopeNote: 'Replace the corroded valve body — chargeable.',
      });
      assert.equal(proposed.replayed, false);
      assert.equal(proposed.work.status, 'CHARGEABLE_PROPOSED');
      assert.equal(proposed.work.claimId, claim.id);
      assert.equal(proposed.work.warrantyId, warranty.id);
      assert.equal(proposed.work.executionScopeId, scope.id);
      assert.equal(proposed.work.bastId, bast.id);
      assert.equal(proposed.work.clientId, claimBefore.client_id);
      assert.equal(proposed.work.paymentTriggerEmittedAt, null);
      assert.equal(proposed.paymentTrigger, null);
      assert.equal(proposed.event.eventType, 'PROPOSE');
      // A referral is neither a warranty state nor a money state.
      assert.equal(proposed.warrantyStatus, 'CLAIM_APPROVED');
      assert.equal(proposed.claimStatus, 'CLAIM_APPROVED');
      assert.equal((await warrantyRow(warranty.id)).status, 'CLAIM_APPROVED');
      // History preserved: BAST, warranty and claim rows are untouched,
      // and the free-rework family was never written.
      assert.deepEqual(await bastRow(bast.id), bastBefore);
      assert.deepEqual(await warrantyRow(warranty.id), warrantyBefore);
      assert.deepEqual(await claimRow(claim.id), claimBefore);
      assert.deepEqual(await reworkRows(claim.id), []);
    });

  it('authorizes a separated chargeable scope and emits the CR-HM-13 trigger',
    async () => {
      const { scope, bast, warranty, claim } = await approvedClaimFixture();
      const bastBefore = await bastRow(bast.id);
      const warrantyBefore = await warrantyRow(warranty.id);
      const claimBefore = await claimRow(claim.id);
      const proposed = await proposeHandymanChargeableAdditionalWork(actor, {
        claimId: claim.id, idempotencyKey: id(),
      });
      const accepted = await acceptHandymanChargeableAdditionalWork(actor, {
        workId: proposed.work.id, idempotencyKey: id(),
      });
      assert.equal(accepted.work.status, 'CHARGEABLE_AUTHORIZED');
      assert.equal(accepted.work.decidedByUserId, actor);
      assert.ok(accepted.work.decidedAt instanceof Date);
      assert.ok(accepted.work.paymentTriggerEmittedAt instanceof Date);
      assert.equal(accepted.event.eventType, 'ACCEPT');
      assert.equal(accepted.paymentTrigger?.eventType, 'PAYMENT_TRIGGER');
      // The trigger fact is the ONLY outbound money-adjacent artifact.
      const fact = await getHandymanChargeablePaymentTrigger(proposed.work.id);
      assert.ok(fact);
      assert.equal(fact?.workId, proposed.work.id);
      assert.equal(fact?.claimId, claim.id);
      assert.equal(fact?.warrantyId, warranty.id);
      assert.equal(fact?.executionScopeId, scope.id);
      assert.equal(fact?.bastId, bast.id);
      assert.equal(fact?.eventId, accepted.paymentTrigger?.id);
      assert.equal(fact?.emittedAt.getTime(),
        accepted.work.paymentTriggerEmittedAt?.getTime());
      assert.deepEqual(Object.keys(fact ?? {}).sort(), [
        'bastId', 'claimId', 'clientId', 'emittedAt', 'eventId',
        'executionScopeId', 'warrantyId', 'workId',
      ]);
      // The head never became a chargeable or billing state.
      assert.equal(accepted.warrantyStatus, 'CLAIM_APPROVED');
      assert.equal((await warrantyRow(warranty.id)).status, 'CLAIM_APPROVED');
      assert.equal((await claimRow(claim.id)).status, 'CLAIM_APPROVED');
      assert.deepEqual(await bastRow(bast.id), bastBefore);
      assert.deepEqual(await warrantyRow(warranty.id), warrantyBefore);
      assert.deepEqual(await claimRow(claim.id), claimBefore);
    });

  it('closes a rejected referral with no payment trigger', async () => {
    const { warranty, claim } = await rejectedClaimFixture();
    const proposed = await proposeHandymanChargeableAdditionalWork(actor, {
      claimId: claim.id, idempotencyKey: id(),
    });
    const rejected = await rejectHandymanChargeableAdditionalWork(actor, {
      workId: proposed.work.id, idempotencyKey: id(),
    });
    assert.equal(rejected.work.status, 'CHARGEABLE_REJECTED');
    assert.equal(rejected.work.paymentTriggerEmittedAt, null);
    assert.equal(rejected.paymentTrigger, null);
    assert.equal(rejected.event.eventType, 'REJECT');
    assert.equal(
      await getHandymanChargeablePaymentTrigger(proposed.work.id), null);
    assert.equal(rejected.warrantyStatus, 'CLAIM_REJECTED');
    assert.equal((await warrantyRow(warranty.id)).status, 'CLAIM_REJECTED');
    // Both outcomes are final: no late authorization.
    await assert.rejects(
      acceptHandymanChargeableAdditionalWork(actor, {
        workId: proposed.work.id, idempotencyKey: id(),
      }),
      hasCode(ERROR_CODES
        .HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_ILLEGAL_TRANSITION),
    );
    assert.equal((await q(
      `SELECT count(*)::int AS n
         FROM handyman_chargeable_additional_work_events
        WHERE work_id=$1 AND event_type='PAYMENT_TRIGGER'`,
      [proposed.work.id])).rows[0].n, 0);
  });

  it('is idempotent and bounded to ONE referral per claim', async () => {
    const { warranty, claim } = await approvedClaimFixture();
    const proposeKey = id();
    const first = await proposeHandymanChargeableAdditionalWork(actor, {
      claimId: claim.id, idempotencyKey: proposeKey,
      scopeNote: 'Chargeable scope A.',
    });
    const replay = await proposeHandymanChargeableAdditionalWork(actor, {
      claimId: claim.id, idempotencyKey: proposeKey,
      scopeNote: 'Chargeable scope A.',
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.work.id, first.work.id);
    assert.equal(replay.event.id, first.event.id);
    await assert.rejects(
      proposeHandymanChargeableAdditionalWork(actor, {
        claimId: claim.id, idempotencyKey: id(),
      }),
      hasCode(ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_CONFLICT),
    );
    const acceptKey = id();
    const accepted = await acceptHandymanChargeableAdditionalWork(actor, {
      workId: first.work.id, idempotencyKey: acceptKey,
    });
    const acceptReplay = await acceptHandymanChargeableAdditionalWork(actor, {
      workId: first.work.id, idempotencyKey: acceptKey,
    });
    assert.equal(acceptReplay.replayed, true);
    assert.equal(acceptReplay.event.id, accepted.event.id);
    assert.equal(acceptReplay.paymentTrigger?.id,
      accepted.paymentTrigger?.id);
    assert.equal((await q(
      `SELECT count(*)::int AS n
         FROM handyman_chargeable_additional_works WHERE claim_id=$1`,
      [claim.id])).rows[0].n, 1);
    assert.equal(
      (await listHandymanChargeableAdditionalWorks(warranty.id)).length, 1);
    assert.equal(
      (await findHandymanChargeableAdditionalWorkByClaimId(claim.id))?.id,
      first.work.id);
    assert.equal(
      (await getHandymanChargeableAdditionalWorkById(first.work.id)).status,
      'CHARGEABLE_AUTHORIZED');
  });

  it('refuses the chargeable path for unpaid claim states and outsiders',
    async () => {
      const pending = await warrantyFixture();
      const draft = await openHandymanServiceWarrantyClaim(actor, {
        warrantyId: pending.warranty.id, idempotencyKey: id(),
        evidenceRecordId: await claimEvidence(pending.scope.id,
          pending.leadUserId),
      });
      // A DRAFT claim has no chargeable path yet …
      await assert.rejects(
        proposeHandymanChargeableAdditionalWork(actor, {
          claimId: draft.claim.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_ELIGIBLE),
      );
      // … and neither does a SUBMITTED (undecided) claim.
      await submitHandymanServiceWarrantyClaim(actor, {
        claimId: draft.claim.id, idempotencyKey: id(),
      });
      await assert.rejects(
        proposeHandymanChargeableAdditionalWork(actor, {
          claimId: draft.claim.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_ELIGIBLE),
      );
      // Foreign actor: no authority, nothing written.
      const outsider = await userService.createUser({
        email: `outsider-${id().slice(0, 8)}@example.com`,
        displayName: 'Outsider',
      });
      const eligible = await approvedClaimFixture();
      await assert.rejects(
        proposeHandymanChargeableAdditionalWork(outsider.id, {
          claimId: eligible.claim.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_AUTHORIZED),
      );
      assert.equal((await q(
        `SELECT count(*)::int AS n
           FROM handyman_chargeable_additional_works WHERE claim_id=$1`,
        [eligible.claim.id])).rows[0].n, 0);
      // Unknown referral is a bounded 404.
      await assert.rejects(
        getHandymanChargeableAdditionalWorkById(id()),
        hasCode(ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_FOUND),
      );
    });

  it('refuses chargeable work while free rework is already authorized',
    async () => {
      const { claim } = await approvedClaimFixture();
      const rework = await proposeHandymanServiceWarrantyRework(actor, {
        claimId: claim.id, idempotencyKey: id(),
      });
      // REWORK_DRAFT: the free scope is still open, the chargeable path is
      // available (the customer may yet decline the free scope) …
      const chargeable = await proposeHandymanChargeableAdditionalWork(actor, {
        claimId: claim.id, idempotencyKey: id(),
      });
      assert.equal(chargeable.work.status, 'CHARGEABLE_PROPOSED');
      // … but an AUTHORIZED free rework can never be converted.
      const second = await approvedClaimFixture();
      const secondRework = await proposeHandymanServiceWarrantyRework(actor, {
        claimId: second.claim.id, idempotencyKey: id(),
      });
      await authorizeHandymanServiceWarrantyRework(actor, {
        reworkId: secondRework.rework.id, idempotencyKey: id(),
      });
      await assert.rejects(
        proposeHandymanChargeableAdditionalWork(actor, {
          claimId: second.claim.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES
          .HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_FREE_REWORK_CONFLICT),
      );
      assert.equal((await q(
        `SELECT count(*)::int AS n
           FROM handyman_chargeable_additional_works WHERE claim_id=$1`,
        [second.claim.id])).rows[0].n, 0);
      assert.equal(secondRework.rework.status, 'REWORK_DRAFT');
      assert.equal(rework.rework.status, 'REWORK_DRAFT');
    });

  it('never converts free rework into chargeable work (both directions)',
    async () => {
      // Once a chargeable referral exists, the free rework of that claim
      // can never be accepted or executed: it stays REWORK_DRAFT forever.
      const { claim } = await approvedClaimFixture();
      const rework = await proposeHandymanServiceWarrantyRework(actor, {
        claimId: claim.id, idempotencyKey: id(),
      });
      await proposeHandymanChargeableAdditionalWork(actor, {
        claimId: claim.id, idempotencyKey: id(),
      });
      await assert.rejects(
        authorizeHandymanServiceWarrantyRework(actor, {
          reworkId: rework.rework.id, idempotencyKey: id(),
        }),
        /SEPARATE \(B8\)|never be accepted or executed/,
      );
      const reworkRow = await q(
        `SELECT status FROM handyman_service_warranty_reworks WHERE id=$1`,
        [rework.rework.id]);
      assert.equal(reworkRow.rows[0].status, 'REWORK_DRAFT');
      assert.equal((await reworkRows(claim.id)).length, 1);
    });

  it('enforces separation, history and firewall laws in SQL', async () => {
    const { scope, warranty, bast, claim } = await approvedClaimFixture();
    const proposed = await proposeHandymanChargeableAdditionalWork(actor, {
      claimId: claim.id, idempotencyKey: id(),
    });
    const workId = proposed.work.id;

    // Identity can never be re-pointed; the family is never deleted.
    await assert.rejects(q(
      `UPDATE handyman_chargeable_additional_works SET claim_id=$2
        WHERE id=$1`, [workId, id()]), /immutable/);
    await assert.rejects(q(
      `UPDATE handyman_chargeable_additional_works SET execution_scope_id=$2
        WHERE id=$1`, [workId, id()]), /immutable/);
    await assert.rejects(q(
      `DELETE FROM handyman_chargeable_additional_works WHERE id=$1`,
      [workId]), /history is preserved/);
    // Events are append-only.
    await assert.rejects(q(
      `UPDATE handyman_chargeable_additional_work_events
          SET event_type='ACCEPT' WHERE id=$1`, [proposed.event.id]),
    /append-only/);
    await assert.rejects(q(
      `DELETE FROM handyman_chargeable_additional_work_events WHERE id=$1`,
      [proposed.event.id]), /append-only/);
    // A referral can never be created outside the governed path, nor for
    // a claim that has no chargeable path.
    await assert.rejects(q(
      `INSERT INTO handyman_chargeable_additional_works
         (id, client_id, warranty_id, claim_id, execution_scope_id, bast_id,
          status, proposed_by_user_id, decided_at, decided_by_user_id,
          payment_trigger_emitted_at)
       SELECT $1, c.client_id, c.warranty_id, c.id, c.execution_scope_id,
              c.bast_id, 'CHARGEABLE_AUTHORIZED', $2, NOW(), $2, NOW()
         FROM handyman_service_warranty_claims c WHERE c.id=$3`,
      [id(), actor, claim.id]), /CHARGEABLE_PROPOSED/);
    const other = await approvedClaimFixture();
    const rework = await proposeHandymanServiceWarrantyRework(actor, {
      claimId: other.claim.id, idempotencyKey: id(),
    });
    await authorizeHandymanServiceWarrantyRework(actor, {
      reworkId: rework.rework.id, idempotencyKey: id(),
    });
    await assert.rejects(q(
      `INSERT INTO handyman_chargeable_additional_works
         (id, client_id, warranty_id, claim_id, execution_scope_id, bast_id,
          status, proposed_by_user_id)
       SELECT $1, c.client_id, c.warranty_id, c.id, c.execution_scope_id,
              c.bast_id, 'CHARGEABLE_PROPOSED', $2
         FROM handyman_service_warranty_claims c WHERE c.id=$3`,
      [id(), actor, other.claim.id]), /can never become chargeable/);
    // A referral without its PROPOSE event can never become durable, and
    // an authorization without its payment trigger fact is impossible.
    await assert.rejects(q(
      `INSERT INTO handyman_chargeable_additional_works
         (id, client_id, warranty_id, claim_id, execution_scope_id, bast_id,
          status, proposed_by_user_id)
       SELECT $1, c.client_id, c.warranty_id, c.id, c.execution_scope_id,
              c.bast_id, 'CHARGEABLE_PROPOSED', $2
         FROM handyman_service_warranty_claims c WHERE c.id=$3`,
      [id(), actor, (await approvedClaimFixture()).claim.id]),
    /without its PROPOSE event/);
    const rawClaim = await approvedClaimFixture();
    await assert.rejects(rawTx(async (client) => {
      const raw = id();
      await client.query(
        `INSERT INTO handyman_chargeable_additional_works
           (id, client_id, warranty_id, claim_id, execution_scope_id, bast_id,
            status, proposed_by_user_id)
         SELECT $1, c.client_id, c.warranty_id, c.id, c.execution_scope_id,
                c.bast_id, 'CHARGEABLE_PROPOSED', $2
           FROM handyman_service_warranty_claims c WHERE c.id=$3`,
        [raw, actor, rawClaim.claim.id]);
      await client.query(
        `INSERT INTO handyman_chargeable_additional_work_events
           (id, client_id, work_id, claim_id, warranty_id, execution_scope_id,
            bast_id, event_type, idempotency_key, actor_user_id)
         SELECT $1, w.client_id, w.id, w.claim_id, w.warranty_id,
                w.execution_scope_id, w.bast_id, 'PROPOSE', 'raw-1', $2
           FROM handyman_chargeable_additional_works w WHERE w.id=$3`,
        [id(), actor, raw]);
      await client.query(
        `UPDATE handyman_chargeable_additional_works
            SET status='CHARGEABLE_AUTHORIZED', decided_at=NOW(),
                decided_by_user_id=$2, payment_trigger_emitted_at=NOW()
          WHERE id=$1`, [raw, actor]);
      await client.query(
        `INSERT INTO handyman_chargeable_additional_work_events
           (id, client_id, work_id, claim_id, warranty_id, execution_scope_id,
            bast_id, event_type, idempotency_key, actor_user_id)
         SELECT $1, w.client_id, w.id, w.claim_id, w.warranty_id,
                w.execution_scope_id, w.bast_id, 'ACCEPT', 'raw-2', $2
           FROM handyman_chargeable_additional_works w WHERE w.id=$3`,
        [id(), actor, raw]);
    }), /payment trigger fact/);
    // The state check refuses a fabricated decision.
    await assert.rejects(q(
      `UPDATE handyman_chargeable_additional_works
          SET status='CHARGEABLE_AUTHORIZED', decided_at=NOW(),
              decided_by_user_id=$2
        WHERE id=$1`, [workId, actor]),
    /state_check|Illegal/);
    // The head vocabulary is frozen: it has no chargeable value at all.
    const headCheck = await q(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.conrelid = 'handyman_service_warranties'::regclass
          AND c.conname = 'handyman_service_warranty_status_check'`);
    assert.equal(String(headCheck.rows[0].def).includes('CHARGEABLE'), false);
    // History preservation: claim, warranty, BAST and the free-rework
    // family are untouched by the chargeable path.
    assert.equal((await claimRow(claim.id)).status, 'CLAIM_APPROVED');
    assert.equal((await warrantyRow(warranty.id)).status, 'CLAIM_APPROVED');
    assert.equal((await bastRow(bast.id)).status, 'ACCEPTED');
    assert.equal((await warrantyRow(warranty.id)).starts_at.getTime(),
      (await warrantyRow(warranty.id)).bast_accepted_at.getTime());
    assert.deepEqual(await reworkRows(claim.id), []);
    assert.equal(scope.id.length > 0, true);
  });

  it('keeps zero money vocabulary and zero FM / SaaS coupling', async () => {
    const columns = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name LIKE 'handyman_chargeable_additional_work%'`);
    const names = columns.rows.map((r) => r.column_name);
    assert.ok(names.length > 0);
    // The ONLY payment-worded column is the CR-HM-13 trigger fact; no
    // amount/price/currency/ledger/payment/settlement can ever exist.
    const moneyish = names.filter((name) =>
      /amount|price|currency|settle|invoice|ledger|fee|tax|total|discount|payment/
        .test(name));
    assert.deepEqual(moneyish, ['payment_trigger_emitted_at']);
    const fks = await q(
      `SELECT c.confrelid::regclass::text AS target
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid::regclass::text IN (
            'handyman_chargeable_additional_works',
            'handyman_chargeable_additional_work_events')`);
    assert.ok(fks.rows.length > 0);
    for (const row of fks.rows) {
      assert.ok(
        /^(handyman_(chargeable_additional_work(s)?|service_warranty_claim(s)?|service_warranties|bast_documents|execution_scopes)|clients|users)$/
          .test(row.target),
        `unexpected FK target ${row.target}`);
      assert.equal(/fm_|saas|asset_warranty/.test(row.target), false,
        row.target);
    }
  });
});
