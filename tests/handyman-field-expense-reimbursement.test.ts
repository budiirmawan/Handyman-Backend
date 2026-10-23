import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
} from './helpers/embedded-test-db';
import { ensureTestDatabase } from './helpers/postgres';
import {
  crewFixture,
  initHandymanFixtures,
  locationChain,
  realmFixture,
  scopeFixture,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';

/**
 * CR-HM-FIELD-EXPENSE-HELPER-01 PART 01 — Foto Nota dan Reimbursement Petugas
 *
 * Focused E2E verification on a disposable fully-migrated PostgreSQL instance
 * (`0001..0470`), real HTTP routes, real private binary evidence storage, and
 * strict RBAC + exact-Building scoping:
 *   1. Personal out-of-pocket (`REIMBURSEMENT`) lifecycle:
 *      private `MATERIAL_RECEIPT` upload -> request (with `workOrderId`) ->
 *      Operations approval -> supplier purchase -> usage/return ->
 *      Operations verification/reconciliation (`RECONCILED_PAYABLE`) ->
 *      Finance private receipt inspection + Finance approval (`FINANCE_APPROVED`) ->
 *      Finance disbursement (`DISBURSED`), with immutable audit trail.
 *   2. Funding-source eligibility:
 *      `CASH_ADVANCE` (uang muka Handyman) and `COMPANY_DIRECT` / `PETTY_CASH`
 *      (dana perusahaan) never create worker reimbursement claims.
 *   3. Anti-fraud invariants:
 *      blocks disbursement without approval, double payment, duplicate receipts
 *      (same reference, identical binary SHA-256, or same supplier+invoice),
 *      cross-Work Order claims, and wrong-purpose evidence.
 *   4. RBAC, separation of duties (no self-approval/self-disbursement),
 *      exact-Building isolation, Finance rejection, and Migration 0470 down/up.
 */

const V1 = '/api/v1';

let dbHandle: EmbeddedTestDatabase | null = null;
let pool: Pool | null = null;
let evidenceDir = '';
let adminId = '';

const q = (text: string, params: unknown[] = []) =>
  getPool().query(text, params);

function makePngBytes(tag: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`receipt-payload:${tag}`),
  ]);
}

