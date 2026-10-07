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
import {
  findHandymanServiceWarrantyByScopeId,
  startHandymanServiceWarranty,
} from '../src/modules/handyman-service-warranties';
import {
  openHandymanServiceWarrantyClaim,
  submitHandymanServiceWarrantyClaim,
  approveHandymanServiceWarrantyClaim,
  rejectHandymanServiceWarrantyClaim,
  withdrawHandymanServiceWarrantyClaim,
} from '../src/modules/handyman-service-warranty-claims';
import {
  createHandymanEvidenceRecord,
  openHandymanQcRun,
  setHandymanQcRunItemOutcome,
  finishHandymanQcRun,
} from '../src/modules/handyman-evidence-qc';
import {
  proposeHandymanServiceWarrantyRework,
  authorizeHandymanServiceWarrantyRework,
  startHandymanServiceWarrantyRework,
  completeHandymanServiceWarrantyRework,
  verifyHandymanServiceWarrantyRework,
  getHandymanServiceWarrantyReworkById,
  findHandymanServiceWarrantyReworkByClaimId,
  listHandymanServiceWarrantyReworks,
  assertHandymanServiceWarrantyReworkIntakeEligible,
  nextHandymanServiceWarrantyReworkStatus,
  nextHandymanServiceWarrantyReworkHeadStatus,
  isNotWarrantyReworkAuthorityAlias,
  HANDYMAN_SERVICE_WARRANTY_REWORK_STATUSES,
  HANDYMAN_SERVICE_WARRANTY_REWORK_EVENT_TYPES,
  HANDYMAN_SERVICE_WARRANTY_REWORK_ACTIONS,
  HANDYMAN_NOT_WARRANTY_REWORK_AUTHORITY,
} from '../src/modules/handyman-service-warranty-reworks';

/**
 * CR-HM-15 PART 03 — free warranty REWORK only: bound to the APPROVED
 * claim, its service warranty and ORIGINAL execution scope; the original
 * BAST, the warranty start boundary and the service history are
 * preserved; CR-HM-10 evidence/QC authority is consumed READ-ONLY.
 * No chargeable financial execution, no pricing/payment/settlement, no
 * FM/SaaS, no HTTP.
 */

const DIR = '/tmp/hm15-part03-pg';
const PORT = 55499;
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

const warrantyRow = async (warrantyId: string) =>
  (await q(`SELECT * FROM handyman_service_warranties WHERE id=$1`,
    [warrantyId])).rows[0];

const claimRow = async (claimId: string) =>
  (await q(`SELECT * FROM handyman_service_warranty_claims WHERE id=$1`,
    [claimId])).rows[0];

const evidenceRow = async (evidenceId: string) =>
  (await q(`SELECT * FROM handyman_evidence_records WHERE id=$1`,
    [evidenceId])).rows[0];

const qcRow = async (qcRunId: string) =>
  (await q(`SELECT * FROM handyman_qc_runs WHERE id=$1`, [qcRunId])).rows[0];

/**
 * Real CR-HM-10 evidence via its OWN authority (read-only for CR-HM-15):
 * evidence and QC commands belong to the scope's authoritative Crew Lead.
 */
async function evidenceViaAuthority(
  scopeId: string,
  stage: string,
  leadUserId: string,
) {
  const created = await createHandymanEvidenceRecord({
    executionScopeId: scopeId,
    stage: stage as never,
    description: 'warranty rework evidence',
    idempotencyKey: id(),
  }, leadUserId);
  return created.record.id;
}

