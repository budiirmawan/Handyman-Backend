import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
  locationChain,
  realmFixture,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { credentialService } from '../src/modules/auth';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { activateHandymanCommercialAgreementVersion, prepareHandymanCommercialAgreement } from '../src/modules/handyman-commercial-agreements';
import { allocateHandymanCustomerPayment } from '../src/modules/handyman-customer-payment-allocations';
import { confirmHandymanCustomerPayment, recordHandymanCustomerPayment } from '../src/modules/handyman-customer-payments';
import { composeHandymanChargeLine, openHandymanCustomerTransaction } from '../src/modules/handyman-customer-transactions';
import { deriveHandymanFinancialEntitlements } from '../src/modules/handyman-financial-entitlements';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import {
  holdHandymanSettlementDispute,
  includeHandymanSettlement,
  prepareHandymanSettlement,
  reconcileHandymanSettlement,
  settleHandymanSettlement,
} from '../src/modules/handyman-settlement';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import {
  createChannelAttribution,
} from '../src/modules/handyman-channel-attributions';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';

/**
 * CR-HM-18 FULL-CAPABILITY-E2E-CLOSURE-01 — focused end-to-end evidence for
 * the two confirmed P0/P1 capability gaps closed in this CR:
 *
 *   J01 — tenant request cancellation (migration 0459, `CANCELLED` terminal
 *         state + append-only cancellation fact);
 *   J12 — settlement dispute adjudication (migration 0460, RELEASED/UPHELD
 *         append-only decisions that stop/keep blocking include/settle and
 *         the Manager final-close gate).
 *
 * Both journeys run over real HTTP against a disposable embedded PostgreSQL
 * with persisted-state assertions, so the evidence is behavioural, not
 * source-inspection.
 */

const DIR = '/tmp/hm-e2e-capability-closure-pg';
const PORT = 55560;
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  DB_HOST: '127.0.0.1',
  DB_PORT: String(PORT),
  DB_USER: 'postgres',
  DB_PASSWORD: '',
  DB_NAME: 'asentra_test',
  DB_SSL: 'false',
});

const V1 = '/api/v1';
let pg: EmbeddedPostgres;
let pool: Pool;
let adminId = '';
let disciplineId = '';
const id = () => randomUUID();
const key = (prefix = 'e2e-hm18') => `${prefix}-${randomUUID()}`;
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

