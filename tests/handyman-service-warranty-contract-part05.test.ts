import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { createAdminUser } from './helpers/access';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { baseFixture, crewFixture, initHandymanFixtures }
  from './helpers/handyman-fixtures';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import { AppError, ERROR_CODES } from '../src/shared/errors';
import {
  acceptHandymanBast,
  issueHandymanBast,
  prepareHandymanBast,
} from '../src/modules/handyman-bast';
import {
  HANDYMAN_SERVICE_WARRANTY_COVERAGE_TYPES,
  HANDYMAN_SERVICE_WARRANTY_STATUSES,
  startHandymanServiceWarranty,
} from '../src/modules/handyman-service-warranties';
import {
  HANDYMAN_SERVICE_WARRANTY_CLAIM_STATUSES,
  openHandymanServiceWarrantyClaim,
  submitHandymanServiceWarrantyClaim,
  approveHandymanServiceWarrantyClaim,
  rejectHandymanServiceWarrantyClaim,
} from '../src/modules/handyman-service-warranty-claims';
import {
  HANDYMAN_SERVICE_WARRANTY_REWORK_STATUSES,
  proposeHandymanServiceWarrantyRework,
  authorizeHandymanServiceWarrantyRework,
  startHandymanServiceWarrantyRework,
  completeHandymanServiceWarrantyRework,
  verifyHandymanServiceWarrantyRework,
} from '../src/modules/handyman-service-warranty-reworks';
import {
  HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_STATUSES,
  proposeHandymanChargeableAdditionalWork,
  acceptHandymanChargeableAdditionalWork,
} from '../src/modules/handyman-chargeable-additional-works';
import { createHandymanEvidenceRecord }
  from '../src/modules/handyman-evidence-qc';
import {
  HANDYMAN_ASSET_WARRANTY_FIREWALL,
  HANDYMAN_NOT_SERVICE_WARRANTY_CONTRACT_SOURCE,
  HANDYMAN_SERVICE_WARRANTY_CONTRACT_SOURCE,
  HANDYMAN_SERVICE_WARRANTY_CONTRACT_VERSION,
  assertHandymanServiceWarrantyContractShape,
  assertHandymanServiceWarrantyContractSource,
  assertHandymanServiceWarrantyContractStartSource,
  isNotServiceWarrantyContractSourceAlias,
  readHandymanChargeableAdditionalWorkContract,
  readHandymanServiceWarrantyClaimContract,
  readHandymanServiceWarrantyContractByExecutionScopeId,
  readHandymanServiceWarrantyContractByWarrantyId,
  readHandymanServiceWarrantyReworkContract,
} from '../src/modules/handyman-service-warranty-contracts';
import * as contractModule
  from '../src/modules/handyman-service-warranty-contracts';

/**
 * CR-HM-15 PART 05 — PUBLISHED READ CONTRACT only: read-only, versioned
 * publication of the four CR-HM-15 families (owner statuses verbatim,
 * immutable anchors, history instants, non-authoritative readiness) plus
 * the Asset-Warranty firewall. Zero new authority, zero new vocabulary,
 * zero writes, zero money, zero FM/SaaS, no HTTP/OpenAPI.
 */

const DIR = '/tmp/hm15-part05-pg';
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

/** Row-fact snapshot of the whole CR-HM-15 surface (write detector). */
const CR_HM15_TABLES = [
  'handyman_service_warranties',
  'handyman_service_warranty_coverages',
  'handyman_service_warranty_events',
  'handyman_service_warranty_claims',
  'handyman_service_warranty_claim_events',
  'handyman_service_warranty_reworks',
  'handyman_service_warranty_rework_events',
  'handyman_chargeable_additional_works',
  'handyman_chargeable_additional_work_events',
];

async function crHm15Snapshot(): Promise<Record<string, unknown[]>> {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of CR_HM15_TABLES) {
    snapshot[table] = (await q(
      `SELECT * FROM ${table} ORDER BY id`)).rows;
  }
  return snapshot;
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