/** Real CR-HM-10 QC run finished through its own authority. */
async function qcRunViaAuthority(
  scopeId: string,
  item: 'PASS' | 'DEFECT',
  leadUserId: string,
) {
  const opened = await openHandymanQcRun({
    executionScopeId: scopeId,
    checklistIdentity: `QC_${id().slice(0, 8)}`,
    idempotencyKey: id(),
  }, leadUserId);
  await setHandymanQcRunItemOutcome({
    qcRunId: opened.run.id,
    itemKey: 'ITEM_1',
    outcome: item,
    idempotencyKey: id(),
  }, leadUserId);
  const finished = await finishHandymanQcRun({
    qcRunId: opened.run.id,
    idempotencyKey: id(),
  }, leadUserId);
  return finished.run;
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

/** Warranty with an APPROVED claim ready for free rework. */
async function approvedClaimFixture() {
  const f = await warrantyFixture();
  const evidenceId = await evidenceViaAuthority(f.scope.id, 'DEFECT',
    f.leadUserId);
  const opened = await openHandymanServiceWarrantyClaim(actor, {
    warrantyId: f.warranty.id, idempotencyKey: id(),
    evidenceRecordId: evidenceId,
  });
  await submitHandymanServiceWarrantyClaim(actor, {
    claimId: opened.claim.id, idempotencyKey: id(),
  });
  const approved = await approveHandymanServiceWarrantyClaim(actor, {
    claimId: opened.claim.id, idempotencyKey: id(),
    decisionNote: 'Workmanship defect confirmed.',
  });
  return { ...f, claim: approved.claim, claimEvidenceId: evidenceId };
}

describe('CR-HM-15 PART 03 rework lifecycle guards', () => {
  it('freezes vocabulary', () => {
    assert.deepEqual([...HANDYMAN_SERVICE_WARRANTY_REWORK_STATUSES], [
      'REWORK_DRAFT', 'REWORK_AUTHORIZED', 'REWORK_IN_PROGRESS',
      'REWORK_COMPLETE', 'REWORK_VERIFIED',
    ]);
    assert.deepEqual([...HANDYMAN_SERVICE_WARRANTY_REWORK_EVENT_TYPES], [
      'PROPOSE', 'ACCEPT', 'START', 'COMPLETE', 'VERIFY',
    ]);
    assert.deepEqual([...HANDYMAN_SERVICE_WARRANTY_REWORK_ACTIONS], [
      'ACCEPT', 'START', 'COMPLETE', 'VERIFY',
    ]);
    // No chargeable state is admitted in PART 03.
    assert.equal(
      (HANDYMAN_SERVICE_WARRANTY_REWORK_STATUSES as readonly string[])
        .includes('REWORK_CHARGEABLE'), false);
    for (const alias of HANDYMAN_NOT_WARRANTY_REWORK_AUTHORITY) {
      assert.equal(isNotWarrantyReworkAuthorityAlias(alias), true);
    }
    assert.equal(isNotWarrantyReworkAuthorityAlias('CLAIM_APPROVED'), false);
  });

  it('gates intake on the APPROVED claim and CLAIM_APPROVED warranty', () => {
    assert.doesNotThrow(() =>
      assertHandymanServiceWarrantyReworkIntakeEligible(
        'CLAIM_APPROVED', 'CLAIM_APPROVED'));
    for (const claimStatus of ['CLAIM_DRAFT', 'CLAIM_SUBMITTED',
      'CLAIM_REJECTED', 'CLAIM_WITHDRAWN'] as const) {
      assert.throws(() =>
        assertHandymanServiceWarrantyReworkIntakeEligible(
          claimStatus, 'CLAIM_APPROVED'),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_ELIGIBLE),
      claimStatus);
    }
    for (const warrantyStatus of ['ACTIVE', 'CLAIM_OPEN', 'CLAIM_REJECTED',
      'REWORK_IN_PROGRESS', 'REWORK_COMPLETE', 'EXPIRED'] as const) {
      assert.throws(() =>
        assertHandymanServiceWarrantyReworkIntakeEligible(
          'CLAIM_APPROVED', warrantyStatus),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_ELIGIBLE),
      warrantyStatus);
    }
  });

  it('freezes the rework record and warranty head machines', () => {
    assert.equal(
      nextHandymanServiceWarrantyReworkStatus('REWORK_DRAFT', 'ACCEPT'),
      'REWORK_AUTHORIZED');
    assert.equal(
      nextHandymanServiceWarrantyReworkStatus('REWORK_AUTHORIZED', 'START'),
      'REWORK_IN_PROGRESS');
    assert.equal(
      nextHandymanServiceWarrantyReworkStatus('REWORK_IN_PROGRESS',
        'COMPLETE'),
      'REWORK_COMPLETE');
    assert.equal(
      nextHandymanServiceWarrantyReworkStatus('REWORK_COMPLETE', 'VERIFY'),
      'REWORK_VERIFIED');
    for (const from of ['REWORK_DRAFT', 'REWORK_AUTHORIZED',
      'REWORK_IN_PROGRESS', 'REWORK_COMPLETE'] as const) {
      for (const action of ['ACCEPT', 'START', 'COMPLETE', 'VERIFY']) {
        const legal = (from === 'REWORK_DRAFT' && action === 'ACCEPT')
          || (from === 'REWORK_AUTHORIZED' && action === 'START')
          || (from === 'REWORK_IN_PROGRESS' && action === 'COMPLETE')
          || (from === 'REWORK_COMPLETE' && action === 'VERIFY');
        if (legal) continue;
        assert.throws(
          () => nextHandymanServiceWarrantyReworkStatus(from, action),
          hasCode(
            ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_ILLEGAL_TRANSITION),
          `${from}/${action}`);
      }
    }
    // VERIFIED is terminal: nothing moves it again.
    for (const action of ['ACCEPT', 'START', 'COMPLETE', 'VERIFY']) {
      assert.throws(
        () => nextHandymanServiceWarrantyReworkStatus(
          'REWORK_VERIFIED', action),
        hasCode(
          ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_ILLEGAL_TRANSITION),
        action);
    }
    // Head mapping.
    assert.equal(
      nextHandymanServiceWarrantyReworkHeadStatus('CLAIM_APPROVED',
        'PROPOSE'), 'CLAIM_APPROVED');
    assert.equal(
      nextHandymanServiceWarrantyReworkHeadStatus('CLAIM_APPROVED',
        'ACCEPT'), 'CLAIM_APPROVED');
    assert.equal(
      nextHandymanServiceWarrantyReworkHeadStatus('CLAIM_APPROVED',
        'START'), 'REWORK_IN_PROGRESS');
    assert.equal(
      nextHandymanServiceWarrantyReworkHeadStatus('REWORK_IN_PROGRESS',
        'COMPLETE'), 'REWORK_COMPLETE');
    assert.equal(
      nextHandymanServiceWarrantyReworkHeadStatus('REWORK_COMPLETE',
        'VERIFY'), 'REWORK_COMPLETE');
    for (const from of ['ACTIVE', 'CLAIM_OPEN', 'CLAIM_REJECTED', 'EXPIRED',
      'INELIGIBLE'] as const) {
      for (const action of ['ACCEPT', 'START', 'COMPLETE', 'VERIFY']) {
        assert.throws(
          () => nextHandymanServiceWarrantyReworkHeadStatus(from, action),
          hasCode(
            ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_ILLEGAL_TRANSITION),
          `${from}/${action}`);
      }
    }
    // The chargeable path is not a PART 03 transition.
    assert.throws(
      () => nextHandymanServiceWarrantyReworkStatus('REWORK_DRAFT',
        'CHARGE'),
      hasCode(
        ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_ILLEGAL_TRANSITION));
  });
});

