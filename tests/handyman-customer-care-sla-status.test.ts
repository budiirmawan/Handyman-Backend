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
import { closePool, initDatabase, migrateUp, withTransaction } from '../src/database';
import { applyToNewSubject } from '../src/modules/applied-slas/applied-sla.service';
import {
  acceptHandymanBast,
  issueHandymanBast,
  prepareHandymanBast,
} from '../src/modules/handyman-bast';
import { openHandymanCustomerTransaction } from '../src/modules/handyman-customer-transactions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  createHandymanEvidenceRecord,
  openHandymanDefect,
  openHandymanQcRun,
} from '../src/modules/handyman-evidence-qc';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { startHandymanServiceWarranty } from '../src/modules/handyman-service-warranties';
import {
  openHandymanServiceWarrantyClaim,
  submitHandymanServiceWarrantyClaim,
} from '../src/modules/handyman-service-warranty-claims';
import {
  HANDYMAN_SLA_SUBJECT_MILESTONES,
  HANDYMAN_SLA_SUBJECT_TYPES,
} from '../src/modules/sla-definitions/handyman-sla-subjects';
import { slaDefinitionRepository } from '../src/modules/sla-definitions/sla-definition.repository';
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
 * CR-HM-17 TRANSPORT GAP — PART 07 B8 SLA + STATUS VISIBILITY
 *
 * Verifies:
 *   - GET /api/v1/handyman/sla/subjects/:subjectType/:subjectId
 *   - GET /api/v1/handyman/provider-performance
 *   - GET /api/v1/handyman/requests/:id/status-visibility
 *   - GET /api/v1/handyman/execution-scopes/:id/status-visibility
 *   - RBAC (`tenant_company.read`) + `canAccessClient`
 *   - Rejection of non-Handyman SLA subject types (`WORK_ORDER`, etc.)
 *   - Zero writes, zero new lifecycle/SLA state, zero FM/SaaS/settlement leakage
 */

const DIR = '/tmp/hm17-part07-sla-status-pg';
const PORT = 55467;
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
const shortCode = () => randomUUID().slice(0, 8).toUpperCase();
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

