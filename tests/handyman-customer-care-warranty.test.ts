import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  acceptHandymanBast,
  issueHandymanBast,
  prepareHandymanBast,
} from '../src/modules/handyman-bast';
import { proposeHandymanChargeableAdditionalWork } from '../src/modules/handyman-chargeable-additional-works';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { createHandymanEvidenceRecord } from '../src/modules/handyman-evidence-qc';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { startHandymanServiceWarranty } from '../src/modules/handyman-service-warranties';
import {
  assertHandymanServiceWarrantyContractShape,
  HANDYMAN_SERVICE_WARRANTY_CONTRACT_SOURCE,
  HANDYMAN_SERVICE_WARRANTY_CONTRACT_VERSION,
} from '../src/modules/handyman-service-warranty-contracts';
import { proposeHandymanServiceWarrantyRework } from '../src/modules/handyman-service-warranty-reworks';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';

/**
 * CR-HM-17 TRANSPORT GAP — PART 06 B7 WARRANTY
 *
 * Verifies the thin Customer Care HTTP/OpenAPI transport over CR-HM-15:
 *   - 5 published contract GET readers (`tenant_company.read` + `canAccessClient`)
 *   - 8 governed customer claim/decision POST commands (`tenant_company.manage` +
 *     `canAccessClient` + `idempotencyKey` + audit events)
 *   - Reuse of CR-HM-15 authority (`WORKMANSHIP`/`MATERIAL` coverages, claims,
 *     free rework, separated chargeable additional work)
 *   - Strict firewall: no field-worker commands, no warranty lifecycle
 *     calculation, no CR-HM-13/14 financial leakage, no FM asset-warranty fallback
 */

const DIR = '/tmp/hm17-part06-warranty-pg';
const PORT = 55466;
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  DB_NAME: 'asentra_test',
  DB_HOST: '127.0.0.1',
  DB_PORT: String(PORT),
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_SSL: 'false',
});

let pg: EmbeddedPostgres;
let pool: Pool;
let adminUserId: string;
let adminToken: string;
const app = createApp();
const id = () => randomUUID();
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

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

async function crHm15RowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of CR_HM15_TABLES) {
    const res = await q(`SELECT COUNT(*)::int AS c FROM ${table}`);
    counts[table] = res.rows[0].c;
  }
  return counts;
}

async function seedStartedWarranty() {
  const { realm, chain, scope } = await baseFixture();
  const crew = await crewFixture(realm);
  await assignHandymanExecutionScopeCrew(
    {
      executionScopeId: scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    },
    adminUserId,
  );
  const prepared = await prepareHandymanBast(adminUserId, {
    executionScopeId: scope.id,
    idempotencyKey: `prep-${id()}`,
  });
  await issueHandymanBast(adminUserId, {
    bastId: prepared.bast.id,
    idempotencyKey: `issue-${id()}`,
  });
  const accepted = await acceptHandymanBast(adminUserId, {
    bastId: prepared.bast.id,
    idempotencyKey: `accept-${id()}`,
    signatureDigest: `sig-${id()}`,
  });
  const started = await startHandymanServiceWarranty(
    {
      executionScopeId: scope.id,
      idempotencyKey: `start-warranty-${id()}`,
    },
    adminUserId,
  );
  return {
    realm,
    chain,
    scope,
    bast: accepted.bast,
    warranty: started.warranty,
    leadUserId: crew.leadUser.id,
  };
}

async function seedDefectEvidence(scopeId: string, leadUserId: string) {
  const created = await createHandymanEvidenceRecord(
    {
      executionScopeId: scopeId,
      stage: 'DEFECT' as never,
      description: 'Post-handover warranty defect photo',
      idempotencyKey: `defect-ev-${id()}`,
    },
    leadUserId,
  );
  return created.record.id;
}

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  pg = new EmbeddedPostgres({
    databaseDir: DIR,
    port: PORT,
    user: 'postgres',
    password: '',
    persistent: true,
    authMethod: 'trust',
  });
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

  const adminSession = await createAdminUser();
  adminUserId = adminSession.userId;
  adminToken = adminSession.token;

  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  assert.ok(discipline);
  initHandymanFixtures({
    adminUserId,
    disciplineId: discipline.id,
    query: q,
  });
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
});

