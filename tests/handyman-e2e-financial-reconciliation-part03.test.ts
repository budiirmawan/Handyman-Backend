import assert from 'node:assert/strict';
import { randomUUID as id, createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { resetAppConfigCache } from '../src/config';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import {
  initHandymanFixtures,
  realmFixture,
  locationChain,
  crewFixture,
} from './helpers/handyman-fixtures';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { roleService } from '../src/modules/roles';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { MANAGER_ROLE, CUSTOMER_CARE_ROLE } from '../src/modules/iam-bootstrap/iam-canonical-roles';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { serviceCatalogService } from '../src/modules/service-catalog';
import {
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
  handymanServiceRequestDiagnosisService,
  recordHandymanInspection,
} from '../src/modules/handyman-requests';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  createHandymanQuotationRevision,
  decideHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import {
  openHandymanCustomerTransaction,
  composeHandymanChargeLine,
} from '../src/modules/handyman-customer-transactions';
import {
  recordHandymanCustomerPayment,
  confirmHandymanCustomerPayment,
} from '../src/modules/handyman-customer-payments';
import { allocateHandymanCustomerPayment } from '../src/modules/handyman-customer-payment-allocations';
import {
  refundHandymanCustomerPayment,
  reverseHandymanPaymentAllocation,
  adjustHandymanCustomerLedger,
} from '../src/modules/handyman-customer-ledger-corrections';
import { readHandymanLedgerTransactionAt } from '../src/modules/handyman-customer-ledger-read';
import {
  agreeInspectionFee,
  creditPaidInspection,
  prepareInspectionFeeOffer,
  readInspectionFee,
} from '../src/modules/handyman-customer-transactions/handyman-inspection-fee.service';
import {
  prepareHandymanTaxProfile,
  reconcileHandymanPayment,
  recordHandymanFiscalDocument,
  applyHandymanWithholdingCredit,
  readHandymanTaxReconciliation,
  recordHandymanBmFiscalDocument,
} from '../src/modules/handyman-customer-transactions/handyman-financial-tax.service';
import {
  calculateHandymanIndonesiaTax as tax,
  type HandymanTaxFacts,
  jakartaDate,
} from '../src/modules/handyman-pricing-contract/handyman-indonesia-tax';
import { computePaymentAvailableActions } from '../src/modules/handyman-customer-payments/handyman-customer-payment.available-actions';
import { createEvidenceStorage, evidenceStorageKey } from '../src/modules/evidence/storage';
import {
  proposeScopeVariation,
  reviewScopeVariation,
  prepareVariationRevisedQuotation,
  recordVariationTenantDecision,
  authorizeVariationScope,
} from '../src/modules/handyman-scope-variations';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import {
  prepareHandymanCommercialAgreement,
  activateHandymanCommercialAgreementVersion,
} from '../src/modules/handyman-commercial-agreements';
import {
  prepareHandymanSettlement,
  includeHandymanSettlement,
  reconcileHandymanSettlement,
  settleHandymanSettlement,
} from '../src/modules/handyman-settlement';
import { migration0482HandymanFinancialReconciliation } from '../src/database/migrations/0482_handyman_financial_reconciliation';
import { deriveHandymanFinancialEntitlements } from '../src/modules/handyman-financial-entitlements';

const facts: HandymanTaxFacts = {
  priceBasis: 'GROSS_INCLUSIVE',
  providerStatus: 'PKP',
  vatRegime: 'PMK131_ART3',
  recipientKind: 'DOMESTIC_BODY',
  incomeRecipientReference: 'TEST Handyman taxpayer',
  payerReference: 'TEST tenant taxpayer',
  serviceClass: 'ORDINARY_SERVICE',
  payerIsWithholder: true,
  incomeTax: 'PPH23',
  hasNpwp: true,
  qualification: 'NOT_APPLICABLE',
  withholdingBasis: 'ALL_SERVICE_NET',
  effectiveFrom: '2025-01-01',
  effectiveTo: '2027-12-31',
  sourceReference: 'TEST verified PKP/taxpayer facts',
  classificationReference: 'TEST reviewed qualifying PMK141 maintenance service',
};
const nonPkp: HandymanTaxFacts = {
  ...facts,
  providerStatus: 'NON_PKP',
  vatRegime: 'NON_PKP',
  payerIsWithholder: false,
  incomeTax: 'NONE',
};
const noWh: HandymanTaxFacts = { ...facts, payerIsWithholder: false, incomeTax: 'NONE' };
const blocked = (e: unknown) => {
  assert.match(
    String((e as { code?: string }).code),
    /HANDYMAN_FINANCIAL_|HANDYMAN_CUSTOMER_|PERMISSION_DENIED|BUILDING_ACCESS_DENIED/,
  );
  return true;
};
// Existing BE-19D contracts only; test credentials/references are not external verification.
async function finalizeBilling(c: Awaited<ReturnType<typeof context>>, lineId: string, expected: number) {
  await q("INSERT INTO client_allowed_transaction_currencies(client_id,currency_code) VALUES($1,'IDR') ON CONFLICT DO NOTHING", [c.realm.client.id]);
  const manager = await session(c.realm.building.id, [
    ...MANAGER_ROLE.permissions, 'handyman.finance.manage', 'tenant_invoice.manage',
  ]);
  const created = await api().post(`${V1}/tenant-companies/${c.company.id}/invoices`)
    .set('Authorization', `Bearer ${manager.token}`).send({
      buildingId:c.realm.building.id, spaceId:c.chain.space.id, invoiceNumber:`P15-${id()}`,
      invoiceDate:jakartaDate(new Date()), dueDate:jakartaDate(new Date()), currencyCode:'IDR',
    });
  assert.equal(created.status,201,JSON.stringify(created.body));
  const invoiceId = created.body.data.id;
  const linked = await api().post(`${V1}/tenant-invoices/${invoiceId}/lines`)
    .set('Authorization', `Bearer ${manager.token}`).send({sourceType:'HANDYMAN_CHARGE',sourceId:lineId});
  assert.equal(linked.status,201,JSON.stringify(linked.body));
  const finalized = await api().post(`${V1}/tenant-invoices/${invoiceId}/finalize`)
    .set('Authorization', `Bearer ${manager.token}`).send({});
  assert.equal(finalized.status,200,JSON.stringify(finalized.body));
  assert.equal(finalized.body.data.totalAmount,expected);
  assert.equal(finalized.body.data.lines[0].amount,expected);
  return invoiceId;
}
describe('PART03 — explicit Indonesia tax configurations (no universal classification)', () => {
  it('PKP PMK131: 12% × 11/12 DPP; gross, net, VAT, PPh23 and cash stay distinct', () => {
    const r = tax(facts, '1110.00', '0.00', '2026-10-25');
    assert.deepEqual(
      [r.serviceNet, r.dpp, r.vat, r.withholding, r.cashDue],
      ['1000.00', '916.67', '110.00', '20.00', '1090.00'],
    );
  });
  it('Care action projection is closed by default; Finance status projection never grants backend authority', () => {
    assert.deepEqual(computePaymentAvailableActions('PENDING'), []);
    assert.deepEqual(computePaymentAvailableActions('PENDING', true), ['CONFIRM', 'REJECT']);
    assert.deepEqual(computePaymentAvailableActions('CONFIRMED', true), []);
  });
  it('non-PKP consumer: no invented VAT or withholding', () => {
    const r = tax(nonPkp, '1000.00');
    assert.equal(r.vat, '0.00');
    assert.equal(r.withholding, '0.00');
    assert.equal(r.cashDue, '1000.00');
  });
  it('known non-withholding consumer: PKP still owes VAT, not PPh23 customer withholding', () => {
    const r = tax(noWh, '1110.00');
    assert.equal(r.vat, '110.00');
    assert.equal(r.withholding, '0.00');
  });
  it('PP9/2022 applies ONLY to explicit qualifying construction/certification; self-remittance is not a customer credit', () => {
    const f: HandymanTaxFacts = {
      ...facts,
      incomeTax: 'PPH_FINAL_CONSTRUCTION',
      serviceClass: 'CONSTRUCTION_WORK',
      qualification: 'SMALL_CERTIFIED',
      certificateReference: 'TEST SBU small',
    };
    assert.equal(tax(f, '1110.00').withholding, '17.50');
    const own = tax({ ...f, payerIsWithholder: false }, '1110.00');
    assert.equal(own.withholding, '0.00');
    assert.equal(own.selfRemittance, '17.50');
    assert.throws(() => tax({ ...facts, incomeTax: 'PPH_FINAL_CONSTRUCTION' }, '1110.00'), blocked);
  });
  it('missing PKP/classification, unsupported special/exclusive pricing, unqualified PPh23 and expired facts fail closed', () => {
    for (const f of [
      {},
      { ...facts, priceBasis: 'EXCLUSIVE' },
      { ...facts, providerStatus: 'UNKNOWN' },
      { ...facts, recipientKind: 'DOMESTIC_INDIVIDUAL' },
      { ...facts, payerIsWithholder: false },
    ])
      assert.throws(() => tax(f as HandymanTaxFacts, '1110.00'), blocked);
    assert.throws(
      () => tax({ ...facts, effectiveTo: '2025-12-31' }, '1110.00', '0.00', '2026-10-25'),
      blocked,
    );
  });
});
const DIR = '/tmp/hm-e2e-financial-part03',
  PORT = 55681,
  V1 = '/api/v1';
let db: Awaited<ReturnType<typeof startEmbeddedTestDatabase>>,
  pool: Pool,
  admin: string,
  discipline: string;
const q = (s: string, p: unknown[] = []) => pool.query(s, p);
async function grant(user: string, permissions: readonly string[]) {
  const role = await roleService.createRole({
    code: `P03_${id().slice(0, 8)}`,
    name: 'Handyman Manager domain capabilities',
  });
  for (const code of new Set(permissions)) {
    const p =
      (await permissionRepository.findByCode(code)) ??
      (await permissionService.createPermission({ code, name: `Test fixture ${code}` }));
    assert.ok(p, code);
    await permissionService.assignPermissionToRole(role.id, p.id);
  }
  await roleService.assignRoleToUser(user, role.id);
}
async function session(
  building: string,
  permissions: readonly string[],
  label = 'Handyman Manager',
) {
  const email = `p03-${id()}@example.invalid`,
    password = 'TestPwd1!good';
  const user = await userService.createUser({ email, displayName: label });
  await credentialService.createInitialCredential({ userId: user.id, password });
  await grant(user.id, permissions);
  await buildingAssignmentService.createAssignment(user.id, { buildingId: building });
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { id: user.id, token: login.body.data.sessionToken as string };
}
async function context() {
  const realm = await realmFixture('P03'),
    chain = await locationChain(realm);
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: realm.client.id, tenantCode: `T${id().slice(0, 8)}`, tenantName: 'Customer' },
    admin,
  );
  const person = await userService.createUser({
    email: `customer-${id()}@example.invalid`,
    displayName: 'Optional authenticated request PIC',
  });
  await buildingAssignmentService.createAssignment(person.id, { buildingId: realm.building.id });
  const pic = await tenantPicService.createTenantPic(
    { tenantCompanyId: company.id, picName: 'Customer', userId: person.id },
    admin,
  );
  await tenantSpaceService.assignSpaceToTenant(
    { tenantCompanyId: company.id, buildingId: realm.building.id, spaceId: chain.space.id },
    admin,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: company.id, buildingId: realm.building.id },
    admin,
  );
  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: realm.client.id,
      code: `S${id().slice(0, 8).toUpperCase()}`,
      name: 'Reviewed service',
      category: 'TEST',
    },
    admin,
  );
  const uom = id();
  await q(
    `INSERT INTO units_of_measure(id,client_id,code,name,symbol,category) VALUES($1,$2,$3,'unit','u','COUNT')`,
    [uom, realm.client.id, `U${id().slice(0, 8)}`],
  );
  async function request(inspection = false) {
    const a = await createChannelAttribution({
      tenantCompanyId: company.id,
      buildingId: realm.building.id,
      tenantPicId: pic.id,
      spaceId: chain.space.id,
      originChannel: 'BM_SUPER_APP',
      originReference: `bm-handoff:BM_SUPER_APP:${id()}`,
      createdByUserId: person.id,
    });
    const r = await handymanServiceRequestService.createHandymanServiceRequest(
      { channelAttributionId: a.id, serviceCatalogId: service.id },
      admin,
    );
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: r.id,
        triageDisposition: inspection ? 'INSPECTION_REQUIRED' : 'DIAGNOSIS',
        triageNote: 'Actual test triage facts',
      },
      admin,
    );
    if (!inspection)
      await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
        { handymanRequestId: r.id, disciplineId: discipline, diagnosis: 'Reviewed scope' },
        admin,
      );
    return r;
  }
  async function quote(
    requestId: string,
    amount = 1110,
    profile: HandymanTaxFacts | null = noWh,
    offer?: {
      parent: string;
      treatment: 'PAID_CREDITED' | 'PAID_SEPARATE';
      noProceed?: 'REFUND_AGREED_FEE' | 'RETAIN_AGREED_FEE';
    },
  ) {
    const b = await createHandymanQuotation({ handymanRequestId: requestId }, admin),
      version = b.versions[0].id;
    const line = await addHandymanQuotationLine(
      version,
      {
        lineType: 'LABOR',
        description: 'Agreed service price (inclusive where tax profile exists)',
        quantity: 1,
        uomId: uom,
        currency: 'IDR',
        finalQuotedUnitAmount: amount,
      },
      admin,
    );
    if (profile) await prepareHandymanTaxProfile({ quotationVersionId: version }, profile, admin);
    if (offer)
      await prepareInspectionFeeOffer(
        version,
        {
          handymanRequestId: offer.parent,
          treatment: offer.treatment,
          noProceedTreatment: offer.noProceed ?? 'RETAIN_AGREED_FEE',
          creditMode: 'SEPARATE_SERVICE_DISCOUNT',
        },
        admin,
      );
    await issueHandymanQuotationVersion(
      version,
      { validUntil: new Date(Date.now() + 86400000).toISOString() },
      admin,
    );
    const d = await decideHandymanQuotation(
      version,
      { decision: 'APPROVE', idempotencyKey: id() },
      person.id,
    );
    assert.ok(d.executionScope);
    await openHandymanCustomerTransaction(
      { executionScopeId: d.executionScope.id, idempotencyKey: id() },
      admin,
    );
    return { scope: d.executionScope, version, line };
  }
  return { realm, chain, person, company, request, quote };
}
async function pay(
  scope: string,
  amount: string,
  stage: 'DP' | 'TERMIN' | 'PELUNASAN' = 'PELUNASAN',
) {
  const r = await recordHandymanCustomerPayment(
    {
      executionScopeId: scope,
      amount,
      channel: 'BANK_TRANSFER',
      obligationStage: stage,
      idempotencyKey: id(),
      externalReference: id(),
    },
    admin,
  );
  await confirmHandymanCustomerPayment(
    { executionScopeId: scope, paymentId: r.payment.id, idempotencyKey: id() },
    admin,
  );
  return r.payment;
}
async function charge(f: Awaited<ReturnType<Awaited<ReturnType<typeof context>>['quote']>>) {
  return (
    await composeHandymanChargeLine(
      { executionScopeId: f.scope.id, quotationLineId: f.line.id, idempotencyKey: id() },
      admin,
    )
  ).chargeLine;
}
describe('PART03 — real PostgreSQL financial integration (existing engines)', () => {
  before(async () => {
    process.env.EVIDENCE_STORAGE_DIR = DIR + '-evidence';
    resetAppConfigCache();
    db = await startEmbeddedTestDatabase({ dir: DIR, port: PORT });
    pool = await initDatabase({
      host: '127.0.0.1',
      port: PORT,
      name: 'asentra_test',
      user: 'postgres',
      password: '',
      ssl: false,
    });
    await migrateUp(pool);
    admin = (await createAdminUser()).userId;
    await grant(admin, [
      'handyman.finance.manage',
      'handyman.finance.read',
      'handyman.commercial.manage',
      'handyman.settlement.manage',
    ]);
    const d = await handymanDisciplineRepository.findDisciplineByCode(
      undefined,
      'GENERAL_HANDYMAN',
    );
    assert.ok(d);
    discipline = d.id;
    initHandymanFixtures({ adminUserId: admin, disciplineId: discipline, query: q });
  });
  after(async () => {
    try {
      if (pool) await closePool(pool);
      if (db) await db.stop();
    } finally {
      await rm(DIR, { recursive: true, force: true });
      await rm(DIR + '-evidence', { recursive: true, force: true });
      delete process.env.EVIDENCE_STORAGE_DIR;
      resetAppConfigCache();
    }
  });
  it('FREE inspection has no fee/payment/credit; direct no-inspection quotation cannot acquire an inspection fee', async () => {
    const c = await context(),
      r = await c.request(true);
    const t = await agreeInspectionFee(r.id, { treatment: 'FREE', idempotencyKey: id() }, admin);
    assert.equal(t.agreed_amount, '0.00');
    assert.deepEqual((await readInspectionFee(r.id, admin)).payments, []);
    const direct = await c.request();
    await assert.rejects(
      agreeInspectionFee(direct.id, { treatment: 'FREE', idempotencyKey: id() }, admin),
      blocked,
    );
    const f = await c.quote(direct.id, 100, nonPkp);
    assert.ok(f.scope.id);
    await assert.rejects(
      creditPaidInspection(f.scope.id, { chargeLineId: id(), idempotencyKey: id() }, admin),
      blocked,
    );
  });
  it('PAID_CREDITED: approved separate fee displayed before visit; only verified funds unlock one discount, never a copied payment', async () => {
    const c = await context(),
      parent = await c.request(true),
      fee = await c.quote((await c.request()).id, 111, noWh, {
        parent: parent.id,
        treatment: 'PAID_CREDITED',
      });
    await agreeInspectionFee(
      parent.id,
      { treatment: 'PAID_CREDITED', feeExecutionScopeId: fee.scope.id, idempotencyKey: id() },
      admin,
    );
    assert.equal((await readInspectionFee(parent.id, admin)).charge, '111.00');
    await recordHandymanInspection(
      {
        handymanRequestId: parent.id,
        inspectionResult: 'INSPECTED',
        inspectionNotes: 'Actual existing result',
      },
      admin,
    );
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
      { handymanRequestId: parent.id, disciplineId: discipline, diagnosis: 'Inspected labor' },
      admin,
    );
    const job = await c.quote(parent.id, 1110, noWh),
      line = await charge(job),
      key = id();
    await assert.rejects(
      creditPaidInspection(job.scope.id, { chargeLineId: line.id, idempotencyKey: key }, admin),
      blocked,
    );
    const payment = await pay(fee.scope.id, '111.00');
    await assert.rejects(
      creditPaidInspection(job.scope.id, { chargeLineId: line.id, idempotencyKey: key }, admin),
      blocked,
    );
    await reconcileHandymanPayment(
      fee.scope.id,
      payment.id,
      {
        bankReference: id(),
        actualReceivedAt: new Date(Date.now() - 1000).toISOString(),
        idempotencyKey: id(),
      },
      admin,
    );
    const credit = await creditPaidInspection(
      job.scope.id,
      { chargeLineId: line.id, idempotencyKey: key },
      admin,
    );
    assert.equal(credit.replayed, false);
    assert.equal(
      (
        await creditPaidInspection(
          job.scope.id,
          { chargeLineId: line.id, idempotencyKey: key },
          admin,
        )
      ).replayed,
      true,
    );
    await assert.rejects(
      creditPaidInspection(job.scope.id, { chargeLineId: line.id, idempotencyKey: id() }, admin),
      blocked,
    );
    const ledger = await readHandymanLedgerTransactionAt(job.scope.id, admin);
    assert.equal(ledger.totals.chargedNet, '999.00');
    assert.equal(ledger.payments.length, 0);
    await finalizeBilling(c, line.id, 999);
    const feeTax = await readHandymanTaxReconciliation(fee.scope.id, admin),
      jobTax = await readHandymanTaxReconciliation(job.scope.id, admin);
    assert.equal(feeTax.amounts?.vat, '11.00');
    assert.equal(jobTax.amounts?.vat, '99.00');
    assert.equal(
      BigInt(feeTax.amounts!.vat.replace('.', '')) + BigInt(jobTax.amounts!.vat.replace('.', '')),
      11000n,
      'The actual inspection plus discounted job must not add a second VAT charge',
    );

    await assert.rejects(
      refundHandymanCustomerPayment(
        {
          executionScopeId: fee.scope.id,
          paymentId: payment.id,
          amount: '111.00',
          reason: 'Attempt to refund an already spent inspection credit',
          idempotencyKey: id(),
        },
        admin,
      ),
      blocked,
    );
    assert.equal(
      (await q('SELECT amount FROM handyman_customer_payments WHERE id=$1', [payment.id])).rows[0]
        .amount,
      '111.00',
    );
    assert.equal(
      (await q('SELECT line_total FROM handyman_quotation_lines WHERE id=$1', [job.line.id]))
        .rows[0].line_total,
      '1110.00',
    );
  });
  it('PAID_SEPARATE: no job credit and no invented cancellation/no-show charges', async () => {
    const c = await context(),
      r = await c.request(true),
      fee = await c.quote((await c.request()).id, 100, nonPkp, {
        parent: r.id,
        treatment: 'PAID_SEPARATE',
      });
    await agreeInspectionFee(
      r.id,
      { treatment: 'PAID_SEPARATE', feeExecutionScopeId: fee.scope.id, idempotencyKey: id() },
      admin,
    );
    await pay(fee.scope.id, '100.00');
    const read = await readInspectionFee(r.id, admin);
    assert.equal(read.noProceed, 'RETAIN_AGREED_FEE');
    assert.equal(read.refundAutomatic, false);
    assert.equal(read.credits?.length, 0);
    await assert.rejects(
      creditPaidInspection(fee.scope.id, { chargeLineId: id(), idempotencyKey: id() }, admin),
      blocked,
    );
  });
  it('100% upfront: actual receipt timing -> external tax reference; no duplicate VAT from final settlement or repeated allocation', async () => {
    const c = await context(),
      job = await c.quote((await c.request()).id),
      p = await pay(job.scope.id, '1110.00', 'DP');
    const at = new Date(Date.now() - 1000).toISOString(),
      ref = id();
    await reconcileHandymanPayment(
      job.scope.id,
      p.id,
      { bankReference: ref, actualReceivedAt: at, idempotencyKey: id() },
      admin,
    );
    const input = {
      kind: 'ADVANCE' as const,
      paymentId: p.id,
      grossLabor: '1110.00',
      taxPointAt: at,
      documentDate: jakartaDate(new Date(at)),
      externalReference: `TEST-DJP-${id()}`,
      idempotencyKey: id(),
    };
    const d = await recordHandymanFiscalDocument(job.scope.id, input, admin);
    assert.equal(d.amounts.vat, '110.00');
    assert.equal((await recordHandymanFiscalDocument(job.scope.id, input, admin)).replayed, true);
    await assert.rejects(
      recordHandymanFiscalDocument(
        job.scope.id,
        { ...input, idempotencyKey: id(), externalReference: id() },
        admin,
      ),
      blocked,
    );
    const state = await readHandymanTaxReconciliation(job.scope.id, admin);
    assert.equal(state.readyForInvoice, true);
    assert.equal(
      (
        await q(
          'SELECT count(*)::int n FROM handyman_fiscal_documents WHERE execution_scope_id=$1',
          [job.scope.id],
        )
      ).rows[0].n,
      1,
    );
    const manager = await session(c.realm.building.id, ['finding.close', 'handyman.finance.read']);
    const close = await api()
      .post(`${V1}/handyman/execution-scopes/${job.scope.id}/final-close`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ reason: 'Fully funded does not authorize operational close', idempotencyKey: id() });
    assert.equal(close.status, 409, JSON.stringify(close.body));
  });
  it('DP + installment PPN timing and linkage use actual receipt dates; Care reporting date is not the tax point', async () => {
    const c = await context(),
      job = await c.quote((await c.request()).id);
    const first = await pay(job.scope.id, '333.00', 'DP'),
      at = new Date(Date.now() - 3000).toISOString();
    await assert.rejects(
      recordHandymanFiscalDocument(
        job.scope.id,
        {
          kind: 'ADVANCE',
          paymentId: first.id,
          grossLabor: '333.00',
          taxPointAt: at,
          documentDate: jakartaDate(new Date(at)),
          externalReference: id(),
          idempotencyKey: id(),
        },
        admin,
      ),
      blocked,
    );
    await reconcileHandymanPayment(
      job.scope.id,
      first.id,
      { bankReference: id(), actualReceivedAt: at, idempotencyKey: id() },
      admin,
    );
    const a = await recordHandymanFiscalDocument(
      job.scope.id,
      {
        kind: 'ADVANCE',
        paymentId: first.id,
        grossLabor: '333.00',
        taxPointAt: at,
        documentDate: jakartaDate(new Date(at)),
        externalReference: id(),
        idempotencyKey: id(),
      },
      admin,
    );
    assert.equal(a.amounts.vat, '33.00');
    const second = await pay(job.scope.id, '777.00', 'TERMIN'),
      at2 = new Date(Date.now() - 1000).toISOString();
    await reconcileHandymanPayment(
      job.scope.id,
      second.id,
      { bankReference: id(), actualReceivedAt: at2, idempotencyKey: id() },
      admin,
    );
    const b = await recordHandymanFiscalDocument(
      job.scope.id,
      {
        kind: 'INSTALLMENT',
        paymentId: second.id,
        grossLabor: '777.00',
        taxPointAt: at2,
        documentDate: jakartaDate(new Date(at2)),
        previousDocumentId: a.id,
        externalReference: id(),
        idempotencyKey: id(),
      },
      admin,
    );
    assert.equal(b.amounts.vat, '77.00');
    const read = await readHandymanTaxReconciliation(job.scope.id, admin);
    assert.equal(read.readyForInvoice, true);
    assert.equal('posted' in read && read.posted?.vat, '110.00');
    const line = await charge(job);
    const invoiceId = await finalizeBilling(c, line.id, 1110);
    for (const [payment,amount] of [[first,'333.00'],[second,'777.00']] as const) {
      await allocateHandymanCustomerPayment({executionScopeId:job.scope.id,
        paymentId:payment.id, chargeLineId:line.id, amount, idempotencyKey:id()},admin);
    }
    const summary = await api().get(`${V1}/handyman/execution-scopes/${job.scope.id}/invoice-reconciliation`)
      .set('Authorization',`Bearer ${(await session(c.realm.building.id, ['handyman.finance.read'])).token}`);
    assert.equal(summary.status,200,JSON.stringify(summary.body));
    assert.equal(summary.body.data.invoice.invoiceId,invoiceId);
    assert.equal(summary.body.data.invoice.grossTotal,'1110.00');
    assert.equal(summary.body.data.invoice.dpDeductedAmount,'333.00');
    assert.equal(summary.body.data.invoice.totalAppliedAmount,'1110.00');
    assert.equal(summary.body.data.invoice.remainingBalance,'0.00');
  });
  it('qualified PPh23: verified cash + actual certificate credit are distinguishable; no synthetic cash payment and no double credit', async () => {
    const c = await context(),
      job = await c.quote((await c.request()).id, 1110, facts),
      line = await charge(job),
      p = await pay(job.scope.id, '1090.00');
    const at = new Date(Date.now() - 1000).toISOString();
    await reconcileHandymanPayment(
      job.scope.id,
      p.id,
      { bankReference: id(), actualReceivedAt: at, idempotencyKey: id() },
      admin,
    );
    const d = await recordHandymanFiscalDocument(
      job.scope.id,
      {
        kind: 'ADVANCE',
        paymentId: p.id,
        grossLabor: '1110.00',
        taxPointAt: at,
        documentDate: jakartaDate(new Date(at)),
        externalReference: id(),
        withholdingReference: `TEST-EBUPOT-${id()}`,
        idempotencyKey: id(),
      },
      admin,
    );
    assert.equal((await readHandymanTaxReconciliation(job.scope.id, admin)).readyForInvoice, false);
    await applyHandymanWithholdingCredit(job.scope.id, d.id, admin);
    assert.equal((await applyHandymanWithholdingCredit(job.scope.id, d.id, admin)).replayed, true);
    await allocateHandymanCustomerPayment(
      {
        executionScopeId: job.scope.id,
        paymentId: p.id,
        chargeLineId: line.id,
        amount: '1090.00',
        idempotencyKey: id(),
      },
      admin,
    );
    const state = await readHandymanTaxReconciliation(job.scope.id, admin);
    assert.equal(state.readyForInvoice, true);
    assert.equal('amounts' in state && state.amounts?.gross, '1110.00');
    assert.equal('withholdingCredit' in state && state.withholdingCredit, '20.00');
    const ledger = await readHandymanLedgerTransactionAt(job.scope.id, admin);
    assert.equal(ledger.totals.chargedNet, '1090.00');
    assert.equal(ledger.payments.length, 1);
    await finalizeBilling(c, line.id, 1090);
    const another = await c.quote((await c.request()).id, 1110, facts),
      cash = await pay(another.scope.id, '1090.00'),
      received = new Date(Date.now() - 1000).toISOString();
    await reconcileHandymanPayment(
      another.scope.id,
      cash.id,
      { bankReference: id(), actualReceivedAt: received, idempotencyKey: id() },
      admin,
    );
    await assert.rejects(
      recordHandymanFiscalDocument(
        another.scope.id,
        {
          kind: 'ADVANCE',
          paymentId: cash.id,
          grossLabor: '1110.00',
          taxPointAt: received,
          documentDate: jakartaDate(new Date(received)),
          externalReference: id(),
          withholdingReference: d.withholding_reference,
          idempotencyKey: id(),
        },
        admin,
      ),
      blocked,
    );
  });
  it('Handyman Manager uses explicit Finance capability; Customer Care and generic BM Manager cannot confirm funds or bank reconciliation', async () => {
    const c = await context(),
      job = await c.quote((await c.request()).id, 100, nonPkp);
    const manager = await session(c.realm.building.id, [
      ...MANAGER_ROLE.permissions,
      'handyman.finance.manage',
    ]);
    const care = await session(
      c.realm.building.id,
      CUSTOMER_CARE_ROLE.permissions,
      'Customer Care',
    );
    const bm = await session(
      c.realm.building.id,
      MANAGER_ROLE.permissions,
      'BM Manager (no Handyman Finance grant)',
    );
    const p = await recordHandymanCustomerPayment(
      {
        executionScopeId: job.scope.id,
        amount: '100.00',
        channel: 'BANK_TRANSFER',
        idempotencyKey: id(),
      },
      admin,
    );
    for (const [actor, expected] of [
      [care, []],
      [manager, ['CONFIRM', 'REJECT']],
    ] as const) {
      const r = await api()
        .get(`${V1}/handyman/execution-scopes/${job.scope.id}/customer-payments`)
        .set('Authorization', `Bearer ${actor.token}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.data.payments[0].availableActions, expected);
    }
    const path = `${V1}/handyman/execution-scopes/${job.scope.id}/customer-payments/${p.payment.id}/confirm`;
    for (const actor of [care, bm]) {
      const r = await api()
        .post(path)
        .set('Authorization', `Bearer ${actor.token}`)
        .send({ idempotencyKey: id() });
      assert.equal(r.status, 403, JSON.stringify(r.body));
    }
    const ok = await api()
      .post(path)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ idempotencyKey: id() });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.payment.decidedByUserId, manager.id);
    const bank = `${V1}/handyman/execution-scopes/${job.scope.id}/customer-payments/${p.payment.id}/reconciliation`;
    assert.equal(
      (
        await api()
          .post(bank)
          .set('Authorization', `Bearer ${care.token}`)
          .send({
            bankReference: id(),
            actualReceivedAt: new Date(Date.now() - 1000).toISOString(),
            idempotencyKey: id(),
          })
      ).status,
      403,
    );
  });
  it('bank-reference reuse across payments and cross-tenant/Building fiscal writes are rejected', async () => {
    const c = await context(),
      j = await c.quote((await c.request()).id, 100, nonPkp),
      p = await pay(j.scope.id, '50.00'),
      p2 = await pay(j.scope.id, '50.00'),
      ref = id(),
      at = new Date(Date.now() - 1000).toISOString();
    await reconcileHandymanPayment(
      j.scope.id,
      p.id,
      { bankReference: ref, actualReceivedAt: at, idempotencyKey: id() },
      admin,
    );
    await assert.rejects(
      reconcileHandymanPayment(
        j.scope.id,
        p2.id,
        { bankReference: ref, actualReceivedAt: at, idempotencyKey: id() },
        admin,
      ),
      blocked,
    );
    const other = await context(),
      outsider = await session(other.realm.building.id, ['handyman.finance.manage']);
    await assert.rejects(
      reconcileHandymanPayment(
        j.scope.id,
        p2.id,
        { bankReference: id(), actualReceivedAt: at, idempotencyKey: id() },
        outsider.id,
      ),
      blocked,
    );
  });
  it('missing/unknown tax configuration is BLOCKED, not a non-PKP/exempt assumption; issued policy/history cannot be rewritten', async () => {
    const c = await context(),
      job = await c.quote((await c.request()).id, 100, null);
    assert.equal((await readHandymanTaxReconciliation(job.scope.id, admin)).configured, false);
    await assert.rejects(
      prepareHandymanTaxProfile(
        { quotationVersionId: job.version },
        { ...noWh, sourceReference: 'different facts' },
        admin,
      ),
      blocked,
    );
    const configured = await c.quote((await c.request()).id, 100, noWh);
    await assert.rejects(
      q('UPDATE handyman_financial_tax_profiles SET facts=$1 WHERE quotation_version_id=$2', [
        JSON.stringify(nonPkp),
        configured.version,
      ]),
    );
  });
  it('approved ADD and REDUCE after DP preserve original approvals, bank facts and tax history with exact-version reviewed facts', async () => {
    for (const kind of ['ADD', 'REDUCE'] as const) {
      const c = await context(),
        job = await c.quote((await c.request()).id),
        p = await pay(job.scope.id, '333.00', 'DP'),
        crew = await crewFixture(c.realm),
        at = new Date(Date.now() - 1000).toISOString();
      await credentialService.createInitialCredential({
        userId: crew.leadUser.id,
        password: 'TestPwd1!good',
      });
      await assignHandymanExecutionScopeCrew(
        {
          executionScopeId: job.scope.id,
          providerContextId: crew.providerContext.id,
          crewId: crew.crew.id,
        },
        admin,
      );
      await reconcileHandymanPayment(
        job.scope.id,
        p.id,
        { bankReference: id(), actualReceivedAt: at, idempotencyKey: id() },
        admin,
      );
      const original = await recordHandymanFiscalDocument(
        job.scope.id,
        {
          kind: 'ADVANCE',
          paymentId: p.id,
          grossLabor: '333.00',
          taxPointAt: at,
          documentDate: jakartaDate(new Date(at)),
          externalReference: id(),
          idempotencyKey: id(),
        },
        admin,
      );
      const upload = id(),
        storage = evidenceStorageKey(upload),
        bytes = Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from(`test-${upload}`),
        ]),
        evidence = `hm-ev://${upload}`;
      await createEvidenceStorage().put(storage, { buffer: bytes, mimeType: 'image/png' });
      await q(
        `INSERT INTO handyman_field_evidence_uploads(id,client_id,tenant_company_id,building_id,handyman_request_id,execution_scope_id,purpose,upload_status,original_file_name,mime_type,storage_key,declared_byte_size,verified_byte_size,sha256_checksum,attachment_reference,uploaded_by_user_id,uploaded_by_role,idempotency_key,verified_at)
        VALUES($1,$2,$3,$4,$5,$6,'VARIATION_FINDING','VERIFIED','test.png','image/png',$7,$8,$8,$9,$10,$11,'PIC_PEKERJAAN',$12,NOW())`,
        [
          upload,
          c.realm.client.id,
          c.company.id,
          c.realm.building.id,
          job.scope.handymanRequestId,
          job.scope.id,
          storage,
          bytes.length,
          createHash('sha256').update(bytes).digest('hex'),
          evidence,
          crew.leadUser.id,
          id(),
        ],
      );
      let v = (
        await proposeScopeVariation(crew.leadUser.id, job.scope.id, {
          variationType: kind,
          lineType: 'LABOR',
          targetQuotationLineId: kind === 'REDUCE' ? job.line.id : undefined,
          title: 'Actual scope change',
          description: 'Reviewed after DP',
          technicalFinding: 'Actual finding',
          quantity: 0.1,
          uomId: job.line.uomId,
          evidenceReference: evidence,
          idempotencyKey: id(),
        })
      ).variation;
      v = (
        await reviewScopeVariation(admin, job.scope.id, v.id, {
          evidenceReference: evidence,
          idempotencyKey: id(),
          expectedVersion: v.version,
        })
      ).variation;
      const revision = await createHandymanQuotationRevision(job.scope.quotationId, admin);
      await addHandymanQuotationLine(
        revision.id,
        {
          lineType: 'LABOR',
          description: 'Revised approved scope',
          quantity: 1,
          uomId: job.line.uomId,
          currency: 'IDR',
          finalQuotedUnitAmount: kind === 'ADD' ? 1221 : 999,
        },
        admin,
      );
      await prepareHandymanTaxProfile(
        { quotationVersionId: revision.id },
        {
          ...noWh,
          classificationReference: 'TEST independently reviewed revised maintenance scope',
        },
        admin,
      );
      await issueHandymanQuotationVersion(
        revision.id,
        { validUntil: new Date(Date.now() + 86400000).toISOString() },
        admin,
      );
      v = (
        await prepareVariationRevisedQuotation(admin, job.scope.id, v.id, {
          quotedUnitAmount: 1110,
          currency: 'IDR',
          revisedQuotationVersionId: revision.id,
          evidenceReference: evidence,
          idempotencyKey: id(),
          expectedVersion: v.version,
        })
      ).variation;
      v = (
        await recordVariationTenantDecision(c.person.id, job.scope.id, v.id, {
          decision: 'APPROVE',
          revisedQuotationVersionId: revision.id,
          evidenceReference: evidence,
          idempotencyKey: id(),
          expectedVersion: v.version,
        })
      ).variation;
      await authorizeVariationScope(admin, job.scope.id, v.id, {
        evidenceReference: evidence,
        idempotencyKey: id(),
        expectedVersion: v.version,
      });
      const r = await readHandymanTaxReconciliation(job.scope.id, admin);
      assert.equal(r.configured, true);
      assert.equal('amounts' in r && r.amounts?.gross, kind === 'ADD' ? '1221.00' : '999.00');
      assert.equal('amounts' in r && r.amounts?.vat, kind === 'ADD' ? '121.00' : '99.00');
      assert.equal(
        (await q('SELECT amount,status FROM handyman_customer_payments WHERE id=$1', [p.id]))
          .rows[0].amount,
        '333.00',
      );
      assert.equal(
        (await q('SELECT amounts FROM handyman_fiscal_documents WHERE id=$1', [original.id]))
          .rows[0].amounts.vat,
        '33.00',
      );
      assert.equal(
        (await q('SELECT status FROM handyman_quotation_versions WHERE id=$1', [job.version]))
          .rows[0].status,
        'APPROVED',
      );
    }
  });
  it('BM percentage uses contract rate and correction-netted labor EX VAT; BM VAT/PPh and payable settlement stay separate', async () => {
    const c = await context(),
      job = await c.quote((await c.request()).id, 1110, facts),
      line = await charge(job),
      crew = await crewFixture(c.realm);
    await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: job.scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      },
      admin,
    );
    const agreement = await prepareHandymanCommercialAgreement(admin, {
        clientId: c.realm.client.id,
        idempotencyKey: id(),
      }),
      v = agreement.version.id;
    await q(
      `INSERT INTO handyman_bm_fee_rule_definitions(id,agreement_version_id,basis,mode,idempotency_key,created_by_user_id) VALUES($1,$2,'LABOR_ONLY','DEFAULT',$3,$4)`,
      [id(), v, id(), admin],
    );
    await q(
      `INSERT INTO handyman_bm_fee_term_definitions(id,agreement_version_id,term_kind,rate_percent,idempotency_key,created_by_user_id) VALUES($1,$2,'PERCENTAGE_OF_BASIS','5.0000',$3,$4)`,
      [id(), v, id(), admin],
    );
    await q(
      `INSERT INTO handyman_bm_fee_beneficiary_definitions(id,agreement_version_id,beneficiary_kind,beneficiary_reference_id,idempotency_key,created_by_user_id) VALUES($1,$2,'CLIENT_ORGANIZATION',$3,$4,$5)`,
      [id(), v, c.realm.client.id, id(), admin],
    );
    await prepareHandymanTaxProfile(
      { agreementVersionId: v },
      {
        ...facts,
        incomeRecipientReference: 'TEST BM taxpayer',
        payerReference: 'TEST Handyman taxpayer',
        bmSettlementTiming: 'AFTER_FULL_CUSTOMER_COLLECTION',
        classificationReference: 'TEST reviewed BM intermediary service',
      },
      admin,
    );
    await activateHandymanCommercialAgreementVersion(admin, {
      versionId: v,
      effectiveFrom: new Date(Date.now() - 60000).toISOString(),
      idempotencyKey: id(),
    });
    const p = await pay(job.scope.id, '1090.00'),
      received = new Date(Date.now() - 1000).toISOString();
    await reconcileHandymanPayment(
      job.scope.id,
      p.id,
      { bankReference: id(), actualReceivedAt: received, idempotencyKey: id() },
      admin,
    );
    const certificate = await recordHandymanFiscalDocument(
      job.scope.id,
      {
        kind: 'ADVANCE',
        paymentId: p.id,
        grossLabor: '1110.00',
        taxPointAt: received,
        documentDate: jakartaDate(new Date(received)),
        externalReference: id(),
        withholdingReference: id(),
        idempotencyKey: id(),
      },
      admin,
    );
    await applyHandymanWithholdingCredit(job.scope.id, certificate.id, admin);
    await allocateHandymanCustomerPayment(
      {
        executionScopeId: job.scope.id,
        paymentId: p.id,
        chargeLineId: line.id,
        amount: '1090.00',
        idempotencyKey: id(),
      },
      admin,
    );
    const earned = await deriveHandymanFinancialEntitlements(job.scope.id, admin, id());
    assert.equal(earned.bmFee.amount, '50.00');
    assert.equal(earned.provider.amount, '1040.00');
    const basis = (
      await q('SELECT basis_ex_vat FROM handyman_bm_fee_fiscal_bases WHERE entitlement_id=$1', [
        earned.bmFee.id,
      ])
    ).rows[0];
    assert.equal(basis.basis_ex_vat, '1000.00');
    await prepareHandymanSettlement(job.scope.id, admin, id());
    await includeHandymanSettlement(job.scope.id, admin, id());
    assert.equal((await reconcileHandymanSettlement(job.scope.id, admin, id())).outcome, 'MATCHED');
    await assert.rejects(settleHandymanSettlement(job.scope.id, admin, id()), blocked);
    const at = new Date(Date.now() - 1000).toISOString();
    const doc = await recordHandymanBmFiscalDocument(
      job.scope.id,
      {
        taxPointAt: at,
        documentDate: jakartaDate(new Date(at)),
        externalReference: id(),
        withholdingReference: id(),
        reconciliationReference: 'TEST actual outgoing cash + eBupot',
        idempotencyKey: id(),
      },
      admin,
    );
    assert.equal(doc.amounts.gross, '50.00');
    assert.equal(doc.amounts.vat, '4.95');
    assert.equal(doc.amounts.withholding, '0.90');
    assert.equal(doc.amounts.cashDue, '49.10');
    assert.equal((await settleHandymanSettlement(job.scope.id, admin, id())).state, 'SETTLED');
    assert.equal(
      (await q('SELECT status FROM handyman_execution_scopes WHERE id=$1', [job.scope.id])).rows[0]
        .status,
      'AUTHORIZED',
    );
  });
  it('agreed non-proceed refund uses existing real forward-only refund; no fee/credit/VAT is fabricated', async () => {
    const c = await context(),
      parent = await c.request(true),
      fee = await c.quote((await c.request()).id, 100, nonPkp, {
        parent: parent.id,
        treatment: 'PAID_CREDITED',
        noProceed: 'REFUND_AGREED_FEE',
      });
    await agreeInspectionFee(
      parent.id,
      { treatment: 'PAID_CREDITED', feeExecutionScopeId: fee.scope.id, idempotencyKey: id() },
      admin,
    );
    const line = await charge(fee),
      p = await pay(fee.scope.id, '100.00');
    const applied = await allocateHandymanCustomerPayment(
      {
        executionScopeId: fee.scope.id,
        paymentId: p.id,
        chargeLineId: line.id,
        amount: '100.00',
        idempotencyKey: id(),
      },
      admin,
    );
    await refundHandymanCustomerPayment(
      {
        executionScopeId: fee.scope.id,
        paymentId: p.id,
        amount: '100.00',
        reason: 'TEST actual customer non-proceed; previously agreed refund of inspection fee',
        idempotencyKey: id(),
      },
      admin,
    );
    await reverseHandymanPaymentAllocation(
      {
        executionScopeId: fee.scope.id,
        allocationId: applied.allocation.id,
        reason: 'Release refunded inspection application',
        idempotencyKey: id(),
      },
      admin,
    );
    await adjustHandymanCustomerLedger(
      {
        executionScopeId: fee.scope.id,
        chargeLineId: line.id,
        amount: '100.00',
        reason:
          'Apply the previously agreed full no-proceed fee refund; original charge remains history',
        idempotencyKey: id(),
      },
      admin,
    );
    const refunded = await readHandymanLedgerTransactionAt(fee.scope.id, admin);
    assert.equal(refunded.totals.netReceived, '0.00');
    assert.equal(refunded.totals.chargedNet, '0.00');
    assert.equal(refunded.totals.outstanding, '0.00');
    const terms = await readInspectionFee(parent.id, admin);
    assert.equal(terms.noProceed, 'REFUND_AGREED_FEE');
    assert.equal(terms.credits?.length, 0);
  });
  it('a concurrent fee refund and one-time job credit cannot both consume the same real funds', async () => {
    const c = await context(),
      parent = await c.request(true),
      fee = await c.quote((await c.request()).id, 111, noWh, {
        parent: parent.id,
        treatment: 'PAID_CREDITED',
      });
    await agreeInspectionFee(
      parent.id,
      { treatment: 'PAID_CREDITED', feeExecutionScopeId: fee.scope.id, idempotencyKey: id() },
      admin,
    );
    const payment = await pay(fee.scope.id, '111.00'),
      feeLine = await charge(fee);
    await allocateHandymanCustomerPayment(
      {
        executionScopeId: fee.scope.id,
        paymentId: payment.id,
        chargeLineId: feeLine.id,
        amount: '111.00',
        idempotencyKey: id(),
      },
      admin,
    );
    await reconcileHandymanPayment(
      fee.scope.id,
      payment.id,
      {
        bankReference: id(),
        actualReceivedAt: new Date(Date.now() - 1000).toISOString(),
        idempotencyKey: id(),
      },
      admin,
    );
    await recordHandymanInspection(
      {
        handymanRequestId: parent.id,
        inspectionResult: 'INSPECTED',
        inspectionNotes: 'Actual completed inspection before the job',
      },
      admin,
    );
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
      {
        handymanRequestId: parent.id,
        disciplineId: discipline,
        diagnosis: 'Job after real inspection',
      },
      admin,
    );
    const job = await c.quote(parent.id),
      line = await charge(job);
    const outcomes = await Promise.allSettled([
      creditPaidInspection(job.scope.id, { chargeLineId: line.id, idempotencyKey: id() }, admin),
      refundHandymanCustomerPayment(
        {
          executionScopeId: fee.scope.id,
          paymentId: payment.id,
          amount: '111.00',
          reason: 'Actual competing refund before credit consumption',
          idempotencyKey: id(),
        },
        admin,
      ),
    ]);
    assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of outcomes)
      if (r.status === 'rejected')
        assert.equal(
          r.reason.statusCode,
          409,
          'Conflict must be bounded, not a PostgreSQL deadlock',
        );
    const spent = (
      await q(
        'SELECT count(*)::int n FROM handyman_inspection_fee_credits WHERE job_execution_scope_id=$1',
        [job.scope.id],
      )
    ).rows[0].n;
    const returned = (await readHandymanLedgerTransactionAt(fee.scope.id, admin)).totals.refunded;
    assert.ok((spent === 1 && returned === '0.00') || (spent === 0 && returned === '111.00'));
  });

  it('PART15: commercial FINALIZED is independent of missing DJP references; fiscal actions stay closed', async () => {
    for (const profile of [noWh, nonPkp]) {
      const c = await context(), job = await c.quote((await c.request()).id, 1110, profile);
      const line = await charge(job);
      await q("INSERT INTO client_allowed_transaction_currencies(client_id,currency_code) VALUES($1,'IDR') ON CONFLICT DO NOTHING", [c.realm.client.id]);
      const manager = await session(c.realm.building.id, [
        ...MANAGER_ROLE.permissions, 'handyman.finance.manage', 'tenant_invoice.manage',
      ]);
      const invoice = await api().post(`${V1}/tenant-companies/${c.company.id}/invoices`)
        .set('Authorization', `Bearer ${manager.token}`).send({
          buildingId: c.realm.building.id, spaceId: c.chain.space.id,
          invoiceNumber: `P15-${id()}`, invoiceDate: jakartaDate(new Date()),
          dueDate: jakartaDate(new Date()), currencyCode: 'IDR',
        });
      assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
      const invoiceId = invoice.body.data.id;
      const linked = await api().post(`${V1}/tenant-invoices/${invoiceId}/lines`)
        .set('Authorization', `Bearer ${manager.token}`)
        .send({sourceType:'HANDYMAN_CHARGE', sourceId:line.id});
      assert.equal(linked.status, 201, JSON.stringify(linked.body));
      const outsider = await session(c.realm.building.id, MANAGER_ROLE.permissions);
      assert.equal((await api().post(`${V1}/tenant-invoices/${invoiceId}/finalize`)
        .set('Authorization', `Bearer ${outsider.token}`).send({})).status, 403);
      const finalized = await api().post(`${V1}/tenant-invoices/${invoiceId}/finalize`)
        .set('Authorization', `Bearer ${manager.token}`).send({});
      assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
      assert.equal(finalized.body.data.totalAmount, 1110);
      const fiscal = await readHandymanTaxReconciliation(job.scope.id, manager.id);
      assert.equal(fiscal.djpSubmission, false);
      assert.equal('documents' in fiscal && fiscal.documents.length, 0);
      assert.equal(fiscal.readyForInvoice, profile.providerStatus === 'NON_PKP');
      assert.equal((await q('SELECT count(*)::int n FROM tenant_invoice_history WHERE tenant_invoice_id=$1 AND changed_by_user_id=$2',
        [invoiceId,manager.id])).rows[0].n > 0, true);
      await assert.rejects(recordHandymanFiscalDocument(job.scope.id, {
        kind:'FINAL', taxPointAt:new Date().toISOString(), documentDate:jakartaDate(new Date()),
        externalReference:'', idempotencyKey:id(),
      }, manager.id));
    }
  });

  it('PART15: commercial adjustments net once; missing delivery authority cannot post a fiscal adjustment', async () => {
    const c = await context(), job = await c.quote((await c.request()).id,1110,noWh);
    const line = await charge(job);
    const input = {executionScopeId:job.scope.id, chargeLineId:line.id, amount:'111.00',
      reason:'Test reviewed commercial reduction', idempotencyKey:id()};
    await adjustHandymanCustomerLedger(input,admin);
    await adjustHandymanCustomerLedger(input,admin);
    await finalizeBilling(c,line.id,999);
    const fiscal = await readHandymanTaxReconciliation(job.scope.id,admin);
    assert.equal(fiscal.amounts?.gross,'999.00');
    assert.equal(fiscal.amounts?.vat,'99.00');
    assert.equal(fiscal.readyForInvoice,false);
    // Explicit test-only reference cannot substitute for qualified BAST/delivery authority.
    await assert.rejects(recordHandymanFiscalDocument(job.scope.id,{
      kind:'ADJUSTMENT', taxPointAt:new Date().toISOString(), documentDate:jakartaDate(new Date()),
      externalReference:`TEST-NOT-AN-ISSUED-DOCUMENT-${id()}`, idempotencyKey:id(),
    },admin),blocked);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_fiscal_documents WHERE execution_scope_id=$1',[job.scope.id])).rows[0].n,0);
  });

  it('0482 can roll back and reapply on this disposable database without touching immutable source payments or quotes', async () => {
    const before = (await q('SELECT count(*)::int n FROM handyman_customer_payments')).rows[0].n,
      client = await pool.connect();
    const quotationCount = (await q('SELECT count(*)::int n FROM handyman_quotation_versions'))
      .rows[0].n;
    try {
      await client.query('BEGIN');
      await migration0482HandymanFinancialReconciliation.down(client);
      await migration0482HandymanFinancialReconciliation.up(client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    assert.equal(
      (await q('SELECT count(*)::int n FROM handyman_customer_payments')).rows[0].n,
      before,
    );
    assert.equal(
      (await q('SELECT count(*)::int n FROM handyman_quotation_versions')).rows[0].n,
      quotationCount,
    );
    assert.equal(
      (await q('SELECT count(*)::int n FROM handyman_financial_tax_profiles')).rows[0].n,
      0,
    );
  });
});