async function seedFullLineageWithSlas() {
  const { realm, chain, scope } = await baseFixture();
  const requestId = scope.handymanRequestId;
  const quotationId = scope.quotationId;
  const versionId = scope.approvedQuotationVersionId;
  const crew = await crewFixture(realm);
  const assignment = await assignHandymanExecutionScopeCrew(
    {
      executionScopeId: scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    },
    adminUserId,
  );

  // Evidence + QC run + Defect record
  const defectEv = await createHandymanEvidenceRecord(
    {
      executionScopeId: scope.id,
      stage: 'DEFECT' as never,
      description: 'Defect evidence for SLA visibility test',
      idempotencyKey: `ev-${id()}`,
    },
    crew.leadUser.id,
  );
  const qcRun = await openHandymanQcRun(
    {
      executionScopeId: scope.id,
      checklistIdentity: 'CHECKLIST_PLUMBING_V1',
      idempotencyKey: `qc-${id()}`,
    },
    crew.leadUser.id,
  );
  const defect = await openHandymanDefect(
    {
      executionScopeId: scope.id,
      runId: qcRun.run.id,
      description: 'Minor seal gap requiring follow-up',
      idempotencyKey: `def-${id()}`,
    },
    crew.leadUser.id,
  );

  // BAST -> ACCEPTED + Service Warranty -> Claim
  const preparedBast = await prepareHandymanBast(adminUserId, {
    executionScopeId: scope.id,
    idempotencyKey: `bast-prep-${id()}`,
  });
  await issueHandymanBast(adminUserId, {
    bastId: preparedBast.bast.id,
    idempotencyKey: `bast-iss-${id()}`,
  });
  const acceptedBast = await acceptHandymanBast(adminUserId, {
    bastId: preparedBast.bast.id,
    idempotencyKey: `bast-acc-${id()}`,
    signatureDigest: `sig-${id()}`,
  });
  const startedWarranty = await startHandymanServiceWarranty(
    {
      executionScopeId: scope.id,
      idempotencyKey: `war-start-${id()}`,
    },
    adminUserId,
  );
  const openedClaim = await openHandymanServiceWarrantyClaim(adminUserId, {
    warrantyId: startedWarranty.warranty.id,
    idempotencyKey: `claim-open-${id()}`,
    evidenceRecordId: defectEv.record.id,
    claimNote: 'Post-handover warranty claim',
  });
  const submittedClaim = await submitHandymanServiceWarrantyClaim(adminUserId, {
    claimId: openedClaim.claim.id,
    idempotencyKey: `claim-sub-${id()}`,
  });

  // Customer ledger transaction
  const ledgerTx = await openHandymanCustomerTransaction(
    {
      executionScopeId: scope.id,
      idempotencyKey: `tx-open-${id()}`,
    },
    adminUserId,
  );

  // Create SLA definitions for all 5 Handyman subject types and bind each subject
  const now = new Date('2026-09-15T10:00:00.000Z');
  for (const subjectType of HANDYMAN_SLA_SUBJECT_TYPES) {
    await slaDefinitionRepository.create({
      clientId: realm.client.id,
      code: `SLA_${subjectType}_${shortCode()}`,
      name: `SLA ${subjectType}`,
      operationalType: subjectType,
      responseTargetMinutes: 30,
      resolutionTargetMinutes: 120,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
  }

  const subjectMap: Record<(typeof HANDYMAN_SLA_SUBJECT_TYPES)[number], string> =
    {
      HANDYMAN_SERVICE_REQUEST: requestId,
      HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT: assignment.id,
      HANDYMAN_EXECUTION_SCOPE: scope.id,
      HANDYMAN_DEFECT_RECORD: defect.defect.id,
      HANDYMAN_SERVICE_WARRANTY_CLAIM: submittedClaim.claim.id,
    };

  for (const subjectType of HANDYMAN_SLA_SUBJECT_TYPES) {
    const applied = await withTransaction((tx) =>
      applyToNewSubject(
        {
          subjectType,
          subjectId: subjectMap[subjectType],
          clientId: realm.client.id,
          buildingId: realm.building.id,
          createdAt: now,
        },
        tx,
      ),
    );
    assert.ok(applied, `expected applied SLA for ${subjectType}`);
  }

  return {
    realm,
    chain,
    request: { id: requestId },
    quotation: { id: quotationId },
    version: { id: versionId },
    scope,
    assignment,
    qcRun: qcRun.run,
    defect: defect.defect,
    bast: acceptedBast.bast,
    warranty: startedWarranty.warranty,
    claim: submittedClaim.claim,
    ledgerTx: ledgerTx.transaction,
    subjectMap,
  };
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

describe('CR-HM-17 GAP PART 07 — B8 SLA & Status Visibility Transport', () => {
  it('exposes per-subject Handyman SLA clocks & milestones and rejects non-Handyman SLA subject types', async () => {
    const seeded = await seedFullLineageWithSlas();

    for (const subjectType of HANDYMAN_SLA_SUBJECT_TYPES) {
      const subjectId = seeded.subjectMap[subjectType];
      const res = await request(app)
        .get(`/api/v1/handyman/sla/subjects/${subjectType}/${subjectId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      assert.equal(res.status, 200);
      const data = res.body.data;
      assert.equal(data.subjectType, subjectType);
      assert.equal(data.subjectId, subjectId);
      assert.equal(data.clientId, seeded.realm.client.id);
      assert.ok(data.appliedSla);
      assert.equal(data.appliedSla.subjectType, subjectType);
      assert.equal(data.appliedSla.subjectId, subjectId);
      assert.equal('workOrderId' in data.appliedSla, false);

      const expectedMilestones = HANDYMAN_SLA_SUBJECT_MILESTONES.filter(
        (m) => m.subjectType === subjectType,
      ).map((m) => m.milestone);
      assert.deepEqual(
        data.milestones.map((m: { milestone: string }) => m.milestone),
        expectedMilestones,
      );
      for (const m of data.milestones) {
        assert.ok(m.clock, `expected bound clock for ${m.milestone}`);
        assert.equal(m.clock.milestone, m.milestone);
      }
    }

    // Reject non-Handyman SLA subject types (no FM work-order SLA fallback)
    for (const invalidType of [
      'WORK_ORDER',
      'FM_WORK_ORDER',
      'SAAS_TICKET',
      'ASSET_WARRANTY',
    ]) {
      const res = await request(app)
        .get(`/api/v1/handyman/sla/subjects/${invalidType}/${id()}`)
        .set('Authorization', `Bearer ${adminToken}`);
      assert.equal(res.status, 400);
    }

    // 404 for unknown subjectId
    const notFoundRes = await request(app)
      .get(`/api/v1/handyman/sla/subjects/HANDYMAN_SERVICE_REQUEST/${id()}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(notFoundRes.status, 404);
  });

  it('exposes derived Handyman provider performance snapshot with 9-milestone adherence', async () => {
    const seeded = await seedFullLineageWithSlas();

    const res = await request(app)
      .get('/api/v1/handyman/provider-performance')
      .query({
        clientId: seeded.realm.client.id,
        buildingId: seeded.realm.building.id,
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-10-01T00:00:00.000Z',
      })
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    const snap = res.body.data;
    assert.equal(snap.scope.clientId, seeded.realm.client.id);
    assert.equal(snap.scope.buildingId, seeded.realm.building.id);
    assert.equal(snap.inputs.slaClocks, 10);
    assert.equal(snap.responseResolutionAttainment.length, 2);
    assert.deepEqual(
      snap.milestoneAdherence.map((m: { milestone: string }) => m.milestone),
      HANDYMAN_SLA_SUBJECT_MILESTONES.map((m) => m.milestone),
    );
    for (const m of snap.milestoneAdherence) {
      assert.equal(m.clocks, 1);
      assert.equal(m.running, 1);
    }

    // Invalid query parameters -> 400
    await request(app)
      .get('/api/v1/handyman/provider-performance')
      .query({ clientId: 'not-a-uuid' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    await request(app)
      .get('/api/v1/handyman/provider-performance')
      .query({
        clientId: seeded.realm.client.id,
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-09-01T00:00:00.000Z',
      })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('exposes authoritative stage/status facts and 9-milestone SLA visibility for both request and execution scope without mutating state', async () => {
    const seeded = await seedFullLineageWithSlas();

    const beforeAppliedCount = (
      await q('SELECT COUNT(*)::int AS c FROM applied_slas')
    ).rows[0].c;
    const beforeClockCount = (
      await q('SELECT COUNT(*)::int AS c FROM sla_clocks')
    ).rows[0].c;

    const reqVisRes = await request(app)
      .get(`/api/v1/handyman/requests/${seeded.request.id}/status-visibility`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(reqVisRes.status, 200);
    const reqVis = reqVisRes.body.data;
    assert.equal(reqVis.anchorType, 'HANDYMAN_SERVICE_REQUEST');
    assert.equal(reqVis.handymanRequestId, seeded.request.id);
    assert.equal(reqVis.executionScopeId, seeded.scope.id);

    const scopeVisRes = await request(app)
      .get(
        `/api/v1/handyman/execution-scopes/${seeded.scope.id}/status-visibility`,
      )
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(scopeVisRes.status, 200);
    const scopeVis = scopeVisRes.body.data;
    assert.equal(scopeVis.anchorType, 'HANDYMAN_EXECUTION_SCOPE');
    assert.equal(scopeVis.handymanRequestId, seeded.request.id);
    assert.equal(scopeVis.executionScopeId, seeded.scope.id);
    assert.deepEqual(scopeVis.stages, reqVis.stages);
    const stripLiveElapsed = (
      milestones: Array<{ clock: Record<string, unknown> | null }>,
    ) =>
      milestones.map((m) => ({
        ...m,
        clock: m.clock
          ? { ...m.clock, effectiveElapsedMilliseconds: 0 }
          : null,
      }));
    assert.deepEqual(
      stripLiveElapsed(scopeVis.slaMilestones),
      stripLiveElapsed(reqVis.slaMilestones),
    );

    // Verify authoritative stage facts across CR-HM-02..15
    assert.equal(scopeVis.stages.request.requestId, seeded.request.id);
    assert.equal(scopeVis.stages.quotation.quotationId, seeded.quotation.id);
    assert.equal(
      scopeVis.stages.quotation.approvedVersionId,
      seeded.version.id,
    );
    assert.equal(scopeVis.stages.executionScope.executionScopeId, seeded.scope.id);
    assert.equal(scopeVis.stages.executionScope.status, 'AUTHORIZED');
    assert.equal(scopeVis.stages.assignment.assignmentId, seeded.assignment.id);
    assert.equal(scopeVis.stages.assignment.status, 'ACTIVE');
    assert.equal(scopeVis.stages.qc.latestQcRunId, seeded.qcRun.id);
    assert.equal(scopeVis.stages.qc.latestStatus, 'OPEN');
    assert.equal(scopeVis.stages.qc.evidenceRecordCount, 1);
    assert.equal(scopeVis.stages.defects.defectCount, 1);
    assert.equal(scopeVis.stages.defects.openDefectCount, 1);
    assert.equal(scopeVis.stages.defects.latestDefectId, seeded.defect.id);
    assert.equal(scopeVis.stages.defects.latestStatus, 'OPENED');
    assert.equal(scopeVis.stages.bast.bastId, seeded.bast.id);
    assert.equal(scopeVis.stages.bast.status, 'ACCEPTED');
    assert.equal(scopeVis.stages.bast.customerAccepted, true);
    assert.equal(scopeVis.stages.bast.warrantyStartEligible, true);
    assert.equal(
      scopeVis.stages.customerLedger.transactionId,
      seeded.ledgerTx.id,
    );
    assert.equal(scopeVis.stages.customerLedger.currency, 'IDR');
    assert.equal(
      scopeVis.stages.serviceWarranty.warrantyId,
      seeded.warranty.id,
    );
    assert.equal(
      scopeVis.stages.serviceWarranty.warrantyStatus,
      'CLAIM_OPEN',
    );
    assert.equal(
      scopeVis.stages.serviceWarranty.latestClaimId,
      seeded.claim.id,
    );
    assert.equal(
      scopeVis.stages.serviceWarranty.latestClaimStatus,
      'CLAIM_SUBMITTED',
    );

    // Verify all 9 frozen SLA milestones are present and bound
    assert.deepEqual(
      scopeVis.slaMilestones.map((m: { milestone: string }) => m.milestone),
      HANDYMAN_SLA_SUBJECT_MILESTONES.map((m) => m.milestone),
    );
    for (const m of scopeVis.slaMilestones) {
      assert.ok(m.subjectId, `expected subjectId for milestone ${m.milestone}`);
      assert.ok(
        m.appliedSlaId,
        `expected appliedSlaId for milestone ${m.milestone}`,
      );
      assert.ok(m.clock, `expected SLA clock for milestone ${m.milestone}`);
      assert.equal(m.clock.milestone, m.milestone);
    }

    const afterAppliedCount = (
      await q('SELECT COUNT(*)::int AS c FROM applied_slas')
    ).rows[0].c;
    const afterClockCount = (
      await q('SELECT COUNT(*)::int AS c FROM sla_clocks')
    ).rows[0].c;
    assert.equal(afterAppliedCount, beforeAppliedCount);
    assert.equal(afterClockCount, beforeClockCount);
  });

  it('enforces tenant_company.read and canAccessClient across all 4 SLA and status-visibility endpoints', async () => {
    const seeded = await seedFullLineageWithSlas();
    const plainToken = await createPlainSession();
    const unassignedReadToken = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read tenant company' },
    ]);

    const paths = [
      `/api/v1/handyman/sla/subjects/HANDYMAN_SERVICE_REQUEST/${seeded.request.id}`,
      `/api/v1/handyman/provider-performance?clientId=${seeded.realm.client.id}`,
      `/api/v1/handyman/requests/${seeded.request.id}/status-visibility`,
      `/api/v1/handyman/execution-scopes/${seeded.scope.id}/status-visibility`,
    ];

    for (const url of paths) {
      await request(app).get(url).expect(401);
      await request(app)
        .get(url)
        .set('Authorization', `Bearer ${plainToken}`)
        .expect(403);
      await request(app)
        .get(url)
        .set('Authorization', `Bearer ${unassignedReadToken}`)
        .expect(403);
    }
  });

  it('enforces the FM/SaaS/settlement/read-only firewall and documents OpenAPI cleanly', async () => {
    const dir = path.resolve(
      __dirname,
      '../src/modules/handyman-sla-status-api',
    );
    for (const file of [
      'index.ts',
      'handyman-sla-status-api.routes.ts',
      'handyman-sla-status-api.controller.ts',
      'handyman-sla-status-api.service.ts',
    ]) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      assert.doesNotMatch(
        source,
        /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|withTransaction)\b/i,
      );
      assert.doesNotMatch(
        source,
        /from ['"]\.\.\/(work-orders|work-order-sla-register|handyman-settlement|handyman-financial-entitlements|handyman-financial-read|tenant-invoices|vendor-invoices)['"]/,
      );
      assert.doesNotMatch(source, /\brouter\.(post|put|patch|delete)\b/);
    }

    const openapi = readFileSync(
      path.resolve(__dirname, '../docs/api/openapi.yaml'),
      'utf8',
    );
    for (const documentedPath of [
      '/handyman/sla/subjects/{subjectType}/{subjectId}:',
      '/handyman/provider-performance:',
      '/handyman/requests/{id}/status-visibility:',
      '/handyman/execution-scopes/{id}/status-visibility:',
    ]) {
      assert.ok(
        openapi.includes(documentedPath),
        `OpenAPI must include ${documentedPath}`,
      );
    }
  });
});