async function grant(userId: string, permissionCodes: string[]) {
  const role = await roleService.createRole({
    code: `E2E_HM18_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'E2E CR-HM-18 scoped role',
  });
  for (const permissionCode of permissionCodes) {
    const permission = await permissionService
      .createPermission({
        code: permissionCode,
        name: `Scoped ${permissionCode}`,
      })
      .catch(async () => permissionRepository.findByCode(permissionCode));
    if (!permission) throw new Error(`Permission missing: ${permissionCode}`);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}

async function personaSession(
  permissionCodes: readonly string[],
  buildingId: string,
  displayName = 'CR-HM-18 persona',
): Promise<{ userId: string; token: string }> {
  const sfx = randomUUID().slice(0, 8).toLowerCase();
  const password = `Pass_${sfx}_123!`;
  const user = await userService.createUser({
    email: `hm18-${sfx}@example.com`,
    displayName,
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  if (permissionCodes.length > 0) await grant(user.id, [...permissionCodes]);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const login = await api()
    .post(`${V1}/auth/login`)
    .send({ email: user.email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { userId: user.id, token: login.body.data.sessionToken as string };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** Minimal fresh INTAKE request fixture (no diagnosis). */
async function intakeFixture(label: string) {
  const realm = await realmFixture(label);
  const chain = await locationChain(realm);
  const sfx = randomUUID().slice(0, 8).toUpperCase();
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: realm.client.id,
      tenantCode: `TNT_${sfx}`,
      tenantName: 'Tenant Company',
    },
    adminId,
  );
  const picUser = await userService.createUser({
    email: `intake-pic-${sfx.toLowerCase()}@example.com`,
    displayName: 'Tenant PIC',
  });
  // PIC linking requires the user to already hold access to the tenant's
  // Client (exact-Building assignment), exactly like the shared fixtures.
  await buildingAssignmentService.createAssignment(picUser.id, {
    buildingId: realm.building.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Tenant PIC',
      email: `pic-${sfx.toLowerCase()}@example.com`,
      userId: picUser.id,
    },
    adminId,
  );
  await tenantSpaceService.assignSpaceToTenant(
    {
      tenantCompanyId: company.id,
      buildingId: realm.building.id,
      spaceId: chain.space.id,
    },
    adminId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: company.id, buildingId: realm.building.id },
    adminId,
  );
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
    tenantPicId: pic.id,
    spaceId: chain.space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: picUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: realm.client.id,
      code: `HM_${sfx}`,
      name: 'Handyman Service',
      category: 'FM_HINT_TEXT',
    },
    adminId,
  );
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      { channelAttributionId: attribution.id, serviceCatalogId: service.id },
      adminId,
    );
  return { realm, chain, company, request };
}

describe('CR-HM-18 FULL-CAPABILITY-E2E-CLOSURE-01', () => {
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
    const adminClient = pg.getPgClient('postgres', '127.0.0.1');
    await adminClient.connect();
    await adminClient.query('CREATE DATABASE asentra_test');
    await adminClient.end();

    const { ensureTestDatabase } = await import('./helpers/postgres');
    const config = await ensureTestDatabase();
    assert.ok(config);
    pool = await initDatabase(config);
    await migrateUp(pool);

    adminId = (await createAdminUser()).userId;
    const discipline = await handymanDisciplineRepository.findDisciplineByCode(
      undefined,
      'GENERAL_HANDYMAN',
    );
    assert.ok(discipline);
    disciplineId = discipline.id;
    initHandymanFixtures({
      adminUserId: adminId,
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

  it('J01: request cancellation is a terminal, append-only, replay-safe pre-commitment exit', async () => {
    const { realm, request } = await intakeFixture('CancelMain');
    const manager = await personaSession(
      ['tenant_company.read', 'tenant_company.manage'],
      realm.building.id,
      'Operations Manager',
    );

    // --- cancel an INTAKE request -------------------------------------
    const cancelKey = key('cancel');
    const cancelled = await api()
      .post(`${V1}/handyman/requests/${request.id}/cancel`)
      .set(auth(manager.token))
      .send({ reason: 'Tenant no longer needs the visit.', idempotencyKey: cancelKey });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.requestStatus, 'CANCELLED');
    assert.equal(cancelled.body.data.previousStatus, 'INTAKE');
    assert.equal(cancelled.body.data.replayed, false);
    assert.equal(cancelled.body.data.cancelledByUserId, manager.userId);
    assert.equal(cancelled.body.data.reason, 'Tenant no longer needs the visit.');

    const persisted = await q(
      'SELECT status FROM handyman_service_requests WHERE id = $1',
      [request.id],
    );
    assert.equal(persisted.rows[0].status, 'CANCELLED');
    const facts = await q(
      `SELECT previous_status, reason, idempotency_key, cancelled_by_user_id
         FROM handyman_request_cancellations WHERE handyman_request_id = $1`,
      [request.id],
    );
    assert.equal(facts.rows.length, 1);
    assert.equal(facts.rows[0].previous_status, 'INTAKE');
    assert.equal(facts.rows[0].cancelled_by_user_id, manager.userId);

    // --- replay is the same fact --------------------------------------
    const replay = await api()
      .post(`${V1}/handyman/requests/${request.id}/cancel`)
      .set(auth(manager.token))
      .send({ reason: 'Tenant no longer needs the visit.', idempotencyKey: cancelKey });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.replayed, true);
    assert.equal(replay.body.data.id, cancelled.body.data.id);
    assert.equal(
      (
        await q(
          `SELECT count(*)::int AS n FROM handyman_request_cancellations
            WHERE handyman_request_id = $1`,
          [request.id],
        )
      ).rows[0].n,
      1,
    );

    // --- a different key cannot cancel twice --------------------------
    const second = await api()
      .post(`${V1}/handyman/requests/${request.id}/cancel`)
      .set(auth(manager.token))
      .send({ reason: 'Trying again.', idempotencyKey: key('cancel') });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(
      second.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_ALREADY_CANCELLED',
    );

    // --- bounded read -------------------------------------------------
    const read = await api()
      .get(`${V1}/handyman/requests/${request.id}/cancellation`)
      .set(auth(manager.token));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.id, cancelled.body.data.id);
    assert.equal(read.body.data.previousStatus, 'INTAKE');

    // --- smuggled authority fields are ignored ------------------------
    const other = await intakeFixture('CancelSmuggle');
    const smugglerManager = await personaSession(
      ['tenant_company.read', 'tenant_company.manage'],
      other.realm.building.id,
      'Smuggle Attempt Manager',
    );
    const smuggled = await api()
      .post(`${V1}/handyman/requests/${other.request.id}/cancel`)
      .set(auth(smugglerManager.token))
      .send({
        reason: 'Cancelled by the tenant.',
        idempotencyKey: key('cancel'),
        cancelledByUserId: randomUUID(),
        status: 'REFERRED',
        previousStatus: 'DIAGNOSIS',
        clientId: randomUUID(),
      });
    assert.equal(smuggled.status, 200, JSON.stringify(smuggled.body));
    assert.equal(smuggled.body.data.cancelledByUserId, smugglerManager.userId);
    assert.equal(smuggled.body.data.previousStatus, 'INTAKE');
    assert.equal(
      (
        await q('SELECT status FROM handyman_service_requests WHERE id = $1', [
          other.request.id,
        ])
      ).rows[0].status,
      'CANCELLED',
    );

    // --- cross-building actor is denied and persists nothing ----------
    const outsiderRealm = await realmFixture('CancelOutsider');
    const outsider = await personaSession(
      ['tenant_company.read', 'tenant_company.manage'],
      outsiderRealm.building.id,
      'Other Building Manager',
    );
    const deniedTarget = await intakeFixture('CancelDenied');
    const denied = await api()
      .post(`${V1}/handyman/requests/${deniedTarget.request.id}/cancel`)
      .set(auth(outsider.token))
      .send({ reason: 'Not my building.', idempotencyKey: key('cancel') });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(
      (
        await q(
          `SELECT count(*)::int AS n FROM handyman_request_cancellations
            WHERE handyman_request_id = $1`,
          [deniedTarget.request.id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await q('SELECT status FROM handyman_service_requests WHERE id = $1', [
          deniedTarget.request.id,
        ])
      ).rows[0].status,
      'INTAKE',
    );

    // --- terminal REFERRED is never overwritten -----------------------
    const referred = await intakeFixture('CancelReferred');
    const referredManager = await personaSession(
      ['tenant_company.read', 'tenant_company.manage'],
      referred.realm.building.id,
      'Referred Request Manager',
    );
    const fm = await handymanDisciplineRepository.findDisciplineByCode(
      undefined,
      'FM_COMMON_BUILDING',
    );
    assert.ok(fm);
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: referred.request.id,
        triageDisposition: 'DIAGNOSIS',
        triageNote: 'Diagnose to classify.',
      },
      adminId,
    );
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
      {
        handymanRequestId: referred.request.id,
        disciplineId: fm.id,
        diagnosis: 'FM common building system — outside Handyman scope.',
      },
      adminId,
    );
    assert.equal(
      (
        await q('SELECT status FROM handyman_service_requests WHERE id = $1', [
          referred.request.id,
        ])
      ).rows[0].status,
      'REFERRED',
    );
    const refusedTerminal = await api()
      .post(`${V1}/handyman/requests/${referred.request.id}/cancel`)
      .set(auth(referredManager.token))
      .send({ reason: 'Too late.', idempotencyKey: key('cancel') });
    assert.equal(refusedTerminal.status, 409, JSON.stringify(refusedTerminal.body));
    assert.equal(
      refusedTerminal.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_CANCEL_NOT_ALLOWED',
    );
    assert.equal(
      (
        await q('SELECT status FROM handyman_service_requests WHERE id = $1', [
          referred.request.id,
        ])
      ).rows[0].status,
      'REFERRED',
    );

    // --- commercial commitment refuses cancellation -------------------
    const committed = await baseFixture();
    const committedPersona = await personaSession(
      ['tenant_company.read', 'tenant_company.manage'],
      committed.realm.building.id,
      'Committed Scope Manager',
    );
    const refusedCommitted = await api()
      .post(
        `${V1}/handyman/requests/${committed.scope.handymanRequestId}/cancel`,
      )
      .set(auth(committedPersona.token))
      .send({ reason: 'Changed our mind.', idempotencyKey: key('cancel') });
    assert.equal(
      refusedCommitted.status,
      409,
      JSON.stringify(refusedCommitted.body),
    );
    assert.equal(
      refusedCommitted.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_CANCEL_COMMITTED',
    );
    assert.equal(
      (
        await q(
          `SELECT count(*)::int AS n FROM handyman_request_cancellations
            WHERE handyman_request_id = $1`,
          [committed.scope.handymanRequestId],
        )
      ).rows[0].n,
      0,
    );

    // --- the cancellation fact is append-only -------------------------
    await assert.rejects(
      q(`UPDATE handyman_request_cancellations SET reason = 'rewritten'
          WHERE handyman_request_id = $1`, [request.id]),
      /append-only/,
    );
    await assert.rejects(
      q('DELETE FROM handyman_request_cancellations WHERE handyman_request_id = $1', [
        request.id,
      ]),
      /append-only/,
    );
  });

  it('J12: settlement dispute adjudication clears or sustains the hold without touching money facts', async () => {
    // ---- fixture: a funded, PAYABLE settlement unit with a live dispute
    const { realm, scope } = await baseFixture();
    const crew = await crewFixture(realm);
    await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      },
      adminId,
    );
    const draft = await prepareHandymanCommercialAgreement(adminId, {
      clientId: realm.client.id,
      idempotencyKey: id(),
    });
    const version = draft.version.id;
    await q(
      `INSERT INTO handyman_bm_fee_rule_definitions
        (id,agreement_version_id,basis,mode,idempotency_key,created_by_user_id)
        VALUES($1,$2,'LABOR_ONLY','DEFAULT',$3,$4)`,
      [id(), version, id(), adminId],
    );
    await q(
      `INSERT INTO handyman_bm_fee_term_definitions
        (id,agreement_version_id,term_kind,rate_percent,idempotency_key,created_by_user_id)
        VALUES($1,$2,'PERCENTAGE_OF_BASIS','2.5000',$3,$4)`,
      [id(), version, id(), adminId],
    );
    await q(
      `INSERT INTO handyman_bm_fee_beneficiary_definitions
        (id,agreement_version_id,beneficiary_kind,beneficiary_reference_id,
          idempotency_key,created_by_user_id)
        VALUES($1,$2,'CLIENT_ORGANIZATION',$3,$4,$5)`,
      [id(), version, realm.client.id, id(), adminId],
    );
    await activateHandymanCommercialAgreementVersion(adminId, {
      versionId: version,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: id(),
    });
    await openHandymanCustomerTransaction(
      { executionScopeId: scope.id, idempotencyKey: id() },
      adminId,
    );
    const line = (
      await q(
        `SELECT id FROM handyman_quotation_lines
          WHERE quotation_version_id = $1 AND line_type = 'LABOR'`,
        [scope.approvedQuotationVersionId],
      )
    ).rows[0];
    await composeHandymanChargeLine(
      {
        executionScopeId: scope.id,
        quotationLineId: line.id,
        idempotencyKey: id(),
      },
      adminId,
    );
    const derived = await deriveHandymanFinancialEntitlements(
      scope.id,
      adminId,
      id(),
    );
    assert.equal(derived.provider.amount, '97.50');
    assert.equal(derived.bmFee.amount, '2.50');

    const payment = await recordHandymanCustomerPayment(
      {
        executionScopeId: scope.id,
        amount: '100.00',
        channel: 'BANK_TRANSFER',
        providerName: 'Bank',
        providerReference: id(),
        externalReference: id(),
        idempotencyKey: id(),
      },
      adminId,
    );
    await confirmHandymanCustomerPayment(
      { executionScopeId: scope.id, paymentId: payment.payment.id, idempotencyKey: id() },
      adminId,
    );
    await allocateHandymanCustomerPayment(
      {
        executionScopeId: scope.id,
        paymentId: payment.payment.id,
        chargeLineId: (
          await q(
            `SELECT id FROM handyman_charge_lines WHERE transaction_id = $1`,
            [payment.payment.transactionId],
          )
        ).rows[0].id,
        amount: '100.00',
        idempotencyKey: id(),
      },
      adminId,
    );

    const unit = await prepareHandymanSettlement(scope.id, adminId, id());
    assert.equal(unit.state, 'PAYABLE');
    const dispute = await holdHandymanSettlementDispute(scope.id, adminId, id());
    assert.equal(dispute.kind, 'DISPUTED');
    await assert.rejects(
      includeHandymanSettlement(scope.id, adminId, id()),
      (error: { code?: string }) =>
        error.code === 'HANDYMAN_SETTLEMENT_VARIANCE',
    );

    const settlementPersona = await personaSession(
      [
        'tenant_company.read',
        'tenant_company.manage',
        'handyman.finance.read',
        'handyman.finance.manage',
        'handyman.settlement.manage',
        'handyman.commercial.manage',
      ],
      realm.building.id,
      'Settlement Adjudicator',
    );
    const resolutionPath = `${V1}/handyman/execution-scopes/${scope.id}/settlement/dispute/resolution`;

    // ---- strict allow-list: no financial/authority smuggling ---------
    const smuggled = await api()
      .post(resolutionPath)
      .set(auth(settlementPersona.token))
      .send({
        exceptionId: dispute.id,
        outcome: 'RELEASED',
        note: 'Cleared by adjudication.',
        idempotencyKey: key('dispute'),
        amount: '99.00',
      });
    assert.equal(smuggled.status, 400, JSON.stringify(smuggled.body));

    const invalidOutcome = await api()
      .post(resolutionPath)
      .set(auth(settlementPersona.token))
      .send({
        exceptionId: dispute.id,
        outcome: 'APPROVED',
        note: 'Wrong vocabulary.',
        idempotencyKey: key('dispute'),
      });
    assert.equal(invalidOutcome.status, 400, JSON.stringify(invalidOutcome.body));

    // ---- RELEASED clears the hold ------------------------------------
    const resolveKey = key('dispute');
    const released = await api()
      .post(resolutionPath)
      .set(auth(settlementPersona.token))
      .send({
        exceptionId: dispute.id,
        outcome: 'RELEASED',
        note: 'Evidence reviewed; the hold is cleared.',
        idempotencyKey: resolveKey,
      });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.data.outcome, 'RELEASED');
    assert.equal(released.body.data.replayed, false);
    assert.equal(released.body.data.exceptionId, dispute.id);

    const stored = await q(
      `SELECT outcome, note, resolved_by_user_id
         FROM handyman_settlement_dispute_resolutions WHERE exception_id = $1`,
      [dispute.id],
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].outcome, 'RELEASED');
    assert.equal(stored.rows[0].resolved_by_user_id, settlementPersona.userId);
    // the 0418 exception row itself is untouched
    assert.equal(
      (
        await q(
          `SELECT exception_kind FROM handyman_settlement_exceptions WHERE id = $1`,
          [dispute.id],
        )
      ).rows[0].exception_kind,
      'DISPUTED',
    );

    const replay = await api()
      .post(resolutionPath)
      .set(auth(settlementPersona.token))
      .send({
        exceptionId: dispute.id,
        outcome: 'RELEASED',
        note: 'Evidence reviewed; the hold is cleared.',
        idempotencyKey: resolveKey,
      });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.replayed, true);
    assert.equal(replay.body.data.id, released.body.data.id);

    // one adjudication per dispute; a second decision is refused
    const secondAttempt = await api()
      .post(resolutionPath)
      .set(auth(settlementPersona.token))
      .send({
        exceptionId: dispute.id,
        outcome: 'UPHELD',
        note: 'Changing our mind.',
        idempotencyKey: key('dispute'),
      });
    assert.equal(secondAttempt.status, 409, JSON.stringify(secondAttempt.body));
    assert.equal(
      secondAttempt.body.error.code,
      'HANDYMAN_SETTLEMENT_CONFLICT',
    );

    // ---- the released hold no longer blocks the ladder ----------------
    const included = await includeHandymanSettlement(scope.id, adminId, id());
    assert.equal(included.state, 'INCLUDED_IN_SETTLEMENT');
    const reconciled = await reconcileHandymanSettlement(scope.id, adminId, id());
    assert.equal(reconciled.outcome, 'MATCHED');
    const settled = await settleHandymanSettlement(scope.id, adminId, id());
    assert.equal(settled.state, 'SETTLED');
    // adjudicating a settled unit is refused
    const afterSettle = await api()
      .post(resolutionPath)
      .set(auth(settlementPersona.token))
      .send({
        exceptionId: dispute.id,
        outcome: 'UPHELD',
        note: 'Late challenge.',
        idempotencyKey: key('dispute'),
      });
    assert.equal(afterSettle.status, 409, JSON.stringify(afterSettle.body));

    // ---- the adjudication itself is append-only ----------------------
    await assert.rejects(
      q(`UPDATE handyman_settlement_dispute_resolutions
            SET outcome = 'UPHELD' WHERE exception_id = $1`, [dispute.id]),
      /append-only/,
    );
    await assert.rejects(
      q(`DELETE FROM handyman_settlement_dispute_resolutions
          WHERE exception_id = $1`, [dispute.id]),
      /append-only/,
    );

    // ---- UPHELD sustains the hold ------------------------------------
    const upheldFixture = await (async () => {
      const f = await baseFixture();
      const c = await crewFixture(f.realm);
      await assignHandymanExecutionScopeCrew(
        {
          executionScopeId: f.scope.id,
          providerContextId: c.providerContext.id,
          crewId: c.crew.id,
        },
        adminId,
      );
      const agreement = await prepareHandymanCommercialAgreement(adminId, {
        clientId: f.realm.client.id,
        idempotencyKey: id(),
      });
      const v = agreement.version.id;
      await q(
        `INSERT INTO handyman_bm_fee_rule_definitions
          (id,agreement_version_id,basis,mode,idempotency_key,created_by_user_id)
          VALUES($1,$2,'LABOR_ONLY','DEFAULT',$3,$4)`,
        [id(), v, id(), adminId],
      );
      await q(
        `INSERT INTO handyman_bm_fee_term_definitions
          (id,agreement_version_id,term_kind,rate_percent,idempotency_key,created_by_user_id)
          VALUES($1,$2,'PERCENTAGE_OF_BASIS','2.5000',$3,$4)`,
        [id(), v, id(), adminId],
      );
      await q(
        `INSERT INTO handyman_bm_fee_beneficiary_definitions
          (id,agreement_version_id,beneficiary_kind,beneficiary_reference_id,
            idempotency_key,created_by_user_id)
          VALUES($1,$2,'CLIENT_ORGANIZATION',$3,$4,$5)`,
        [id(), v, f.realm.client.id, id(), adminId],
      );
      await activateHandymanCommercialAgreementVersion(adminId, {
        versionId: v,
        effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
        idempotencyKey: id(),
      });
      await openHandymanCustomerTransaction(
        { executionScopeId: f.scope.id, idempotencyKey: id() },
        adminId,
      );
      const l = (
        await q(
          `SELECT id FROM handyman_quotation_lines
            WHERE quotation_version_id = $1 AND line_type = 'LABOR'`,
          [f.scope.approvedQuotationVersionId],
        )
      ).rows[0];
      await composeHandymanChargeLine(
        {
          executionScopeId: f.scope.id,
          quotationLineId: l.id,
          idempotencyKey: id(),
        },
        adminId,
      );
      await deriveHandymanFinancialEntitlements(f.scope.id, adminId, id());
      const p = await recordHandymanCustomerPayment(
        {
          executionScopeId: f.scope.id,
          amount: '100.00',
          channel: 'BANK_TRANSFER',
          providerName: 'Bank',
          providerReference: id(),
          externalReference: id(),
          idempotencyKey: id(),
        },
        adminId,
      );
      await confirmHandymanCustomerPayment(
        {
          executionScopeId: f.scope.id,
          paymentId: p.payment.id,
          idempotencyKey: id(),
        },
        adminId,
      );
      await allocateHandymanCustomerPayment(
        {
          executionScopeId: f.scope.id,
          paymentId: p.payment.id,
          chargeLineId: (
            await q(
              `SELECT id FROM handyman_charge_lines WHERE transaction_id = $1`,
              [p.payment.transactionId],
            )
          ).rows[0].id,
          amount: '100.00',
          idempotencyKey: id(),
        },
        adminId,
      );
      const u = await prepareHandymanSettlement(f.scope.id, adminId, id());
      const d = await holdHandymanSettlementDispute(f.scope.id, adminId, id());
      return { realm: f.realm, scope: f.scope, unit: u, dispute: d };
    })();

    const upheldPersona = await personaSession(
      [
        'tenant_company.read',
        'tenant_company.manage',
        'handyman.finance.read',
        'handyman.finance.manage',
        'handyman.settlement.manage',
      ],
      upheldFixture.realm.building.id,
      'Dispute Board',
    );
    const upheld = await api()
      .post(
        `${V1}/handyman/execution-scopes/${upheldFixture.scope.id}/settlement/dispute/resolution`,
      )
      .set(auth(upheldPersona.token))
      .send({
        exceptionId: upheldFixture.dispute.id,
        outcome: 'UPHELD',
        note: 'The variance is real; sustain the hold pending a correction.',
        idempotencyKey: key('dispute'),
      });
    assert.equal(upheld.status, 200, JSON.stringify(upheld.body));
    assert.equal(upheld.body.data.outcome, 'UPHELD');
    await assert.rejects(
      includeHandymanSettlement(upheldFixture.scope.id, adminId, id()),
      (error: { code?: string }) =>
        error.code === 'HANDYMAN_SETTLEMENT_VARIANCE',
    );
    assert.equal(
      (
        await q(
          `SELECT count(*)::int AS n FROM handyman_settlement_events
            WHERE unit_id = $1 AND state = 'SETTLED'`,
          [upheldFixture.unit.unitId],
        )
      ).rows[0].n,
      0,
    );
  });
});
