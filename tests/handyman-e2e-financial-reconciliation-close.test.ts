import { prepareHandymanTaxProfile, reconcileHandymanPayment, recordHandymanFiscalDocument, readHandymanTaxReconciliation } from '../src/modules/handyman-customer-transactions/handyman-financial-tax.service';
import { jakartaDate } from '../src/modules/handyman-pricing-contract/handyman-indonesia-tax';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import {
  createEvidenceStorage,
  evidenceStorageKey,
} from '../src/modules/evidence/storage';
import { issueHandymanBast, prepareHandymanBast } from '../src/modules/handyman-bast';
import {
  activateHandymanCommercialAgreementVersion,
  prepareHandymanCommercialAgreement,
} from '../src/modules/handyman-commercial-agreements';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  bindHandymanQcEvidence,
  configureHandymanQcChecklist,
  finishHandymanQcRun,
  openHandymanQcRun,
  publishHandymanQcChecklistVersion,
  setHandymanQcRunItemOutcome,
} from '../src/modules/handyman-evidence-qc';
import { CANONICAL_ROLE_DEFINITIONS } from '../src/modules/iam-bootstrap';
import {
  approveHandymanMaterialExecutionLine,
  estimateHandymanMaterialExecutionLine,
  issueHandymanMaterialExecutionLine,
  settleHandymanMaterialExecutionLine,
  useHandymanMaterialExecutionLine,
} from '../src/modules/handyman-material-execution';
import { prepareHandymanMaterialPricingBasis } from '../src/modules/handyman-material-pricing';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { workforceService } from '../src/modules/workforce';
import { assignSupervisor } from '../src/modules/workforce-reporting-lines';
import { credentialService } from '../src/modules/auth';
import { createAdminUser } from './helpers/access';
import {
  crewFixture,
  initHandymanFixtures,
  locationChain,
  realmFixture,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { handymanCustomerConsentInput } from './helpers/handyman-customer-consent';
import {
  createChannelAttribution,
} from '../src/modules/handyman-channel-attributions';
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

/**
 * CR-HM-E2E-FINANCIAL-RECONCILIATION — Focused End-to-End Integration Tests
 * covering all 12 mandatory scenarios across:
 *   1. Quotation DP terms -> DP upload -> Finance verify -> WO stays OPEN
 *   2. DP rejected -> WO stays OPEN
 *   3. DP partial -> balance and status accurate
 *   4. Execution -> variation/material -> QC -> BAST
 *   5. BAST rejected -> rework -> re-QC -> BAST accepted
 *   6. Final invoice deducts allocated DP accurately
 *   7. Final payment proof uploaded but unverified -> CLOSE rejected
 *   8. Final payment verified, invoice PAID, all gates PASS -> Manager CLOSE succeeds
 *   9. Customer Care / Dispatcher / Lead / Finance Verifier attempts CLOSE -> 403
 *  10. Duplicate payment report / verification / retry -> no double posting
 *  11. Cross-tenant / cross-building access -> rejected
 *  12. Overpayment or forward-only correction -> no false balance
 */

const DIR = '/tmp/hm-e2e-fin-reconcil-close-pg';
const PORT = 55549;
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
const key = () => `e2e-rc-${randomUUID()}`;
const fiscalFacts = {priceBasis:'GROSS_INCLUSIVE',providerStatus:'PKP',vatRegime:'PMK131_ART3',recipientKind:'DOMESTIC_BODY',incomeRecipientReference:'TEST Handyman taxpayer',payerReference:'TEST customer non-withholding taxpayer',serviceClass:'ORDINARY_SERVICE',payerIsWithholder:false,incomeTax:'NONE',hasNpwp:true,qualification:'NOT_APPLICABLE',withholdingBasis:'ALL_SERVICE_NET',effectiveFrom:'2025-01-01',effectiveTo:'2027-12-31',sourceReference:'TEST reviewed PKP inclusive-price facts',classificationReference:'TEST reviewed ordinary non-special maintenance'};

const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

function rolePermissions(code: string): readonly string[] {
  const found = CANONICAL_ROLE_DEFINITIONS.find((r) => r.code === code);
  if (!found) throw new Error(`Unknown canonical role: ${code}`);
  return found.permissions;
}

async function grant(userId: string, permissionCodes: string[]) {
  const role = await roleService.createRole({
    code: `E2E_RC_${randomUUID().slice(0, 8).toUpperCase()}`,
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

async function createPersonaSession(
  permissionCodes: readonly string[],
  buildingId: string,
  displayName = 'Persona User',
): Promise<{ userId: string; email: string; token: string }> {
  const sfx = randomUUID().slice(0, 8).toLowerCase();
  const password = `Pass_${sfx}_123!`;
  const user = await userService.createUser({
    email: `actor-${sfx}@example.com`,
    displayName,
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  if (permissionCodes.length > 0) {
    await grant(user.id, [...permissionCodes]);
  }
  await buildingAssignmentService.createAssignment(user.id, {
    buildingId,
  });
  const loginRes = await api()
    .post(`${V1}/auth/login`)
    .send({ email: user.email, password });
  assert.equal(loginRes.status, 200, JSON.stringify(loginRes.body));
  return {
    userId: user.id,
    email: user.email,
    token: loginRes.body.data.sessionToken as string,
  };
}

async function seedFieldEvidence(params: {
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  handymanRequestId: string;
  executionScopeId: string;
  uploadedByUserId: string;
  uploadedByRole?: string;
  purpose: string;
  tag: string;
}): Promise<string> {
  const uploadId = id();
  const storageKey = evidenceStorageKey(uploadId);
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`ev-${params.tag}-${uploadId}`),
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
     VALUES ($1,$2,$3,$4,$5,$6,$7,'VERIFIED','evidence.png','image/png',
       $8,$9,$9,$10,$11,$12,$13,$14,NOW())`,
    [
      uploadId,
      params.clientId,
      params.tenantCompanyId,
      params.buildingId,
      params.handymanRequestId,
      params.executionScopeId,
      params.purpose,
      storageKey,
      bytes.byteLength,
      createHash('sha256').update(bytes).digest('hex'),
      reference,
      params.uploadedByUserId,
      params.uploadedByRole ?? 'PIC_PEKERJAAN',
      key(),
    ],
  );
  return reference;
}

async function createDiagnosedRequestFixture(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  chain: Awaited<ReturnType<typeof locationChain>>,
) {
  const sfx = randomUUID().slice(0, 8).toUpperCase();
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: realm.client.id,
      tenantCode: `TNT_${sfx}`,
      tenantName: 'Tenant Company',
    },
    adminId,
  );
  const tenantPicSession = await createPersonaSession(
    ['tenant_company.read', 'tenant_company.manage'],
    realm.building.id,
    'Authorized Tenant PIC',
  );
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Authorized Tenant PIC',
      email: `pic-${sfx.toLowerCase()}@tenant.example.com`,
      userId: tenantPicSession.userId,
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
    {
      tenantCompanyId: company.id,
      buildingId: realm.building.id,
    },
    adminId,
  );
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
    tenantPicId: pic.id,
    spaceId: chain.space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: tenantPicSession.userId,
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
  const request = await handymanServiceRequestService.createHandymanServiceRequest(
    {
      channelAttributionId: attribution.id,
      serviceCatalogId: service.id,
    },
    adminId,
  );
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: request.id,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Direct to diagnosis.',
    },
    adminId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: request.id,
      disciplineId,
      diagnosis: 'AC compressor and valve replacement required.',
    },
    adminId,
  );
  const uomId = randomUUID();
  await q(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uomId, realm.client.id, `U_${sfx}`, 'Unit', 'u', 'COUNT'],
  );
  return {
    company,
    pic,
    tenantPicSession,
    request,
    uomId,
  };
}

describe('CR-HM-E2E-FINANCIAL-RECONCILIATION — Backend E2E Scenarios 1..12', () => {
  before(async () => {
    storageDir = mkdtempSync(join(tmpdir(), 'hm-e2e-rc-evidence-'));
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
    await grant(adminId, ['handyman.qc.configure', 'handyman.bast.manage']);

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
      if (storageDir) rmSync(storageDir, { recursive: true, force: true });
      delete process.env.EVIDENCE_STORAGE_DIR;
      resetAppConfigCache();
    }
  });

  it('Scenarios 1..10: Quotation DP -> Care upload -> Finance verify/reject -> Execution/Material/Variation -> Re-QC/BAST -> Final Invoice -> Manager FINAL CLOSE & RBAC', async () => {
    const realm = await realmFixture('ReconcilMain');
    const chain = await locationChain(realm);
    const f = await createDiagnosedRequestFixture(realm, chain);
    await q(
      `INSERT INTO client_allowed_transaction_currencies (client_id, currency_code)
       VALUES ($1, 'IDR')
       ON CONFLICT DO NOTHING`,
      [realm.client.id],
    );

    // Canonical persona actors assigned to realm.building.id
    const opsActor = await createPersonaSession(
      rolePermissions('OPERATIONS'),
      realm.building.id,
      'Operations Actor',
    );

    const careActor = await createPersonaSession(
      rolePermissions('CUSTOMER_CARE'),
      realm.building.id,
      'Customer Care Actor',
    );

    const financeVerifier = await createPersonaSession(
      [
        'tenant_company.read',
        'tenant_company.manage',
        'tenant_invoice.read',
        'tenant_invoice.manage',
        'handyman.finance.read',
        'handyman.finance.manage',
        'evidence.read',
        'evidence.manage',
      ],
      realm.building.id,
      'Finance Verifier',
    );

    const managerActor = await createPersonaSession(
      rolePermissions('MANAGER'),
      realm.building.id,
      'Handyman Manager',
    );

    // =========================================================================
    // SCENARIO 1: Quotation with DP terms -> Tenant approve -> Care DP upload
    //             -> Finance verify -> WO stays OPEN (AUTHORIZED)
    // =========================================================================
    const createdQuotationRes = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/quotation`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({
        dpRequired: true,
        dpPercentage: 40,
        dpTermsNotes: '40% DP required prior to execution',
      });
    assert.equal(createdQuotationRes.status, 201, JSON.stringify(createdQuotationRes.body));
    const quotationId: string = createdQuotationRes.body.data.quotation.id;
    const version1Id: string = createdQuotationRes.body.data.versions[0].id;
    assert.equal(createdQuotationRes.body.data.versions[0].dpRequired, true);
    assert.equal(createdQuotationRes.body.data.versions[0].dpPercentage, 40);

    // Add LABOR (200.00) and MATERIAL (100.00) lines -> total 300.00
    const laborLineRes = await api()
      .post(`${V1}/handyman/quotation-versions/${version1Id}/lines`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({
        lineType: 'LABOR',
        description: 'Lead technician labor',
        quantity: 2,
        uomId: f.uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 100,
      });
    assert.equal(laborLineRes.status, 201, JSON.stringify(laborLineRes.body));
    const laborQuotationLineId: string = laborLineRes.body.data.id;

    const materialLineRes = await api()
      .post(`${V1}/handyman/quotation-versions/${version1Id}/lines`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({
        lineType: 'MATERIAL',
        description: 'Replacement valve kit',
        quantity: 2,
        uomId: f.uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 50,
      });
    assert.equal(materialLineRes.status, 201, JSON.stringify(materialLineRes.body));
    const materialQuotationLineId: string = materialLineRes.body.data.id;

    await prepareHandymanTaxProfile({quotationVersionId:version1Id},fiscalFacts,financeVerifier.userId);

    // Issue quotation -> dpAmount auto-calculated as 40% of 300.00 = 120.00
    const issuedRes = await api()
      .post(`${V1}/handyman/quotation-versions/${version1Id}/issue`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({
        validUntil: '2027-12-31T00:00:00.000Z',
      });
    assert.equal(issuedRes.status, 200, JSON.stringify(issuedRes.body));
    assert.equal(issuedRes.body.data.status, 'ISSUED');
    assert.equal(issuedRes.body.data.dpRequired, true);
    assert.equal(issuedRes.body.data.dpPercentage, 40);
    assert.equal(issuedRes.body.data.dpAmount, 120);

    // Authorized Tenant PIC approves quotation -> creates AUTHORIZED Execution Scope
    const approveRes = await api()
      .post(`${V1}/handyman/quotation-versions/${version1Id}/decision`)
      .set('Authorization', `Bearer ${f.tenantPicSession.token}`)
      .set('Idempotency-Key', key())
      .send({
        decision: 'APPROVE',
      });
    assert.equal(approveRes.status, 201, JSON.stringify(approveRes.body));
    const executionScopeId: string = approveRes.body.data.executionScope.id;
    assert.equal(approveRes.body.data.executionScope.status, 'AUTHORIZED');

    // Open customer transaction for the Execution Scope
    const openTxRes = await api()
      .post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-transaction`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: key() });
    assert.equal(openTxRes.status, 200, JSON.stringify(openTxRes.body));

    // =========================================================================
    // SCENARIO 2: Rejected DP -> WO stays OPEN and rejected DP excluded
    // =========================================================================
    const rejectedDpReportRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${f.request.id}/payments`,
      )
      .set('Authorization', `Bearer ${careActor.token}`)
      .send({
        amount: '120.00',
        channel: 'BANK_TRANSFER',
        obligationStage: 'DP',
        providerName: 'BCA',
        providerReference: 'BCA-INVALID-001',
        externalReference: `EXT-DP-REJECT-${randomUUID()}`,
        idempotencyKey: key(),
      });
    assert.equal(rejectedDpReportRes.status, 201, JSON.stringify(rejectedDpReportRes.body));
    const rejectedDpPaymentId: string = rejectedDpReportRes.body.data.payment.id;
    assert.equal(rejectedDpReportRes.body.data.payment.status, 'PENDING');
    assert.equal(rejectedDpReportRes.body.data.payment.obligationStage, 'DP');

    // Care uploads proof for the DP payment (before any final invoice exists)
    const rejectedDpProofRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${f.request.id}/payments/${rejectedDpPaymentId}/proof`,
      )
      .set('Authorization', `Bearer ${careActor.token}`)
      .send({
        note: 'Uploaded wrong transfer slip',
        idempotencyKey: key(),
        file: {
          fileName: 'wrong-dp-slip.png',
          mimeType: 'image/png',
          contentBase64: Buffer.from('wrong-dp-proof-bytes').toString('base64'),
        },
      });
    assert.equal(rejectedDpProofRes.status, 201, JSON.stringify(rejectedDpProofRes.body));

    // Finance rejects the DP payment
    const rejectDpRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${rejectedDpPaymentId}/reject`,
      )
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({
        reason: 'Funds did not enter destination account',
        idempotencyKey: key(),
      });
    assert.equal(rejectDpRes.status, 200, JSON.stringify(rejectDpRes.body));
    assert.equal(rejectDpRes.body.data.payment.status, 'REJECTED');

    // Verify WO stays AUTHORIZED (OPEN) and verified DP is still 0.00
    const scopeAfterRejectedDp = await q(
      `SELECT status FROM handyman_execution_scopes WHERE id = $1`,
      [executionScopeId],
    );
    assert.equal(scopeAfterRejectedDp.rows[0].status, 'AUTHORIZED');

    // =========================================================================
    // SCENARIO 3: Partial DP -> balance and DP satisfaction status accurate
    // =========================================================================
    const partialDpExtRef = `EXT-DP-PARTIAL-${randomUUID()}`;
    const partialDpIdemKey = key();
    const partialDpReportRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${f.request.id}/payments`,
      )
      .set('Authorization', `Bearer ${careActor.token}`)
      .send({
        amount: '50.00',
        channel: 'BANK_TRANSFER',
        obligationStage: 'DP',
        providerName: 'BCA',
        providerReference: 'BCA-DP-PART-01',
        externalReference: partialDpExtRef,
        idempotencyKey: partialDpIdemKey,
      });
    assert.equal(partialDpReportRes.status, 201, JSON.stringify(partialDpReportRes.body));
    const partialDpPaymentId: string = partialDpReportRes.body.data.payment.id;
    assert.equal(partialDpReportRes.body.data.payment.status, 'PENDING');
    assert.equal(partialDpReportRes.body.data.payment.obligationStage, 'DP');

    // =========================================================================
    // SCENARIO 10: Duplicate payment report / verification / retry -> no double posting
    // =========================================================================
    const replayDpReportRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${f.request.id}/payments`,
      )
      .set('Authorization', `Bearer ${careActor.token}`)
      .send({
        amount: '50.00',
        channel: 'BANK_TRANSFER',
        obligationStage: 'DP',
        providerName: 'BCA',
        providerReference: 'BCA-DP-PART-01',
        externalReference: partialDpExtRef,
        idempotencyKey: partialDpIdemKey,
      });
    assert.equal(replayDpReportRes.status, 200);
    assert.equal(replayDpReportRes.body.data.replayed, true);
    assert.equal(replayDpReportRes.body.data.payment.id, partialDpPaymentId);

    // Different idempotencyKey with same externalReference -> 409 conflict
    const dupExtRefRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${f.request.id}/payments`,
      )
      .set('Authorization', `Bearer ${careActor.token}`)
      .send({
        amount: '50.00',
        channel: 'BANK_TRANSFER',
        obligationStage: 'DP',
        providerName: 'BCA',
        providerReference: 'BCA-DP-PART-01',
        externalReference: partialDpExtRef,
        idempotencyKey: key(),
      });
    assert.equal(dupExtRefRes.status, 409);
    assert.equal(
      dupExtRefRes.body.error.code,
      'HANDYMAN_CUSTOMER_PAYMENT_CONFLICT',
    );

    // Upload proof for partial DP via Care endpoint
    const partialDpProofRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${f.request.id}/payments/${partialDpPaymentId}/proof`,
      )
      .set('Authorization', `Bearer ${careActor.token}`)
      .send({
        note: 'Partial DP transfer slip 50.00',
        idempotencyKey: key(),
        file: {
          fileName: 'dp-part-1.png',
          mimeType: 'image/png',
          contentBase64: Buffer.from('dp-part-1-proof').toString('base64'),
        },
      });
    assert.equal(partialDpProofRes.status, 201);

    // Finance confirms partial DP (and replay-checks confirmation)
    const confirmPartialDpKey = key();
    const confirmPartialDpRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${partialDpPaymentId}/confirm`,
      )
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: confirmPartialDpKey });
    assert.equal(confirmPartialDpRes.status, 200);
    assert.equal(confirmPartialDpRes.body.data.payment.status, 'CONFIRMED');

    const replayConfirmPartialDpRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${partialDpPaymentId}/confirm`,
      )
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: confirmPartialDpKey });
    assert.equal(replayConfirmPartialDpRes.status, 200);
    assert.equal(replayConfirmPartialDpRes.body.data.replayed, true);

    // Check reconciliation after partial DP (50.00 of required 120.00)
    const reconcilAfterPartialDp = await api()
      .get(`${V1}/handyman/execution-scopes/${executionScopeId}/invoice-reconciliation`)
      .set('Authorization', `Bearer ${financeVerifier.token}`);
    assert.equal(reconcilAfterPartialDp.status, 200, JSON.stringify(reconcilAfterPartialDp.body));
    assert.equal(reconcilAfterPartialDp.body.data.quotationDpTerms.dpAmount, '120.00');
    assert.equal(
      reconcilAfterPartialDp.body.data.ledgerSummary.dpVerifiedAmount,
      '50.00',
    );
    assert.equal(
      reconcilAfterPartialDp.body.data.ledgerSummary.dpRemainingRequiredAmount,
      '70.00',
    );
    assert.equal(
      reconcilAfterPartialDp.body.data.ledgerSummary.derivedPaymentStatus,
      'DP_PARTIAL',
    );

    // Second DP installment (70.00) to complete the 120.00 DP
    const remDpReportRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${f.request.id}/payments`,
      )
      .set('Authorization', `Bearer ${careActor.token}`)
      .send({
        amount: '70.00',
        channel: 'BANK_TRANSFER',
        obligationStage: 'DP',
        providerName: 'BCA',
        providerReference: 'BCA-DP-PART-02',
        externalReference: `EXT-DP-REM-${randomUUID()}`,
        idempotencyKey: key(),
      });
    assert.equal(remDpReportRes.status, 201);
    const remDpPaymentId: string = remDpReportRes.body.data.payment.id;

    const remDpProofRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${remDpPaymentId}/payment-proof`,
      )
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({
        note: 'Remaining DP transfer slip 70.00',
        idempotencyKey: key(),
        file: {
          fileName: 'dp-part-2.png',
          mimeType: 'image/png',
          contentBase64: Buffer.from('dp-part-2-proof').toString('base64'),
        },
      });
    assert.equal(remDpProofRes.status, 201, JSON.stringify(remDpProofRes.body));

    const confirmRemDpRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${remDpPaymentId}/confirm`,
      )
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: key() });
    assert.equal(confirmRemDpRes.status, 200);

    // Verify DP is now SATISFIED (120.00 verified) AND Execution Scope is still AUTHORIZED (OPEN)
    const reconcilAfterFullDp = await api()
      .get(`${V1}/handyman/execution-scopes/${executionScopeId}/invoice-reconciliation`)
      .set('Authorization', `Bearer ${financeVerifier.token}`);
    assert.equal(reconcilAfterFullDp.status, 200);
    assert.equal(
      reconcilAfterFullDp.body.data.ledgerSummary.dpVerifiedAmount,
      '120.00',
    );
    assert.equal(
      reconcilAfterFullDp.body.data.ledgerSummary.dpRemainingRequiredAmount,
      '0.00',
    );
    assert.equal(
      reconcilAfterFullDp.body.data.ledgerSummary.derivedPaymentStatus,
      'DP_PAID',
    );
    assert.equal(reconcilAfterFullDp.body.data.scopeStatus, 'AUTHORIZED');

    // PART03: real pre-delivery receipts, not Care reporting timestamps, own
    // advance VAT timing. Cumulative tax documents never deduct the DP twice.
    let precedingFiscalDocumentId:string|undefined;
    for(const [paymentId,amount] of [[partialDpPaymentId,'50.00'],[remDpPaymentId,'70.00']] as const){
      const verified=(await q('SELECT decided_at FROM handyman_customer_payments WHERE id=$1',[paymentId])).rows[0].decided_at as Date;
      const actual=new Date(verified.getTime()-1000).toISOString();
      await reconcileHandymanPayment(executionScopeId,paymentId,{bankReference:`TEST-BANK-${paymentId}`,actualReceivedAt:actual,idempotencyKey:key()},financeVerifier.userId);
      const fiscal=await recordHandymanFiscalDocument(executionScopeId,{kind:'ADVANCE',paymentId,grossLabor:amount,taxPointAt:actual,documentDate:jakartaDate(new Date(actual)),externalReference:`TEST-DJP-${paymentId}`,previousDocumentId:precedingFiscalDocumentId,idempotencyKey:key()},financeVerifier.userId);
      precedingFiscalDocumentId=fiscal.id;
    }

    // Manager attempting FINAL CLOSE when only DP is verified must be rejected
    const prematureCloseRes = await api()
      .post(`${V1}/handyman/execution-scopes/${executionScopeId}/final-close`)
      .set('Authorization', `Bearer ${managerActor.token}`)
      .send({
        reason: 'Premature close attempt with only DP paid',
        idempotencyKey: key(),
      });
    assert.equal(prematureCloseRes.status, 409);
    assert.equal(prematureCloseRes.body.error.code, 'HANDYMAN_FINAL_CLOSE_GATE_FAILED');

    // =========================================================================
    // SCENARIO 4: Execution -> crew assignment, work session, material settlement,
    //             chargeable variation (ADD), evidence -> Supervisor QC -> BAST
    // =========================================================================
    const crew = await crewFixture(realm);
    const assignment = await assignHandymanExecutionScopeCrew(
      {
        executionScopeId,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      },
      adminId,
    );

    // Create session for the assigned Freelance Lead Worker (crew.leadUser)
    const leadSession = await createPersonaSession(
      rolePermissions('MOBILE_STAFF'),
      realm.building.id,
      'Freelance Lead Worker',
    );
    await q(`UPDATE workforce_profiles SET user_id = $1 WHERE id = $2`, [
      leadSession.userId,
      crew.workerContext.workforceProfileId,
    ]);

    // Create Supervisor in reporting line over the Crew Lead
    const supervisorSession = await createPersonaSession(
      [
        'tenant_company.read',
        'tenant_company.manage',
        'handyman.qc.manage',
        'handyman.bast.manage',
      ],
      realm.building.id,
      'Assigned Supervisor',
    );
    const supProfile = await workforceService.createWorkforceProfile({
      organizationId: realm.organization.id,
      departmentId: realm.department.id,
      positionId: realm.position.id,
      employeeCode: `SUP_${randomUUID().slice(0, 8).toUpperCase()}`,
      fullName: 'Assigned Supervisor',
      userId: supervisorSession.userId,
    });
    await assignSupervisor({
      workforceProfileId: crew.workerContext.workforceProfileId,
      supervisorWorkforceProfileId: supProfile.id,
    });

    // 4a. Material execution lifecycle -> FINAL_CHARGE_READY (used 2 of 2)
    const matEst = await estimateHandymanMaterialExecutionLine(
      {
        executionScopeId,
        quotationVersionId: version1Id,
        quotationLineId: materialQuotationLineId,
        estimatedQty: 2,
        supplierReference: 'SUP-VALVE-001',
        idempotencyKey: key(),
      },
      leadSession.userId,
    );
    await approveHandymanMaterialExecutionLine(
      { executionScopeId, lineId: matEst.line.id, idempotencyKey: key() },
      leadSession.userId,
    );
    await issueHandymanMaterialExecutionLine(
      {
        executionScopeId,
        lineId: matEst.line.id,
        quantity: 2,
        supplierReference: 'SUP-VALVE-001',
        idempotencyKey: key(),
      },
      leadSession.userId,
    );
    await useHandymanMaterialExecutionLine(
      {
        executionScopeId,
        lineId: matEst.line.id,
        quantity: 2,
        idempotencyKey: key(),
      },
      leadSession.userId,
    );
    await settleHandymanMaterialExecutionLine(
      { executionScopeId, lineId: matEst.line.id, idempotencyKey: key() },
      leadSession.userId,
    );

    // 4b. Propose & authorize chargeable Scope Variation (ADD: +80.00 LABOR)
    // Create revised quotation version 2 on the same quotation thread containing original lines (300.00) + new ADD line (80.00) = 380.00 (+80.00 delta)
    const revQuoteRes = await api()
      .post(`${V1}/handyman/quotations/${quotationId}/versions`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({});
    assert.equal(revQuoteRes.status, 201, JSON.stringify(revQuoteRes.body));
    const version2Id: string = revQuoteRes.body.data.id;

    await api()
      .post(`${V1}/handyman/quotation-versions/${version2Id}/lines`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({
        lineType: 'LABOR',
        description: 'Lead technician labor',
        quantity: 2,
        uomId: f.uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 100,
      });
    await api()
      .post(`${V1}/handyman/quotation-versions/${version2Id}/lines`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({
        lineType: 'MATERIAL',
        description: 'Replacement valve kit',
        quantity: 2,
        uomId: f.uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 50,
      });
    const varLaborLineRes = await api()
      .post(`${V1}/handyman/quotation-versions/${version2Id}/lines`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({
        lineType: 'LABOR',
        description: 'Additional condensate drain pipe clearing',
        quantity: 1,
        uomId: f.uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 80,
      });
    assert.equal(varLaborLineRes.status, 201, JSON.stringify(varLaborLineRes.body));
    const varLaborQuotationLineId: string = varLaborLineRes.body.data.id;

    await prepareHandymanTaxProfile({quotationVersionId:version2Id},fiscalFacts,financeVerifier.userId);

    await api()
      .post(`${V1}/handyman/quotation-versions/${version2Id}/issue`)
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({ validUntil: '2027-12-31T00:00:00.000Z' });

    const evVarProp = await seedFieldEvidence({
      clientId: realm.client.id,
      tenantCompanyId: f.company.id,
      buildingId: realm.building.id,
      handymanRequestId: f.request.id,
      executionScopeId,
      uploadedByUserId: leadSession.userId,
      purpose: 'VARIATION_FINDING',
      tag: 'var-prop',
    });

    const varPropRes = await api()
      .post(`${V1}/handyman/field/execution-scopes/${executionScopeId}/variations/proposals`)
      .set('Authorization', `Bearer ${leadSession.token}`)
      .send({
        variationType: 'ADD',
        lineType: 'LABOR',
        title: 'Additional condensate drain pipe clearing',
        description: 'Clear secondary condensate line behind ceiling panel',
        technicalFinding: 'Secondary line blocked by sediment',
        quantity: 1,
        uomId: f.uomId,
        evidenceReference: evVarProp,
        notes: 'Crew Lead proposes additional drain clearing',
        idempotencyKey: key(),
      });
    assert.equal(varPropRes.status, 201, JSON.stringify(varPropRes.body));
    const variationId: string = varPropRes.body.data.variation.id;
    let varVersion: number = varPropRes.body.data.variation.version;

    // Stage 3: Operations review
    const varOpsRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${executionScopeId}/variations/${variationId}/operations-review`,
      )
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({
        evidenceReference: evVarProp,
        notes: 'Approved for revised quotation',
        expectedVersion: varVersion,
        idempotencyKey: key(),
      });
    assert.equal(varOpsRes.status, 200, JSON.stringify(varOpsRes.body));
    varVersion = varOpsRes.body.data.variation.version;

    // Stage 4: Revised quotation link
    const varRevQuoRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${executionScopeId}/variations/${variationId}/revised-quotation`,
      )
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({
        quotedUnitAmount: 80,
        currency: 'IDR',
        revisedQuotationVersionId: version2Id,
        evidenceReference: evVarProp,
        notes: 'Prepared revised quotation v2',
        expectedVersion: varVersion,
        idempotencyKey: key(),
      });
    assert.equal(varRevQuoRes.status, 200, JSON.stringify(varRevQuoRes.body));
    varVersion = varRevQuoRes.body.data.variation.version;

    // Stage 5: Authorized Tenant PIC approves variation
    const varTenantRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${executionScopeId}/variations/${variationId}/tenant-decision`,
      )
      .set('Authorization', `Bearer ${f.tenantPicSession.token}`)
      .send({
        decision: 'APPROVE',
        revisedQuotationVersionId: version2Id,
        evidenceReference: evVarProp,
        notes: 'Tenant PIC approved additional drain work',
        expectedVersion: varVersion,
        idempotencyKey: key(),
      });
    assert.equal(varTenantRes.status, 200, JSON.stringify(varTenantRes.body));
    varVersion = varTenantRes.body.data.variation.version;

    // Stage 6: Operations authorizes variation into scope
    const varAuthRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${executionScopeId}/variations/${variationId}/authorize-scope`,
      )
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({
        evidenceReference: evVarProp,
        notes: 'Variation authorized for execution',
        expectedVersion: varVersion,
        idempotencyKey: key(),
      });
    assert.equal(varAuthRes.status, 200, JSON.stringify(varAuthRes.body));
    varVersion = varAuthRes.body.data.variation.version;

    // Stage 7: Lead Worker records variation execution + completed work session
    const varExecRes = await api()
      .post(
        `${V1}/handyman/field/execution-scopes/${executionScopeId}/variations/${variationId}/execution`,
      )
      .set('Authorization', `Bearer ${leadSession.token}`)
      .send({
        evidenceReference: evVarProp,
        notes: 'Condensate line cleared and tested',
        expectedVersion: varVersion,
        idempotencyKey: key(),
      });
    assert.equal(varExecRes.status, 200, JSON.stringify(varExecRes.body));
    varVersion = varExecRes.body.data.variation.version;

    await q(
      `INSERT INTO handyman_work_sessions
         (id, client_id, execution_scope_id, assignment_id, lead_worker_id,
          lead_user_id, status, started_work_at, completed_at, checked_out_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'CHECKED_OUT', NOW(), NOW(), NOW())`,
      [
        id(),
        realm.client.id,
        executionScopeId,
        assignment.id,
        crew.workerContext.id,
        leadSession.userId,
      ],
    );

    // 4c. Configure QC checklist & Supervisor executes QC Run #1 (PASSED)
    const qcTemplate = await publishHandymanQcChecklistVersion(
      {
        clientId: realm.client.id,
        code: 'HANDYMAN_FINAL_RC',
        versionNumber: 1,
        requiredItemKeys: ['quality'],
      },
      adminId,
    );
    await configureHandymanQcChecklist(
      { executionScopeId, templateVersionId: qcTemplate.version.id },
      adminId,
    );

    async function runSupervisorQcPass(tag: string): Promise<string> {
      const { run } = await openHandymanQcRun(
        {
          executionScopeId,
          checklistIdentity: 'HANDYMAN_FINAL_RC@v1',
          idempotencyKey: key(),
        },
        supervisorSession.userId,
      );
      await setHandymanQcRunItemOutcome(
        {
          qcRunId: run.id,
          itemKey: 'quality',
          outcome: 'PASS',
          expectedVersion: 1,
          idempotencyKey: key(),
        },
        supervisorSession.userId,
      );
      const qcEvRef = await seedFieldEvidence({
        clientId: realm.client.id,
        tenantCompanyId: f.company.id,
        buildingId: realm.building.id,
        handymanRequestId: f.request.id,
        executionScopeId,
        uploadedByUserId: leadSession.userId,
        purpose: 'QC_EVIDENCE',
        tag,
      });
      await bindHandymanQcEvidence(
        {
          qcRunId: run.id,
          evidenceReference: qcEvRef,
          expectedVersion: 2,
          idempotencyKey: key(),
        },
        supervisorSession.userId,
      );
      const finished = await finishHandymanQcRun(
        {
          qcRunId: run.id,
          outcome: 'PASSED',
          expectedVersion: 3,
          idempotencyKey: key(),
        },
        supervisorSession.userId,
      );
      assert.equal(finished.run.status, 'PASSED');
      return finished.run.id;
    }

    const qcRun1Id = await runSupervisorQcPass('qc-run-1');

    // Prepare & issue BAST #1 bound to qcRun1Id
    const bast1Prepared = await prepareHandymanBast(adminId, {
      executionScopeId,
      idempotencyKey: key(),
    });
    assert.equal(bast1Prepared.bast.qcRunId, qcRun1Id);
    const bast1Issued = await issueHandymanBast(adminId, {
      bastId: bast1Prepared.bast.id,
      idempotencyKey: key(),
    });
    assert.equal(bast1Issued.bast.status, 'ISSUED');

    // =========================================================================
    // SCENARIO 5: BAST rejected -> rework -> re-QC -> BAST accepted
    // =========================================================================
    const rejectBast1Res = await api()
      .post(`${V1}/handyman/bast/${bast1Issued.bast.id}/reject`)
      .set('Authorization', `Bearer ${f.tenantPicSession.token}`)
      .send({
        rejectReason: 'Ceiling panel edge needs wipe-down before final acceptance',
        idempotencyKey: key(),
      });
    assert.equal(rejectBast1Res.status, 200, JSON.stringify(rejectBast1Res.body));
    assert.equal(rejectBast1Res.body.data.bast.status, 'REJECTED');

    // Attempting to re-prepare BAST while latest QC PASS is still qcRun1Id (same as rejected BAST #1) must fail-closed
    await assert.rejects(
      () =>
        prepareHandymanBast(adminId, {
          executionScopeId,
          idempotencyKey: key(),
        }),
      (err: { code?: string }) =>
        err?.code === 'HANDYMAN_BAST_QC_NOT_READY',
    );

    // Rework performed -> Supervisor executes a fresh QC PASS run (qcRun2Id)
    const qcRun2Id = await runSupervisorQcPass('qc-run-2-after-rework');
    assert.notEqual(qcRun2Id, qcRun1Id);

    // Prepare and issue BAST #2 bound to fresh qcRun2Id
    const bast2Prepared = await prepareHandymanBast(adminId, {
      executionScopeId,
      idempotencyKey: key(),
    });
    assert.notEqual(bast2Prepared.bast.id, bast1Issued.bast.id);
    assert.equal(bast2Prepared.bast.qcRunId, qcRun2Id);
    const bast2Issued = await issueHandymanBast(adminId, {
      bastId: bast2Prepared.bast.id,
      idempotencyKey: key(),
    });
    assert.equal(bast2Issued.bast.status, 'ISSUED');

    // Personal Tenant PIC confirms the exact immutable issued BAST manifest.
    const bast2Consent = await handymanCustomerConsentInput(bast2Issued.bast.id, f.tenantPicSession.userId);
    const acceptBast2Res = await api()
      .post(`${V1}/handyman/bast/${bast2Issued.bast.id}/accept`)
      .set('Authorization', `Bearer ${f.tenantPicSession.token}`)
      .send({
        signatureDigest: bast2Consent.signatureDigest,
        idempotencyKey: key(),
      });
    assert.equal(acceptBast2Res.status, 200, JSON.stringify(acceptBast2Res.body));
    assert.equal(acceptBast2Res.body.data.bast.status, 'ACCEPTED');

    // Preserve historical BAST #1 (REJECTED) alongside BAST #2 (ACCEPTED)
    const bastHistoryRows = await q(
      `SELECT id, status, qc_run_id FROM handyman_bast_documents
        WHERE execution_scope_id = $1 ORDER BY created_at ASC`,
      [executionScopeId],
    );
    assert.equal(bastHistoryRows.rows.length, 2);
    assert.equal(bastHistoryRows.rows[0].status, 'REJECTED');
    assert.equal(bastHistoryRows.rows[1].status, 'ACCEPTED');

    // Complete Stages 8 & 9 of variation (QC PASSED + FINAL_CHARGE_ELIGIBILITY bound to qcRun2Id and bast2Issued)
    const varQcRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${executionScopeId}/variations/${variationId}/qc`,
      )
      .set('Authorization', `Bearer ${supervisorSession.token}`)
      .send({
        qcOutcome: 'PASSED',
        qcRunId: qcRun2Id,
        evidenceReference: evVarProp,
        notes: 'Variation verified in QC Run #2',
        expectedVersion: varVersion,
        idempotencyKey: key(),
      });
    assert.equal(varQcRes.status, 200, JSON.stringify(varQcRes.body));
    varVersion = varQcRes.body.data.variation.version;

    const varFceRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${executionScopeId}/variations/${variationId}/final-charge-eligibility`,
      )
      .set('Authorization', `Bearer ${opsActor.token}`)
      .send({
        qcRunId: qcRun2Id,
        bastId: bast2Issued.bast.id,
        evidenceReference: evVarProp,
        notes: 'Admitted to final charge eligibility',
        expectedVersion: varVersion,
        idempotencyKey: key(),
      });
    assert.equal(varFceRes.status, 200, JSON.stringify(varFceRes.body));
    assert.equal(varFceRes.body.data.variation.finalChargeEligible, true);

    // =========================================================================
    // SCENARIO 6: Final invoice deducts allocated DP accurately
    // =========================================================================
    // Compose governed charge lines:
    //  1) Original LABOR (200.00)
    //  2) Original MATERIAL from settled usage (100.00)
    //  3) Approved & eligible ADD variation LABOR (80.00)
    const compLaborRes = await api()
      .post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-charge-lines`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({
        quotationLineId: laborQuotationLineId,
        idempotencyKey: key(),
      });
    assert.equal(compLaborRes.status, 200, JSON.stringify(compLaborRes.body));
    const laborChargeLineId: string = compLaborRes.body.data.chargeLine.id;
    assert.equal(compLaborRes.body.data.chargeLine.amount, '200.00');

    const compMatRes = await api()
      .post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-charge-lines`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({
        quotationLineId: materialQuotationLineId,
        idempotencyKey: key(),
      });
    assert.equal(compMatRes.status, 200, JSON.stringify(compMatRes.body));
    const materialChargeLineId: string = compMatRes.body.data.chargeLine.id;
    assert.equal(compMatRes.body.data.chargeLine.amount, '100.00');

    const compVarLaborRes = await api()
      .post(`${V1}/handyman/execution-scopes/${executionScopeId}/customer-charge-lines`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({
        quotationLineId: varLaborQuotationLineId,
        idempotencyKey: key(),
      });
    assert.equal(compVarLaborRes.status, 200, JSON.stringify(compVarLaborRes.body));
    const varLaborChargeLineId: string = compVarLaborRes.body.data.chargeLine.id;
    assert.equal(compVarLaborRes.body.data.chargeLine.amount, '80.00');

    // Allocate the two confirmed DP payments (50.00 + 70.00 = 120.00) to the original LABOR charge line
    const allocDp1Res = await api()
      .post(`${V1}/handyman/execution-scopes/${executionScopeId}/payment-allocations`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({
        paymentId: partialDpPaymentId,
        chargeLineId: laborChargeLineId,
        amount: '50.00',
        idempotencyKey: key(),
      });
    assert.equal(allocDp1Res.status, 200, JSON.stringify(allocDp1Res.body));

    // Scenario 10 check: attempting to over-allocate partialDpPaymentId beyond 50.00 fails with 409
    const overAllocDp1Res = await api()
      .post(`${V1}/handyman/execution-scopes/${executionScopeId}/payment-allocations`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({
        paymentId: partialDpPaymentId,
        chargeLineId: laborChargeLineId,
        amount: '10.00',
        idempotencyKey: key(),
      });
    assert.equal(overAllocDp1Res.status, 409);

    const allocDp2Res = await api()
      .post(`${V1}/handyman/execution-scopes/${executionScopeId}/payment-allocations`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({
        paymentId: remDpPaymentId,
        chargeLineId: laborChargeLineId,
        amount: '70.00',
        idempotencyKey: key(),
      });
    assert.equal(allocDp2Res.status, 200, JSON.stringify(allocDp2Res.body));

    // Create & finalize Tenant Invoice linked to executionScopeId and the 3 charge lines
    const createInvRes = await api()
      .post(`${V1}/tenant-companies/${f.company.id}/invoices`)
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({
        buildingId: realm.building.id,
        spaceId: chain.space.id,
        invoiceNumber: `INV-HM-${randomUUID().slice(0, 8).toUpperCase()}`,
        invoiceDate: '2026-10-20',
        dueDate: '2026-11-20',
        currencyCode: 'IDR',
        notes: 'Final Handyman Invoice including variation and DP deduction',
      });
    assert.equal(createInvRes.status, 201, JSON.stringify(createInvRes.body));
    const invoiceId: string = createInvRes.body.data.id;

    for (const chargeLineId of [
      laborChargeLineId,
      materialChargeLineId,
      varLaborChargeLineId,
    ] as const) {
      const addLineRes = await api()
        .post(`${V1}/tenant-invoices/${invoiceId}/lines`)
        .set('Authorization', `Bearer ${financeVerifier.token}`)
        .send({
          sourceType: 'HANDYMAN_CHARGE',
          sourceId: chargeLineId,
        });
      assert.equal(addLineRes.status, 201, JSON.stringify(addLineRes.body));
    }

    // PART15: commercial FINALIZED is not e-Faktur certification. Missing
    // external references still block fiscal reconciliation / FINAL CLOSE.
    const commercial=await api().post(`${V1}/tenant-invoices/${invoiceId}/finalize`).set('Authorization',`Bearer ${financeVerifier.token}`).send({});
    assert.equal(commercial.status,200,JSON.stringify(commercial.body));
    const missingFiscal=await readHandymanTaxReconciliation(executionScopeId,financeVerifier.userId);
    assert.equal(missingFiscal.readyForInvoice,false);
    const pendingFiscal=await api().get(`${V1}/handyman/execution-scopes/${executionScopeId}/final-close/readiness`).set('Authorization',`Bearer ${managerActor.token}`);
    assert.equal(pendingFiscal.status,200,JSON.stringify(pendingFiscal.body));
    assert.ok(pendingFiscal.body.data.blockers.some((b:{code:string})=>b.code==='FISCAL_RECONCILIATION_REQUIRED'));
    const delivered=(await q('SELECT accepted_at FROM handyman_bast_documents WHERE id=$1',[bast2Issued.bast.id])).rows[0].accepted_at as Date;
    const finalFiscal=await recordHandymanFiscalDocument(executionScopeId,{kind:'FINAL',taxPointAt:delivered.toISOString(),documentDate:jakartaDate(delivered),externalReference:`TEST-DJP-FINAL-${executionScopeId}`,previousDocumentId:precedingFiscalDocumentId,idempotencyKey:key()},financeVerifier.userId);
    assert.equal(finalFiscal.amounts.gross,'260.00');assert.equal(finalFiscal.amounts.vat,'25.77');
    const fiscalReady=await readHandymanTaxReconciliation(executionScopeId,financeVerifier.userId);
    assert.equal(fiscalReady.readyForInvoice,true);assert.equal('posted' in fiscalReady&&fiscalReady.posted?.vat,'37.66');

    assert.equal(commercial.body.data.status, 'FINALIZED');
    assert.equal(Number(commercial.body.data.totalAmount).toFixed(2), '380.00');

    // Verify variation row was marked invoiced = TRUE upon invoice finalization
    const varAfterFinalize = await q(
      `SELECT invoiced FROM handyman_scope_variations WHERE id = $1`,
      [variationId],
    );
    assert.equal(varAfterFinalize.rows[0].invoiced, true);

    // Verify invoice reconciliation endpoint reflects exact DP deduction and remaining 260.00 balance
    const reconcilAfterInvoice = await api()
      .get(`${V1}/handyman/execution-scopes/${executionScopeId}/invoice-reconciliation`)
      .set('Authorization', `Bearer ${financeVerifier.token}`);
    assert.equal(reconcilAfterInvoice.status, 200);
    assert.equal(reconcilAfterInvoice.body.data.invoice.invoiceId, invoiceId);
    assert.equal(reconcilAfterInvoice.body.data.invoice.grossTotal, '380.00');
    assert.equal(
      reconcilAfterInvoice.body.data.invoice.dpDeductedAmount,
      '120.00',
    );
    assert.equal(
      reconcilAfterInvoice.body.data.invoice.totalAppliedAmount,
      '120.00',
    );
    assert.equal(
      reconcilAfterInvoice.body.data.invoice.remainingBalance,
      '260.00',
    );
    assert.equal(
      reconcilAfterInvoice.body.data.invoice.paymentStatus,
      'PARTIALLY_PAID',
    );

    // =========================================================================
    // SCENARIO 7: Final payment proof uploaded but unverified -> CLOSE rejected
    // =========================================================================
    const finalPaymentReportRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${f.request.id}/payments`,
      )
      .set('Authorization', `Bearer ${careActor.token}`)
      .send({
        amount: '260.00',
        channel: 'BANK_TRANSFER',
        obligationStage: 'PELUNASAN',
        providerName: 'BCA',
        providerReference: 'BCA-PELUNASAN-001',
        externalReference: `EXT-PELUNASAN-${randomUUID()}`,
        idempotencyKey: key(),
      });
    assert.equal(finalPaymentReportRes.status, 201);
    const finalPaymentId: string = finalPaymentReportRes.body.data.payment.id;
    assert.equal(finalPaymentReportRes.body.data.payment.status, 'PENDING');
    assert.equal(
      finalPaymentReportRes.body.data.payment.obligationStage,
      'PELUNASAN',
    );

    // Upload payment proof via Care Building endpoint (multipart/form-data)
    const finalProofRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${f.request.id}/payments/${finalPaymentId}/proof`,
      )
      .set('Authorization', `Bearer ${careActor.token}`)
      .field('evidenceType', 'PHOTO')
      .attach('file', Buffer.from('pelunasan-proof-bytes'), {
        filename: 'pelunasan-slip.png',
        contentType: 'image/png',
      });
    assert.equal(finalProofRes.status, 201, JSON.stringify(finalProofRes.body));

    // Manager attempts FINAL CLOSE while final payment is still PENDING -> rejected (409)
    const closeWhilePendingRes = await api()
      .post(`${V1}/handyman/execution-scopes/${executionScopeId}/final-close`)
      .set('Authorization', `Bearer ${managerActor.token}`)
      .send({
        reason: 'Attempt close before Finance verifies final payment',
        idempotencyKey: key(),
      });
    assert.equal(closeWhilePendingRes.status, 409);
    assert.equal(
      closeWhilePendingRes.body.error.code,
      'HANDYMAN_FINAL_CLOSE_GATE_FAILED',
    );
    const failedGateCodes = (
      closeWhilePendingRes.body.error.details as Array<{ code: string }>
    ).map((g) => g.code);
    assert.ok(failedGateCodes.includes('PENDING_PAYMENT_UNVERIFIED'));
    assert.ok(failedGateCodes.includes('FINAL_INVOICE_NOT_PAID'));
    assert.ok(failedGateCodes.includes('OUTSTANDING_BALANCE_UNPAID'));

    // =========================================================================
    // SCENARIO 9: Customer Care / Dispatcher / Lead / Finance-only attempts CLOSE -> 403
    // =========================================================================
    for (const [label, token] of [
      ['Customer Care', careActor.token],
      ['Operations / Dispatcher', opsActor.token],
      ['Freelance Lead Worker', leadSession.token],
      ['Finance Verifier (non-Manager)', financeVerifier.token],
    ] as const) {
      const forbiddenCloseRes = await api()
        .post(`${V1}/handyman/execution-scopes/${executionScopeId}/final-close`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: `Unauthorized close attempt by ${label}`,
          idempotencyKey: key(),
        });
      assert.equal(
        forbiddenCloseRes.status,
        403,
        `${label} should get 403 on final-close, got ${forbiddenCloseRes.status}`,
      );
    }

    // =========================================================================
    // SCENARIO 8: Final payment verified, invoice PAID, all gates PASS -> Manager CLOSE succeeds
    // =========================================================================
    const confirmFinalPayRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${executionScopeId}/customer-payments/${finalPaymentId}/confirm`,
      )
      .set('Authorization', `Bearer ${financeVerifier.token}`)
      .send({ idempotencyKey: key() });
    assert.equal(confirmFinalPayRes.status, 200);
    assert.equal(confirmFinalPayRes.body.data.payment.status, 'CONFIRMED');

    // Allocate final payment (260.00): 80.00 to remaining original LABOR, 100.00 to MATERIAL, 80.00 to variation LABOR
    for (const [chargeLineId, amount] of [
      [laborChargeLineId, '80.00'],
      [materialChargeLineId, '100.00'],
      [varLaborChargeLineId, '80.00'],
    ] as const) {
      const allocRes = await api()
        .post(`${V1}/handyman/execution-scopes/${executionScopeId}/payment-allocations`)
        .set('Authorization', `Bearer ${financeVerifier.token}`)
        .send({
          paymentId: finalPaymentId,
          chargeLineId,
          amount,
          idempotencyKey: key(),
        });
      assert.equal(allocRes.status, 200, JSON.stringify(allocRes.body));
    }

    // Verify invoice is now PAID with 0.00 balance via invoice reconciliation
    const reconcilPaidInvRes = await api()
      .get(`${V1}/handyman/execution-scopes/${executionScopeId}/invoice-reconciliation`)
      .set('Authorization', `Bearer ${financeVerifier.token}`);
    assert.equal(reconcilPaidInvRes.status, 200);
    assert.equal(reconcilPaidInvRes.body.data.invoice.paymentStatus, 'PAID');
    assert.equal(reconcilPaidInvRes.body.data.invoice.totalAppliedAmount, '380.00');
    assert.equal(reconcilPaidInvRes.body.data.invoice.remainingBalance, '0.00');

    // Verify readiness check passes all gates
    const readinessRes = await api()
      .get(`${V1}/handyman/execution-scopes/${executionScopeId}/final-close/readiness`)
      .set('Authorization', `Bearer ${managerActor.token}`);
    assert.equal(readinessRes.status, 200, JSON.stringify(readinessRes.body));
    assert.equal(readinessRes.body.data.eligibleForFinalClose, true);
    assert.deepEqual(readinessRes.body.data.blockers, []);

    const paidFiscal=await readHandymanTaxReconciliation(executionScopeId,financeVerifier.userId);
    assert.equal(paidFiscal.readyForInvoice,true);assert.equal('posted' in paidFiscal&&paidFiscal.posted?.vat,'37.66');
    assert.equal('documents' in paidFiscal&&paidFiscal.documents?.length,3);

    // Manager executes FINAL CLOSE
    const finalCloseIdemKey = key();
    const finalCloseRes = await api()
      .post(`${V1}/handyman/execution-scopes/${executionScopeId}/final-close`)
      .set('Authorization', `Bearer ${managerActor.token}`)
      .send({
        reason: 'All operational, QC, BAST, and financial reconciliation gates verified',
        idempotencyKey: finalCloseIdemKey,
      });
    assert.equal(finalCloseRes.status, 200, JSON.stringify(finalCloseRes.body));
    assert.equal(finalCloseRes.body.data.readiness.scopeStatus, 'CLOSED');
    assert.equal(
      finalCloseRes.body.data.closeEvent.actorUserId,
      managerActor.userId,
    );
    assert.equal(finalCloseRes.body.data.replayed, false);
    assert.ok(finalCloseRes.body.data.closeEvent.occurredAt);

    // Idempotent replay with same idempotencyKey returns 200 with replayed: true
    const replayCloseRes = await api()
      .post(`${V1}/handyman/execution-scopes/${executionScopeId}/final-close`)
      .set('Authorization', `Bearer ${managerActor.token}`)
      .send({
        reason: 'All operational, QC, BAST, and financial reconciliation gates verified',
        idempotencyKey: finalCloseIdemKey,
      });
    assert.equal(replayCloseRes.status, 200);
    assert.equal(replayCloseRes.body.data.replayed, true);
    assert.equal(
      replayCloseRes.body.data.closeEvent.id,
      finalCloseRes.body.data.closeEvent.id,
    );

    // Second close attempt with a new idempotencyKey fails with HANDYMAN_FINAL_CLOSE_ALREADY_CLOSED (409)
    const duplicateCloseRes = await api()
      .post(`${V1}/handyman/execution-scopes/${executionScopeId}/final-close`)
      .set('Authorization', `Bearer ${managerActor.token}`)
      .send({
        reason: 'Duplicate close attempt',
        idempotencyKey: key(),
      });
    assert.equal(duplicateCloseRes.status, 409);
    assert.equal(
      duplicateCloseRes.body.error.code,
      'HANDYMAN_FINAL_CLOSE_ALREADY_CLOSED',
    );

    // Verify persisted close event and operational audit trail
    const closeEventRows = await q(
      `SELECT id, actor_user_id, execution_scope_id, reason
         FROM handyman_execution_scope_close_events
        WHERE execution_scope_id = $1`,
      [executionScopeId],
    );
    assert.equal(closeEventRows.rows.length, 1);
    assert.equal(closeEventRows.rows[0].actor_user_id, managerActor.userId);
  });

  it('Scenarios 11 & 12: Cross-tenant/building isolation and Overpayment / Forward-Only Correction accuracy', async () => {
    const realmA = await realmFixture('RealmA');
    const chainA = await locationChain(realmA);
    const fA = await createDiagnosedRequestFixture(realmA, chainA);
    await q(
      `INSERT INTO client_allowed_transaction_currencies (client_id, currency_code)
       VALUES ($1, 'IDR')
       ON CONFLICT DO NOTHING`,
      [realmA.client.id],
    );

    const realmB = await realmFixture('RealmB');

    const opsA = await createPersonaSession(
      rolePermissions('OPERATIONS'),
      realmA.building.id,
      'Operations Realm A',
    );

    const financeA = await createPersonaSession(
      [
        'tenant_company.read',
        'tenant_company.manage',
        'tenant_invoice.read',
        'tenant_invoice.manage',
        'handyman.finance.read',
        'handyman.finance.manage',
      ],
      realmA.building.id,
      'Finance Realm A',
    );

    // Actors assigned ONLY to Building B (other tenant/client)
    const managerB = await createPersonaSession(
      rolePermissions('MANAGER'),
      realmB.building.id,
      'Manager Realm B',
    );

    const careB = await createPersonaSession(
      rolePermissions('CUSTOMER_CARE'),
      realmB.building.id,
      'Care Realm B',
    );

    // Create, issue, and approve quotation in Realm A (100.00 LABOR)
    const qRes = await api()
      .post(`${V1}/handyman/requests/${fA.request.id}/quotation`)
      .set('Authorization', `Bearer ${opsA.token}`)
      .send({});
    assert.equal(qRes.status, 201, JSON.stringify(qRes.body));
    const vId: string = qRes.body.data.versions[0].id;

    const lineRes = await api()
      .post(`${V1}/handyman/quotation-versions/${vId}/lines`)
      .set('Authorization', `Bearer ${opsA.token}`)
      .send({
        lineType: 'LABOR',
        description: 'Inspection and repair labor',
        quantity: 1,
        uomId: fA.uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 100,
      });
    assert.equal(lineRes.status, 201);
    const laborLineId: string = lineRes.body.data.id;

    await api()
      .post(`${V1}/handyman/quotation-versions/${vId}/issue`)
      .set('Authorization', `Bearer ${opsA.token}`)
      .send({ validUntil: '2027-12-31T00:00:00.000Z' });

    const decRes = await api()
      .post(`${V1}/handyman/quotation-versions/${vId}/decision`)
      .set('Authorization', `Bearer ${fA.tenantPicSession.token}`)
      .set('Idempotency-Key', key())
      .send({ decision: 'APPROVE' });
    assert.equal(decRes.status, 201);
    const scopeAId: string = decRes.body.data.executionScope.id;

    // =========================================================================
    // SCENARIO 11: Cross-tenant / cross-building access -> rejected
    // =========================================================================
    const crossCarePayRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${realmA.building.id}/requests/${fA.request.id}/payments`,
      )
      .set('Authorization', `Bearer ${careB.token}`)
      .send({
        amount: '50.00',
        channel: 'BANK_TRANSFER',
        obligationStage: 'DP',
        providerName: 'BCA',
        providerReference: 'CROSS-01',
        externalReference: `EXT-CROSS-${randomUUID()}`,
        idempotencyKey: key(),
      });
    assert.ok(
      crossCarePayRes.status === 403 || crossCarePayRes.status === 404,
      `Expected 403/404 for cross-building Care payment report, got ${crossCarePayRes.status}`,
    );

    const crossReconcilRes = await api()
      .get(`${V1}/handyman/execution-scopes/${scopeAId}/invoice-reconciliation`)
      .set('Authorization', `Bearer ${managerB.token}`);
    assert.ok(
      crossReconcilRes.status === 403 || crossReconcilRes.status === 404,
      `Expected 403/404 for cross-building reconciliation read, got ${crossReconcilRes.status}`,
    );

    const crossFinalCloseRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scopeAId}/final-close`)
      .set('Authorization', `Bearer ${managerB.token}`)
      .send({
        reason: 'Cross-tenant close attempt',
        idempotencyKey: key(),
      });
    assert.ok(
      crossFinalCloseRes.status === 403 || crossFinalCloseRes.status === 404,
      `Expected 403/404 for cross-building final close, got ${crossFinalCloseRes.status}`,
    );

    // =========================================================================
    // SCENARIO 12: Overpayment or forward-only correction -> no false balance
    // =========================================================================
    const openTxARes = await api()
      .post(`${V1}/handyman/execution-scopes/${scopeAId}/customer-transaction`)
      .set('Authorization', `Bearer ${financeA.token}`)
      .send({ idempotencyKey: key() });
    assert.equal(openTxARes.status, 200);

    const chargeRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scopeAId}/customer-charge-lines`)
      .set('Authorization', `Bearer ${financeA.token}`)
      .send({
        quotationLineId: laborLineId,
        idempotencyKey: key(),
      });
    assert.equal(chargeRes.status, 200, JSON.stringify(chargeRes.body));
    const chargeLineId: string = chargeRes.body.data.chargeLine.id;

    // Apply a 10.00 forward-only ADJUSTMENT on the 100.00 charge line -> net charge is 90.00
    const adjustRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scopeAId}/ledger-adjustments`)
      .set('Authorization', `Bearer ${financeA.token}`)
      .send({
        chargeLineId,
        amount: '10.00',
        reason: 'Agreed 10.00 commercial adjustment',
        idempotencyKey: key(),
      });
    assert.equal(adjustRes.status, 200, JSON.stringify(adjustRes.body));

    // Customer pays 110.00 (overpayment of 20.00 relative to 90.00 net charge)
    const overPayRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scopeAId}/customer-payments`)
      .set('Authorization', `Bearer ${financeA.token}`)
      .send({
        amount: '110.00',
        channel: 'BANK_TRANSFER',
        obligationStage: 'PELUNASAN',
        providerName: 'Mandiri',
        providerReference: 'MDR-OVER-01',
        externalReference: `EXT-OVER-${randomUUID()}`,
        idempotencyKey: key(),
      });
    assert.equal(overPayRes.status, 200, JSON.stringify(overPayRes.body));
    const overPayId: string = overPayRes.body.data.payment.id;

    await api()
      .post(
        `${V1}/handyman/execution-scopes/${scopeAId}/customer-payments/${overPayId}/confirm`,
      )
      .set('Authorization', `Bearer ${financeA.token}`)
      .send({ idempotencyKey: key() });

    // Allocate 90.00 (exact net charge cap) to the adjusted charge line
    const alloc90Res = await api()
      .post(`${V1}/handyman/execution-scopes/${scopeAId}/payment-allocations`)
      .set('Authorization', `Bearer ${financeA.token}`)
      .send({
        paymentId: overPayId,
        chargeLineId,
        amount: '90.00',
        idempotencyKey: key(),
      });
    assert.equal(alloc90Res.status, 200, JSON.stringify(alloc90Res.body));

    // Attempting to allocate the remaining 20.00 overpayment onto the 90.00 net charge line fails-closed
    const overChargeAllocRes = await api()
      .post(`${V1}/handyman/execution-scopes/${scopeAId}/payment-allocations`)
      .set('Authorization', `Bearer ${financeA.token}`)
      .send({
        paymentId: overPayId,
        chargeLineId,
        amount: '20.00',
        idempotencyKey: key(),
      });
    assert.equal(overChargeAllocRes.status, 409);

    // Create & finalize invoice -> snapshots net charge 90.00, paid 90.00, balance 0.00 (no negative/false balance)
    const invRes = await api()
      .post(`${V1}/tenant-companies/${fA.company.id}/invoices`)
      .set('Authorization', `Bearer ${financeA.token}`)
      .send({
        buildingId: realmA.building.id,
        spaceId: chainA.space.id,
        invoiceNumber: `INV-ADJ-${randomUUID().slice(0, 8).toUpperCase()}`,
        invoiceDate: '2026-10-20',
        dueDate: '2026-11-20',
        currencyCode: 'IDR',
      });
    assert.equal(invRes.status, 201, JSON.stringify(invRes.body));
    const invId: string = invRes.body.data.id;

    const invLineRes = await api()
      .post(`${V1}/tenant-invoices/${invId}/lines`)
      .set('Authorization', `Bearer ${financeA.token}`)
      .send({
        sourceType: 'HANDYMAN_CHARGE',
        sourceId: chargeLineId,
      });
    assert.equal(invLineRes.status, 201, JSON.stringify(invLineRes.body));

    const finInvRes = await api()
      .post(`${V1}/tenant-invoices/${invId}/finalize`)
      .set('Authorization', `Bearer ${financeA.token}`)
      .send({});
    assert.equal(finInvRes.status, 200, JSON.stringify(finInvRes.body));
    assert.equal(Number(finInvRes.body.data.totalAmount).toFixed(2), '90.00');

    // Check reconciliation before refund: unallocatedConfirmedAmount is 20.00, remainingBalance is 0.00
    const reconcilBeforeRefund = await api()
      .get(`${V1}/handyman/execution-scopes/${scopeAId}/invoice-reconciliation`)
      .set('Authorization', `Bearer ${financeA.token}`);
    assert.equal(reconcilBeforeRefund.status, 200);
    assert.equal(reconcilBeforeRefund.body.data.ledgerSummary.chargedNet, '90.00');
    assert.equal(
      reconcilBeforeRefund.body.data.ledgerSummary.remainingBalanceAfterDpAndPayments,
      '0.00',
    );
    assert.equal(
      reconcilBeforeRefund.body.data.ledgerSummary.unallocatedConfirmedAmount,
      '20.00',
    );
    assert.equal(
      reconcilBeforeRefund.body.data.ledgerSummary.derivedPaymentStatus,
      'OVERPAID_UNRECONCILED',
    );
    assert.equal(reconcilBeforeRefund.body.data.invoice.grossTotal, '90.00');
    assert.equal(reconcilBeforeRefund.body.data.invoice.totalAppliedAmount, '90.00');
    assert.equal(reconcilBeforeRefund.body.data.invoice.remainingBalance, '0.00');
    assert.equal(reconcilBeforeRefund.body.data.invoice.paymentStatus, 'PAID');

    // Refund the 20.00 unallocated overpayment -> totalConfirmedReceivedNet becomes 90.00, unallocatedConfirmedAmount becomes 0.00
    const refundRes = await api()
      .post(
        `${V1}/handyman/execution-scopes/${scopeAId}/ledger-refunds`,
      )
      .set('Authorization', `Bearer ${financeA.token}`)
      .send({
        paymentId: overPayId,
        amount: '20.00',
        reason: 'Refund excess 20.00 overpayment',
        idempotencyKey: key(),
      });
    assert.equal(refundRes.status, 200, JSON.stringify(refundRes.body));

    const reconcilAfterRefund = await api()
      .get(`${V1}/handyman/execution-scopes/${scopeAId}/invoice-reconciliation`)
      .set('Authorization', `Bearer ${financeA.token}`);
    assert.equal(reconcilAfterRefund.status, 200);
    assert.equal(
      reconcilAfterRefund.body.data.ledgerSummary.totalConfirmedReceivedNet,
      '90.00',
    );
    assert.equal(
      reconcilAfterRefund.body.data.ledgerSummary.remainingBalanceAfterDpAndPayments,
      '0.00',
    );
    assert.equal(
      reconcilAfterRefund.body.data.ledgerSummary.unallocatedConfirmedAmount,
      '0.00',
    );
    assert.equal(
      reconcilAfterRefund.body.data.ledgerSummary.derivedPaymentStatus,
      'PAID',
    );
    assert.equal(
      reconcilAfterRefund.body.data.invoice.remainingBalance,
      '0.00',
    );
  });
});
