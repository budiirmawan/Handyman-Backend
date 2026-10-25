import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { resetAppConfigCache } from '../src/config';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import {
  createEvidenceStorage,
  evidenceStorageKey,
} from '../src/modules/evidence/storage';
import { prepareHandymanBast, issueHandymanBast } from '../src/modules/handyman-bast';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  bindHandymanQcEvidence,
  configureHandymanQcChecklist,
  createHandymanEvidenceRecord,
  finishHandymanQcRun,
  openHandymanQcRun,
  publishHandymanQcChecklistVersion,
  setHandymanQcRunItemOutcome,
} from '../src/modules/handyman-evidence-qc';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { workforceService } from '../src/modules/workforce';
import { assignSupervisor } from '../src/modules/workforce-reporting-lines';
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
import { api } from './helpers/http';
import { handymanCustomerForScope, handymanCustomerConsentInput } from './helpers/handyman-customer-consent';

/**
 * CR-HM-E2E-LIFECYCLE-01 — persona-handoff integration tests for the
 * finance close HTTP seams (J10–J12) on disposable embedded PostgreSQL.
 *
 * Every command under test goes over real HTTP against the real app;
 * only upstream journey state (quotation/scope/crew, guarded QC PASS,
 * BAST) is arranged through the owning services, mirroring the
 * focused CR-HM-11/13/14/15 suites. Assertions verify persisted state,
 * not mocked responses.
 */

const DIR = '/tmp/hm-e2e-finance-close-pg';
const PORT = 55541;
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  DB_HOST: '127.0.0.1',
  DB_PORT: String(PORT),
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_NAME: 'asentra_test',
  DB_SSL: 'false',
});

const V1 = '/api/v1';
let pg: EmbeddedPostgres;
let pool: Pool;
let storageDir = '';
let adminId = '';
let adminToken = '';
const id = () => randomUUID();
const key = () => `e2e-${randomUUID()}`;
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