describe('CR-HM-15 PART 03 free rework execution', () => {
  it('binds the rework to the approved claim, warranty and original scope',
    async () => {
      const { scope, bast, warranty, claim } = await approvedClaimFixture();
      const bastBefore = await bastRow(bast.id);
      const warrantyBefore = await warrantyRow(warranty.id);
      const claimBefore = await claimRow(claim.id);
      const proposed = await proposeHandymanServiceWarrantyRework(actor, {
        claimId: claim.id, idempotencyKey: id(),
        scopeNote: 'Re-seal the joint and re-test under pressure.',
      });
      assert.equal(proposed.replayed, false);
      assert.equal(proposed.rework.status, 'REWORK_DRAFT');
      assert.equal(proposed.rework.claimId, claim.id);
      assert.equal(proposed.rework.warrantyId, warranty.id);
      assert.equal(proposed.rework.executionScopeId, scope.id);
      assert.equal(proposed.rework.bastId, bast.id);
      assert.equal(proposed.rework.clientId, claimBefore.client_id);
      assert.equal(proposed.event.eventType, 'PROPOSE');
      // A proposed rework is not an execution state: head unchanged.
      assert.equal(proposed.warrantyStatus, 'CLAIM_APPROVED');
      assert.equal(proposed.claimStatus, 'CLAIM_APPROVED');
      assert.equal((await warrantyRow(warranty.id)).status, 'CLAIM_APPROVED');
      // History preserved: BAST + warranty + claim rows untouched.
      assert.deepEqual(await bastRow(bast.id), bastBefore);
      assert.deepEqual(await warrantyRow(warranty.id), warrantyBefore);
      assert.deepEqual(await claimRow(claim.id), claimBefore);
    });

  it('runs the full free rework ladder and closes the claim on verify',
    async () => {
      const { scope, warranty, claim, leadUserId } =
        await approvedClaimFixture();
      const proposed = await proposeHandymanServiceWarrantyRework(actor, {
        claimId: claim.id, idempotencyKey: id(),
      });
      const authorized = await authorizeHandymanServiceWarrantyRework(actor, {
        reworkId: proposed.rework.id, idempotencyKey: id(),
      });
      assert.equal(authorized.rework.status, 'REWORK_AUTHORIZED');
      assert.equal(authorized.rework.authorizedByUserId, actor);
      assert.equal(authorized.warrantyStatus, 'CLAIM_APPROVED');
      const started = await startHandymanServiceWarrantyRework(actor, {
        reworkId: proposed.rework.id, idempotencyKey: id(),
      });
      assert.equal(started.rework.status, 'REWORK_IN_PROGRESS');
      assert.ok(started.rework.startedAt instanceof Date);
      assert.equal(started.warrantyStatus, 'REWORK_IN_PROGRESS');
      assert.equal((await warrantyRow(warranty.id)).status,
        'REWORK_IN_PROGRESS');
      const completed = await completeHandymanServiceWarrantyRework(actor, {
        reworkId: proposed.rework.id, idempotencyKey: id(),
        completionNote: 'Joint re-sealed; pressure test passed on site.',
      });
      assert.equal(completed.rework.status, 'REWORK_COMPLETE');
      assert.equal(completed.rework.completionNote,
        'Joint re-sealed; pressure test passed on site.');
      assert.equal(completed.warrantyStatus, 'REWORK_COMPLETE');
      assert.equal((await warrantyRow(warranty.id)).status, 'REWORK_COMPLETE');
      // Verification consumes CR-HM-10 authority READ-ONLY.
      const evidenceId = await evidenceViaAuthority(scope.id, 'RECTIFICATION',
        leadUserId);
      const qc = await qcRunViaAuthority(scope.id, 'PASS', leadUserId);
      assert.equal(qc.status, 'PASSED');
      const verified = await verifyHandymanServiceWarrantyRework(actor, {
        reworkId: proposed.rework.id, idempotencyKey: id(),
        evidenceRecordId: evidenceId, qcRunId: qc.id,
      });
      assert.equal(verified.rework.status, 'REWORK_VERIFIED');
      assert.equal(verified.rework.verificationEvidenceRecordId, evidenceId);
      assert.equal(verified.rework.verificationQcRunId, qc.id);
      // The frozen head vocabulary has no post-verification state: the
      // head keeps REWORK_COMPLETE and the claim closure is the rework.
      assert.equal(verified.warrantyStatus, 'REWORK_COMPLETE');
      assert.equal(verified.claimStatus, 'CLAIM_APPROVED');
      // The CR-HM-10 rows are untouched by our verification.
      assert.equal((await evidenceRow(evidenceId)).stage, 'RECTIFICATION');
      assert.equal((await qcRow(qc.id)).status, 'PASSED');
      // The warranty start boundary is still the accepted BAST instant.
      const reloaded = await findHandymanServiceWarrantyByScopeId(scope.id);
      assert.equal(reloaded?.startsAt.getTime(),
        reloaded?.bastAcceptedAt.getTime());
      assert.equal(reloaded?.status, 'REWORK_COMPLETE');
    });

  it('requires rework evidence and only consumes a PASSED QC run',
    async () => {
      const { realm, scope, claim, leadUserId } = await approvedClaimFixture();
      const proposed = await proposeHandymanServiceWarrantyRework(actor, {
        claimId: claim.id, idempotencyKey: id(),
      });
      await authorizeHandymanServiceWarrantyRework(actor, {
        reworkId: proposed.rework.id, idempotencyKey: id(),
      });
      await startHandymanServiceWarrantyRework(actor, {
        reworkId: proposed.rework.id, idempotencyKey: id(),
      });
      await completeHandymanServiceWarrantyRework(actor, {
        reworkId: proposed.rework.id, idempotencyKey: id(),
      });
      // Evidence is mandatory.
      await assert.rejects(
        verifyHandymanServiceWarrantyRework(actor, {
          reworkId: proposed.rework.id, idempotencyKey: id(),
          evidenceRecordId: '',
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_EVIDENCE_REQUIRED),
      );
      // Evidence of another scope/client can never be bound.
      const foreign = await approvedClaimFixture();
      const foreignEvidence = await evidenceViaAuthority(foreign.scope.id,
        'RECTIFICATION', foreign.leadUserId);
      await assert.rejects(
        verifyHandymanServiceWarrantyRework(actor, {
          reworkId: proposed.rework.id, idempotencyKey: id(),
          evidenceRecordId: foreignEvidence,
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_EVIDENCE_INVALID),
      );
      await assert.rejects(
        verifyHandymanServiceWarrantyRework(actor, {
          reworkId: proposed.rework.id, idempotencyKey: id(),
          evidenceRecordId: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_EVIDENCE_INVALID),
      );
      // A QC run of another scope, or one that did not pass, is refused.
      const foreignQc = await qcRunViaAuthority(foreign.scope.id, 'PASS',
        foreign.leadUserId);
      const ownFailedQc = await qcRunViaAuthority(scope.id, 'DEFECT',
        leadUserId);
      assert.equal(ownFailedQc.status, 'FAILED');
      const ownEvidence = await evidenceViaAuthority(scope.id,
        'RECTIFICATION', leadUserId);
      await assert.rejects(
        verifyHandymanServiceWarrantyRework(actor, {
          reworkId: proposed.rework.id, idempotencyKey: id(),
          evidenceRecordId: ownEvidence, qcRunId: foreignQc.id,
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_QC_INVALID),
      );
      await assert.rejects(
        verifyHandymanServiceWarrantyRework(actor, {
          reworkId: proposed.rework.id, idempotencyKey: id(),
          evidenceRecordId: ownEvidence, qcRunId: ownFailedQc.id,
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_QC_INVALID),
      );
      await assert.rejects(
        verifyHandymanServiceWarrantyRework(actor, {
          reworkId: proposed.rework.id, idempotencyKey: id(),
          evidenceRecordId: ownEvidence, qcRunId: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_QC_INVALID),
      );
      // Nothing was written while verification kept failing.
      const reloaded = await getHandymanServiceWarrantyReworkById(
        proposed.rework.id);
      assert.equal(reloaded.status, 'REWORK_COMPLETE');
      assert.equal(reloaded.verificationEvidenceRecordId, null);
      assert.equal(reloaded.verificationQcRunId, null);
      assert.equal(realm.client.id.length > 0, true);
    });

  it('is idempotent, one rework per claim, and never forgets a step',
    async () => {
      const { scope, claim, leadUserId } = await approvedClaimFixture();
      const proposeKey = id();
      const first = await proposeHandymanServiceWarrantyRework(actor, {
        claimId: claim.id, idempotencyKey: proposeKey,
      });
      const replay = await proposeHandymanServiceWarrantyRework(actor, {
        claimId: claim.id, idempotencyKey: proposeKey,
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.rework.id, first.rework.id);
      assert.equal(replay.event.id, first.event.id);
      await assert.rejects(
        proposeHandymanServiceWarrantyRework(actor, {
          claimId: claim.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_CONFLICT),
      );
      // Steps cannot be skipped: START before ACCEPT, COMPLETE before
      // START, VERIFY before COMPLETE.
      await assert.rejects(
        startHandymanServiceWarrantyRework(actor, {
          reworkId: first.rework.id, idempotencyKey: id(),
        }),
        hasCode(
          ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_ILLEGAL_TRANSITION),
      );
      const acceptKey = id();
      const authorized = await authorizeHandymanServiceWarrantyRework(actor, {
        reworkId: first.rework.id, idempotencyKey: acceptKey,
      });
      const acceptReplay = await authorizeHandymanServiceWarrantyRework(actor, {
        reworkId: first.rework.id, idempotencyKey: acceptKey,
      });
      assert.equal(acceptReplay.replayed, true);
      assert.equal(acceptReplay.event.id, authorized.event.id);
      await assert.rejects(
        completeHandymanServiceWarrantyRework(actor, {
          reworkId: first.rework.id, idempotencyKey: id(),
        }),
        hasCode(
          ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_ILLEGAL_TRANSITION),
      );
      await assert.rejects(
        verifyHandymanServiceWarrantyRework(actor, {
          reworkId: first.rework.id, idempotencyKey: id(),
          evidenceRecordId: await evidenceViaAuthority(scope.id, 'QC',
            leadUserId),
        }),
        hasCode(
          ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_ILLEGAL_TRANSITION),
      );
      assert.equal(
        (await q(`SELECT count(*)::int AS n
                    FROM handyman_service_warranty_reworks WHERE claim_id=$1`,
        [claim.id])).rows[0].n, 1);
      assert.equal((await listHandymanServiceWarrantyReworks(
        first.rework.warrantyId)).length, 1);
      assert.equal((await findHandymanServiceWarrantyReworkByClaimId(claim.id))
        ?.id, first.rework.id);
    });

  it('refuses free rework for non-approved claims and foreign actors',
    async () => {
      // Fixture A: a claim that is still DRAFT and then SUBMITTED.
      const pending = await warrantyFixture();
      const draft = await openHandymanServiceWarrantyClaim(actor, {
        warrantyId: pending.warranty.id, idempotencyKey: id(),
        evidenceRecordId: await evidenceViaAuthority(pending.scope.id,
          'DEFECT', pending.leadUserId),
      });
      await assert.rejects(
        proposeHandymanServiceWarrantyRework(actor, {
          claimId: draft.claim.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_ELIGIBLE),
      );
      await submitHandymanServiceWarrantyClaim(actor, {
        claimId: draft.claim.id, idempotencyKey: id(),
      });
      await assert.rejects(
        proposeHandymanServiceWarrantyRework(actor, {
          claimId: draft.claim.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_ELIGIBLE),
      );

      // Fixture B: a WITHDRAWN claim on a warranty back to ACTIVE.
      const withdrawnFixture = await warrantyFixture();
      const toWithdraw = await openHandymanServiceWarrantyClaim(actor, {
        warrantyId: withdrawnFixture.warranty.id, idempotencyKey: id(),
        evidenceRecordId: await evidenceViaAuthority(withdrawnFixture.scope.id,
          'DEFECT', withdrawnFixture.leadUserId),
      });
      await submitHandymanServiceWarrantyClaim(actor, {
        claimId: toWithdraw.claim.id, idempotencyKey: id(),
      });
      const withdrawn = await withdrawHandymanServiceWarrantyClaim(actor, {
        claimId: toWithdraw.claim.id, idempotencyKey: id(),
      });
      assert.equal(withdrawn.claim.status, 'CLAIM_WITHDRAWN');
      assert.equal(withdrawn.warrantyStatus, 'ACTIVE');
      await assert.rejects(
        proposeHandymanServiceWarrantyRework(actor, {
          claimId: toWithdraw.claim.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_ELIGIBLE),
      );

      // Fixture C: a REJECTED claim — the chargeable path is NOT free
      // rework, so PART 03 refuses it.
      const rejectedFixture = await warrantyFixture();
      const toReject = await openHandymanServiceWarrantyClaim(actor, {
        warrantyId: rejectedFixture.warranty.id, idempotencyKey: id(),
        evidenceRecordId: await evidenceViaAuthority(rejectedFixture.scope.id,
          'DEFECT', rejectedFixture.leadUserId),
      });
      await submitHandymanServiceWarrantyClaim(actor, {
        claimId: toReject.claim.id, idempotencyKey: id(),
      });
      const rejected = await rejectHandymanServiceWarrantyClaim(actor, {
        claimId: toReject.claim.id, idempotencyKey: id(),
        decisionNote: 'Not a covered defect.',
      });
      assert.equal(rejected.claim.status, 'CLAIM_REJECTED');
      await assert.rejects(
        proposeHandymanServiceWarrantyRework(actor, {
          claimId: toReject.claim.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_ELIGIBLE),
      );

      // Foreign actor: no authority, nothing written.
      const outsider = await userService.createUser({
        email: `outsider-${id().slice(0, 8)}@example.com`,
        displayName: 'Outsider',
      });
      await assert.rejects(
        proposeHandymanServiceWarrantyRework(outsider.id, {
          claimId: draft.claim.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_AUTHORIZED),
      );
      assert.equal(
        (await q(`SELECT count(*)::int AS n
                    FROM handyman_service_warranty_reworks
                   WHERE claim_id=$1`, [draft.claim.id])).rows[0].n, 0);
    });

  it('enforces binding, history and firewall laws in SQL', async () => {
    const { scope, warranty, claim } = await approvedClaimFixture();
    const proposed = await proposeHandymanServiceWarrantyRework(actor, {
      claimId: claim.id, idempotencyKey: id(),
    });
    const reworkId = proposed.rework.id;

    // Identity can never be re-pointed at another claim/warranty/scope.
    await assert.rejects(q(
      `UPDATE handyman_service_warranty_reworks SET claim_id=$2
        WHERE id=$1`, [reworkId, (await approvedClaimFixture()).claim.id]),
    /immutable/);
    await assert.rejects(q(
      `UPDATE handyman_service_warranty_reworks SET execution_scope_id=$2
        WHERE id=$1`, [reworkId, id()]), /immutable/);
    // A rework can never be created outside the governed path (raw SQL).
    const other = await approvedClaimFixture();
    await assert.rejects(q(
      `INSERT INTO handyman_service_warranty_reworks
         (id, client_id, warranty_id, claim_id, execution_scope_id, bast_id,
          status, proposed_by_user_id, authorized_at, authorized_by_user_id)
       SELECT $1, c.client_id, c.warranty_id, c.id, c.execution_scope_id,
              c.bast_id, 'REWORK_AUTHORIZED', $2, NOW(), $2
         FROM handyman_service_warranty_claims c WHERE c.id=$3`,
      [id(), actor, other.claim.id]),
    /REWORK_DRAFT/);
    // No rework for a claim that is not APPROVED (raw SQL).
    const submittedFixture = await baseFixture();
    const prepared = await prepareHandymanBast(actor, {
      executionScopeId: submittedFixture.scope.id, idempotencyKey: id(),
    });
    await issueHandymanBast(actor, {
      bastId: prepared.bast.id, idempotencyKey: id(),
    });
    await acceptHandymanBast(actor, {
      bastId: prepared.bast.id, idempotencyKey: id(),
      signatureDigest: `sig-${id()}`,
    });
    const started = await startHandymanServiceWarranty(
      { executionScopeId: submittedFixture.scope.id, idempotencyKey: id() },
      actor);
    const submittedCrew = await crewFixture(submittedFixture.realm);
    await assignHandymanExecutionScopeCrew({
      executionScopeId: submittedFixture.scope.id,
      providerContextId: submittedCrew.providerContext.id,
      crewId: submittedCrew.crew.id,
    }, actor);
    const otherEvidence = await evidenceViaAuthority(
      submittedFixture.scope.id, 'DEFECT', submittedCrew.leadUser.id);
    const pending = await openHandymanServiceWarrantyClaim(actor, {
      warrantyId: started.warranty.id, idempotencyKey: id(),
      evidenceRecordId: otherEvidence,
    });
    await submitHandymanServiceWarrantyClaim(actor, {
      claimId: pending.claim.id, idempotencyKey: id(),
    });
    await assert.rejects(q(
      `INSERT INTO handyman_service_warranty_reworks
         (id, client_id, warranty_id, claim_id, execution_scope_id, bast_id,
          status, proposed_by_user_id)
       SELECT $1, c.client_id, c.warranty_id, c.id, c.execution_scope_id,
              c.bast_id, 'REWORK_DRAFT', $2
         FROM handyman_service_warranty_claims c WHERE c.id=$3`,
      [id(), actor, pending.claim.id]),
    /APPROVED claim/);
    // No forged chargeable state exists in this PART: the frozen guard
    // refuses it as an illegal transition …
    await assert.rejects(q(
      `UPDATE handyman_service_warranty_reworks SET status='REWORK_CHARGEABLE'
        WHERE id=$1`, [reworkId]),
    /state machine/);
    // … and the schema literal never admits it either.
    const statusCheck = await q(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.conrelid = 'handyman_service_warranty_reworks'::regclass
          AND c.conname = 'handyman_service_warranty_rework_status_check'`);
    const statusDef = String(statusCheck.rows[0].def);
    for (const status of HANDYMAN_SERVICE_WARRANTY_REWORK_STATUSES) {
      assert.ok(statusDef.includes(status), status);
    }
    assert.equal(statusDef.includes('REWORK_CHARGEABLE'), false);
    // Skipping a step is impossible even by raw SQL.
    await assert.rejects(q(
      `UPDATE handyman_service_warranty_reworks
          SET status='REWORK_COMPLETE', completed_at=NOW()
        WHERE id=$1`, [reworkId]),
    /state machine/);
    // A rework execution cannot exist without the matching head state:
    // even with the START event forced in by raw SQL, the deferred mirror
    // refuses execution while the warranty head is not in rework.
    await authorizeHandymanServiceWarrantyRework(actor, {
      reworkId, idempotencyKey: id(),
    });
    await assert.rejects(q(
      `WITH forged AS (
         INSERT INTO handyman_service_warranty_rework_events
           (id, client_id, rework_id, claim_id, warranty_id,
            execution_scope_id, bast_id, event_type, idempotency_key,
            actor_user_id)
         SELECT $2, r.client_id, r.id, r.claim_id, r.warranty_id,
                r.execution_scope_id, r.bast_id, 'START', 'raw-start', $3
           FROM handyman_service_warranty_reworks r WHERE r.id=$1
       )
       UPDATE handyman_service_warranty_reworks
          SET status='REWORK_IN_PROGRESS', started_at=NOW()
        WHERE id=$1`, [reworkId, id(), actor]),
    /matching warranty head state/);
    // A head can never claim REWORK_COMPLETE without a completed rework.
    await assert.rejects(q(
      `UPDATE handyman_service_warranties SET status='REWORK_COMPLETE'
        WHERE id=$1`, [warranty.id]),
    /contradict its rework facts/);
    // A rework without its PROPOSE event can never become durable.
    await assert.rejects(q(
      `INSERT INTO handyman_service_warranty_reworks
         (id, client_id, warranty_id, claim_id, execution_scope_id, bast_id,
          status, proposed_by_user_id)
       SELECT $1, c.client_id, c.warranty_id, c.id, c.execution_scope_id,
              c.bast_id, 'REWORK_DRAFT', $2
         FROM handyman_service_warranty_claims c WHERE c.id=$3`,
      [id(), actor, other.claim.id]),
    /without its PROPOSE event/);
    // Reworks and their events are history: never deleted, events
    // append-only.
    await assert.rejects(q(
      `DELETE FROM handyman_service_warranty_reworks WHERE id=$1`, [reworkId]),
    /preserved/);
    await assert.rejects(q(
      `UPDATE handyman_service_warranty_rework_events
          SET event_type='ACCEPT' WHERE id=$1`, [proposed.event.id]),
    /append-only/);
    await assert.rejects(q(
      `DELETE FROM handyman_service_warranty_rework_events WHERE id=$1`,
      [proposed.event.id]),
    /append-only/);
    // History preservation: the accepted BAST and the claim anchors.
    assert.equal((await bastRow(claim.bastId)).status, 'ACCEPTED');
    assert.equal((await warrantyRow(warranty.id)).starts_at.getTime(),
      (await warrantyRow(warranty.id)).bast_accepted_at.getTime());
    assert.equal((await claimRow(claim.id)).status, 'CLAIM_APPROVED');
    assert.equal(scope.id.length > 0, true);
  });

  it('keeps zero FM / SaaS coupling and no money vocabulary', async () => {
    const fks = await q(
      `SELECT c.conrelid::regclass::text AS tbl,
              c.confrelid::regclass::text AS target
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid::regclass::text IN (
            'handyman_service_warranty_reworks',
            'handyman_service_warranty_rework_events')`);
    assert.ok(fks.rows.length > 0);
    for (const row of fks.rows) {
      assert.ok(
        /^(handyman_(service_warranty_rework(s)?|service_warranty_claim(s)?|service_warranties|bast_documents|execution_scopes|evidence_records|qc_runs)|clients|users)$/
          .test(row.target),
        `unexpected FK target ${row.tbl} -> ${row.target}`);
    }
    const columns = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name LIKE 'handyman_service_warranty_rework%'`);
    for (const name of columns.rows.map((r) => r.column_name)) {
      assert.ok(
        !/amount|price|currency|charge|payment|settle|invoice|asset/.test(name),
        `firewall vocabulary leaked into column ${name}`);
    }
  });
});
