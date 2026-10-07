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
} from '../src/modules/handyman-bast';
import {
  expireHandymanServiceWarranty,
  findHandymanServiceWarrantyByScopeId,
  startHandymanServiceWarranty,
} from '../src/modules/handyman-service-warranties';
import {
  openHandymanServiceWarrantyClaim,
  submitHandymanServiceWarrantyClaim,
  approveHandymanServiceWarrantyClaim,
  rejectHandymanServiceWarrantyClaim,
  withdrawHandymanServiceWarrantyClaim,
  getHandymanServiceWarrantyClaimById,
  listHandymanServiceWarrantyClaims,
  assertHandymanServiceWarrantyClaimIntakeEligible,
  nextHandymanServiceWarrantyClaimStatus,
  nextHandymanServiceWarrantyClaimHeadStatus,
  isNotWarrantyClaimTriggerAlias,
  HANDYMAN_SERVICE_WARRANTY_CLAIM_STATUSES,
  HANDYMAN_SERVICE_WARRANTY_CLAIM_EVENT_TYPES,
  HANDYMAN_SERVICE_WARRANTY_CLAIM_ACTIONS,
  HANDYMAN_NOT_WARRANTY_CLAIM_TRIGGER,
} from '../src/modules/handyman-service-warranty-claims';

/**
 * CR-HM-15 PART 02 — warranty CLAIM INTAKE only: claims bind to an
 * EXISTING service warranty and its ORIGINAL scope; the warranty, BAST
 * and service history are preserved. No rework execution, no
 * pricing/payment/settlement, no FM/SaaS, no HTTP.
 */

const DIR = '/tmp/hm15-part02-pg';
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
  (await q(`SELECT status, accepted_at, rejected_at, voided_at, client_id,
                   execution_scope_id
              FROM handyman_bast_documents WHERE id=$1`, [bastId])).rows[0];

const warrantyRow = async (warrantyId: string) =>
  (await q(`SELECT * FROM handyman_service_warranties WHERE id=$1`,
    [warrantyId])).rows[0];

/** A started warranty whose BAST is ACCEPTED (PART 01 law). */
async function warrantyFixture() {
  const { realm, scope } = await baseFixture();
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
  return { realm, scope, bast: signed.bast, warranty: started.warranty };
}

/** An evidence record of the scope (frozen stage vocabulary). */
async function evidenceFixture(
  realm: { client: { id: string } }, scopeId: string,
) {
  const evidenceId = id();
  await q(`INSERT INTO handyman_evidence_records
             (id, client_id, execution_scope_id, stage, description)
           VALUES ($1, $2, $3, 'DEFECT', 'warranty claim evidence')`,
  [evidenceId, realm.client.id, scopeId]);
  return evidenceId;
}

