import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createEvidenceStorage, evidenceStorageKey } from '../src/modules/evidence/storage';
import { CANONICAL_ROLE_DEFINITIONS } from '../src/modules/iam-bootstrap';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { createAdminUser } from './helpers/access';
import { initHandymanFixtures, realmFixture, locationChain } from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { resetAppConfigCache } from '../src/config';

/**
 * CR-HM-FINANCE-BANK-RECEIPT-ATTESTATION-01 — Focused 3P Verification
 *   P = Positive happy paths
 *   N = Negative denials
 *   E = Edge / Boundary & immutability
 */

const DIR = '/tmp/hm-bank-receipt-attestation-pg';
const PORT = 55550;
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
let storageDir = '';
let adminId = '';
let disciplineId = '';
const id = () => randomUUID();
const key = () => `bank-att-${randomUUID()}`;
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

function rolePermissions(code: string): readonly string[] {
  const found = CANONICAL_ROLE_DEFINITIONS.find((r) => r.code === code);
  if (!found) throw new Error(`Unknown canonical role: ${code}`);
  return found.permissions;
}

async function grant(userId: string, permissionCodes: string[]) {
  const role = await roleService.createRole({
    code: `BANK_ATT_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Bank attestation test role',
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

async function createPersonaSession(
  permissionCodes: readonly string[],
  buildingId: string,
  displayName = 'Persona User',
): Promise<{ userId: string; email: string; token: string }> {
  const sfx = randomUUID().slice(0, 8).toLowerCase();
  const password = `Pass_${sfx}_123!`;
  const user = await userService.createUser({ email: `actor-${sfx}@example.com`, displayName });
  await credentialService.createInitialCredential({ userId: user.id, password });
  if (permissionCodes.length > 0) await grant(user.id, [...permissionCodes]);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const loginRes = await api().post(`${V1}/auth/login`).send({ email: user.email, password });
  assert.equal(loginRes.status, 200, JSON.stringify(loginRes.body));
  return { userId: user.id, email: user.email, token: loginRes.body.data.sessionToken as string };
}

async function createDiagnosedRequestFixture(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  chain: Awaited<ReturnType<typeof locationChain>>,
) {
  const sfx = randomUUID().slice(0, 8).toUpperCase();
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: realm.client.id, tenantCode: `TNT_${sfx}`, tenantName: 'Tenant Company' },
    adminId,
  );
  const tenantPicSession = await createPersonaSession(
    ['tenant_company.read', 'tenant_company.manage'],
    realm.building.id, 'Authorized Tenant PIC',
  );
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Authorized Tenant PIC',
    email: `pic-${sfx.toLowerCase()}@tenant.example.com`,
    userId: tenantPicSession.userId,
  }, adminId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id, buildingId: realm.building.id, spaceId: chain.space.id,
  }, adminId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id, buildingId: realm.building.id,
  }, adminId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id, buildingId: realm.building.id, tenantPicId: pic.id,
    spaceId: chain.space.id, originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`, createdByUserId: tenantPicSession.userId,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry({
    clientId: realm.client.id, code: `HM_${sfx}`, name: 'Handyman Service', category: 'FM_HINT_TEXT',
  }, adminId);
  const request = await handymanServiceRequestService.createHandymanServiceRequest({
    channelAttributionId: attribution.id, serviceCatalogId: service.id,
  }, adminId);
  await handymanServiceRequestTriageService.recordHandymanRequestTriage({
    handymanRequestId: request.id, triageDisposition: 'DIAGNOSIS', triageNote: 'Direct to diagnosis.',
  }, adminId);
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({
    handymanRequestId: request.id, disciplineId, diagnosis: 'AC compressor replacement.',
  }, adminId);
  const uomId = randomUUID();
  await q(`INSERT INTO units_of_measure (id, client_id, code, name, symbol, category) VALUES ($1,$2,$3,$4,$5,$6)`, [uomId, realm.client.id, `U_${sfx}`, 'Unit', 'u', 'COUNT']);
  return { company, pic, tenantPicSession, request, uomId };
}

describe('CR-HM-FINANCE-BANK-RECEIPT-ATTESTATION-01 — bank receipt attestation 3P', () => {
  before(async () => {
    storageDir = mkdtempSync(join(tmpdir(), 'hm-bank-att-evidence-'));
    process.env.EVIDENCE_STORAGE_DIR = join(storageDir, 'evidence');
    resetAppConfigCache();
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    pg = new EmbeddedPostgres({ databaseDir: DIR, port: PORT, user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
    await pg.initialise(); await pg.start();
    const adminClient = pg.getPgClient('postgres', '127.0.0.1');
    await adminClient.connect();
    await adminClient.query('CREATE DATABASE asentra_test');
    await adminClient.end();
    const { ensureTestDatabase } = await import('./helpers/postgres');
    const config = await ensureTestDatabase();
    assert.ok(config);
    pool = await initDatabase(config as any);
    await migrateUp(pool as any);
    const admin = await createAdminUser(); adminId = admin.userId;
    await grant(adminId, ['handyman.qc.configure', 'handyman.bast.manage']);
    const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN');
    assert.ok(discipline);
    disciplineId = discipline.id;
    initHandymanFixtures({ adminUserId: adminId, disciplineId: discipline.id, query: q as any });
  });

  after(async () => {
    try { if (pool) await closePool(pool as any); if (pg) await pg.stop(); } finally {
      await rm(DIR, { recursive: true, force: true });
      if (storageDir) rmSync(storageDir, { recursive: true, force: true });
      delete process.env.EVIDENCE_STORAGE_DIR;
      resetAppConfigCache();
    }
  });

  // ---------------------------------------------------------------------------
  // Helper to build a fresh execution scope with an open transaction and a finance verifier
  // ---------------------------------------------------------------------------
  async function setupScopeWithFinance() {
    const realm = await realmFixture(`BankAtt_${randomUUID().slice(0, 4)}`);
    const chain = await locationChain(realm);
    const f = await createDiagnosedRequestFixture(realm, chain);
    await q(`INSERT INTO client_allowed_transaction_currencies (client_id, currency_code) VALUES ($1, 'IDR') ON CONFLICT DO NOTHING`, [realm.client.id]);
    const opsActor = await createPersonaSession(rolePermissions('OPERATIONS'), realm.building.id, 'Ops');
    const careActor = await createPersonaSession(rolePermissions('CUSTOMER_CARE'), realm.building.id, 'Care');
    const financeVerifier = await createPersonaSession(
      ['tenant_company.read', 'tenant_company.manage', 'tenant_invoice.read', 'tenant_invoice.manage', 'handyman.finance.read', 'handyman.finance.manage', 'evidence.read', 'evidence.manage'],
      realm.building.id, 'Finance Verifier',
    );

    const createdQuotationRes = await api().post(`${V1}/handyman/requests/${f.request.id}/quotation`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({ dpRequired: true, dpPercentage: 40, dpTermsNotes: '40% DP' });
    assert.equal(createdQuotationRes.status, 201, JSON.stringify(createdQuotationRes.body));
    const quotationId = createdQuotationRes.body.data.quotation.id as string;
    const version1Id = createdQuotationRes.body.data.versions[0].id as string;

    const laborRes = await api().post(`${V1}/handyman/quotation-versions/${version1Id}/lines`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({ lineType: 'LABOR', description: 'Labor', quantity: 2, uomId: f.uomId, currency: 'IDR', finalQuotedUnitAmount: 100 });
    assert.equal(laborRes.status, 201);
    const materialRes = await api().post(`${V1}/handyman/quotation-versions/${version1Id}/lines`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({ lineType: 'MATERIAL', description: 'Valve', quantity: 2, uomId: f.uomId, currency: 'IDR', finalQuotedUnitAmount: 50 });
    assert.equal(materialRes.status, 201);
    const issueRes = await api().post(`${V1}/handyman/quotation-versions/${version1Id}/issue`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({ validUntil: '2027-12-31T00:00:00.000Z' });
    assert.equal(issueRes.status, 200);
    const approveRes = await api().post(`${V1}/handyman/quotation-versions/${version1Id}/decision`)
      .set('Authorization', `Bearer ${f.tenantPicSession.token}`)
      .set('Idempotency-Key', key())
      .send({ decision: 'APPROVE' });
    assert.equal(approveRes.status, 201, JSON.stringify(approveRes.body));
    const executionScopeId = approveRes.body.data.executionScope.id as string;

    const openTxRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-transaction`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: key() });
    assert.equal(openTxRes.status, 200, JSON.stringify(openTxRes.body));

    return { realm, chain, f, executionScopeId, opsActor, careActor, financeVerifier };
  }

  // =========================================================================
  // P — Positive
  // =========================================================================
  it('P1 — confirm with valid 7-field attestation moves payment to CONFIRMED and persists immutable trail (service path)', async () => {
    const { realm, executionScopeId, financeVerifier } = await setupScopeWithFinance();
    // Create destination bank account (client-wide)
    const acctRes = await api().post(`${V1}/handyman/bank-accounts`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({
        clientId: realm.client.id,
        bankName: 'BCA', accountNumber: `12345678${randomUUID().slice(0, 4)}`,
        accountHolderName: 'PT Asentra Handyman', displayName: 'BCA Ops', currency: 'IDR',
      });
    assert.equal(acctRes.status, 201, JSON.stringify(acctRes.body));
    assert.match(acctRes.body.data.maskedAccountNumber, /^\*\*\*\*/);
    const accountId = acctRes.body.data.id as string;

    // Record a DP payment via Care endpoint (pre-existing, no attestation at record time)
    const careActor = await createPersonaSession(rolePermissions('CUSTOMER_CARE'), realm.building.id, 'Care P1');
    // Need a second request? Use direct record via ledger API (ops/finance can also record)
    const recRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ amount: '120.00', channel: 'BANK_TRANSFER', obligationStage: 'DP', idempotencyKey: key() });
    assert.equal(recRes.status, 200, JSON.stringify(recRes.body));
    const paymentId = recRes.body.data.payment.id as string;
    assert.equal(recRes.body.data.payment.status, 'PENDING');

    const bankRef = `BANK-P1-${randomUUID()}`;
    const confirmRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${paymentId}/confirm`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({
        idempotencyKey: key(),
        bankReceiptAttestation: {
          destinationBankAccountId: accountId,
          bankTransactionId: bankRef,
          amountCredited: '120.00',
          bankCreditedAt: new Date(Date.now() - 60_000).toISOString(),
          bankStatementEvidenceRef: 's3://bank-statements/p1.pdf',
        },
      });
    assert.equal(confirmRes.status, 200, JSON.stringify(confirmRes.body));
    assert.equal(confirmRes.body.data.payment.status, 'CONFIRMED');
    assert.equal(confirmRes.body.data.replayed, false);

    // Verify attestation persisted and readable via finance read
    const attRes = await api().get(`${V1}/handyman/bank-receipt-attestations/by-payment/${paymentId}`)
      .set('Authorization', `Bearer ${financeVerifier.token}`);
    assert.equal(attRes.status, 200);
    assert.equal(attRes.body.data.bankTransactionId, bankRef);
    assert.equal(attRes.body.data.amountCredited, '120.00');
    assert.equal(attRes.body.data.destinationBankAccountId, accountId);
  });

  it('P2 — building-scoped destination is accepted when scope building matches', async () => {
    const { realm, executionScopeId, financeVerifier } = await setupScopeWithFinance();
    const acctRes = await api().post(`${V1}/handyman/bank-accounts`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({
        clientId: realm.client.id, buildingId: realm.building.id,
        bankName: 'Mandiri', accountNumber: `8800${randomUUID().slice(0, 6)}`,
        accountHolderName: 'PT Asentra', displayName: 'Mandiri Building Scoped', currency: 'IDR',
      });
    assert.equal(acctRes.status, 201, JSON.stringify(acctRes.body));
    const accountId = acctRes.body.data.id as string;

    const recRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ amount: '200.00', channel: 'BANK_TRANSFER', idempotencyKey: key() });
    assert.equal(recRes.status, 200);
    const pid = recRes.body.data.payment.id as string;

    const confirmRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${pid}/confirm`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({
        idempotencyKey: key(),
        bankReceiptAttestation: {
          destinationBankAccountId: accountId,
          bankTransactionId: `BANK-P2-${randomUUID()}`,
          amountCredited: '200.00',
          bankCreditedAt: new Date(Date.now() - 10_000).toISOString(),
        },
      });
    assert.equal(confirmRes.status, 200, JSON.stringify(confirmRes.body));
    assert.equal(confirmRes.body.data.payment.status, 'CONFIRMED');
  });

  it('P3 — idempotency replay with same key returns same payment (deterministic)', async () => {
    const { realm, executionScopeId, financeVerifier } = await setupScopeWithFinance();
    const acctRes = await api().post(`${V1}/handyman/bank-accounts`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ clientId: realm.client.id, bankName: 'BRI', accountNumber: `9900${randomUUID().slice(0, 6)}`, accountHolderName: 'PT Asentra', displayName: 'BRI P3', currency: 'IDR' });
    assert.equal(acctRes.status, 201);
    const accountId = acctRes.body.data.id as string;

    const recRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ amount: '500.00', channel: 'CASH', idempotencyKey: key() });
    const pid = recRes.body.data.payment.id as string;
    const idem = key();
    const bankRef = `BANK-P3-${randomUUID()}`;
    const first = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${pid}/confirm`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: idem, bankReceiptAttestation: { destinationBankAccountId: accountId, bankTransactionId: bankRef, amountCredited: '500.00', bankCreditedAt: new Date(Date.now() - 5000).toISOString() } });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.replayed, false);

    const replay = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${pid}/confirm`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: idem, bankReceiptAttestation: { destinationBankAccountId: accountId, bankTransactionId: `OTHER-${randomUUID()}`, amountCredited: '500.00', bankCreditedAt: new Date(Date.now() - 5000).toISOString() } });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.replayed, true);
    assert.equal(replay.body.data.payment.status, 'CONFIRMED');
  });

  it('P4 — bank account list masks account number (reads never expose full account)', async () => {
    const { realm, financeVerifier } = await setupScopeWithFinance();
    const createRes = await api().post(`${V1}/handyman/bank-accounts`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ clientId: realm.client.id, bankName: 'CIMB', accountNumber: '123456789012', accountHolderName: 'PT Asentra', displayName: 'CIMB Mask', currency: 'IDR' });
    assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
    assert.equal(createRes.body.data.maskedAccountNumber, '****9012');
    assert.ok(!createRes.body.data.accountNumber, 'full accountNumber must not be exposed');

    const listRes = await api().get(`${V1}/handyman/bank-accounts?clientId=${realm.client.id}`)
      .set('Authorization', `Bearer ${financeVerifier.token}`);
    assert.equal(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body.data.bankAccounts));
    for (const acct of listRes.body.data.bankAccounts) {
      assert.ok(acct.maskedAccountNumber.startsWith('****'));
      assert.ok(!acct.accountNumber);
    }
  });

  // =========================================================================
  // N — Negative
  // =========================================================================
  it('N1 — confirm without attestation is denied 400 ATTESTATION_REQUIRED', async () => {
    const { executionScopeId, financeVerifier } = await setupScopeWithFinance();
    const recRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ amount: '100.00', channel: 'CASH', idempotencyKey: key() });
    const pid = recRes.body.data.payment.id as string;
    const res = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${pid}/confirm`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: key() });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'HANDYMAN_BANK_RECEIPT_ATTESTATION_REQUIRED');
  });

  it('N2 — amountCredited mismatch is denied 409 AMOUNT_MISMATCH', async () => {
    const { realm, executionScopeId, financeVerifier } = await setupScopeWithFinance();
    const acctRes = await api().post(`${V1}/handyman/bank-accounts`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ clientId: realm.client.id, bankName: 'BCA', accountNumber: `N2-${randomUUID()}`, accountHolderName: 'PT Asentra', displayName: 'BCA N2', currency: 'IDR' });
    const acctId = acctRes.body.data.id as string;
    const recRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ amount: '1000.00', channel: 'BANK_TRANSFER', idempotencyKey: key() });
    const pid = recRes.body.data.payment.id as string;
    const res = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${pid}/confirm`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: key(), bankReceiptAttestation: { destinationBankAccountId: acctId, bankTransactionId: `N2-${randomUUID()}`, amountCredited: '999.00', bankCreditedAt: new Date(Date.now() - 1000).toISOString() } });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'HANDYMAN_BANK_RECEIPT_AMOUNT_MISMATCH');
  });

  it('N3 — duplicate bankTransactionId within same client is denied 409 DUPLICATE_REFERENCE', async () => {
    const { realm, executionScopeId, financeVerifier } = await setupScopeWithFinance();
    const acctRes = await api().post(`${V1}/handyman/bank-accounts`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ clientId: realm.client.id, bankName: 'Mandiri', accountNumber: `N3-${randomUUID()}`, accountHolderName: 'PT Asentra', displayName: 'Mandiri N3', currency: 'IDR' });
    const acctId = acctRes.body.data.id as string;
    const dupRef = `DUP-${randomUUID()}`;

    const rec1 = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ amount: '300.00', channel: 'CASH', idempotencyKey: key() });
    const pid1 = rec1.body.data.payment.id as string;
    const cnf1 = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${pid1}/confirm`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: key(), bankReceiptAttestation: { destinationBankAccountId: acctId, bankTransactionId: dupRef, amountCredited: '300.00', bankCreditedAt: new Date(Date.now() - 1000).toISOString() } });
    assert.equal(cnf1.status, 200, JSON.stringify(cnf1.body));

    const rec2 = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ amount: '300.00', channel: 'CASH', idempotencyKey: key() });
    const pid2 = rec2.body.data.payment.id as string;
    const cnf2 = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${pid2}/confirm`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: key(), bankReceiptAttestation: { destinationBankAccountId: acctId, bankTransactionId: dupRef, amountCredited: '300.00', bankCreditedAt: new Date(Date.now() - 1000).toISOString() } });
    assert.equal(cnf2.status, 409, JSON.stringify(cnf2.body));
    assert.equal(cnf2.body.error.code, 'HANDYMAN_BANK_RECEIPT_DUPLICATE_REFERENCE');
  });

  it('N4 — cross-tenant destination account is denied 403 BANK_ACCOUNT_NOT_AUTHORIZED', async () => {
    const { realm, executionScopeId, financeVerifier } = await setupScopeWithFinance();
    const otherRealm = await realmFixture(`Other_${randomUUID().slice(0, 4)}`);
    await locationChain(otherRealm);
    const otherFinance = await createPersonaSession(['handyman.finance.manage'], otherRealm.building.id, 'Other Finance');
    const foreignRes = await api().post(`${V1}/handyman/bank-accounts`)
      .set('Authorization', `Bearer ${otherFinance.token}`)
      .send({ clientId: otherRealm.client.id, bankName: 'BCA', accountNumber: `FOREIGN-${randomUUID()}`, accountHolderName: 'PT Foreign', displayName: 'Foreign', currency: 'IDR' });
    assert.equal(foreignRes.status, 201);
    const foreignId = foreignRes.body.data.id as string;

    const recRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ amount: '400.00', channel: 'CASH', idempotencyKey: key() });
    const pid = recRes.body.data.payment.id as string;
    const res = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${pid}/confirm`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: key(), bankReceiptAttestation: { destinationBankAccountId: foreignId, bankTransactionId: `N4-${randomUUID()}`, amountCredited: '400.00', bankCreditedAt: new Date(Date.now() - 1000).toISOString() } });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'HANDYMAN_BANK_ACCOUNT_NOT_AUTHORIZED');
  });

  it('N5 — non-existent destination account is 404 BANK_ACCOUNT_NOT_FOUND', async () => {
    const { executionScopeId, financeVerifier } = await setupScopeWithFinance();
    const recRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ amount: '120.00', channel: 'CASH', idempotencyKey: key() });
    const pid = recRes.body.data.payment.id as string;
    const res = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${pid}/confirm`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: key(), bankReceiptAttestation: { destinationBankAccountId: randomUUID(), bankTransactionId: `N5-${randomUUID()}`, amountCredited: '120.00', bankCreditedAt: new Date(Date.now() - 1000).toISOString() } });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'HANDYMAN_BANK_ACCOUNT_NOT_FOUND');
  });

  // =========================================================================
  // E — Edge
  // =========================================================================
  it('E1 — future bankCreditedAt is denied 400', async () => {
    const { realm, executionScopeId, financeVerifier } = await setupScopeWithFinance();
    const acctRes = await api().post(`${V1}/handyman/bank-accounts`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ clientId: realm.client.id, bankName: 'BCA', accountNumber: `E1-${randomUUID()}`, accountHolderName: 'PT Asentra', displayName: 'BCA E1', currency: 'IDR' });
    const acctId = acctRes.body.data.id as string;
    const recRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ amount: '600.00', channel: 'CASH', idempotencyKey: key() });
    const pid = recRes.body.data.payment.id as string;
    const res = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${pid}/confirm`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: key(), bankReceiptAttestation: { destinationBankAccountId: acctId, bankTransactionId: `E1-${randomUUID()}`, amountCredited: '600.00', bankCreditedAt: new Date(Date.now() + 3600_000).toISOString() } });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    // Parser returns 400 validation; service would also reject
    assert.ok(['HANDYMAN_BANK_RECEIPT_ATTESTATION_INVALID', 'VALIDATION_ERROR'].includes(res.body.error.code));
  });

  it('E2 — building-scoped destination used for wrong building is denied 403', async () => {
    const { realm, executionScopeId, financeVerifier } = await setupScopeWithFinance();
    const { buildingService } = await import('../src/modules/buildings/building.service');
    const otherBuilding = await buildingService.createBuilding({ propertyId: realm.property.id, buildingName: `Bld E2 ${randomUUID().slice(0, 6)}` }, adminId);
    const otherFinance = await createPersonaSession(['handyman.finance.manage'], otherBuilding.id, 'Finance Other Bld');
    const scopedRes = await api().post(`${V1}/handyman/bank-accounts`)
      .set('Authorization', `Bearer ${otherFinance.token}`)
      .send({ clientId: realm.client.id, buildingId: otherBuilding.id, bankName: 'BNI', accountNumber: `E2-${randomUUID()}`, accountHolderName: 'PT Asentra', displayName: 'BNI Scoped Other', currency: 'IDR' });
    assert.equal(scopedRes.status, 201, JSON.stringify(scopedRes.body));
    const scopedId = scopedRes.body.data.id as string;

    const recRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ amount: '700.00', channel: 'CASH', idempotencyKey: key() });
    const pid = recRes.body.data.payment.id as string;
    const res = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${pid}/confirm`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: key(), bankReceiptAttestation: { destinationBankAccountId: scopedId, bankTransactionId: `E2-${randomUUID()}`, amountCredited: '700.00', bankCreditedAt: new Date(Date.now() - 1000).toISOString() } });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'HANDYMAN_BANK_ACCOUNT_NOT_AUTHORIZED');
  });

  it('E3 — deactivated bank account cannot be used for new attestations', async () => {
    const { realm, executionScopeId, financeVerifier } = await setupScopeWithFinance();
    const acctRes = await api().post(`${V1}/handyman/bank-accounts`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ clientId: realm.client.id, bankName: 'Permata', accountNumber: `E3-${randomUUID()}`, accountHolderName: 'PT Asentra', displayName: 'Permata E3', currency: 'IDR' });
    const acctId = acctRes.body.data.id as string;
    const deactRes = await api().post(`${V1}/handyman/bank-accounts/${acctId}/deactivate`)
      .set('Authorization', `Bearer ${financeVerifier.token}`).send({});
    assert.equal(deactRes.status, 200);
    assert.equal(deactRes.body.data.isActive, false);

    const recRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ amount: '800.00', channel: 'CASH', idempotencyKey: key() });
    const pid = recRes.body.data.payment.id as string;
    const res = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${pid}/confirm`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: key(), bankReceiptAttestation: { destinationBankAccountId: acctId, bankTransactionId: `E3-${randomUUID()}`, amountCredited: '800.00', bankCreditedAt: new Date(Date.now() - 1000).toISOString() } });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'HANDYMAN_BANK_RECEIPT_ATTESTATION_CONFLICT');
  });

  it('E4 — cross-building isolation: sibling building actor cannot confirm payment on this scope', async () => {
    const { realm, executionScopeId } = await setupScopeWithFinance();
    const { buildingService } = await import('../src/modules/buildings/building.service');
    const siblingBuilding = await buildingService.createBuilding({ propertyId: realm.property.id, buildingName: `Sibling ${randomUUID().slice(0, 6)}` }, adminId);
    const siblingFinance = await createPersonaSession(
      ['handyman.finance.manage', 'handyman.finance.read', 'tenant_company.read', 'tenant_company.manage', 'tenant_invoice.read', 'tenant_invoice.manage', 'handyman.finance.read', 'handyman.finance.manage'],
      siblingBuilding.id, 'Sibling Finance',
    );
    // Recreate finance for original building can open tx? Already open. Now sibling tries confirm.
    const legitFinance = await createPersonaSession(['handyman.finance.manage', 'handyman.finance.read'], realm.building.id, 'Legit Finance');
    const acctRes = await api().post(`${V1}/handyman/bank-accounts`)
      .set('Authorization', `Bearer ${legitFinance.token}`)
      .send({ clientId: realm.client.id, bankName: 'BCA', accountNumber: `E4-${randomUUID()}`, accountHolderName: 'PT Asentra', displayName: 'BCA E4', currency: 'IDR' });
    const acctId = acctRes.body.data.id as string;
    const recRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${legitFinance.token}`)
      .send({ amount: '900.00', channel: 'CASH', idempotencyKey: key() });
    const pid = recRes.body.data.payment.id as string;

    const res = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${pid}/confirm`)
      .set('Authorization', `Bearer ${siblingFinance.token}`)
      .send({ idempotencyKey: key(), bankReceiptAttestation: { destinationBankAccountId: acctId, bankTransactionId: `E4-${randomUUID()}`, amountCredited: '900.00', bankCreditedAt: new Date(Date.now() - 1000).toISOString() } });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED');
  });

  it('E5 — immutable audit trail: direct UPDATE/DELETE on attestations is blocked by DB trigger', async () => {
    const { realm, executionScopeId, financeVerifier } = await setupScopeWithFinance();
    const acctRes = await api().post(`${V1}/handyman/bank-accounts`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ clientId: realm.client.id, bankName: 'BCA', accountNumber: `E5-${randomUUID()}`, accountHolderName: 'PT Asentra', displayName: 'BCA E5', currency: 'IDR' });
    const acctId = acctRes.body.data.id as string;

    const recRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ amount: '111.00', channel: 'CASH', idempotencyKey: key() });
    const pid = recRes.body.data.payment.id as string;
    const cnfRes = await api().post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${pid}/confirm`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: key(), bankReceiptAttestation: { destinationBankAccountId: acctId, bankTransactionId: `E5-${randomUUID()}`, amountCredited: '111.00', bankCreditedAt: new Date(Date.now() - 1000).toISOString() } });
    assert.equal(cnfRes.status, 200, JSON.stringify(cnfRes.body));

    const att = await q(`SELECT id FROM handyman_bank_receipt_attestations WHERE payment_id = $1`, [pid]);
    assert.equal(att.rows.length, 1);
    const attId = att.rows[0].id as string;
    await assert.rejects(
      () => q(`UPDATE handyman_bank_receipt_attestations SET bank_statement_evidence_ref='tampered' WHERE id=$1`, [attId]),
      (err: any) => { assert.match(String(err.message), /immutable/i); return true; },
    );
    await assert.rejects(
      () => q(`DELETE FROM handyman_bank_receipt_attestations WHERE id=$1`, [attId]),
      (err: any) => { assert.match(String(err.message), /immutable/i); return true; },
    );
  });
});