async function claimFixture(decision: 'APPROVE' | 'REJECT') {
  const f: WarrantyFixture = await warrantyFixture();
  const opened = await openHandymanServiceWarrantyClaim(actor, {
    warrantyId: f.warranty.id, idempotencyKey: id(),
    evidenceRecordId: await claimEvidence(f.scope.id, f.leadUserId),
  });
  await submitHandymanServiceWarrantyClaim(actor, {
    claimId: opened.claim.id, idempotencyKey: id(),
  });
  const decided = decision === 'APPROVE'
    ? await approveHandymanServiceWarrantyClaim(actor, {
      claimId: opened.claim.id, idempotencyKey: id(),
      decisionNote: 'Workmanship defect confirmed.',
    })
    : await rejectHandymanServiceWarrantyClaim(actor, {
      claimId: opened.claim.id, idempotencyKey: id(),
      decisionNote: 'Not a covered defect.',
    });
  return { ...f, claim: decided.claim };
}

describe('CR-HM-15 PART 05 published contract projection', () => {
  it('publishes a versioned, bounded, owner-vocabulary contract', async () => {
    const { scope, bast, warranty } = await warrantyFixture();
    const contract = await readHandymanServiceWarrantyContractByWarrantyId(
      warranty.id);
    assert.equal(contract.contractVersion,
      HANDYMAN_SERVICE_WARRANTY_CONTRACT_VERSION);
    assert.equal(contract.contractSource,
      HANDYMAN_SERVICE_WARRANTY_CONTRACT_SOURCE);
    assert.equal(contract.readOnly, true);
    // Anchors are the ORIGINAL identities.
    assert.deepEqual(contract.anchors, {
      clientId: warranty.clientId,
      executionScopeId: scope.id,
      bastId: bast.id,
      warrantyId: warranty.id,
      claimId: null,
      reworkId: null,
      chargeableAdditionalWorkId: null,
    });
    // Bounded lifecycle = the owner's vocabulary, nothing else.
    assert.deepEqual(contract.lifecycle, {
      warrantyStatus: 'ACTIVE',
      claimStatus: null,
      reworkStatus: null,
      chargeableAdditionalWorkStatus: null,
    });
    assert.ok((HANDYMAN_SERVICE_WARRANTY_STATUSES as readonly string[])
      .includes(contract.warranty.status));
    // BAST/service history: the ORIGINAL start boundary, no rewriting.
    assert.equal(contract.history.bastAcceptedAt.getTime(),
      bast.acceptedAt?.getTime());
    assert.equal(contract.history.warrantyStartsAt.getTime(),
      contract.history.bastAcceptedAt.getTime());
    assert.equal(contract.history.warrantyExpiredAt, null);
    // Coverages: both frozen kinds, published as read facts.
    assert.deepEqual(
      contract.warranty.coverages.map((c) => c.coverageType).sort(),
      [...HANDYMAN_SERVICE_WARRANTY_COVERAGE_TYPES].sort());
    // Readiness facts mirror the owners' guards (no new authority).
    assert.deepEqual(contract.readiness, {
      warrantyStarted: true,
      warrantyExpired: false,
      freeReworkAvailable: false,
      freeReworkAwaitingCustomerDecision: false,
      freeReworkClosed: false,
      chargeablePathAvailable: false,
      chargeableAdditionalWorkAwaitingCustomerDecision: false,
      chargeableAdditionalWorkAuthorized: false,
      paymentTriggerEmitted: false,
    });
    assert.deepEqual(contract.claims, []);
    assert.deepEqual(contract.reworks, []);
    assert.deepEqual(contract.chargeableAdditionalWorks, []);
    // The contract publishes NO lifecycle vocabulary of its own: the
    // status sets stay owned by PART 01–04.
    const ownerVocabularies = [
      'HANDYMAN_SERVICE_WARRANTY_STATUSES',
      'HANDYMAN_SERVICE_WARRANTY_COVERAGE_TYPES',
      'HANDYMAN_SERVICE_WARRANTY_EVENT_TYPES',
      'HANDYMAN_SERVICE_WARRANTY_CLAIM_STATUSES',
      'HANDYMAN_SERVICE_WARRANTY_REWORK_STATUSES',
      'HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_STATUSES',
    ];
    for (const vocabulary of ownerVocabularies) {
      assert.equal(Object.keys(contractModule).includes(vocabulary), false,
        vocabulary);
    }
    // Order determinism: the empty lists stay empty across reads.
    const again = await readHandymanServiceWarrantyContractByWarrantyId(
      warranty.id);
    assert.deepEqual(again.lifecycle, contract.lifecycle);
    assert.deepEqual(again.anchors, contract.anchors);
  });

  it('projects claim, rework and chargeable facts through one contract',
    async () => {
      // Warranty A: APPROVED claim, free scope proposed but not accepted.
      const a = await claimFixture('APPROVE');
      const proposed = await proposeHandymanServiceWarrantyRework(actor, {
        claimId: a.claim.id, idempotencyKey: id(),
      });
      const contractA = await readHandymanServiceWarrantyClaimContract(
        a.claim.id);
      assert.equal(contractA.warranty.id, a.warranty.id);
      assert.equal(contractA.claims.length, 1);
      assert.equal(contractA.claims[0].status, 'CLAIM_APPROVED');
      assert.equal(contractA.claims[0].reworkId, proposed.rework.id);
      assert.equal(contractA.claims[0].chargeableAdditionalWorkId, null);
      assert.equal(contractA.lifecycle.warrantyStatus, 'CLAIM_APPROVED');
      assert.equal(contractA.lifecycle.claimStatus, 'CLAIM_APPROVED');
      assert.equal(contractA.lifecycle.reworkStatus, 'REWORK_DRAFT');
      assert.ok((HANDYMAN_SERVICE_WARRANTY_CLAIM_STATUSES as readonly string[])
        .includes(contractA.lifecycle.claimStatus ?? ''));
      assert.ok((HANDYMAN_SERVICE_WARRANTY_REWORK_STATUSES as readonly string[])
        .includes(contractA.lifecycle.reworkStatus ?? ''));
      assert.equal(contractA.anchors.reworkId, proposed.rework.id);
      assert.equal(contractA.readiness.freeReworkAvailable, false);
      assert.equal(contractA.readiness.freeReworkAwaitingCustomerDecision,
        true);
      assert.equal(contractA.readiness.chargeablePathAvailable, true);
      assert.equal(contractA.readiness.freeReworkClosed, false);
      // Addressed by the rework row: the SAME bounded contract.
      const byRework = await readHandymanServiceWarrantyReworkContract(
        proposed.rework.id);
      assert.deepEqual(byRework, contractA);
      // Addressed by the execution scope: the SAME bounded contract.
      const byScope = await readHandymanServiceWarrantyContractByExecutionScopeId(
        a.scope.id);
      assert.deepEqual(byScope, contractA);

      // Warranty B: free rework executed and verified — the closure fact.
      const b = await claimFixture('APPROVE');
      const chain = await proposeHandymanServiceWarrantyRework(actor, {
        claimId: b.claim.id, idempotencyKey: id(),
      });
      await authorizeHandymanServiceWarrantyRework(actor, {
        reworkId: chain.rework.id, idempotencyKey: id(),
      });
      await startHandymanServiceWarrantyRework(actor, {
        reworkId: chain.rework.id, idempotencyKey: id(),
      });
      await completeHandymanServiceWarrantyRework(actor, {
        reworkId: chain.rework.id, idempotencyKey: id(),
        completionNote: 'Joint re-sealed and re-tested.',
      });
      const evidence = await claimEvidence(b.scope.id, b.leadUserId);
      await verifyHandymanServiceWarrantyRework(actor, {
        reworkId: chain.rework.id, idempotencyKey: id(),
        evidenceRecordId: evidence,
      });
      const contractB = await readHandymanServiceWarrantyContractByWarrantyId(
        b.warranty.id);
      assert.equal(contractB.lifecycle.warrantyStatus, 'REWORK_COMPLETE');
      assert.equal(contractB.lifecycle.reworkStatus, 'REWORK_VERIFIED');
      assert.equal(contractB.readiness.freeReworkClosed, true);
      assert.equal(contractB.readiness.freeReworkAwaitingCustomerDecision,
        false);
      assert.equal(contractB.readiness.chargeablePathAvailable, false);
      assert.ok(contractB.history.reworkCompletedAt instanceof Date);
      assert.equal(contractB.history.reworkVerifiedAt?.getTime(),
        contractB.reworks[0].verifiedAt?.getTime());
      assert.equal(contractB.reworks[0].verificationEvidenceRecordId,
        evidence);

      // Warranty C: REJECTED claim on the separated chargeable path.
      const c = await claimFixture('REJECT');
      const chargeable = await proposeHandymanChargeableAdditionalWork(
        actor, { claimId: c.claim.id, idempotencyKey: id() });
      const beforeDecision =
        await readHandymanChargeableAdditionalWorkContract(
          chargeable.work.id);
      assert.equal(beforeDecision.lifecycle.claimStatus, 'CLAIM_REJECTED');
      assert.equal(beforeDecision.lifecycle.chargeableAdditionalWorkStatus,
        'CHARGEABLE_PROPOSED');
      assert.ok((HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_STATUSES as readonly
        string[]).includes(
        beforeDecision.lifecycle.chargeableAdditionalWorkStatus ?? ''));
      assert.equal(
        beforeDecision.readiness
          .chargeableAdditionalWorkAwaitingCustomerDecision, true);
      assert.equal(beforeDecision.readiness.chargeableAdditionalWorkAuthorized,
        false);
      assert.equal(beforeDecision.readiness.paymentTriggerEmitted, false);
      assert.equal(beforeDecision.readiness.chargeablePathAvailable, false);
      await acceptHandymanChargeableAdditionalWork(actor, {
        workId: chargeable.work.id, idempotencyKey: id(),
      });
      const afterDecision =
        await readHandymanChargeableAdditionalWorkContract(
          chargeable.work.id);
      assert.equal(afterDecision.lifecycle.chargeableAdditionalWorkStatus,
        'CHARGEABLE_AUTHORIZED');
      assert.equal(afterDecision.readiness.chargeableAdditionalWorkAuthorized,
        true);
      assert.equal(afterDecision.readiness.paymentTriggerEmitted, true);
      assert.ok(afterDecision.history.paymentTriggerEmittedAt instanceof Date);
      // The head is still a warranty state, never a chargeable one.
      assert.equal(afterDecision.lifecycle.warrantyStatus, 'CLAIM_REJECTED');
      assert.equal(afterDecision.lifecycle.claimStatus, 'CLAIM_REJECTED');
    });

  it('bounds missing rows with the owners own NOT_FOUND errors', async () => {
    const unknown = id();
    await assert.rejects(
      readHandymanServiceWarrantyContractByWarrantyId(unknown),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_NOT_FOUND),
    );
    await assert.rejects(
      readHandymanServiceWarrantyContractByExecutionScopeId(unknown),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_NOT_FOUND),
    );
    await assert.rejects(
      readHandymanServiceWarrantyClaimContract(unknown),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_NOT_FOUND),
    );
    await assert.rejects(
      readHandymanServiceWarrantyReworkContract(unknown),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_FOUND),
    );
    await assert.rejects(
      readHandymanChargeableAdditionalWorkContract(unknown),
      hasCode(ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_FOUND),
    );
    // Malformed addresses are bounded 400s, never an unguarded query.
    await assert.rejects(
      readHandymanServiceWarrantyContractByWarrantyId('not-a-uuid'),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_VALIDATION),
    );
  });

  it('preserves BAST and service history across repeated reads', async () => {
    const { scope, bast, warranty } = await claimFixture('APPROVE');
    const bastBefore = (await q(
      `SELECT * FROM handyman_bast_documents WHERE id=$1`, [bast.id])).rows[0];
    const warrantyBefore = (await q(
      `SELECT * FROM handyman_service_warranties WHERE id=$1`,
      [warranty.id])).rows[0];
    const first = await readHandymanServiceWarrantyContractByWarrantyId(
      warranty.id);
    const second = await readHandymanServiceWarrantyContractByWarrantyId(
      warranty.id);
    assert.deepEqual(first, second);
    // Anchors expose the ORIGINAL BAST + scope; nothing was re-pointed.
    assert.equal(first.anchors.bastId, bast.id);
    assert.equal(first.anchors.executionScopeId, scope.id);
    assert.equal(first.warranty.startsAt.getTime(),
      first.warranty.bastAcceptedAt.getTime());
    assert.deepEqual((await q(
      `SELECT * FROM handyman_bast_documents WHERE id=$1`,
      [bast.id])).rows[0], bastBefore);
    assert.deepEqual((await q(
      `SELECT * FROM handyman_service_warranties WHERE id=$1`,
      [warranty.id])).rows[0], warrantyBefore);
    // History instants come from the owners' rows, not from this module.
    assert.equal(first.history.claimSubmittedAt?.getTime(),
      first.claims[0].submittedAt?.getTime());
    assert.equal(first.history.claimDecidedAt?.getTime(),
      first.claims[0].decidedAt?.getTime());
  });

  it('enforces the Asset-Warranty firewall', async () => {
    // The frozen separations are republished verbatim (§5).
    assert.deepEqual([...HANDYMAN_ASSET_WARRANTY_FIREWALL], [
      'SESSION_COMPLETE != WARRANTY_START (CR-HM-08)',
      'CHECK_OUT != WARRANTY_START (CR-HM-08)',
      'BAST_ACCEPTED == WARRANTY_START (CR-HM-11)',
      'QC_PASS != WARRANTY_START (CR-HM-10)',
      'ASSET_WARRANTY != HANDYMAN_SERVICE_WARRANTY (CR-HM-15)',
    ]);
    assert.doesNotThrow(() =>
      assertHandymanServiceWarrantyContractSource('HANDYMAN_SERVICE_WARRANTY'));
    for (const source of HANDYMAN_NOT_SERVICE_WARRANTY_CONTRACT_SOURCE) {
      assert.equal(isNotServiceWarrantyContractSourceAlias(source), true);
      assert.throws(
        () => assertHandymanServiceWarrantyContractSource(source),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_VALIDATION), source);
    }
    // Only the ACCEPTED BAST may be published as the warranty start.
    assert.doesNotThrow(() =>
      assertHandymanServiceWarrantyContractStartSource('BAST_ACCEPTED'));
    for (const startSource of ['SESSION_COMPLETE', 'CHECK_OUT', 'QC_PASS',
      'QUOTATION_APPROVAL'] as const) {
      assert.throws(
        () => assertHandymanServiceWarrantyContractStartSource(startSource),
        hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_VALIDATION),
        startSource);
    }
    for (const alias of ['FM_ASSET_WARRANTY', 'ASSET_WARRANTY',
      'VENDOR_WARRANTY', 'SAAS_WARRANTY'] as const) {
      assert.equal(
        isNotServiceWarrantyContractSourceAlias(alias), true, alias);
    }
    // Publication-shape gate: a doctored projection refuses to publish.
    assert.throws(
      () => assertHandymanServiceWarrantyContractShape({ amount: '100' }),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_VALIDATION));
    assert.throws(
      () => assertHandymanServiceWarrantyContractShape({
        chargeable: { priceCurrency: 'IDR' },
      }),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_VALIDATION));
    assert.throws(
      () => assertHandymanServiceWarrantyContractShape({
        fmAssetWarrantyId: id(),
      }),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_VALIDATION));
    assert.throws(
      () => assertHandymanServiceWarrantyContractShape({
        nested: [{ contractSource: 'ASSET_WARRANTY' }],
      }),
      hasCode(ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_VALIDATION));
    // … and the REAL contract passes the gate untouched.
    const { warranty } = await claimFixture('REJECT');
    const contract = await readHandymanServiceWarrantyContractByWarrantyId(
      warranty.id);
    assert.doesNotThrow(() =>
      assertHandymanServiceWarrantyContractShape(contract));
    const keys = JSON.stringify(contract);
    for (const forbidden of ['amount', 'price', 'currency', 'ledger',
      'settle', 'invoice', 'entitlement', 'fmAsset', 'assetWarranty',
      'saas', 'vendor']) {
      assert.equal(keys.toLowerCase().includes(forbidden.toLowerCase()),
        false, forbidden);
    }
  });

  it('adds no lifecycle authority and writes nothing', async () => {
    const { warranty } = await claimFixture('APPROVE');
    const before = await crHm15Snapshot();
    await readHandymanServiceWarrantyContractByWarrantyId(warranty.id);
    await readHandymanServiceWarrantyContractByExecutionScopeId(
      (await q(`SELECT execution_scope_id AS s
                  FROM handyman_service_warranties WHERE id=$1`,
      [warranty.id])).rows[0].s);
    const after = await crHm15Snapshot();
    assert.deepEqual(after, before);
    // No mutating export exists on the published contract surface.
    const mutatingVerb = new RegExp(
      '^(create|update|insert|delete|remove|start|expire|open|submit'
      + '|approve|reject|withdraw|propose|accept|authorize|complete|verify'
      + '|write|mutate|pay)', 'i');
    assert.deepEqual(Object.keys(contractModule).filter((key) =>
      mutatingVerb.test(key)), []);
    // The reader source performs no write statement at all.
    const readerPath = path.join(process.cwd(),
      'src/modules/handyman-service-warranty-contracts',
      'handyman-service-warranty-contract.reader.ts');
    const source = readFileSync(readerPath, 'utf8');
    assert.equal(/(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)/i.test(source),
      false);
    assert.equal(/(migrateUp|withTransaction)/.test(source), false);
  });
});