describe('CR-HM-15 PART 02 claim lifecycle guards', () => {
  it('freezes vocabulary', () => {
    assert.deepEqual([...HANDYMAN_SERVICE_WARRANTY_CLAIM_STATUSES], [
      'CLAIM_DRAFT', 'CLAIM_SUBMITTED', 'CLAIM_APPROVED', 'CLAIM_REJECTED',
      'CLAIM_WITHDRAWN',
    ]);
    assert.deepEqual([...HANDYMAN_SERVICE_WARRANTY_CLAIM_EVENT_TYPES], [
      'OPEN', 'SUBMIT', 'APPROVE', 'REJECT', 'WITHDRAW',
    ]);
    assert.deepEqual([...HANDYMAN_SERVICE_WARRANTY_CLAIM_ACTIONS], [
      'SUBMIT', 'APPROVE', 'REJECT', 'WITHDRAW',
    ]);
    // Session COMPLETE / CHECK_OUT / QC PASS / quotation approval / FM
    // asset warranty never trigger or decide a claim.
    for (const alias of HANDYMAN_NOT_WARRANTY_CLAIM_TRIGGER) {
      assert.equal(isNotWarrantyClaimTriggerAlias(alias), true);
    }
    assert.equal(isNotWarrantyClaimTriggerAlias('ACCEPTED_BAST'), false);
    assert.equal(isNotWarrantyClaimTriggerAlias('CLAIM_SUBMITTED'), false);
  });

  it('gates intake on the ACTIVE warranty state only', () => {
    assert.doesNotThrow(
      () => assertHandymanServiceWarrantyClaimIntakeEligible('ACTIVE'));
    for (const status of ['INELIGIBLE', 'CLAIM_OPEN', 'CLAIM_APPROVED',
      'CLAIM_REJECTED', 'REWORK_IN_PROGRESS', 'REWORK_COMPLETE',
      'EXPIRED'] as const) {
      assert.throws(
        () => assertHandymanServiceWarrantyClaimIntakeEligible(status),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_NOT_ELIGIBLE),
        status);
    }
  });

  it('freezes the claim record and warranty head machines', () => {
    assert.equal(
      nextHandymanServiceWarrantyClaimStatus('CLAIM_DRAFT', 'SUBMIT'),
      'CLAIM_SUBMITTED');
    assert.equal(
      nextHandymanServiceWarrantyClaimStatus('CLAIM_SUBMITTED', 'APPROVE'),
      'CLAIM_APPROVED');
    assert.equal(
      nextHandymanServiceWarrantyClaimStatus('CLAIM_SUBMITTED', 'REJECT'),
      'CLAIM_REJECTED');
    assert.equal(
      nextHandymanServiceWarrantyClaimStatus('CLAIM_SUBMITTED', 'WITHDRAW'),
      'CLAIM_WITHDRAWN');
    for (const from of ['CLAIM_DRAFT', 'CLAIM_APPROVED', 'CLAIM_REJECTED',
      'CLAIM_WITHDRAWN'] as const) {
      for (const action of ['APPROVE', 'REJECT', 'WITHDRAW']) {
        assert.throws(
          () => nextHandymanServiceWarrantyClaimStatus(from, action),
          hasCode(
            ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_ILLEGAL_TRANSITION),
          `${from}/${action}`);
      }
    }
    assert.throws(
      () => nextHandymanServiceWarrantyClaimStatus('CLAIM_SUBMITTED', 'SUBMIT'),
      hasCode(
        ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_ILLEGAL_TRANSITION));

    assert.equal(
      nextHandymanServiceWarrantyClaimHeadStatus('ACTIVE', 'SUBMIT'),
      'CLAIM_OPEN');
    assert.equal(
      nextHandymanServiceWarrantyClaimHeadStatus('CLAIM_OPEN', 'APPROVE'),
      'CLAIM_APPROVED');
    assert.equal(
      nextHandymanServiceWarrantyClaimHeadStatus('CLAIM_OPEN', 'REJECT'),
      'CLAIM_REJECTED');
    assert.equal(
      nextHandymanServiceWarrantyClaimHeadStatus('CLAIM_OPEN', 'WITHDRAW'),
      'ACTIVE');
    for (const from of ['ACTIVE', 'CLAIM_APPROVED', 'CLAIM_REJECTED',
      'EXPIRED', 'INELIGIBLE'] as const) {
      for (const action of ['APPROVE', 'REJECT', 'WITHDRAW']) {
        assert.throws(
          () => nextHandymanServiceWarrantyClaimHeadStatus(from, action),
          hasCode(
            ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_ILLEGAL_TRANSITION),
          `${from}/${action}`);
      }
    }
    // Rework execution does not exist in PART 02.
    assert.throws(
      () => nextHandymanServiceWarrantyClaimHeadStatus('CLAIM_APPROVED',
        'REWORK_START'),
      hasCode(
        ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_ILLEGAL_TRANSITION));
  });
});