async function grant(userId: string, permissionCodes: string[]) {
  const role = await roleService.createRole({
    code: `E2E_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'E2E scoped test role',
  });
  for (const permissionCode of permissionCodes) {
    const permission = await permissionService
      .createPermission({ code: permissionCode, name: `Scoped ${permissionCode}` })
      .catch(async () => permissionRepository.findByCode(permissionCode));
    if (!permission) throw new Error(`Permission missing: ${permissionCode}`);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}

const credentials = new Map<string, string>();
async function login(userId: string, email: string): Promise<string> {
  let password = credentials.get(userId);
  if (!password) {
    password = `Pass${randomUUID().slice(0, 8)}!1`;
    await credentialService.createInitialCredential({ userId, password });
    credentials.set(userId, password);
  }
  const response = await api()
    .post(`${V1}/auth/login`)
    .send({ email, password });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data.sessionToken as string;
}

function post(token: string, url: string, body: unknown) {
  return api().post(url).set('Authorization', `Bearer ${token}`).send(body as object);
}
function get(token: string, url: string) {
  return api().get(url).set('Authorization', `Bearer ${token}`);
}
const errCode = (res: { body?: { error?: { code?: string } } }) =>
  res.body?.error?.code;

before(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'hm-e2e-evidence-'));
  process.env.EVIDENCE_STORAGE_DIR = join(storageDir, 'evidence');
  resetAppConfigCache();
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
  const admin = await createAdminUser();
  adminId = admin.userId;
  adminToken = admin.token;
  await grant(adminId, ['handyman.qc.configure']);
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  assert.ok(discipline);
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
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
    delete process.env.EVIDENCE_STORAGE_DIR;
    resetAppConfigCache();
  }
});

/** Scope + crew arranged through owning services (J03/J04 state).
 * NOTE: the shared crewFixture already performs the 0439 workforce_building
 * placement for the realm's building (and the Lead's user_building grant);
 * repeating assignBuildingToWorkforce here would hit the ACTIVE-placement
 * duplicate guard. */
async function scopedFixture() {
  const { realm, scope } = await baseFixture();
  const crew = await crewFixture(realm);
  const assignment = await assignHandymanExecutionScopeCrew(
    {
      executionScopeId: scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    },
    adminId,
  );
  return { realm, scope, crew, assignment };
}

/** Commercial agreement + pricing/BM-fee authoring entirely over HTTP. */
async function configureCommercialViaHttp(clientId: string) {
  const prepared = await post(
    adminToken,
    `${V1}/handyman/commercial-agreements`,
    { clientId, idempotencyKey: key() },
  );
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const versionId = prepared.body.data.version.id as string;

  const labor = await post(
    adminToken,
    `${V1}/handyman/commercial-agreement-versions/${versionId}/labor-pricing-basis`,
    {
      mode: 'HOURLY',
      crewMode: 'PER_HEAD',
      billableTimeBasis: 'ACTUAL_WORK',
      unitAmount: '150000.00',
      currency: 'IDR',
      idempotencyKey: key(),
    },
  );
  assert.equal(labor.status, 200, JSON.stringify(labor.body));
  const material = await post(
    adminToken,
    `${V1}/handyman/commercial-agreement-versions/${versionId}/material-pricing-basis`,
    { mode: 'SETTLED_USAGE', idempotencyKey: key() },
  );
  assert.equal(material.status, 200, JSON.stringify(material.body));
  const rule = await post(
    adminToken,
    `${V1}/handyman/commercial-agreement-versions/${versionId}/bm-fee-rule`,
    { basis: 'LABOR_ONLY', mode: 'DEFAULT', idempotencyKey: key() },
  );
  assert.equal(rule.status, 200, JSON.stringify(rule.body));
  const term = await post(
    adminToken,
    `${V1}/handyman/commercial-agreement-versions/${versionId}/bm-fee-term`,
    {
      termKind: 'PERCENTAGE_OF_BASIS',
      ratePercent: '2.5000',
      idempotencyKey: key(),
    },
  );
  assert.equal(term.status, 200, JSON.stringify(term.body));
  const beneficiary = await post(
    adminToken,
    `${V1}/handyman/commercial-agreement-versions/${versionId}/bm-fee-beneficiary`,
    {
      beneficiaryKind: 'CLIENT_ORGANIZATION',
      beneficiaryReferenceId: clientId,
      idempotencyKey: key(),
    },
  );
  assert.equal(beneficiary.status, 200, JSON.stringify(beneficiary.body));

  const activated = await post(
    adminToken,
    `${V1}/handyman/commercial-agreement-versions/${versionId}/activate`,
    {
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: key(),
    },
  );
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal(activated.body.data.version.status, 'ACTIVE');
  return versionId;
}

async function laborQuotationLineId(scope: {
  approvedQuotationVersionId: string;
}) {
  const rows = await q(
    `SELECT id FROM handyman_quotation_lines
      WHERE quotation_version_id = $1 AND line_type = 'LABOR'`,
    [scope.approvedQuotationVersionId],
  );
  assert.equal(rows.rows.length, 1);
  return rows.rows[0].id as string;
}

/** Genuine guarded QC PASS + ACCEPTED BAST (J08/J09 upstream state). */
async function acceptedBastFixture() {
  const f = await scopedFixture();
  const template = await publishHandymanQcChecklistVersion(
    {
      clientId: f.scope.clientId,
      code: 'HANDYMAN_FINAL',
      versionNumber: 1,
      requiredItemKeys: ['quality'],
    },
    adminId,
  );
  await configureHandymanQcChecklist(
    { executionScopeId: f.scope.id, templateVersionId: template.version.id },
    adminId,
  );
  const supervisor = await userService.createUser({
    email: `supervisor-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Assigned Supervisor',
  });
  const supProfile = await workforceService.createWorkforceProfile({
    organizationId: f.realm.organization.id,
    departmentId: f.realm.department.id,
    positionId: f.realm.position.id,
    employeeCode: `SUP_${randomUUID().slice(0, 8).toUpperCase()}`,
    fullName: 'Assigned Supervisor',
    userId: supervisor.id,
  });
  await assignSupervisor({
    workforceProfileId: f.crew.workerContext.workforceProfileId,
    supervisorWorkforceProfileId: supProfile.id,
  });
  await buildingAssignmentService.createAssignment(supervisor.id, {
    buildingId: f.realm.building.id,
  });
  await grant(supervisor.id, ['handyman.qc.manage']);

  await getPool().query(
    `INSERT INTO handyman_work_sessions
       (id, client_id, execution_scope_id, assignment_id, lead_worker_id,
        lead_user_id, status, started_work_at, completed_at, checked_out_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'CHECKED_OUT', NOW(), NOW(), NOW())`,
    [
      id(),
      f.scope.clientId,
      f.scope.id,
      f.assignment.id,
      f.crew.workerContext.id,
      f.crew.leadUser.id,
    ],
  );
  const { run } = await openHandymanQcRun(
    {
      executionScopeId: f.scope.id,
      checklistIdentity: 'HANDYMAN_FINAL@v1',
      idempotencyKey: key(),
    },
    supervisor.id,
  );
  await setHandymanQcRunItemOutcome(
    {
      qcRunId: run.id,
      itemKey: 'quality',
      outcome: 'PASS',
      expectedVersion: 1,
      idempotencyKey: key(),
    },
    supervisor.id,
  );
  const uploadId = id();
  const storageKey = evidenceStorageKey(uploadId);
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`qc-${uploadId}`),
  ]);
  await createEvidenceStorage().put(storageKey, {
    buffer: bytes,
    mimeType: 'image/png',
  });
  const reference = `hm-ev://${uploadId}`;
  await getPool().query(
    `INSERT INTO handyman_field_evidence_uploads
       (id, client_id, tenant_company_id, building_id, handyman_request_id,
        execution_scope_id, purpose, upload_status, original_file_name,
        mime_type, storage_key, declared_byte_size, verified_byte_size,
        sha256_checksum, attachment_reference, uploaded_by_user_id,
        uploaded_by_role, idempotency_key, verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,'QC_EVIDENCE','VERIFIED','qc.png','image/png',
       $7,$8,$8,$9,$10,$11,'PIC_PEKERJAAN',$12,NOW())`,
    [
      uploadId,
      f.scope.clientId,
      f.scope.tenantCompanyId,
      f.realm.building.id,
      f.scope.handymanRequestId,
      f.scope.id,
      storageKey,
      bytes.byteLength,
      createHash('sha256').update(bytes).digest('hex'),
      reference,
      f.crew.leadUser.id,
      key(),
    ],
  );
  await bindHandymanQcEvidence(
    {
      qcRunId: run.id,
      evidenceReference: reference,
      expectedVersion: 2,
      idempotencyKey: key(),
    },
    supervisor.id,
  );
  const finished = await finishHandymanQcRun(
    { qcRunId: run.id, outcome: 'PASSED', expectedVersion: 3, idempotencyKey: key() },
    supervisor.id,
  );
  assert.equal(finished.run.status, 'PASSED');

  const prepared = await prepareHandymanBast(adminId, {
    executionScopeId: f.scope.id,
    idempotencyKey: key(),
  });
  await issueHandymanBast(adminId, {
    bastId: prepared.bast.id,
    idempotencyKey: key(),
  });
  const customer = await handymanCustomerForScope(f.scope.id);
  await grant(customer.id, ['tenant_company.manage', 'tenant_company.read']);
  const customerToken = await login(customer.id, customer.email);
  const consent = await handymanCustomerConsentInput(prepared.bast.id, customer.id);
  const accepted = await post(customerToken, `${V1}/handyman/bast/${prepared.bast.id}/accept`, {
    idempotencyKey: key(), signatureDigest: consent.signatureDigest,
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.bast.status, 'ACCEPTED');
  return { ...f, bastId: prepared.bast.id, customerToken, customerUserId: customer.id };
}