describe('CR-HM-17 GAP PART 06 — B7 Service Warranty Customer Care Transport', () => {
  it('exposes read-only service warranty contract by executionScopeId and warrantyId with WORKMANSHIP + MATERIAL coverages', async () => {
    const { scope, bast, warranty } = await seedStartedWarranty();
    const beforeCounts = await crHm15RowCounts();

    const byScopeRes = await request(app)
      .get(`/api/v1/handyman/execution-scopes/${scope.id}/service-warranty`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(byScopeRes.status, 200);
    const byScope = byScopeRes.body.data;
    assert.equal(
      byScope.contractVersion,
      HANDYMAN_SERVICE_WARRANTY_CONTRACT_VERSION,
    );
    assert.equal(
      byScope.contractSource,
      HANDYMAN_SERVICE_WARRANTY_CONTRACT_SOURCE,
    );
    assert.equal(byScope.readOnly, true);
    assert.equal(byScope.warranty.id, warranty.id);
    assert.equal(byScope.warranty.executionScopeId, scope.id);
    assert.equal(byScope.warranty.bastId, bast.id);
    assert.equal(byScope.warranty.status, 'ACTIVE');
    assert.deepEqual(
      byScope.warranty.coverages
        .map((c: { coverageType: string }) => c.coverageType)
        .sort(),
      ['MATERIAL', 'WORKMANSHIP'],
    );
    assert.equal(byScope.readiness.warrantyStarted, true);
    assert.equal(byScope.readiness.warrantyExpired, false);
    assertHandymanServiceWarrantyContractShape(byScope);

    const byIdRes = await request(app)
      .get(`/api/v1/handyman/service-warranties/${warranty.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(byIdRes.status, 200);
    assert.deepEqual(byIdRes.body.data, byScope);

    const afterCounts = await crHm15RowCounts();
    assert.deepEqual(afterCounts, beforeCounts);
  });

  it('governs warranty claim open, submit, approve, reject, withdraw, and read by claimId with idempotency', async () => {
    // 1. Open -> Submit -> Approve path
    const f1 = await seedStartedWarranty();
    const ev1 = await seedDefectEvidence(f1.scope.id, f1.leadUserId);
    const openKey = `open-${id()}`;

    const openRes = await request(app)
      .post(`/api/v1/handyman/service-warranties/${f1.warranty.id}/claims`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        idempotencyKey: openKey,
        claimNote: 'Pipe joint leaking after handover',
      });
    assert.equal(openRes.status, 200);
    assert.equal(openRes.body.data.replayed, false);
    assert.equal(openRes.body.data.claim.status, 'CLAIM_DRAFT');
    assert.equal(openRes.body.data.event.eventType, 'OPEN');
    assertHandymanServiceWarrantyContractShape(openRes.body.data);
    const claim1Id = openRes.body.data.claim.id as string;

    // Idempotent replay on open
    const openReplay = await request(app)
      .post(`/api/v1/handyman/service-warranties/${f1.warranty.id}/claims`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        idempotencyKey: openKey,
        claimNote: 'Pipe joint leaking after handover',
      });
    assert.equal(openReplay.status, 200);
    assert.equal(openReplay.body.data.replayed, true);
    assert.equal(openReplay.body.data.claim.id, claim1Id);

    // Approve before submit fails 409 (invalid lifecycle transition)
    const approveBeforeSubmit = await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${claim1Id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        idempotencyKey: `early-app-${id()}`,
        decisionNote: 'Too early',
      });
    assert.equal(approveBeforeSubmit.status, 409);

    // Submit without defect evidence fails 400 (HANDYMAN_SERVICE_WARRANTY_CLAIM_EVIDENCE_REQUIRED)
    const submitWithoutEv = await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${claim1Id}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ idempotencyKey: `sub-no-ev-${id()}` });
    assert.equal(submitWithoutEv.status, 400);

    // Submit with defect evidence transitions CLAIM_DRAFT -> CLAIM_SUBMITTED
    const submitRes = await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${claim1Id}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        idempotencyKey: `sub-${id()}`,
        evidenceRecordId: ev1,
      });
    assert.equal(submitRes.status, 200);
    assert.equal(submitRes.body.data.claim.status, 'CLAIM_SUBMITTED');
    assert.equal(submitRes.body.data.claim.evidenceRecordId, ev1);

    // Approve transitions CLAIM_SUBMITTED -> CLAIM_APPROVED
    const approveRes = await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${claim1Id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        idempotencyKey: `approve-${id()}`,
        decisionNote: 'Covered workmanship defect confirmed',
      });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.data.claim.status, 'CLAIM_APPROVED');

    // Read contract by claimId
    const claimReadRes = await request(app)
      .get(`/api/v1/handyman/service-warranty-claims/${claim1Id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(claimReadRes.status, 200);
    assert.equal(claimReadRes.body.data.anchors.claimId, claim1Id);
    assert.equal(
      claimReadRes.body.data.lifecycle.claimStatus,
      'CLAIM_APPROVED',
    );
    assert.equal(claimReadRes.body.data.readiness.freeReworkAvailable, true);
    assert.equal(
      claimReadRes.body.data.readiness.chargeablePathAvailable,
      true,
    );

    // 2. Open -> Submit -> Withdraw path, then Open -> Submit -> Reject path
    const f2 = await seedStartedWarranty();
    const ev2 = await seedDefectEvidence(f2.scope.id, f2.leadUserId);
    const open2 = await request(app)
      .post(`/api/v1/handyman/service-warranties/${f2.warranty.id}/claims`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        idempotencyKey: `open2-${id()}`,
        evidenceRecordId: ev2,
      });
    const claim2Id = open2.body.data.claim.id as string;
    await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${claim2Id}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ idempotencyKey: `sub2-${id()}` })
      .expect(200);
    const withdrawRes = await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${claim2Id}/withdraw`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ idempotencyKey: `withdraw2-${id()}` });
    assert.equal(withdrawRes.status, 200);
    assert.equal(withdrawRes.body.data.claim.status, 'CLAIM_WITHDRAWN');

    // Reject path on a new submitted claim
    const open3 = await request(app)
      .post(`/api/v1/handyman/service-warranties/${f2.warranty.id}/claims`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        idempotencyKey: `open3-${id()}`,
        evidenceRecordId: ev2,
      });
    const claim3Id = open3.body.data.claim.id as string;
    await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${claim3Id}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ idempotencyKey: `sub3-${id()}` })
      .expect(200);
    const rejectRes = await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${claim3Id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        idempotencyKey: `reject3-${id()}`,
        decisionNote: 'Outside warranty scope — third-party damage',
      });
    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.body.data.claim.status, 'CLAIM_REJECTED');

    const rejectedClaimContract = await request(app)
      .get(`/api/v1/handyman/service-warranty-claims/${claim3Id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(rejectedClaimContract.status, 200);
    assert.equal(
      rejectedClaimContract.body.data.lifecycle.claimStatus,
      'CLAIM_REJECTED',
    );
    assert.equal(
      rejectedClaimContract.body.data.readiness.chargeablePathAvailable,
      true,
    );
    assert.equal(
      rejectedClaimContract.body.data.readiness.freeReworkAvailable,
      false,
    );
  });

  it('governs free warranty rework customer authorization and chargeable additional work customer decisions', async () => {
    // Free warranty rework path on CLAIM_APPROVED
    const fRework = await seedStartedWarranty();
    const evRework = await seedDefectEvidence(
      fRework.scope.id,
      fRework.leadUserId,
    );
    const openedReworkClaim = await request(app)
      .post(`/api/v1/handyman/service-warranties/${fRework.warranty.id}/claims`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        idempotencyKey: `open-rw-${id()}`,
        evidenceRecordId: evRework,
      });
    const reworkClaimId = openedReworkClaim.body.data.claim.id as string;
    await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${reworkClaimId}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ idempotencyKey: `sub-rw-${id()}` })
      .expect(200);
    await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${reworkClaimId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        idempotencyKey: `app-rw-${id()}`,
        decisionNote: 'Approve for free warranty rework',
      })
      .expect(200);

    const proposedRework = await proposeHandymanServiceWarrantyRework(
      fRework.leadUserId,
      {
        claimId: reworkClaimId,
        idempotencyKey: `prop-rw-${id()}`,
        scopeNote: 'Reseal joint and pressure test at zero charge',
      },
    );
    const reworkId = proposedRework.rework.id;

    // Read contract by reworkId before authorization
    const reworkReadBefore = await request(app)
      .get(`/api/v1/handyman/service-warranty-reworks/${reworkId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(reworkReadBefore.status, 200);
    assert.equal(reworkReadBefore.body.data.anchors.reworkId, reworkId);
    assert.equal(
      reworkReadBefore.body.data.lifecycle.reworkStatus,
      'REWORK_DRAFT',
    );
    assert.equal(
      reworkReadBefore.body.data.readiness.freeReworkAwaitingCustomerDecision,
      true,
    );

    // Authorize free rework via Customer Care HTTP POST
    const authRwKey = `auth-rw-${id()}`;
    const authRwRes = await request(app)
      .post(`/api/v1/handyman/service-warranty-reworks/${reworkId}/authorize`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ idempotencyKey: authRwKey });
    assert.equal(authRwRes.status, 200);
    assert.equal(authRwRes.body.data.replayed, false);
    assert.equal(authRwRes.body.data.rework.status, 'REWORK_AUTHORIZED');
    assert.equal(authRwRes.body.data.event.eventType, 'ACCEPT');

    const authRwReplay = await request(app)
      .post(`/api/v1/handyman/service-warranty-reworks/${reworkId}/authorize`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ idempotencyKey: authRwKey });
    assert.equal(authRwReplay.status, 200);
    assert.equal(authRwReplay.body.data.replayed, true);

    const reworkReadAfter = await request(app)
      .get(`/api/v1/handyman/service-warranty-reworks/${reworkId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(reworkReadAfter.status, 200);
    assert.equal(
      reworkReadAfter.body.data.lifecycle.reworkStatus,
      'REWORK_AUTHORIZED',
    );
    assert.equal(
      reworkReadAfter.body.data.readiness.freeReworkAwaitingCustomerDecision,
      false,
    );
    assert.equal(
      reworkReadAfter.body.data.readiness.paymentTriggerEmitted,
      false,
    );

    // Chargeable additional work path on CLAIM_REJECTED (Accept + Reject)
    const fChargeable = await seedStartedWarranty();
    const evChargeable = await seedDefectEvidence(
      fChargeable.scope.id,
      fChargeable.leadUserId,
    );
    const openedChClaim = await request(app)
      .post(
        `/api/v1/handyman/service-warranties/${fChargeable.warranty.id}/claims`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        idempotencyKey: `open-ch-${id()}`,
        evidenceRecordId: evChargeable,
      });
    const chClaimId = openedChClaim.body.data.claim.id as string;
    await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${chClaimId}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ idempotencyKey: `sub-ch-${id()}` })
      .expect(200);
    await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${chClaimId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        idempotencyKey: `rej-ch-${id()}`,
        decisionNote: 'New fixture installation requested outside warranty',
      })
      .expect(200);

    const proposedWork1 = await proposeHandymanChargeableAdditionalWork(
      fChargeable.leadUserId,
      {
        claimId: chClaimId,
        idempotencyKey: `prop-ch1-${id()}`,
        scopeNote: 'Replace customer-damaged valve assembly (chargeable)',
      },
    );
    const work1Id = proposedWork1.work.id;

    // Customer rejects first chargeable proposal
    const rejectWorkRes = await request(app)
      .post(`/api/v1/handyman/chargeable-additional-works/${work1Id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ idempotencyKey: `rej-work1-${id()}` });
    assert.equal(rejectWorkRes.status, 200);
    assert.equal(rejectWorkRes.body.data.work.status, 'CHARGEABLE_REJECTED');
    assert.equal(rejectWorkRes.body.data.paymentTrigger, null);

    // Second warranty -> rejected claim -> provider proposes chargeable scope; customer accepts
    const fChargeable2 = await seedStartedWarranty();
    const evChargeable2 = await seedDefectEvidence(
      fChargeable2.scope.id,
      fChargeable2.leadUserId,
    );
    const openedChClaim2 = await request(app)
      .post(
        `/api/v1/handyman/service-warranties/${fChargeable2.warranty.id}/claims`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        idempotencyKey: `open-ch2-${id()}`,
        evidenceRecordId: evChargeable2,
      });
    const chClaim2Id = openedChClaim2.body.data.claim.id as string;
    await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${chClaim2Id}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ idempotencyKey: `sub-ch2-${id()}` })
      .expect(200);
    await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${chClaim2Id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        idempotencyKey: `rej-ch2-${id()}`,
        decisionNote: 'Valve seal replacement outside warranty scope',
      })
      .expect(200);

    const proposedWork2 = await proposeHandymanChargeableAdditionalWork(
      fChargeable2.leadUserId,
      {
        claimId: chClaim2Id,
        idempotencyKey: `prop-ch2-${id()}`,
        scopeNote: 'Repair valve seal only (chargeable)',
      },
    );
    const work2Id = proposedWork2.work.id;
    const acceptWorkKey = `acc-work2-${id()}`;
    const acceptWorkRes = await request(app)
      .post(`/api/v1/handyman/chargeable-additional-works/${work2Id}/accept`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ idempotencyKey: acceptWorkKey });
    assert.equal(acceptWorkRes.status, 200);
    assert.equal(acceptWorkRes.body.data.replayed, false);
    assert.equal(acceptWorkRes.body.data.work.status, 'CHARGEABLE_AUTHORIZED');
    assert.ok(acceptWorkRes.body.data.paymentTrigger);
    assert.equal(acceptWorkRes.body.data.paymentTrigger.workId, work2Id);
    assertHandymanServiceWarrantyContractShape(acceptWorkRes.body.data);

    const acceptWorkReplay = await request(app)
      .post(`/api/v1/handyman/chargeable-additional-works/${work2Id}/accept`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ idempotencyKey: acceptWorkKey });
    assert.equal(acceptWorkReplay.status, 200);
    assert.equal(acceptWorkReplay.body.data.replayed, true);

    // Read contract by chargeableAdditionalWorkId
    const workReadRes = await request(app)
      .get(`/api/v1/handyman/chargeable-additional-works/${work2Id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(workReadRes.status, 200);
    assert.equal(
      workReadRes.body.data.anchors.chargeableAdditionalWorkId,
      work2Id,
    );
    assert.equal(
      workReadRes.body.data.lifecycle.chargeableAdditionalWorkStatus,
      'CHARGEABLE_AUTHORIZED',
    );
    assert.equal(
      workReadRes.body.data.readiness.chargeableAdditionalWorkAuthorized,
      true,
    );
    assert.equal(workReadRes.body.data.readiness.paymentTriggerEmitted, true);
  });

  it('enforces RBAC (tenant_company.read / tenant_company.manage) and client-scope access (BLK-05) on all reads and commands', async () => {
    const { scope, warranty, leadUserId } = await seedStartedWarranty();
    const evId = await seedDefectEvidence(scope.id, leadUserId);

    const openRes = await request(app)
      .post(`/api/v1/handyman/service-warranties/${warranty.id}/claims`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        idempotencyKey: `rbac-open-${id()}`,
        evidenceRecordId: evId,
      });
    const claimId = openRes.body.data.claim.id as string;
    await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${claimId}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ idempotencyKey: `rbac-sub-${id()}` })
      .expect(200);
    await request(app)
      .post(`/api/v1/handyman/service-warranty-claims/${claimId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ idempotencyKey: `rbac-app-${id()}` })
      .expect(200);
    const rw = await proposeHandymanServiceWarrantyRework(leadUserId, {
      claimId,
      idempotencyKey: `rbac-rw-${id()}`,
    });

    const plainToken = await createPlainSession();
    const readOnlyUnassignedToken = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read tenant company' },
    ]);
    const manageUnassignedToken = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read tenant company' },
      { code: 'tenant_company.manage', name: 'Manage tenant company' },
    ]);

    // 401 without token
    await request(app)
      .get(`/api/v1/handyman/execution-scopes/${scope.id}/service-warranty`)
      .expect(401);
    await request(app)
      .post(`/api/v1/handyman/service-warranties/${warranty.id}/claims`)
      .send({ idempotencyKey: id() })
      .expect(401);

    // 403 without tenant_company.read on GET
    await request(app)
      .get(`/api/v1/handyman/execution-scopes/${scope.id}/service-warranty`)
      .set('Authorization', `Bearer ${plainToken}`)
      .expect(403);

    // 403 without tenant_company.manage on POST (read-only user)
    await request(app)
      .post(`/api/v1/handyman/service-warranties/${warranty.id}/claims`)
      .set('Authorization', `Bearer ${readOnlyUnassignedToken}`)
      .send({ idempotencyKey: id() })
      .expect(403);

    // 403 when caller has permission but lacks client access (BLK-05)
    await request(app)
      .get(`/api/v1/handyman/execution-scopes/${scope.id}/service-warranty`)
      .set('Authorization', `Bearer ${readOnlyUnassignedToken}`)
      .expect(403);
    await request(app)
      .get(`/api/v1/handyman/service-warranties/${warranty.id}`)
      .set('Authorization', `Bearer ${readOnlyUnassignedToken}`)
      .expect(403);
    await request(app)
      .get(`/api/v1/handyman/service-warranty-claims/${claimId}`)
      .set('Authorization', `Bearer ${readOnlyUnassignedToken}`)
      .expect(403);
    await request(app)
      .get(`/api/v1/handyman/service-warranty-reworks/${rw.rework.id}`)
      .set('Authorization', `Bearer ${readOnlyUnassignedToken}`)
      .expect(403);
    await request(app)
      .post(
        `/api/v1/handyman/service-warranty-reworks/${rw.rework.id}/authorize`,
      )
      .set('Authorization', `Bearer ${manageUnassignedToken}`)
      .send({ idempotencyKey: id() })
      .expect(403);
  });

  it('enforces the financial & asset-warranty firewall, blocks field-worker routes, and documents OpenAPI cleanly', async () => {
    const { warranty } = await seedStartedWarranty();

    // Financial or FM/asset-warranty keys in POST body are rejected (400)
    for (const forbiddenPayload of [
      { idempotencyKey: id(), amount: '100.00' },
      { idempotencyKey: id(), priceCents: 5000 },
      { idempotencyKey: id(), currency: 'IDR' },
      { idempotencyKey: id(), ledgerEntryId: id() },
      { idempotencyKey: id(), settlementId: id() },
      { idempotencyKey: id(), assetWarrantyId: id() },
      { idempotencyKey: id(), fmAssetId: id() },
    ]) {
      const res = await request(app)
        .post(`/api/v1/handyman/service-warranties/${warranty.id}/claims`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(forbiddenPayload);
      assert.equal(res.status, 400);
    }

    // Field-worker rework execution and warranty lifecycle calculation routes are NOT exposed
    for (const unexposedPath of [
      `/api/v1/handyman/service-warranties/${warranty.id}/start`,
      `/api/v1/handyman/service-warranties/${warranty.id}/expire`,
      `/api/v1/handyman/service-warranty-reworks/${id()}/propose`,
      `/api/v1/handyman/service-warranty-reworks/${id()}/start`,
      `/api/v1/handyman/service-warranty-reworks/${id()}/complete`,
      `/api/v1/handyman/service-warranty-reworks/${id()}/verify`,
      `/api/v1/handyman/chargeable-additional-works/${id()}/propose`,
    ]) {
      const res = await request(app)
        .post(unexposedPath)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ idempotencyKey: id() });
      assert.equal(res.status, 404);
    }

    // Source firewall check on src/modules/handyman-service-warranty-api
    const dir = path.resolve(
      __dirname,
      '../src/modules/handyman-service-warranty-api',
    );
    for (const file of [
      'index.ts',
      'handyman-service-warranty-api.routes.ts',
      'handyman-service-warranty-api.controller.ts',
      'handyman-service-warranty-api.service.ts',
    ]) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      assert.doesNotMatch(
        source,
        /\b(startHandymanServiceWarranty|expireHandymanServiceWarranty|proposeHandymanServiceWarrantyRework|startHandymanServiceWarrantyRework|completeHandymanServiceWarrantyRework|verifyHandymanServiceWarrantyRework|proposeHandymanChargeableAdditionalWork)\b/,
      );
      assert.doesNotMatch(
        source,
        /from ['"]\.\.\/(asset-warranties|assets|handyman-customer-ledger|handyman-settlement-entitlements|tenant-invoices|vendor-invoices)['"]/,
      );
    }

    // OpenAPI documentation check
    const openapi = readFileSync(
      path.resolve(__dirname, '../docs/api/openapi.yaml'),
      'utf8',
    );
    for (const documentedPath of [
      '/handyman/execution-scopes/{executionScopeId}/service-warranty:',
      '/handyman/service-warranties/{warrantyId}:',
      '/handyman/service-warranties/{warrantyId}/claims:',
      '/handyman/service-warranty-claims/{claimId}:',
      '/handyman/service-warranty-claims/{claimId}/submit:',
      '/handyman/service-warranty-claims/{claimId}/approve:',
      '/handyman/service-warranty-claims/{claimId}/reject:',
      '/handyman/service-warranty-claims/{claimId}/withdraw:',
      '/handyman/service-warranty-reworks/{reworkId}:',
      '/handyman/service-warranty-reworks/{reworkId}/authorize:',
      '/handyman/chargeable-additional-works/{workId}:',
      '/handyman/chargeable-additional-works/{workId}/accept:',
      '/handyman/chargeable-additional-works/{workId}/reject:',
    ]) {
      assert.ok(
        openapi.includes(documentedPath),
        `OpenAPI must include ${documentedPath}`,
      );
    }
  });
});