describe('CR-HM-15 PART 02 claim intake and decision', () => {
  it('binds a claim to the existing warranty and its original scope',
    async () => {
      const { scope, bast, warranty } = await warrantyFixture();
      const bastBefore = await bastRow(bast.id);
      const warrantyBefore = await warrantyRow(warranty.id);
      const opened = await openHandymanServiceWarrantyClaim(actor, {
        warrantyId: warranty.id, idempotencyKey: id(),
        claimNote: 'Seal leaks again after the visit.',
      });
      assert.equal(opened.replayed, false);
      assert.equal(opened.claim.status, 'CLAIM_DRAFT');
      assert.equal(opened.claim.warrantyId, warranty.id);
      assert.equal(opened.claim.executionScopeId, scope.id);
      assert.equal(opened.claim.bastId, bast.id);
      assert.equal(opened.claim.clientId, warrantyBefore.client_id);
      assert.equal(opened.event.eventType, 'OPEN');
      // A draft claim is not a warranty state: the head is untouched.
      assert.equal(opened.warrantyStatus, 'ACTIVE');
      assert.equal((await warrantyRow(warranty.id)).status, 'ACTIVE');
      // The accepted BAST / service history is preserved.
      assert.deepEqual(await bastRow(bast.id), bastBefore);
      assert.deepEqual(await warrantyRow(warranty.id), warrantyBefore);
    });

  it('submits with evidence and mirrors the head as CLAIM_OPEN', async () => {
    const { realm, scope, warranty } = await warrantyFixture();
    const evidenceId = await evidenceFixture(realm, scope.id);
    const opened = await openHandymanServiceWarrantyClaim(actor, {
      warrantyId: warranty.id, idempotencyKey: id(),
    });
    await assert.rejects(
      submitHandymanServiceWarrantyClaim(actor, {
        claimId: opened.claim.id, idempotencyKey: id(),
      }),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_EVIDENCE_REQUIRED),
    );
    const submitted = await submitHandymanServiceWarrantyClaim(actor, {
      claimId: opened.claim.id, idempotencyKey: id(),
      evidenceRecordId: evidenceId,
    });
    assert.equal(submitted.claim.status, 'CLAIM_SUBMITTED');
    assert.equal(submitted.claim.evidenceRecordId, evidenceId);
    assert.equal(submitted.claim.claimantUserId, actor);
    assert.ok(submitted.claim.submittedAt instanceof Date);
    assert.deepEqual(submitted.claim.decidedAt, null);
    assert.equal(submitted.warrantyStatus, 'CLAIM_OPEN');
    assert.equal((await warrantyRow(warranty.id)).status, 'CLAIM_OPEN');
    assert.equal(submitted.event.eventType, 'SUBMIT');
    // The start boundary of the warranty is untouched by the claim.
    const reloaded = await findHandymanServiceWarrantyByScopeId(scope.id);
    assert.equal(reloaded?.startsAt.getTime(),
      reloaded?.bastAcceptedAt.getTime());
    assert.equal(reloaded?.bastId, opened.claim.bastId);
  });

  it('approves a submitted claim and freezes it as decided', async () => {
    const { realm, scope, warranty } = await warrantyFixture();
    const evidenceId = await evidenceFixture(realm, scope.id);
    const opened = await openHandymanServiceWarrantyClaim(actor, {
      warrantyId: warranty.id, idempotencyKey: id(),
      evidenceRecordId: evidenceId,
    });
    await submitHandymanServiceWarrantyClaim(actor, {
      claimId: opened.claim.id, idempotencyKey: id(),
    });
    const approved = await approveHandymanServiceWarrantyClaim(actor, {
      claimId: opened.claim.id, idempotencyKey: id(),
      decisionNote: 'Workmanship defect confirmed on site.',
    });
    assert.equal(approved.claim.status, 'CLAIM_APPROVED');
    assert.equal(approved.claim.decidedByUserId, actor);
    assert.ok(approved.claim.decidedAt instanceof Date);
    assert.equal(approved.warrantyStatus, 'CLAIM_APPROVED');
    assert.equal(approved.event.eventType, 'APPROVE');
    // One authoritative transition per claim: a second decision fails.
    await assert.rejects(
      approveHandymanServiceWarrantyClaim(actor, {
        claimId: opened.claim.id, idempotencyKey: id(),
      }),
      hasCode(
        ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_ILLEGAL_TRANSITION),
    );
    await assert.rejects(
      rejectHandymanServiceWarrantyClaim(actor, {
        claimId: opened.claim.id, idempotencyKey: id(),
        decisionNote: 'second thoughts',
      }),
      hasCode(
        ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_ILLEGAL_TRANSITION),
    );
    assert.equal((await warrantyRow(warranty.id)).status, 'CLAIM_APPROVED');
  });

  it('rejects a claim with a recorded reason and reaches CLAIM_REJECTED',
    async () => {
      const { realm, scope, warranty } = await warrantyFixture();
      const evidenceId = await evidenceFixture(realm, scope.id);
      const opened = await openHandymanServiceWarrantyClaim(actor, {
        warrantyId: warranty.id, idempotencyKey: id(),
        evidenceRecordId: evidenceId,
      });
      await submitHandymanServiceWarrantyClaim(actor, {
        claimId: opened.claim.id, idempotencyKey: id(),
      });
      // A rejection without a reason is refused (bounded validation).
      await assert.rejects(
        rejectHandymanServiceWarrantyClaim(actor, {
          claimId: opened.claim.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_VALIDATION),
      );
      const rejected = await rejectHandymanServiceWarrantyClaim(actor, {
        claimId: opened.claim.id, idempotencyKey: id(),
        decisionNote: 'No covered defect found; chargeable path applies.',
      });
      assert.equal(rejected.claim.status, 'CLAIM_REJECTED');
      assert.equal(rejected.claim.decisionNote,
        'No covered defect found; chargeable path applies.');
      assert.equal(rejected.warrantyStatus, 'CLAIM_REJECTED');
      assert.equal((await warrantyRow(warranty.id)).status, 'CLAIM_REJECTED');
      // Rejected warranty accepts no new free-warranty claim.
      await assert.rejects(
        openHandymanServiceWarrantyClaim(actor, {
          warrantyId: warranty.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_NOT_ELIGIBLE),
      );
      assert.equal(scope.id.length > 0, true);
    });

  it('withdraws a claim back to an ACTIVE warranty', async () => {
    const { realm, scope, warranty } = await warrantyFixture();
    const evidenceId = await evidenceFixture(realm, scope.id);
    const opened = await openHandymanServiceWarrantyClaim(actor, {
      warrantyId: warranty.id, idempotencyKey: id(),
      evidenceRecordId: evidenceId,
    });
    await submitHandymanServiceWarrantyClaim(actor, {
      claimId: opened.claim.id, idempotencyKey: id(),
    });
    const withdrawn = await withdrawHandymanServiceWarrantyClaim(actor, {
      claimId: opened.claim.id, idempotencyKey: id(),
    });
    assert.equal(withdrawn.claim.status, 'CLAIM_WITHDRAWN');
    assert.ok(withdrawn.claim.withdrawnAt instanceof Date);
    assert.deepEqual(withdrawn.claim.decidedAt, null);
    assert.equal(withdrawn.warrantyStatus, 'ACTIVE');
    assert.equal((await warrantyRow(warranty.id)).status, 'ACTIVE');
    // The withdrawn claim is terminal and the warranty may claim again.
    await assert.rejects(
      submitHandymanServiceWarrantyClaim(actor, {
        claimId: opened.claim.id, idempotencyKey: id(),
      }),
      hasCode(
        ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_ILLEGAL_TRANSITION),
    );
    const second = await openHandymanServiceWarrantyClaim(actor, {
      warrantyId: warranty.id, idempotencyKey: id(),
      evidenceRecordId: evidenceId,
    });
    assert.equal(second.claim.status, 'CLAIM_DRAFT');
    assert.equal(second.claim.id !== opened.claim.id, true);
  });

  it('is idempotent and bounded (one open claim, single-use keys)',
    async () => {
      const { realm, scope, warranty } = await warrantyFixture();
      const evidenceId = await evidenceFixture(realm, scope.id);
      const openKey = id();
      const first = await openHandymanServiceWarrantyClaim(actor, {
        warrantyId: warranty.id, idempotencyKey: openKey,
      });
      const replay = await openHandymanServiceWarrantyClaim(actor, {
        warrantyId: warranty.id, idempotencyKey: openKey,
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.claim.id, first.claim.id);
      assert.equal(replay.event.id, first.event.id);
      await assert.rejects(
        openHandymanServiceWarrantyClaim(actor, {
          warrantyId: warranty.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_CONFLICT),
      );
      const submitKey = id();
      const submitted = await submitHandymanServiceWarrantyClaim(actor, {
        claimId: first.claim.id, idempotencyKey: submitKey,
        evidenceRecordId: evidenceId,
      });
      const submitReplay = await submitHandymanServiceWarrantyClaim(actor, {
        claimId: first.claim.id, idempotencyKey: submitKey,
        evidenceRecordId: evidenceId,
      });
      assert.equal(submitReplay.replayed, true);
      assert.equal(submitReplay.event.id, submitted.event.id);
      assert.equal(submitReplay.claim.status, 'CLAIM_SUBMITTED');
      assert.equal(
        (await q(`SELECT count(*)::int AS n
                    FROM handyman_service_warranty_claims WHERE warranty_id=$1`,
        [warranty.id])).rows[0].n, 1);
      // The claim is bound to the scope's ORIGINAL warranty, and the
      // claim list proves only this scope's warranty is affected.
      assert.equal((await listHandymanServiceWarrantyClaims(warranty.id)).length,
        1);
      assert.equal(scope.id.length > 0, true);
    });

  it('refuses intake on expired warranties and foreign evidence',
    async () => {
      const { realm, scope, warranty } = await warrantyFixture();
      const expiredFixture = await warrantyFixture();
      await expireHandymanServiceWarranty(
        { warrantyId: expiredFixture.warranty.id, idempotencyKey: id() },
        actor);
      await assert.rejects(
        openHandymanServiceWarrantyClaim(actor, {
          warrantyId: expiredFixture.warranty.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_NOT_ELIGIBLE),
      );
      // Evidence of another scope/client can never be bound.
      const foreign = await warrantyFixture();
      const foreignEvidence = await evidenceFixture(foreign.realm,
        foreign.scope.id);
      await assert.rejects(
        openHandymanServiceWarrantyClaim(actor, {
          warrantyId: warranty.id, idempotencyKey: id(),
          evidenceRecordId: foreignEvidence,
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_EVIDENCE_INVALID),
      );
      await assert.rejects(
        openHandymanServiceWarrantyClaim(actor, {
          warrantyId: warranty.id, idempotencyKey: id(),
          evidenceRecordId: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_EVIDENCE_INVALID),
      );
      const outsider = await userService.createUser({
        email: `outsider-${id().slice(0, 8)}@example.com`,
        displayName: 'Outsider',
      });
      await assert.rejects(
        openHandymanServiceWarrantyClaim(outsider.id, {
          warrantyId: warranty.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_NOT_AUTHORIZED),
      );
      // A warranty with no claim is still absent of claim rows.
      assert.equal(
        (await q(`SELECT count(*)::int AS n
                    FROM handyman_service_warranty_claims WHERE warranty_id=$1`,
        [warranty.id])).rows[0].n, 0);
      assert.equal(realm.client.id.length > 0 && scope.id.length > 0, true);
    });

  it('enforces claim binding, history preservation and firewall laws in SQL',
    async () => {
      const { realm, scope, warranty } = await warrantyFixture();
      const evidenceId = await evidenceFixture(realm, scope.id);
      const opened = await openHandymanServiceWarrantyClaim(actor, {
        warrantyId: warranty.id, idempotencyKey: id(),
        evidenceRecordId: evidenceId,
      });

      // A claim cannot be handed another warranty's identity.
      const other = await warrantyFixture();
      await assert.rejects(q(
        `UPDATE handyman_service_warranty_claims SET warranty_id=$2
          WHERE id=$1`, [opened.claim.id, other.warranty.id]),
      /immutable/);
      // A claim can never be opened outside the governed path (raw SQL).
      await assert.rejects(q(
        `INSERT INTO handyman_service_warranty_claims
           (id, client_id, warranty_id, execution_scope_id, bast_id,
            status, opened_by_user_id)
         VALUES ($1,$2,$3,$4,$5,'CLAIM_APPROVED',$6)`,
        [id(), other.warranty.clientId, other.warranty.id,
          other.warranty.executionScopeId, other.warranty.bastId, actor]),
      /CLAIM_DRAFT/);
      // A second open claim for the same warranty is refused.
      await assert.rejects(
        openHandymanServiceWarrantyClaim(actor, {
          warrantyId: warranty.id, idempotencyKey: id(),
        }),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_CONFLICT),
      );
      await assert.rejects(q(
        `INSERT INTO handyman_service_warranty_claims
           (id, client_id, warranty_id, execution_scope_id, bast_id,
            status, opened_by_user_id)
         VALUES ($1,$2,$3,$4,$5,'CLAIM_DRAFT',$6)`,
        [id(), warranty.clientId, warranty.id, warranty.executionScopeId,
          warranty.bastId, actor]),
      /duplicate key|unique/i);
      // Evidence of another client/scope can never be bound (raw SQL).
      await assert.rejects(q(
        `UPDATE handyman_service_warranty_claims SET evidence_record_id=$2
          WHERE id=$1`, [opened.claim.id,
          (await evidenceFixture(other.realm, other.scope.id))]),
      /ORIGINAL execution scope/);
      // Claims are history: never deleted, never status-forged.
      await assert.rejects(q(
        `DELETE FROM handyman_service_warranty_claims WHERE id=$1`,
        [opened.claim.id]), /preserved/);
      await assert.rejects(q(
        `UPDATE handyman_service_warranty_claims
            SET status='REWORK_IN_PROGRESS' WHERE id=$1`,
        [opened.claim.id]), /transition|state machine/i);
      // A claim without its OPEN event can never become durable.
      await assert.rejects(q(
        `INSERT INTO handyman_service_warranty_claims
           (id, client_id, warranty_id, execution_scope_id, bast_id,
            status, opened_by_user_id)
         SELECT $1, w.client_id, w.id, w.execution_scope_id, w.bast_id,
                'CLAIM_DRAFT', $2
           FROM handyman_service_warranties w WHERE w.id=$3`,
        [id(), actor, other.warranty.id]),
      /without its OPEN event/);
      // The head cannot claim CLAIM_OPEN without a submitted claim.
      const forged = await warrantyFixture();
      await assert.rejects(q(
        `UPDATE handyman_service_warranties SET status='CLAIM_OPEN'
          WHERE id=$1`, [forged.warranty.id]),
      /contradict its claim facts/);
      // Events are append-only.
      await assert.rejects(q(
        `UPDATE handyman_service_warranty_claim_events
            SET event_type='SUBMIT' WHERE id=$1`, [opened.event.id]),
      /append-only/);
      await assert.rejects(q(
        `DELETE FROM handyman_service_warranty_claim_events WHERE id=$1`,
        [opened.event.id]), /append-only/);
      // The original BAST and warranty anchors survive all of the above.
      assert.equal((await bastRow(opened.claim.bastId)).status, 'ACCEPTED');
      assert.equal((await warrantyRow(warranty.id)).status, 'ACTIVE');
      assert.equal((await getHandymanServiceWarrantyClaimById(opened.claim.id))
        .status, 'CLAIM_DRAFT');
    });

  it('keeps zero FM / SaaS coupling and no money vocabulary', async () => {
    const fks = await q(
      `SELECT c.conrelid::regclass::text AS tbl,
              c.confrelid::regclass::text AS target
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid::regclass::text IN (
            'handyman_service_warranty_claims',
            'handyman_service_warranty_claim_events')`);
    assert.ok(fks.rows.length > 0);
    for (const row of fks.rows) {
      assert.ok(
        /^(handyman_(service_warranty_claim(s)?|service_warranties|bast_documents|execution_scopes|evidence_records)|clients|users)$/
          .test(row.target),
        `unexpected FK target ${row.tbl} -> ${row.target}`);
    }
    const columns = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name LIKE 'handyman_service_warranty_claim%'`);
    for (const name of columns.rows.map((r) => r.column_name)) {
      assert.ok(
        !/amount|price|currency|charge|payment|settle|invoice|asset|rework/
          .test(name),
        `firewall vocabulary leaked into column ${name}`);
    }
  });
});