describe('CR-HM-E2E-LIFECYCLE-01 finance close HTTP seams (J10–J12)', () => {
  it('J12→J10→J12: commercial authoring, ledger open/charge, payment allocation, entitlement derivation and settlement ladder complete over HTTP with persisted state', async () => {
    const f = await scopedFixture();
    const versionId = await configureCommercialViaHttp(f.realm.client.id);

    const pricing = await get(
      adminToken,
      `${V1}/handyman/pricing-contract?clientId=${f.realm.client.id}&asOf=${encodeURIComponent(new Date().toISOString())}`,
    );
    assert.equal(pricing.status, 200, JSON.stringify(pricing.body));
    assert.equal(pricing.body.data.binding.agreementVersionId, versionId);
    assert.equal(
      pricing.body.data.bmFeeRule.authoritativeForEntitlement,
      true,
    );
    const bmConfig = await get(
      adminToken,
      `${V1}/handyman/bm-fee-configuration?clientId=${f.realm.client.id}&asOf=${encodeURIComponent(new Date().toISOString())}`,
    );
    assert.equal(bmConfig.status, 200, JSON.stringify(bmConfig.body));
    assert.equal(bmConfig.body.data.authoritativeForEntitlement, true);
    assert.deepEqual(bmConfig.body.data.unconfiguredSlots, []);

    const scopeUrl = `${V1}/handyman/execution-scopes/${f.scope.id}`;
    const openKey = key();
    const opened = await post(adminToken, `${scopeUrl}/customer-transaction`, {
      idempotencyKey: openKey,
    });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const replayedOpen = await post(
      adminToken,
      `${scopeUrl}/customer-transaction`,
      { idempotencyKey: openKey },
    );
    assert.equal(replayedOpen.body.data.replayed, true);
    assert.equal(
      replayedOpen.body.data.transaction.id,
      opened.body.data.transaction.id,
    );
    const secondOpen = await post(
      adminToken,
      `${scopeUrl}/customer-transaction`,
      { idempotencyKey: key() },
    );
    assert.equal(secondOpen.status, 409);

    const charge = await post(adminToken, `${scopeUrl}/customer-charge-lines`, {
      quotationLineId: await laborQuotationLineId(f.scope),
      idempotencyKey: key(),
    });
    assert.equal(charge.status, 200, JSON.stringify(charge.body));
    assert.equal(charge.body.data.chargeLine.amount, '100.00');
    const chargeLineId = charge.body.data.chargeLine.id as string;

    const recorded = await post(adminToken, `${scopeUrl}/customer-payments`, {
      amount: '100.00',
      channel: 'BANK_TRANSFER',
      providerName: 'Bank',
      providerReference: id(),
      externalReference: id(),
      idempotencyKey: key(),
    });
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
    const paymentId = recorded.body.data.payment.id as string;
    const confirmed = await post(
      adminToken,
      `${scopeUrl}/customer-payments/${paymentId}/confirm`,
      { idempotencyKey: key() },
    );
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

    const allocation = await post(
      adminToken,
      `${scopeUrl}/payment-allocations`,
      {
        paymentId,
        chargeLineId,
        amount: '100.00',
        idempotencyKey: key(),
      },
    );
    assert.equal(allocation.status, 200, JSON.stringify(allocation.body));
    assert.equal(allocation.body.data.paymentUnallocated, '0.00');

    const derived = await post(
      adminToken,
      `${scopeUrl}/financial-entitlements/derive`,
      { idempotencyKey: key() },
    );
    assert.equal(derived.status, 200, JSON.stringify(derived.body));
    assert.equal(derived.body.data.provider.amount, '97.50');
    assert.equal(derived.body.data.bmFee.amount, '2.50');

    const preparedSettlement = await post(
      adminToken,
      `${scopeUrl}/settlement/prepare`,
      { idempotencyKey: key() },
    );
    assert.equal(
      preparedSettlement.status,
      200,
      JSON.stringify(preparedSettlement.body),
    );
    assert.equal(preparedSettlement.body.data.state, 'PAYABLE');
    const included = await post(adminToken, `${scopeUrl}/settlement/include`, {
      idempotencyKey: key(),
    });
    assert.equal(included.body.data.state, 'INCLUDED_IN_SETTLEMENT');
    const reconciled = await post(
      adminToken,
      `${scopeUrl}/settlement/reconcile`,
      { idempotencyKey: key() },
    );
    assert.equal(reconciled.body.data.outcome, 'MATCHED');
    assert.equal(reconciled.body.data.variance, '0.00');
    const settleKey = key();
    const settled = await post(adminToken, `${scopeUrl}/settlement/settle`, {
      idempotencyKey: settleKey,
    });
    assert.equal(settled.body.data.state, 'SETTLED');
    const settledReplay = await post(
      adminToken,
      `${scopeUrl}/settlement/settle`,
      { idempotencyKey: settleKey },
    );
    assert.equal(settledReplay.body.data.replayed, true);

    const financial = await get(
      adminToken,
      `${scopeUrl}/financial-transaction`,
    );
    assert.equal(financial.status, 200, JSON.stringify(financial.body));
    assert.equal(financial.body.data.status, 'SETTLED');
    assert.equal(financial.body.data.entitlements.length, 2);
    const clientRead = await get(
      adminToken,
      `${V1}/handyman/financial-transactions?clientId=${f.realm.client.id}`,
    );
    assert.equal(clientRead.status, 200, JSON.stringify(clientRead.body));
    assert.ok(
      clientRead.body.data.transactions.some(
        (t: { transaction: { executionScopeId: string } }) =>
          t.transaction.executionScopeId === f.scope.id,
      ),
      JSON.stringify(clientRead.body),
    );

    // Post-settlement correction is a new fact, never a rewrite.
    const refund = await post(adminToken, `${scopeUrl}/ledger-refunds`, {
      paymentId,
      amount: '5.00',
      reason: 'Post-close customer correction',
      idempotencyKey: key(),
    });
    assert.equal(refund.status, 200, JSON.stringify(refund.body));
    const correction = await post(
      adminToken,
      `${scopeUrl}/settlement/correction`,
      {
        ledgerCorrectionId: refund.body.data.correction.id,
        idempotencyKey: key(),
      },
    );
    assert.equal(correction.status, 200, JSON.stringify(correction.body));
    assert.equal(correction.body.data.kind, 'ADJUSTED');
    const variance = await post(
      adminToken,
      `${scopeUrl}/settlement/reconcile`,
      { idempotencyKey: key() },
    );
    assert.equal(variance.body.data.outcome, 'VARIANCE');

    const states = await q(
      `SELECT state FROM handyman_settlement_events
        WHERE unit_id = $1 ORDER BY occurred_at`,
      [preparedSettlement.body.data.unitId],
    );
    assert.deepEqual(
      states.rows.map((r: { state: string }) => r.state),
      ['PAYABLE', 'INCLUDED_IN_SETTLEMENT', 'SETTLED'],
    );
    const facts = await q(
      `SELECT entitlement_kind, amount FROM handyman_entitlement_facts
        WHERE transaction_id = $1 ORDER BY entitlement_kind`,
      [opened.body.data.transaction.id],
    );
    assert.equal(facts.rows.length, 2);
  });

  it('J10 corrections: allocation reversal, re-allocation, refund and payment reversal persist as forward-only facts', async () => {
    const f = await scopedFixture();
    await configureCommercialViaHttp(f.realm.client.id);
    const scopeUrl = `${V1}/handyman/execution-scopes/${f.scope.id}`;
    const openedTx = await post(adminToken, `${scopeUrl}/customer-transaction`, {
      idempotencyKey: key(),
    });
    assert.equal(openedTx.status, 200, JSON.stringify(openedTx.body));
    const charge = await post(adminToken, `${scopeUrl}/customer-charge-lines`, {
      quotationLineId: await laborQuotationLineId(f.scope),
      idempotencyKey: key(),
    });
    assert.equal(charge.status, 200, JSON.stringify(charge.body));
    const chargeLineId = charge.body.data.chargeLine.id as string;

    const recorded = await post(adminToken, `${scopeUrl}/customer-payments`, {
      amount: '100.00',
      channel: 'BANK_TRANSFER',
      providerReference: id(),
      idempotencyKey: key(),
    });
    const paymentId = recorded.body.data.payment.id as string;
    await post(adminToken, `${scopeUrl}/customer-payments/${paymentId}/confirm`, {
      idempotencyKey: key(),
    });

    const partial = await post(adminToken, `${scopeUrl}/payment-allocations`, {
      paymentId,
      chargeLineId,
      amount: '60.00',
      idempotencyKey: key(),
    });
    assert.equal(partial.status, 200, JSON.stringify(partial.body));
    assert.equal(partial.body.data.paymentUnallocated, '40.00');
    const reversed = await post(
      adminToken,
      `${scopeUrl}/ledger-reversals/allocation`,
      {
        allocationId: partial.body.data.allocation.id,
        reason: 'Allocated to the wrong charge line',
        idempotencyKey: key(),
      },
    );
    assert.equal(reversed.status, 200, JSON.stringify(reversed.body));
    assert.equal(reversed.body.data.correction.correctionKind, 'REVERSAL');

    const full = await post(adminToken, `${scopeUrl}/payment-allocations`, {
      paymentId,
      chargeLineId,
      amount: '100.00',
      idempotencyKey: key(),
    });
    assert.equal(full.status, 200, JSON.stringify(full.body));
    assert.equal(full.body.data.paymentUnallocated, '0.00');

    const refund = await post(adminToken, `${scopeUrl}/ledger-refunds`, {
      paymentId,
      amount: '10.00',
      reason: 'Partial customer refund',
      idempotencyKey: key(),
    });
    assert.equal(refund.body.data.correction.correctionKind, 'REFUND');

    const recorded2 = await post(adminToken, `${scopeUrl}/customer-payments`, {
      amount: '20.00',
      channel: 'CASH',
      idempotencyKey: key(),
    });
    const payment2Id = recorded2.body.data.payment.id as string;
    await post(
      adminToken,
      `${scopeUrl}/customer-payments/${payment2Id}/confirm`,
      { idempotencyKey: key() },
    );
    const reversedPayment = await post(
      adminToken,
      `${scopeUrl}/ledger-reversals/payment`,
      {
        paymentId: payment2Id,
        reason: 'Duplicate bank credit',
        idempotencyKey: key(),
      },
    );
    assert.equal(
      reversedPayment.body.data.correction.correctionKind,
      'REVERSAL',
    );

    const adjusted = await post(adminToken, `${scopeUrl}/ledger-adjustments`, {
      chargeLineId,
      amount: '5.00',
      reason: 'Approved price adjustment',
      idempotencyKey: key(),
    });
    assert.equal(adjusted.status, 200, JSON.stringify(adjusted.body));
    assert.equal(adjusted.body.data.correction.correctionKind, 'ADJUSTMENT');

    const corrections = await q(
      `SELECT correction_kind FROM handyman_ledger_corrections
        WHERE transaction_id = $1 ORDER BY created_at`,
      [recorded.body.data.payment.transactionId],
    );
    assert.deepEqual(
      corrections.rows.map((r: { correction_kind: string }) => r.correction_kind),
      ['REVERSAL', 'REFUND', 'REVERSAL', 'ADJUSTMENT'],
    );
  });

  it('authority boundaries: RBAC gates finance writes, exact-scope authority denies outsiders, smuggled fields are rejected', async () => {
    const f = await scopedFixture();
    const scopeUrl = `${V1}/handyman/execution-scopes/${f.scope.id}`;
    const plain = await createPlainSession();
    const readOnly = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
    ]);

    const anon = await api()
      .post(`${scopeUrl}/customer-transaction`)
      .send({ idempotencyKey: key() });
    assert.equal(anon.status, 401);

    const plainWrite = await post(plain, `${scopeUrl}/customer-transaction`, {
      idempotencyKey: key(),
    });
    assert.equal(plainWrite.status, 403);

    const readOnlyWrite = await post(
      readOnly,
      `${scopeUrl}/customer-transaction`,
      { idempotencyKey: key() },
    );
    assert.equal(readOnlyWrite.status, 403);

    // Read permission alone does not cross the exact-Building wall.
    const readOnlyRead = await get(readOnly, `${scopeUrl}/financial-transaction`);
    assert.equal(readOnlyRead.status, 403);

    // A read-role user cannot author client commercial terms either.
    const outsiderCommercial = await post(
      readOnly,
      `${V1}/handyman/commercial-agreements`,
      { clientId: f.realm.client.id, idempotencyKey: key() },
    );
    assert.equal(outsiderCommercial.status, 403);

    // Smuggled authority fields are rejected at the transport edge.
    const smuggled = await post(adminToken, `${scopeUrl}/customer-charge-lines`, {
      quotationLineId: await laborQuotationLineId(f.scope),
      amount: '1.00',
      clientId: f.realm.client.id,
      idempotencyKey: key(),
    });
    assert.equal(smuggled.status, 400);
    assert.equal(errCode(smuggled), 'VALIDATION_ERROR');

    const unknownScope = await post(
      adminToken,
      `${V1}/handyman/execution-scopes/${id()}/customer-transaction`,
      { idempotencyKey: key() },
    );
    assert.equal(unknownScope.status, 404);

    const rows = await q(
      `SELECT count(*)::int AS n FROM handyman_customer_transactions
        WHERE execution_scope_id = $1`,
      [f.scope.id],
    );
    assert.equal(rows.rows[0].n, 0);
  });

  it('J11: warranty start and expire complete over HTTP from an ACCEPTED BAST', async () => {
    const f = await acceptedBastFixture();
    const scopeUrl = `${V1}/handyman/execution-scopes/${f.scope.id}`;
    const startKey = key();
    const started = await post(adminToken, `${scopeUrl}/service-warranty/start`, {
      idempotencyKey: startKey,
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.data.warranty.status, 'ACTIVE');
    assert.equal(started.body.data.coverages.length, 2);
    const replay = await post(adminToken, `${scopeUrl}/service-warranty/start`, {
      idempotencyKey: startKey,
    });
    assert.equal(replay.body.data.replayed, true);

    const warrantyId = started.body.data.warranty.id as string;
    const expired = await post(
      adminToken,
      `${V1}/handyman/service-warranties/${warrantyId}/expire`,
      { idempotencyKey: key() },
    );
    assert.equal(expired.status, 200, JSON.stringify(expired.body));
    assert.equal(expired.body.data.warranty.status, 'EXPIRED');
    const row = await q(
      `SELECT status FROM handyman_service_warranties WHERE id = $1`,
      [warrantyId],
    );
    assert.equal(row.rows[0].status, 'EXPIRED');
  });

  it('J11 rework ladder: Crew Lead proposes/starts/completes/verifies over auth-only HTTP; customer authorizes; non-lead cannot propose', async () => {
    const f = await acceptedBastFixture();
    const scopeUrl = `${V1}/handyman/execution-scopes/${f.scope.id}`;
    const started = await post(adminToken, `${scopeUrl}/service-warranty/start`, {
      idempotencyKey: key(),
    });
    const warrantyId = started.body.data.warranty.id as string;

    const defectEvidence = await createHandymanEvidenceRecord(
      {
        executionScopeId: f.scope.id,
        stage: 'DEFECT',
        description: 'Warranty defect evidence',
        idempotencyKey: key(),
      },
      f.crew.leadUser.id,
    );
    const claim = await post(
      adminToken,
      `${V1}/handyman/service-warranties/${warrantyId}/claims`,
      {
        claimNote: 'Leak returned under warranty',
        evidenceRecordId: defectEvidence.record.id,
        idempotencyKey: key(),
      },
    );
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    const claimId = claim.body.data.claim.id as string;
    await post(adminToken, `${V1}/handyman/service-warranty-claims/${claimId}/submit`, {
      idempotencyKey: key(),
    });
    const approved = await post(
      adminToken,
      `${V1}/handyman/service-warranty-claims/${claimId}/approve`,
      { decisionNote: 'Workmanship defect confirmed', idempotencyKey: key() },
    );
    assert.equal(approved.body.data.claim.status, 'CLAIM_APPROVED');

    // Crew Lead holds no tenant RBAC permissions: the rework field
    // ladder is authentication + service-enforced CURRENT Lead authority.
    const leadToken = await login(f.crew.leadUser.id, f.crew.leadUser.email);
    const proposed = await post(
      leadToken,
      `${V1}/handyman/service-warranty-claims/${claimId}/reworks`,
      { scopeNote: 'Reseal the joint', idempotencyKey: key() },
    );
    assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
    assert.equal(proposed.body.data.rework.status, 'REWORK_DRAFT');
    const reworkId = proposed.body.data.rework.id as string;

    // The office actor is not the CURRENT Crew Lead and cannot start it.
    const officeStart = await post(
      adminToken,
      `${V1}/handyman/service-warranty-reworks/${reworkId}/start`,
      { idempotencyKey: key() },
    );
    assert.equal(officeStart.status, 403);

    // Authorization is the personal PIC's customer decision, not the provider's.
    const authorized = await post(
      f.customerToken,
      `${V1}/handyman/service-warranty-reworks/${reworkId}/authorize`,
      { idempotencyKey: key() },
    );
    assert.equal(authorized.status, 200, JSON.stringify(authorized.body));
    assert.equal(authorized.body.data.rework.status, 'REWORK_AUTHORIZED');

    const startedRework = await post(
      leadToken,
      `${V1}/handyman/service-warranty-reworks/${reworkId}/start`,
      { idempotencyKey: key() },
    );
    assert.equal(startedRework.body.data.rework.status, 'REWORK_IN_PROGRESS');
    const completed = await post(
      leadToken,
      `${V1}/handyman/service-warranty-reworks/${reworkId}/complete`,
      { completionNote: 'Joint resealed', idempotencyKey: key() },
    );
    assert.equal(completed.body.data.rework.status, 'REWORK_COMPLETE');

    const verifyEvidence = await createHandymanEvidenceRecord(
      {
        executionScopeId: f.scope.id,
        stage: 'RECTIFICATION',
        description: 'Rework verification evidence',
        idempotencyKey: key(),
      },
      f.crew.leadUser.id,
    );
    const verified = await post(
      leadToken,
      `${V1}/handyman/service-warranty-reworks/${reworkId}/verify`,
      {
        evidenceRecordId: verifyEvidence.record.id,
        qcRunId: null,
        idempotencyKey: key(),
      },
    );
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.data.rework.status, 'REWORK_VERIFIED');

    const events = await q(
      `SELECT event_type FROM handyman_service_warranty_rework_events
        WHERE rework_id = $1 ORDER BY created_at`,
      [reworkId],
    );
    assert.deepEqual(
      events.rows.map((r: { event_type: string }) => r.event_type),
      ['PROPOSE', 'ACCEPT', 'START', 'COMPLETE', 'VERIFY'],
    );
  });

  it('finance integrity: refund is bounded by received-and-applied, concurrent allocations cannot exceed capacity, idempotency keys cannot be rebound', async () => {
    const f = await scopedFixture();
    await configureCommercialViaHttp(f.realm.client.id);
    const scopeUrl = `${V1}/handyman/execution-scopes/${f.scope.id}`;
    await post(adminToken, `${scopeUrl}/customer-transaction`, {
      idempotencyKey: key(),
    });
    const charge = await post(adminToken, `${scopeUrl}/customer-charge-lines`, {
      quotationLineId: await laborQuotationLineId(f.scope),
      idempotencyKey: key(),
    });
    const chargeLineId = charge.body.data.chargeLine.id as string;
    const recorded = await post(adminToken, `${scopeUrl}/customer-payments`, {
      amount: '100.00',
      channel: 'BANK_TRANSFER',
      providerReference: id(),
      idempotencyKey: key(),
    });
    const paymentId = recorded.body.data.payment.id as string;
    const transactionId = recorded.body.data.payment.transactionId as string;
    await post(
      adminToken,
      `${scopeUrl}/customer-payments/${paymentId}/confirm`,
      { idempotencyKey: key() },
    );

    const first = await post(adminToken, `${scopeUrl}/payment-allocations`, {
      paymentId,
      chargeLineId,
      amount: '60.00',
      idempotencyKey: key(),
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    // Refund bound: only received AND applied funds (60.00) can leave.
    const overRefund = await post(adminToken, `${scopeUrl}/ledger-refunds`, {
      paymentId,
      amount: '60.01',
      reason: 'Refund beyond applied amount',
      idempotencyKey: key(),
    });
    assert.equal(overRefund.status, 409, JSON.stringify(overRefund.body));
    const noCorrection = await q(
      `SELECT count(*)::int AS n FROM handyman_ledger_corrections
        WHERE transaction_id = $1`,
      [transactionId],
    );
    assert.equal(noCorrection.rows[0].n, 0);

    // Concurrency: two parallel 40.00 allocations race for the last
    // 40.00 of capacity — exactly one may persist.
    const raceKeyA = key();
    const raceKeyB = key();
    const [raceA, raceB] = await Promise.all([
      post(adminToken, `${scopeUrl}/payment-allocations`, {
        paymentId,
        chargeLineId,
        amount: '40.00',
        idempotencyKey: raceKeyA,
      }),
      post(adminToken, `${scopeUrl}/payment-allocations`, {
        paymentId,
        chargeLineId,
        amount: '40.00',
        idempotencyKey: raceKeyB,
      }),
    ]);
    const raceStatuses = [raceA.status, raceB.status].sort();
    assert.deepEqual(raceStatuses, [200, 409]);
    const winner = raceA.status === 200 ? raceA : raceB;
    const winnerKey = raceA.status === 200 ? raceKeyA : raceKeyB;
    const persisted = await q(
      `SELECT COALESCE(SUM(amount), 0)::numeric(18, 2)::text AS total,
              count(*)::int AS n
         FROM handyman_payment_allocations WHERE payment_id = $1`,
      [paymentId],
    );
    assert.equal(persisted.rows[0].total, '100.00');
    assert.equal(persisted.rows[0].n, 2);

    // Replay of the winning key returns the same allocation; rebinding
    // the same key to a different amount is a bounded conflict.
    const replay = await post(adminToken, `${scopeUrl}/payment-allocations`, {
      paymentId,
      chargeLineId,
      amount: '40.00',
      idempotencyKey: winnerKey,
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.replayed, true);
    assert.equal(
      replay.body.data.allocation.id,
      winner.body.data.allocation.id,
    );
    const rebound = await post(adminToken, `${scopeUrl}/payment-allocations`, {
      paymentId,
      chargeLineId,
      amount: '10.00',
      idempotencyKey: winnerKey,
    });
    assert.equal(rebound.status, 409, JSON.stringify(rebound.body));

    // After reversing the first allocation, its capacity is allocatable
    // again (net cap), and the payment ends exactly fully applied.
    await post(adminToken, `${scopeUrl}/ledger-reversals/allocation`, {
      allocationId: first.body.data.allocation.id,
      reason: 'Re-route to corrected application',
      idempotencyKey: key(),
    });
    const reallocated = await post(
      adminToken,
      `${scopeUrl}/payment-allocations`,
      {
        paymentId,
        chargeLineId,
        amount: '60.00',
        idempotencyKey: key(),
      },
    );
    assert.equal(reallocated.status, 200, JSON.stringify(reallocated.body));
    assert.equal(reallocated.body.data.paymentUnallocated, '0.00');
    assert.equal(reallocated.body.data.chargeLineOutstanding, '0.00');
  });
});