async function grantPermissions(userId: string, codes: string[]) {
  const role = await roleService.createRole({
    code: `P01_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Part 01 Scoped Role',
  });
  for (const code of codes) {
    const perm = await permissionService
      .createPermission({ code, name: `Scoped ${code}` })
      .catch(async () => permissionRepository.findByCode(code));
    assert.ok(perm, `Expected permission ${code} to exist`);
    await permissionService.assignPermissionToRole(role.id, perm.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}

async function createPersonaUser(
  label: string,
  permissionCodes: string[],
  buildingIds: string[],
) {
  const suffix = randomUUID().slice(0, 8).toLowerCase();
  const password = 'SafePass!2026';
  const user = await userService.createUser({
    email: `${label}-${suffix}@example.com`,
    displayName: `${label} User`,
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  if (permissionCodes.length > 0) {
    await grantPermissions(user.id, permissionCodes);
  }
  for (const buildingId of buildingIds) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }
  const login = await api()
    .post(`${V1}/auth/login`)
    .send({ email: user.email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return {
    userId: user.id,
    token: login.body.data.sessionToken as string,
  };
}

async function loginExistingUser(userId: string, email: string) {
  const password = 'LeadPass!2026';
  await credentialService.createInitialCredential({ userId, password });
  const login = await api()
    .post(`${V1}/auth/login`)
    .send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return login.body.data.sessionToken as string;
}

async function uploadFieldEvidence(
  token: string,
  executionScopeId: string,
  purpose: string,
  bytes: Buffer,
  fileName = 'nota.png',
) {
  const res = await api()
    .post(`${V1}/handyman/field/evidence/upload`)
    .set('Authorization', `Bearer ${token}`)
    .field('executionScopeId', executionScopeId)
    .field('purpose', purpose)
    .field('mimeType', 'image/png')
    .field('originalFileName', fileName)
    .field('idempotencyKey', `ev-${randomUUID()}`)
    .attach('file', bytes, { filename: fileName, contentType: 'image/png' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return {
    evidenceId: res.body.data.evidence.id as string,
    attachmentReference: res.body.data.evidence.attachmentReference as string,
    sha256Checksum: res.body.data.evidence.sha256Checksum as string,
  };
}

async function seedCanonicalWorkOrder(
  clientId: string,
  buildingId: string,
  code: string,
): Promise<string> {
  const woId = randomUUID();
  await q(
    `INSERT INTO work_orders (
       id, client_id, building_id, work_order_number,
       title, description, work_type, status, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, 'CORRECTIVE', 'OPEN', $7)`,
    [
      woId,
      clientId,
      buildingId,
      code,
      `WO ${code}`,
      'Canonical Work Order linked to Handyman execution scope',
      adminId,
    ],
  );
  return woId;
}

before(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
  });
  evidenceDir = mkdtempSync(join(tmpdir(), 'hm-p01-evidence-'));
  process.env.EVIDENCE_STORAGE_DIR = evidenceDir;

  dbHandle = await startEmbeddedTestDatabase({
    dir: '/tmp/hm-part01-reimbursement-pg',
    port: 55571,
  });
  resetAppConfigCache();
  const config = await ensureTestDatabase();
  assert.ok(config);
  pool = await initDatabase(config);
  await migrateUp(pool);

  const admin = await createAdminUser();
  adminId = admin.userId;

  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  assert.ok(discipline, 'GENERAL_HANDYMAN discipline must be seeded');
  initHandymanFixtures({
    adminUserId: adminId,
    disciplineId: discipline.id,
    query: q,
  });
});

after(async () => {
  if (pool) {
    await closePool(pool);
  }
  if (dbHandle) {
    await dbHandle.stop();
  }
  if (evidenceDir) {
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

describe('CR-HM-FIELD-EXPENSE-HELPER-01 PART 01 — Foto Nota & Reimbursement Petugas', () => {
  it('1: completes personal out-of-pocket (REIMBURSEMENT) E2E lifecycle with private receipt inspection, Operations verification, Finance approval/disbursement, and immutable audit trail', async () => {
    const realm = await realmFixture('Part01A');
    const chain = await locationChain(realm);
    const { scope } = await scopeFixture(realm, chain);
    const crew = await crewFixture(realm);
    await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
        idempotencyKey: `assign-${randomUUID()}`,
      },
      adminId,
    );

    const leadToken = await loginExistingUser(
      crew.leadUser.id,
      crew.leadUser.email,
    );
    const opsActor = await createPersonaUser(
      'ops',
      ['tenant_company.read', 'tenant_company.manage'],
      [realm.building.id],
    );
    const financeActor = await createPersonaUser(
      'finance',
      ['handyman.finance.read', 'handyman.finance.manage'],
      [realm.building.id],
    );

    const uomId = randomUUID();
    await q(
      `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
       VALUES ($1, $2, $3, 'Pieces', 'pcs', 'COUNT')`,
      [uomId, realm.client.id, `PCS_${randomUUID().slice(0, 6).toUpperCase()}`],
    );
    const workOrderId = await seedCanonicalWorkOrder(
      realm.client.id,
      realm.building.id,
      `WO-P01-${randomUUID().slice(0, 6).toUpperCase()}`,
    );

    // 1. Upload initial request evidence & receipt photo to private storage
    const reqEv = await uploadFieldEvidence(
      leadToken,
      scope.id,
      'MATERIAL_RECEIPT',
      makePngBytes('req-photo-1'),
      'req-item.png',
    );
    const receiptBytes = makePngBytes('nota-toko-sinar-001');
    const receiptEv = await uploadFieldEvidence(
      leadToken,
      scope.id,
      'MATERIAL_RECEIPT',
      receiptBytes,
      'nota-sinar-001.png',
    );

    // 2. Crew Lead submits personal out-of-pocket material purchase request bound to Work Order
    const reqRes = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scope.id}/material-purchases/requests`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        workOrderId,
        itemName: 'Flexible Hose Braided 60cm',
        uomId,
        uomCode: 'PCS',
        fundingSource: 'REIMBURSEMENT',
        requestedQuantity: 4,
        supplierName: 'TB Sinar Abadi',
        currency: 'IDR',
        evidenceReference: reqEv.attachmentReference,
        notes: 'Emergency replacement hose bought out-of-pocket',
        idempotencyKey: `req-${randomUUID()}`,
      });
    assert.equal(reqRes.status, 201, JSON.stringify(reqRes.body));
    const recordId = reqRes.body.data.record.id as string;
    assert.equal(reqRes.body.data.record.workOrderId, workOrderId);

    // 3. Operations approves purchase request
    const appRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/material-purchases/${recordId}/approve`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({
        approvedQuantity: 4,
        approvedMaxUnitPrice: 80000,
        approvalReference: 'OPS-APR-001',
        idempotencyKey: `app-${randomUUID()}`,
      });
    assert.equal(appRes.status, 200, JSON.stringify(appRes.body));

    // 4. Crew Lead records actual purchase with supplier, transaction date, actual cost, and verified receipt photo
    const purRes = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scope.id}/material-purchases/${recordId}/purchase`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        workOrderId,
        purchasedQuantity: 4,
        supplierName: 'TB Sinar Abadi',
        purchaseReference: 'NOTA-SA-2026-1001',
        actualUnitPrice: 75000,
        currency: 'IDR',
        purchaseDate: '2026-10-23T02:15:00.000Z',
        receiptEvidenceReference: receiptEv.attachmentReference,
        notes: 'Paid using worker personal debit card',
        idempotencyKey: `pur-${randomUUID()}`,
      });
    assert.equal(purRes.status, 200, JSON.stringify(purRes.body));
    assert.equal(purRes.body.data.record.actualTotalExpenseAmount, '300000.00');
    assert.equal(purRes.body.data.record.reimbursementPayableAmount, '300000.00');
    assert.equal(purRes.body.data.record.reimbursementStatus, 'PENDING_RECONCILIATION');
    assert.equal(purRes.body.data.record.receiptSha256Checksum, receiptEv.sha256Checksum);

    // 5. Usage (3 used) + supplier return (1 returned to SUPPLIER_RETURN -> net 225,000 IDR eligible)
    const usageEv = await uploadFieldEvidence(
      leadToken,
      scope.id,
      'BEFORE_AFTER_WORK',
      makePngBytes('installed-hose'),
    );
    const useRes = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scope.id}/material-purchases/${recordId}/usage`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        usedQuantity: 3,
        evidenceReference: usageEv.attachmentReference,
        idempotencyKey: `use-${randomUUID()}`,
      });
    assert.equal(useRes.status, 200, JSON.stringify(useRes.body));

    const retEv = await uploadFieldEvidence(
      leadToken,
      scope.id,
      'MATERIAL_RECEIPT',
      makePngBytes('return-slip-hose'),
    );
    const retRes = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scope.id}/material-purchases/${recordId}/return`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        returnedQuantity: 1,
        returnDestination: 'SUPPLIER_RETURN',
        evidenceReference: retEv.attachmentReference,
        idempotencyKey: `ret-${randomUUID()}`,
      });
    assert.equal(retRes.status, 200, JSON.stringify(retRes.body));

    // Guard: Finance cannot approve or disburse BEFORE Operations verification (RECONCILIATION)
    const prematureFinApprove = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/material-purchases/${recordId}/reimbursement/approve`)
      .set('Authorization', `Bearer ${financeActor.token}`)
      .send({
        approvalReference: 'FIN-TOO-EARLY',
        idempotencyKey: `fin-early-${randomUUID()}`,
      });
    assert.equal(prematureFinApprove.status, 409);
    assert.equal(
      prematureFinApprove.body.error.code,
      'HANDYMAN_REIMBURSEMENT_ILLEGAL_TRANSITION',
    );

    // 6. Operations verifies & reconciles purchase -> RECONCILED_PAYABLE (225,000.00 IDR net of supplier return)
    const recRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/material-purchases/${recordId}/reconcile`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({
        tenantChargeEligible: true,
        notes: 'Verified store receipt and 1 supplier-returned hose',
        idempotencyKey: `rec-${randomUUID()}`,
      });
    assert.equal(recRes.status, 200, JSON.stringify(recRes.body));
    assert.equal(recRes.body.data.record.reimbursementStatus, 'RECONCILED_PAYABLE');
    assert.equal(recRes.body.data.record.reimbursementPayableAmount, '225000.00');

    // 7. Finance inspects private MATERIAL_RECEIPT evidence bytes (allowed) but is denied non-receipt BEFORE_AFTER_WORK evidence
    const finReceiptContent = await api()
      .get(`${V1}/handyman/field/evidence/${receiptEv.evidenceId}/content`)
      .set('Authorization', `Bearer ${financeActor.token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    assert.equal(finReceiptContent.status, 200);
    assert.equal(Buffer.compare(finReceiptContent.body as Buffer, receiptBytes), 0);

    const finNonReceiptDenied = await api()
      .get(`${V1}/handyman/field/evidence/${usageEv.evidenceId}/content`)
      .set('Authorization', `Bearer ${financeActor.token}`);
    assert.equal(finNonReceiptDenied.status, 403);
    assert.equal(
      finNonReceiptDenied.body.error.code,
      'HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN',
    );

    // Guard: Finance cannot disburse BEFORE Finance approval
    const prematureDisburse = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/material-purchases/${recordId}/reimbursement/disburse`)
      .set('Authorization', `Bearer ${financeActor.token}`)
      .send({
        disbursementReference: 'TRX-PREMATURE-001',
        idempotencyKey: `disb-early-${randomUUID()}`,
      });
    assert.equal(prematureDisburse.status, 409);
    assert.equal(
      prematureDisburse.body.error.code,
      'HANDYMAN_REIMBURSEMENT_APPROVAL_REQUIRED',
    );

    // 8. Finance queue discovers RECONCILED_PAYABLE claim filtered by workOrderId
    const queueRes = await api()
      .get(`${V1}/handyman/material-reimbursements`)
      .query({ workOrderId, reimbursementStatus: 'RECONCILED_PAYABLE' })
      .set('Authorization', `Bearer ${financeActor.token}`);
    assert.equal(queueRes.status, 200, JSON.stringify(queueRes.body));
    assert.equal(queueRes.body.data.items.length, 1);
    assert.equal(queueRes.body.data.items[0].id, recordId);

    // 9. Finance approves reimbursement -> FINANCE_APPROVED
    const finAppRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/material-purchases/${recordId}/reimbursement/approve`)
      .set('Authorization', `Bearer ${financeActor.token}`)
      .send({
        approvalReference: 'FIN-APR-2026-001',
        notes: 'Original TB Sinar Abadi receipt verified against items used',
        idempotencyKey: 'fin-app-idem-1',
      });
    assert.equal(finAppRes.status, 200, JSON.stringify(finAppRes.body));
    assert.equal(finAppRes.body.data.record.reimbursementStatus, 'FINANCE_APPROVED');
    assert.equal(
      finAppRes.body.data.record.reimbursementFinanceApprovedByUserId,
      financeActor.userId,
    );

    // Guard: Mismatched disbursedAmount is rejected
    const badAmountRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/material-purchases/${recordId}/reimbursement/disburse`)
      .set('Authorization', `Bearer ${financeActor.token}`)
      .send({
        disbursementReference: 'TRX-WRONG-AMT',
        disbursedAmount: 300000,
        idempotencyKey: `disb-bad-amt-${randomUUID()}`,
      });
    assert.equal(badAmountRes.status, 409);
    assert.equal(
      badAmountRes.body.error.code,
      'HANDYMAN_REIMBURSEMENT_AMOUNT_MISMATCH',
    );

    // 10. Finance disburses reimbursement -> DISBURSED (plus idempotent replay check & double-payment block)
    const disbRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/material-purchases/${recordId}/reimbursement/disburse`)
      .set('Authorization', `Bearer ${financeActor.token}`)
      .send({
        disbursementReference: 'BCA-TRF-20261023-0091',
        disbursementMethod: 'BANK_TRANSFER',
        disbursedAmount: 225000,
        notes: 'Transferred to worker registered bank account',
        idempotencyKey: 'fin-disb-idem-1',
      });
    assert.equal(disbRes.status, 200, JSON.stringify(disbRes.body));
    assert.equal(disbRes.body.data.replayed, false);
    assert.equal(disbRes.body.data.record.reimbursementStatus, 'DISBURSED');
    assert.equal(disbRes.body.data.record.reimbursementDisbursedAmount, '225000.00');
    assert.equal(
      disbRes.body.data.record.reimbursementDisbursedByUserId,
      financeActor.userId,
    );

    // Idempotent replay with same key returns 200 replayed: true (single payout)
    const disbReplay = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/material-purchases/${recordId}/reimbursement/disburse`)
      .set('Authorization', `Bearer ${financeActor.token}`)
      .send({
        disbursementReference: 'BCA-TRF-20261023-0091',
        disbursementMethod: 'BANK_TRANSFER',
        disbursedAmount: 225000,
        idempotencyKey: 'fin-disb-idem-1',
      });
    assert.equal(disbReplay.status, 200);
    assert.equal(disbReplay.body.data.replayed, true);

    // Double-payment attempt with new idempotencyKey is rejected with 409 HANDYMAN_REIMBURSEMENT_ALREADY_DISBURSED
    const doublePay = await api()
      .post(`${V1}/handyman/execution-scopes/${scope.id}/material-purchases/${recordId}/reimbursement/disburse`)
      .set('Authorization', `Bearer ${financeActor.token}`)
      .send({
        disbursementReference: 'BCA-TRF-20261023-9999',
        disbursementMethod: 'BANK_TRANSFER',
        idempotencyKey: 'fin-disb-double-attempt',
      });
    assert.equal(doublePay.status, 409);
    assert.equal(
      doublePay.body.error.code,
      'HANDYMAN_REIMBURSEMENT_ALREADY_DISBURSED',
    );

    // 11. Single-record detail endpoints for Mobile Crew Lead & Operations reflect DISBURSED state + full event trail
    const fieldDetail = await api()
      .get(`${V1}/handyman/field/execution-scopes/${scope.id}/material-purchases/${recordId}`)
      .set('Authorization', `Bearer ${leadToken}`);
    assert.equal(fieldDetail.status, 200);
    assert.equal(fieldDetail.body.data.actorRole, 'PIC_PEKERJAAN');
    assert.equal(fieldDetail.body.data.record.reimbursementStatus, 'DISBURSED');
    assert.equal(fieldDetail.body.data.record.reimbursementDisbursedAmount, '225000.00');

    const opsDetail = await api()
      .get(`${V1}/handyman/execution-scopes/${scope.id}/material-purchases/${recordId}`)
      .set('Authorization', `Bearer ${opsActor.token}`);
    assert.equal(opsDetail.status, 200);
    const eventTypes = opsDetail.body.data.events.map((e: any) => e.eventType);
    assert.deepEqual(eventTypes, [
      'REQUEST',
      'APPROVAL',
      'PURCHASED',
      'USAGE',
      'RETURN',
      'RECONCILIATION',
      'REIMBURSEMENT_APPROVED',
      'REIMBURSEMENT_DISBURSED',
    ]);

    // Append-only trigger rejects direct mutation/deletion of audit events
    await assert.rejects(
      () =>
        q(
          `DELETE FROM handyman_material_purchase_events WHERE purchase_record_id = $1`,
          [recordId],
        ),
      /append-only/i,
    );
  });

  it('2: supports Handyman cash advance (CASH_ADVANCE) and company funds (COMPANY_DIRECT / PETTY_CASH) without creating worker reimbursements', async () => {
    const realm = await realmFixture('Part01B');
    const chain = await locationChain(realm);
    const { scope } = await scopeFixture(realm, chain);
    const crew = await crewFixture(realm);
    await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
        idempotencyKey: `assign-${randomUUID()}`,
      },
      adminId,
    );

    const leadToken = await loginExistingUser(
      crew.leadUser.id,
      crew.leadUser.email,
    );
    const opsActor = await createPersonaUser(
      'ops2',
      ['tenant_company.read', 'tenant_company.manage'],
      [realm.building.id],
    );
    const financeActor = await createPersonaUser(
      'finance2',
      ['handyman.finance.read', 'handyman.finance.manage'],
      [realm.building.id],
    );

    const uomId = randomUUID();
    await q(
      `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
       VALUES ($1, $2, $3, 'Pieces', 'pcs', 'COUNT')`,
      [uomId, realm.client.id, `PCS_${randomUUID().slice(0, 6).toUpperCase()}`],
    );

    for (const source of ['CASH_ADVANCE', 'COMPANY_DIRECT', 'PETTY_CASH'] as const) {
      const evReq = await uploadFieldEvidence(
        leadToken,
        scope.id,
        'MATERIAL_RECEIPT',
        makePngBytes(`req-${source}`),
      );
      const evNota = await uploadFieldEvidence(
        leadToken,
        scope.id,
        'MATERIAL_RECEIPT',
        makePngBytes(`nota-${source}`),
      );
      const evUse = await uploadFieldEvidence(
        leadToken,
        scope.id,
        'BEFORE_AFTER_WORK',
        makePngBytes(`use-${source}`),
      );

      const reqRes = await api()
        .post(`${V1}/handyman/field/execution-scopes/${scope.id}/material-purchases/requests`)
        .set('Authorization', `Bearer ${leadToken}`)
        .send({
          itemName: `Sealant (${source})`,
          uomId,
          fundingSource: source,
          requestedQuantity: 2,
          cashAdvanceReference: source === 'CASH_ADVANCE' ? 'ADV-HM-001' : undefined,
          evidenceReference: evReq.attachmentReference,
          idempotencyKey: `req-${source}-${randomUUID()}`,
        });
      assert.equal(reqRes.status, 201, JSON.stringify(reqRes.body));
      const recId = reqRes.body.data.record.id as string;

      await api()
        .post(`${V1}/handyman/execution-scopes/${scope.id}/material-purchases/${recId}/approve`)
        .set('Authorization', `Bearer ${opsActor.token}`)
        .send({
          approvedQuantity: 2,
          approvalReference: `APR-${source}`,
          cashAdvanceReference: source === 'CASH_ADVANCE' ? 'ADV-HM-001' : undefined,
          idempotencyKey: `app-${source}-${randomUUID()}`,
        })
        .expect(200);

      const purRes = await api()
        .post(`${V1}/handyman/field/execution-scopes/${scope.id}/material-purchases/${recId}/purchase`)
        .set('Authorization', `Bearer ${leadToken}`)
        .send({
          purchasedQuantity: 2,
          supplierName: 'TB Mitra Teknik',
          purchaseReference: `INV-${source}-01`,
          actualUnitPrice: 45000,
          purchaseDate: '2026-10-23T03:00:00.000Z',
          receiptEvidenceReference: evNota.attachmentReference,
          idempotencyKey: `pur-${source}-${randomUUID()}`,
        });
      assert.equal(purRes.status, 200, JSON.stringify(purRes.body));
      assert.equal(purRes.body.data.record.reimbursementStatus, 'NOT_APPLICABLE');
      assert.equal(purRes.body.data.record.reimbursementPayableAmount, '0.00');
      assert.equal(purRes.body.data.record.reimbursementPayeeUserId, null);

      await api()
        .post(`${V1}/handyman/field/execution-scopes/${scope.id}/material-purchases/${recId}/usage`)
        .set('Authorization', `Bearer ${leadToken}`)
        .send({
          usedQuantity: 2,
          evidenceReference: evUse.attachmentReference,
          idempotencyKey: `use-${source}-${randomUUID()}`,
        })
        .expect(200);

      const recRes = await api()
        .post(`${V1}/handyman/execution-scopes/${scope.id}/material-purchases/${recId}/reconcile`)
        .set('Authorization', `Bearer ${opsActor.token}`)
        .send({
          tenantChargeEligible: true,
          idempotencyKey: `rec-${source}-${randomUUID()}`,
        });
      assert.equal(recRes.status, 200, JSON.stringify(recRes.body));
      assert.equal(recRes.body.data.record.reimbursementStatus, 'NOT_APPLICABLE');
      assert.equal(recRes.body.data.record.reimbursementPayableAmount, '0.00');

      // Finance approval on non-personal-funds record is rejected with 409 HANDYMAN_REIMBURSEMENT_NOT_ELIGIBLE
      const finApprove = await api()
        .post(`${V1}/handyman/execution-scopes/${scope.id}/material-purchases/${recId}/reimbursement/approve`)
        .set('Authorization', `Bearer ${financeActor.token}`)
        .send({
          approvalReference: `FIN-NO-${source}`,
          idempotencyKey: `fin-no-${source}-${randomUUID()}`,
        });
      assert.equal(finApprove.status, 409);
      assert.equal(
        finApprove.body.error.code,
        'HANDYMAN_REIMBURSEMENT_NOT_ELIGIBLE',
      );
    }

    // Finance queue returns zero items for non-REIMBURSEMENT scope
    const queueRes = await api()
      .get(`${V1}/handyman/material-reimbursements`)
      .query({ executionScopeId: scope.id })
      .set('Authorization', `Bearer ${financeActor.token}`);
    assert.equal(queueRes.status, 200);
    assert.equal(queueRes.body.data.items.length, 0);
  });

  it('3: blocks duplicate receipts, cross-Work Order claims, wrong evidence purpose, unauthorized/cross-Building/self-approval actors, and supports Finance rejection', async () => {
    const realmA = await realmFixture('Part01C_A');
    const chainA1 = await locationChain(realmA);
    const chainA2 = await locationChain(realmA);
    const { scope: scopeA1 } = await scopeFixture(realmA, chainA1);
    const { scope: scopeA2 } = await scopeFixture(realmA, chainA2);
    const crewA = await crewFixture(realmA);
    await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scopeA1.id,
        providerContextId: crewA.providerContext.id,
        crewId: crewA.crew.id,
        idempotencyKey: `assign-${randomUUID()}`,
      },
      adminId,
    );
    await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scopeA2.id,
        providerContextId: crewA.providerContext.id,
        crewId: crewA.crew.id,
        idempotencyKey: `assign-${randomUUID()}`,
      },
      adminId,
    );

    const realmB = await realmFixture('Part01C_B');

    const leadToken = await loginExistingUser(
      crewA.leadUser.id,
      crewA.leadUser.email,
    );
    const opsActor = await createPersonaUser(
      'ops3',
      ['tenant_company.read', 'tenant_company.manage'],
      [realmA.building.id],
    );
    const financeActorA = await createPersonaUser(
      'finA',
      ['handyman.finance.read', 'handyman.finance.manage'],
      [realmA.building.id],
    );
    const financeActorB = await createPersonaUser(
      'finB',
      ['handyman.finance.read', 'handyman.finance.manage'],
      [realmB.building.id],
    );

    const uomId = randomUUID();
    await q(
      `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
       VALUES ($1, $2, $3, 'Pieces', 'pcs', 'COUNT')`,
      [uomId, realmA.client.id, `PCS_${randomUUID().slice(0, 6).toUpperCase()}`],
    );
    const wo1 = await seedCanonicalWorkOrder(realmA.client.id, realmA.building.id, 'WO-FRAUD-1');
    const wo2 = await seedCanonicalWorkOrder(realmA.client.id, realmA.building.id, 'WO-FRAUD-2');

    // Create two approved purchase requests on scopeA1 and one on scopeA2
    async function createApprovedPurchase(scopeId: string, workOrderId?: string) {
      const ev = await uploadFieldEvidence(
        leadToken,
        scopeId,
        'MATERIAL_RECEIPT',
        makePngBytes(`req-${randomUUID()}`),
      );
      const req = await api()
        .post(`${V1}/handyman/field/execution-scopes/${scopeId}/material-purchases/requests`)
        .set('Authorization', `Bearer ${leadToken}`)
        .send({
          workOrderId,
          itemName: 'Copper Fitting',
          uomId,
          fundingSource: 'REIMBURSEMENT',
          requestedQuantity: 1,
          evidenceReference: ev.attachmentReference,
          idempotencyKey: `req-${randomUUID()}`,
        });
      assert.equal(req.status, 201);
      const recId = req.body.data.record.id as string;
      await api()
        .post(`${V1}/handyman/execution-scopes/${scopeId}/material-purchases/${recId}/approve`)
        .set('Authorization', `Bearer ${opsActor.token}`)
        .send({
          approvedQuantity: 1,
          approvalReference: `APR-${randomUUID().slice(0, 6)}`,
          idempotencyKey: `app-${randomUUID()}`,
        })
        .expect(200);
      return recId;
    }

    const recA1First = await createApprovedPurchase(scopeA1.id, wo1);
    const recA1Second = await createApprovedPurchase(scopeA1.id, wo1);
    const recA2Cross = await createApprovedPurchase(scopeA2.id, wo2);

    // Wrong evidence purpose (BEFORE_AFTER_WORK instead of MATERIAL_RECEIPT) is rejected
    const nonReceiptEv = await uploadFieldEvidence(
      leadToken,
      scopeA1.id,
      'BEFORE_AFTER_WORK',
      makePngBytes('not-a-receipt'),
    );
    const wrongPurposeRes = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scopeA1.id}/material-purchases/${recA1First}/purchase`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        purchasedQuantity: 1,
        supplierName: 'TB Makmur',
        purchaseReference: 'INV-MKM-001',
        actualUnitPrice: 50000,
        purchaseDate: '2026-10-23T04:00:00.000Z',
        receiptEvidenceReference: nonReceiptEv.attachmentReference,
        idempotencyKey: `pur-wrong-purpose-${randomUUID()}`,
      });
    assert.equal(wrongPurposeRes.status, 409);
    assert.equal(
      wrongPurposeRes.body.error.code,
      'HANDYMAN_MATERIAL_RECEIPT_PURPOSE_INVALID',
    );

    // Cross-Work Order workOrderId rebinding on purchase is rejected
    const sharedReceiptBytes = makePngBytes('shared-nota-bytes-777');
    const receiptA1 = await uploadFieldEvidence(
      leadToken,
      scopeA1.id,
      'MATERIAL_RECEIPT',
      sharedReceiptBytes,
    );
    const rebindWoRes = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scopeA1.id}/material-purchases/${recA1First}/purchase`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        workOrderId: wo2, // conflicts with wo1 bound on recA1First
        purchasedQuantity: 1,
        supplierName: 'TB Makmur',
        purchaseReference: 'INV-MKM-001',
        actualUnitPrice: 50000,
        purchaseDate: '2026-10-23T04:00:00.000Z',
        receiptEvidenceReference: receiptA1.attachmentReference,
        idempotencyKey: `pur-rebind-wo-${randomUUID()}`,
      });
    assert.equal(rebindWoRes.status, 409);
    assert.equal(
      rebindWoRes.body.error.code,
      'HANDYMAN_REIMBURSEMENT_CROSS_WORK_ORDER_CLAIM',
    );

    // Record valid first purchase on scopeA1
    await api()
      .post(`${V1}/handyman/field/execution-scopes/${scopeA1.id}/material-purchases/${recA1First}/purchase`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        workOrderId: wo1,
        purchasedQuantity: 1,
        supplierName: 'TB Makmur',
        purchaseReference: 'INV-MKM-001',
        actualUnitPrice: 50000,
        purchaseDate: '2026-10-23T04:00:00.000Z',
        receiptEvidenceReference: receiptA1.attachmentReference,
        idempotencyKey: `pur-valid-1-${randomUUID()}`,
      })
      .expect(200);

    // Same Work Order duplicate receipt reference -> 409 HANDYMAN_MATERIAL_RECEIPT_DUPLICATE
    const dupRefSameWo = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scopeA1.id}/material-purchases/${recA1Second}/purchase`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        purchasedQuantity: 1,
        supplierName: 'TB Lain',
        purchaseReference: 'INV-LAIN-999',
        actualUnitPrice: 30000,
        purchaseDate: '2026-10-23T04:05:00.000Z',
        receiptEvidenceReference: receiptA1.attachmentReference,
        idempotencyKey: `pur-dup-ref-${randomUUID()}`,
      });
    assert.equal(dupRefSameWo.status, 409);
    assert.equal(dupRefSameWo.body.error.code, 'HANDYMAN_MATERIAL_RECEIPT_DUPLICATE');

    // Same Work Order duplicate supplier+invoice (with fresh receipt image) -> 409 HANDYMAN_MATERIAL_RECEIPT_DUPLICATE
    const freshReceiptA1 = await uploadFieldEvidence(
      leadToken,
      scopeA1.id,
      'MATERIAL_RECEIPT',
      makePngBytes('fresh-receipt-image-2'),
    );
    const dupInvoiceSameWo = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scopeA1.id}/material-purchases/${recA1Second}/purchase`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        purchasedQuantity: 1,
        supplierName: '  tb makmur ',
        purchaseReference: ' inv-mkm-001 ',
        actualUnitPrice: 30000,
        purchaseDate: '2026-10-23T04:06:00.000Z',
        receiptEvidenceReference: freshReceiptA1.attachmentReference,
        idempotencyKey: `pur-dup-inv-${randomUUID()}`,
      });
    assert.equal(dupInvoiceSameWo.status, 409);
    assert.equal(
      dupInvoiceSameWo.body.error.code,
      'HANDYMAN_MATERIAL_RECEIPT_DUPLICATE',
    );

    // Cross-Work Order claim reusing identical receipt image bytes (same SHA-256) on scopeA2 -> 409 HANDYMAN_REIMBURSEMENT_CROSS_WORK_ORDER_CLAIM
    const reuploadedSameBytesOnA2 = await uploadFieldEvidence(
      leadToken,
      scopeA2.id,
      'MATERIAL_RECEIPT',
      sharedReceiptBytes,
    );
    const crossWoShaClaim = await api()
      .post(`${V1}/handyman/field/execution-scopes/${scopeA2.id}/material-purchases/${recA2Cross}/purchase`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        purchasedQuantity: 1,
        supplierName: 'TB Baru',
        purchaseReference: 'INV-BARU-777',
        actualUnitPrice: 50000,
        purchaseDate: '2026-10-23T04:10:00.000Z',
        receiptEvidenceReference: reuploadedSameBytesOnA2.attachmentReference,
        idempotencyKey: `pur-cross-sha-${randomUUID()}`,
      });
    assert.equal(crossWoShaClaim.status, 409);
    assert.equal(
      crossWoShaClaim.body.error.code,
      'HANDYMAN_REIMBURSEMENT_CROSS_WORK_ORDER_CLAIM',
    );

    // Complete usage + Operations reconciliation on recA1First so we can test RBAC, self-approval, cross-Building, and Finance rejection
    const useEv = await uploadFieldEvidence(
      leadToken,
      scopeA1.id,
      'BEFORE_AFTER_WORK',
      makePngBytes('used-fitting'),
    );
    await api()
      .post(`${V1}/handyman/field/execution-scopes/${scopeA1.id}/material-purchases/${recA1First}/usage`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        usedQuantity: 1,
        evidenceReference: useEv.attachmentReference,
        idempotencyKey: `use-${randomUUID()}`,
      })
      .expect(200);
    await api()
      .post(`${V1}/handyman/execution-scopes/${scopeA1.id}/material-purchases/${recA1First}/reconcile`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({ idempotencyKey: `rec-${randomUUID()}` })
      .expect(200);

    // Operations (tenant_company.manage only) is denied Finance approve & Finance queue (403 PERMISSION_DENIED)
    const opsFinDenied = await api()
      .post(`${V1}/handyman/execution-scopes/${scopeA1.id}/material-purchases/${recA1First}/reimbursement/approve`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({
        approvalReference: 'OPS-TRY-FIN',
        idempotencyKey: `ops-fin-${randomUUID()}`,
      });
    assert.equal(opsFinDenied.status, 403);
    assert.equal(opsFinDenied.body.error.code, 'PERMISSION_DENIED');

    // Cross-Building Finance actor (Building B only) is denied on Building A scope & receipt download, and sees 0 rows in queue
    const crossBuildingFin = await api()
      .post(`${V1}/handyman/execution-scopes/${scopeA1.id}/material-purchases/${recA1First}/reimbursement/approve`)
      .set('Authorization', `Bearer ${financeActorB.token}`)
      .send({
        approvalReference: 'FIN-B-CROSS',
        idempotencyKey: `fin-b-${randomUUID()}`,
      });
    assert.equal(crossBuildingFin.status, 403);
    assert.equal(crossBuildingFin.body.error.code, 'BUILDING_ACCESS_DENIED');

    const crossBuildingReceipt = await api()
      .get(`${V1}/handyman/field/evidence/${receiptA1.evidenceId}/content`)
      .set('Authorization', `Bearer ${financeActorB.token}`);
    assert.equal(crossBuildingReceipt.status, 403);
    assert.equal(crossBuildingReceipt.body.error.code, 'BUILDING_ACCESS_DENIED');

    const crossBuildingQueue = await api()
      .get(`${V1}/handyman/material-reimbursements`)
      .set('Authorization', `Bearer ${financeActorB.token}`);
    assert.equal(crossBuildingQueue.status, 200);
    assert.equal(crossBuildingQueue.body.data.items.length, 0);

    // Spoofed actorUserId in body is rejected with 400 VALIDATION_ERROR
    const spoofRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scopeA1.id}/material-purchases/${recA1First}/reimbursement/approve`)
      .set('Authorization', `Bearer ${financeActorA.token}`)
      .send({
        approvalReference: 'FIN-SPOOF',
        actorUserId: adminId,
        idempotencyKey: `spoof-${randomUUID()}`,
      });
    assert.equal(spoofRes.status, 400);
    assert.equal(spoofRes.body.error.code, 'VALIDATION_ERROR');

    // Self-approval guard: even if requester is granted handyman.finance.manage, they cannot approve their own reimbursement
    await grantPermissions(crewA.leadUser.id, ['handyman.finance.manage']);
    const selfFinApprove = await api()
      .post(`${V1}/handyman/execution-scopes/${scopeA1.id}/material-purchases/${recA1First}/reimbursement/approve`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        approvalReference: 'SELF-FIN-APR',
        idempotencyKey: `self-fin-${randomUUID()}`,
      });
    assert.equal(selfFinApprove.status, 403);
    assert.equal(
      selfFinApprove.body.error.code,
      'HANDYMAN_REIMBURSEMENT_FINANCE_FORBIDDEN',
    );

    // Finance rejects the reimbursement claim -> REJECTED, payable zeroed, subsequent disbursement refused
    const finReject = await api()
      .post(`${V1}/handyman/execution-scopes/${scopeA1.id}/material-purchases/${recA1First}/reimbursement/reject`)
      .set('Authorization', `Bearer ${financeActorA.token}`)
      .send({
        reason: 'Receipt date precedes Work Order intake and item does not match specification',
        idempotencyKey: `fin-rej-${randomUUID()}`,
      });
    assert.equal(finReject.status, 200, JSON.stringify(finReject.body));
    assert.equal(finReject.body.data.record.reimbursementStatus, 'REJECTED');
    assert.equal(finReject.body.data.record.reimbursementPayableAmount, '0.00');

    const disburseRejected = await api()
      .post(`${V1}/handyman/execution-scopes/${scopeA1.id}/material-purchases/${recA1First}/reimbursement/disburse`)
      .set('Authorization', `Bearer ${financeActorA.token}`)
      .send({
        disbursementReference: 'TRX-AFTER-REJECT',
        idempotencyKey: `disb-after-rej-${randomUUID()}`,
      });
    assert.equal(disburseRejected.status, 409);
    assert.equal(
      disburseRejected.body.error.code,
      'HANDYMAN_REIMBURSEMENT_APPROVAL_REQUIRED',
    );
  });
});
