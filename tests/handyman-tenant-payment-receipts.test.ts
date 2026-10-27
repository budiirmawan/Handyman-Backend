import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { issueTenantPaymentReceipt, downloadTenantPaymentReceipt } from '../src/modules/handyman-tenant-receipts/handyman-tenant-receipt.service';
import { confirmHandymanCustomerPayment, recordHandymanCustomerPayment, rejectHandymanCustomerPayment } from '../src/modules/handyman-customer-payments';
import { allocateHandymanCustomerPayment } from '../src/modules/handyman-customer-payment-allocations';
import { reverseHandymanPaymentAllocation } from '../src/modules/handyman-customer-ledger-corrections';
import { composeHandymanChargeLine, openHandymanCustomerTransaction } from '../src/modules/handyman-customer-transactions';
import { reconcileHandymanPayment } from '../src/modules/handyman-customer-transactions/handyman-financial-tax.service';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { updateHandymanDocumentIssuerProfile } from '../src/modules/handyman-documents/handyman-document-issuer.service';
import { createTenantInvoice, addTenantInvoiceLine, finalizeTenantInvoice } from '../src/modules/tenant-invoices';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { roleService } from '../src/modules/roles';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { grantCareActorProperty, revokeCareActorProperty, handymanCareActorService } from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { startEmbeddedTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-test-db';
import { ensureTestDatabase } from './helpers/postgres';
import { initHandymanFixtures, locationChain, realmFixture, scopeFixture } from './helpers/handyman-fixtures';
import { stableJson } from '../src/shared/stable-json';

const id = () => randomUUID(), key = () => `receipt-test-${id()}`;
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const err = (code: string) => (e: { code?: string }) => { assert.equal(e.code, code); return true; };
let db: EmbeddedTestDatabase, pool: Pool, admin: string, adminToken: string, verifier: string;
let care: string, careToken: string, outsiderToken: string, workspaceToken: string, careActor: string;
let realm: Awaited<ReturnType<typeof realmFixture>>, chain: Awaited<ReturnType<typeof locationChain>>;
let scope: NonNullable<Awaited<ReturnType<typeof scopeFixture>>['scope']>, chargeId: string;
let dpId: string, allocationId: string, dpReceipt: Awaited<ReturnType<typeof issueTenantPaymentReceipt>>;
let invoiceId: string, termId: string, finalId: string;
const ref = (paymentId: string) => ({ executionScopeId: scope.id, paymentId });
const base = (paymentId: string) => `/api/v1/handyman/execution-scopes/${scope.id}/customer-payments/${paymentId}/receipt`;
const selection = () => ({ propertyId: realm.property.id, tenantCompanyId: scope.tenantCompanyId,
  buildingId: realm.building.id, spaceId: chain.space.id });
const workspacePath = (paymentId: string) => `/api/v1/handyman/care/requests/${scope.handymanRequestId}/payments/${paymentId}/receipt.pdf`;

async function scopedUser(buildingId: string, permissions: string[], login = false) {
  const user = await userService.createUser({ email: `${id()}@receipt.test`, displayName: 'Receipt Scoped User' });
  const role = await roleService.createRole({ code: `RECEIPT_${id()}`, name: 'Receipt test permissions' });
  for (const code of permissions) {
    const permission = await permissionRepository.findByCode(code); assert.ok(permission, code);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  let token = '';
  if (login) {
    await credentialService.createInitialCredential({ userId: user.id, password: 'ReceiptPass123' });
    const response = await api().post('/api/v1/auth/login').send({ email: user.email, password: 'ReceiptPass123' });
    assert.equal(response.status, 200, JSON.stringify(response.body)); token = response.body.data.sessionToken;
  }
  return { userId: user.id, token };
}
const issuerContent = (legalName: string, expectedVersion: number | null) => ({ clientId: realm.client.id, expectedVersion,
  legalName, displayName: 'Handyman', registeredAddress: 'Jl. Merdeka 1', businessAddress: null, city: 'Jakarta', province: 'Jakarta',
  postalCode: '10110', email: 'issuer@example.test', phone: '+62 21 5000 1111', whatsapp: '+62 811 2000 3000',
  website: null, taxId: null, businessRegistrationId: null, logoReference: null });
async function record(stage: 'DP' | 'TERMIN' | 'PELUNASAN', amount: string) {
  return (await recordHandymanCustomerPayment({ executionScopeId: scope.id, amount, channel: 'BANK_TRANSFER', obligationStage: stage,
    externalReference: key(), idempotencyKey: key() }, admin)).payment.id;
}
async function confirm(paymentId: string, actor = verifier) {
  return confirmHandymanCustomerPayment({ executionScopeId: scope.id, paymentId, idempotencyKey: key() }, actor);
}
async function pdfText(bytes: Buffer) {
  const document = await PDFDocument.load(bytes), out: string[] = [];
  for (const page of document.getPages()) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i)) : contents ? [contents] : [];
    for (const stream of streams) if (stream instanceof PDFRawStream) {
      const data = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      for (const match of data.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(match[1]!, 'hex').toString('latin1'));
    }
  }
  return out.join('\n');
}

before(async () => {
  db = await startEmbeddedTestDatabase({ dir: '/tmp/hm-tenant-receipt-0507-pg', port: 55563 });
  const config = await ensureTestDatabase(); assert.ok(config, 'PostgreSQL is required for this focused suite');
  pool = await initDatabase(config); await migrateUp(pool);
  const root = await createAdminUser(); admin = root.userId; adminToken = root.token;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN'); assert.ok(discipline);
  initHandymanFixtures({ adminUserId: admin, disciplineId: discipline.id, query: q });
  realm = await realmFixture('Receipt'); chain = await locationChain(realm);
  await clientMonetaryContextService.setClientMonetaryContext({ clientId: realm.client.id,
    baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR'] }, admin);
  const fixture = await scopeFixture(realm, chain); assert.ok(fixture.scope); scope = fixture.scope;
  verifier = (await scopedUser(realm.building.id, ['handyman.finance.manage', 'handyman.finance.read'])).userId;
  const careUser = await scopedUser(realm.building.id, ['handyman.care.building'], true); care = careUser.userId; careToken = careUser.token;
  const sibling = await buildingService.createBuilding({ propertyId: realm.property.id, code: `SIB_${id().slice(0, 8)}`, name: 'Sibling' });
  outsiderToken = (await scopedUser(sibling.id, ['handyman.care.building'], true)).token;
  await openHandymanCustomerTransaction({ executionScopeId: scope.id, idempotencyKey: key() }, admin);
  const labor = (await q(`SELECT id FROM handyman_quotation_lines WHERE quotation_version_id=$1 AND line_type='LABOR'`,
    [scope.approvedQuotationVersionId])).rows[0];
  chargeId = (await composeHandymanChargeLine({ executionScopeId: scope.id, quotationLineId: labor.id, idempotencyKey: key() }, admin)).chargeLine.id;
  await updateHandymanDocumentIssuerProfile(issuerContent('PT Original Issuer', null), admin);
  const integrationCode = `RC_${id().slice(0, 8).toUpperCase()}`, secret = 'receipt-workspace-integration-secret';
  const integration = await handoffRuntimeRepository.createIntegration({ integrationCode, displayName: 'Receipt Care' });
  await handymanCareActorService.setIntegrationActorCapability({ integrationId: integration.id, capability: 'CUSTOMER_CARE' });
  careActor = (await handymanCareActorService.createCareActor({ integrationId: integration.id, actorReference: 'care', displayName: 'Care' })).id;
  process.env[handoffIntegrationSecretEnvName(integrationCode)] = secret;
  await grantCareActorProperty({ careActorId: careActor, propertyId: realm.property.id, clientId: realm.client.id }, admin);
  const assertion: CareWorkspaceAssertion = { purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode, assertionId: id(),
    issuedAt: new Date(Date.now()-1000).toISOString(), expiresAt: new Date(Date.now()+240000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: 'care' } };
  workspaceToken = (await admitCareWorkspace(assertion, signCareWorkspaceAssertion(assertion, secret))).workspaceToken;
});
after(async () => { if (pool) await closePool(pool); if (db) await db.stop(); });

describe('CR-HM-TENANT-RECEIPT-01', () => {
  it('rejects pending, rejected, self-confirmed and unmatched payments instead of treating proofs as received funds', async () => {
    const pending = await record('DP', '12.00');
    await assert.rejects(issueTenantPaymentReceipt(admin, ref(pending)), err('HANDYMAN_TENANT_RECEIPT_CONFLICT'));
    const rejected = await record('TERMIN', '13.00');
    await rejectHandymanCustomerPayment({ ...ref(rejected), reason: 'Not verified', idempotencyKey: key() }, verifier);
    await assert.rejects(issueTenantPaymentReceipt(admin, ref(rejected)), err('HANDYMAN_TENANT_RECEIPT_CONFLICT'));
    const self = await record('PELUNASAN', '14.00'); await confirm(self, admin);
    await assert.rejects(issueTenantPaymentReceipt(admin, ref(self)), err('HANDYMAN_TENANT_RECEIPT_CONFLICT'));
    await assert.rejects(issueTenantPaymentReceipt(care, ref(self)), err('PERMISSION_DENIED'));
    await assert.rejects(issueTenantPaymentReceipt(admin, ref(id())), (e: { statusCode?: number }) => e.statusCode === 404);
    const notFound = await api().get(`${base(pending)}.pdf`).set('Authorization', `Bearer ${careToken}`);
    assert.equal(notFound.status, 404); assert.equal((await q('SELECT count(*)::int n FROM handyman_tenant_payment_receipts')).rows[0].n, 0);
  });

  it('issues each independently confirmed DP, termin and pelunasan exactly once under concurrent retries', async () => {
    dpId = await record('DP', '30.00'); await confirm(dpId);
    allocationId = (await allocateHandymanCustomerPayment({ executionScopeId: scope.id, paymentId: dpId,
      chargeLineId: chargeId, amount: '20.00', idempotencyKey: key() }, admin)).allocation.id;
    const results = await Promise.all(Array.from({ length: 4 }, () => issueTenantPaymentReceipt(admin, ref(dpId))));
    assert.equal(new Set(results.map(x => x.id)).size, 1); assert.equal(results.filter(x => !x.replayed).length, 1); dpReceipt = results[0];
    let row = (await q('SELECT * FROM handyman_tenant_payment_receipts WHERE payment_id=$1', [dpId])).rows[0];
    assert.equal(row.source_snapshot.payment.amount, '30.00'); assert.equal(row.source_snapshot.payment.currency, 'IDR');
    assert.equal(row.source_snapshot.payment.obligationStage, 'DP'); assert.equal(row.source_snapshot.verification.confirmedByUserId, verifier);
    assert.equal(row.source_snapshot.verification.basis, 'INDEPENDENT_CONFIRMATION');
    assert.equal(row.source_snapshot.payer.tenantCompanyId, scope.tenantCompanyId); assert.equal(row.source_snapshot.payer.remitterIdentity, 'NOT_VERIFIED');
    assert.equal(row.source_snapshot.reference.requestId, scope.handymanRequestId); assert.equal(row.source_snapshot.reference.invoice, null);
    assert.equal(row.source_snapshot.allocations[0].id, allocationId); assert.equal(row.source_snapshot.allocations[0].amount, '20.00');
    assert.equal(row.source_sha256, sha(stableJson(row.source_snapshot))); assert.equal(row.pdf_sha256, sha(row.pdf_bytes));
    const precision = (await q(`SELECT (d.source_snapshot#>>'{verification,confirmedAt}')::timestamptz=p.decided_at AS exact
      FROM handyman_tenant_payment_receipts d JOIN handyman_customer_payments p ON p.id=d.payment_id WHERE d.id=$1`, [dpReceipt.id])).rows[0];
    assert.equal(precision.exact, true); assert.match(row.source_snapshot.verification.confirmedAt, /\.\d{6}Z$/);
    const falsified = structuredClone(row.source_snapshot), fakeId = id();
    falsified.issuance.id = fakeId; falsified.payment.amount = '999.00';
    const canonical = stableJson(falsified);
    await assert.rejects(q(`INSERT INTO handyman_tenant_payment_receipts
      (id,client_id,building_id,tenant_company_id,request_id,execution_scope_id,transaction_id,payment_id,record_event_id,
       confirmation_event_id,issuer_profile_id,issued_by_user_id,issued_at,source_as_of,source_snapshot,source_canonical,source_sha256,
       pdf_filename,pdf_bytes,pdf_size,pdf_sha256)
      SELECT $2,client_id,building_id,tenant_company_id,request_id,execution_scope_id,transaction_id,payment_id,record_event_id,
       confirmation_event_id,issuer_profile_id,issued_by_user_id,issued_at,source_as_of,$3::text::jsonb,$3::text,$4,
       pdf_filename,pdf_bytes,pdf_size,pdf_sha256 FROM handyman_tenant_payment_receipts WHERE id=$1`,
    [dpReceipt.id, fakeId, canonical, sha(canonical)]), /matching independently verified incoming payment/);
    const text = await pdfText(row.pdf_bytes); assert.ok(text.includes('ISSUED - Tenant Payment Receipt'));
    assert.ok(text.includes('does not certify any invoice')); assert.ok(text.includes('DP, TERMIN or PELUNASAN'));
    const invoice = await createTenantInvoice({ tenantCompanyId: scope.tenantCompanyId, buildingId: scope.buildingId,
      spaceId: scope.spaceId!, invoiceNumber: `INV-${id()}`, invoiceDate: '2026-01-01', dueDate: '2026-02-01', currencyCode: 'IDR' }, admin);
    invoiceId = invoice.id;
    await addTenantInvoiceLine(invoiceId, { sourceType: 'HANDYMAN_CHARGE', sourceId: chargeId }, admin);
    await finalizeTenantInvoice(invoiceId, admin);
    const invoiceBefore = (await q('SELECT status,total_amount FROM tenant_invoices WHERE id=$1', [invoiceId])).rows[0];
    const paymentStatusBefore = (await q('SELECT count(*)::int n FROM invoice_payment_status WHERE invoice_id=$1', [invoiceId])).rows[0].n;
    termId = await record('TERMIN', '20.00'); await confirm(termId);
    const term = await issueTenantPaymentReceipt(admin, ref(termId));
    assert.deepEqual((await q('SELECT status,total_amount FROM tenant_invoices WHERE id=$1', [invoiceId])).rows[0], invoiceBefore);
    assert.equal((await q('SELECT count(*)::int n FROM invoice_payment_status WHERE invoice_id=$1', [invoiceId])).rows[0].n, paymentStatusBefore);
    row = (await q('SELECT * FROM handyman_tenant_payment_receipts WHERE id=$1', [term.id])).rows[0];
    assert.equal(row.source_snapshot.reference.invoice.id, invoiceId); assert.equal(row.source_snapshot.reference.invoice.status, 'FINALIZED');
    assert.equal(row.source_snapshot.payment.obligationStage, 'TERMIN');
    finalId = await record('PELUNASAN', '10.00'); await confirm(finalId);
    const response = await api().post(base(finalId)).set('Authorization', `Bearer ${adminToken}`).send({});
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const replay = await api().post(base(finalId)).set('Authorization', `Bearer ${adminToken}`).send({});
    assert.equal(replay.status, 200); assert.equal(response.body.data.id, replay.body.data.id);
    assert.equal((await q('SELECT source_snapshot FROM handyman_tenant_payment_receipts WHERE id=$1', [response.body.data.id])).rows[0]
      .source_snapshot.payment.obligationStage, 'PELUNASAN');
    assert.equal((await q('SELECT count(*)::int n FROM handyman_tenant_payment_receipts')).rows[0].n, 3);
  });

  it('accepts an independent reconciliation after self-confirmation and records corrections as separate facts', async () => {
    const paymentId = await record('DP', '11.00'), decision = await confirm(paymentId, admin);
    await assert.rejects(issueTenantPaymentReceipt(admin, ref(paymentId)), err('HANDYMAN_TENANT_RECEIPT_CONFLICT'));
    await reconcileHandymanPayment(scope.id, paymentId, { bankReference: key(),
      actualReceivedAt: new Date(Date.parse(decision.payment.decidedAt!) - 1000).toISOString(), idempotencyKey: key() }, verifier);
    const issued = await issueTenantPaymentReceipt(admin, ref(paymentId));
    const row = (await q('SELECT source_snapshot FROM handyman_tenant_payment_receipts WHERE id=$1', [issued.id])).rows[0];
    assert.equal(row.source_snapshot.verification.basis, 'INDEPENDENT_RECONCILIATION');
    assert.equal(row.source_snapshot.verification.reconciliation.verifiedByUserId, verifier);
    const before = (await downloadTenantPaymentReceipt(admin, ref(dpId))).bytes;
    const correction = await reverseHandymanPaymentAllocation({ executionScopeId: scope.id, allocationId,
      reason: 'Separate governed correction', idempotencyKey: key() }, admin);
    assert.ok(correction.correction.id); assert.deepEqual((await downloadTenantPaymentReceipt(admin, ref(dpId))).bytes, before);
    assert.equal((await q('SELECT source_snapshot FROM handyman_tenant_payment_receipts WHERE payment_id=$1', [dpId])).rows[0].source_snapshot.corrections.length, 0);
    const corrected = await record('TERMIN', '5.00'); await confirm(corrected);
    const allocation = await allocateHandymanCustomerPayment({ executionScopeId: scope.id, paymentId: corrected,
      chargeLineId: chargeId, amount: '5.00', idempotencyKey: key() }, admin);
    const reversal = await reverseHandymanPaymentAllocation({ executionScopeId: scope.id, allocationId: allocation.allocation.id,
      reason: 'Earlier correction', idempotencyKey: key() }, admin);
    const correctedReceipt = await issueTenantPaymentReceipt(admin, ref(corrected));
    const correctedSource = (await q('SELECT source_snapshot FROM handyman_tenant_payment_receipts WHERE id=$1', [correctedReceipt.id])).rows[0].source_snapshot;
    assert.equal(correctedSource.allocations[0].id, allocation.allocation.id);
    assert.equal(correctedSource.corrections[0].id, reversal.correction.id);
    assert.equal(correctedSource.corrections[0].kind, 'REVERSAL');
  });

  it('serves byte-identical PDFs only to authorized scoped Customer Care, including workspace occupancy and revocation', async () => {
    const direct = await api().get(`${base(dpId)}.pdf`).set('Authorization', `Bearer ${careToken}`).buffer(true);
    assert.equal(direct.status, 200); assert.equal(direct.headers['content-type'], 'application/pdf');
    assert.equal(direct.headers['x-content-sha256'], dpReceipt.pdfChecksum); assert.equal(direct.headers['cache-control'], 'private, no-store');
    const parallelReads = await Promise.all(Array.from({ length: 12 }, () => downloadTenantPaymentReceipt(care, ref(dpId))));
    assert.ok(parallelReads.every(read => read.pdfChecksum === dpReceipt.pdfChecksum));
    const denied = await api().get(`${base(dpId)}.pdf`).set('Authorization', `Bearer ${outsiderToken}`);
    assert.equal(denied.status, 403);
    const workspace = await api().get(workspacePath(dpId)).query(selection()).set('Authorization', `Bearer ${workspaceToken}`).buffer(true);
    assert.equal(workspace.status, 200, JSON.stringify(workspace.body)); assert.deepEqual(workspace.body, direct.body);
    assert.equal((await api().get(workspacePath(dpId)).query({ ...selection(), tenantCompanyId: id() })
      .set('Authorization', `Bearer ${workspaceToken}`)).status, 404);
    assert.equal((await api().get(workspacePath(dpId)).query({ ...selection(), spaceId: id() })
      .set('Authorization', `Bearer ${workspaceToken}`)).status, 404);
    assert.equal((await api().get(workspacePath(id())).query(selection()).set('Authorization', `Bearer ${workspaceToken}`)).status, 404);
    assert.equal((await api().get(`/api/v1/handyman/care/requests/${scope.handymanRequestId}/invoices/${invoiceId}/payments/${termId}/receipt.pdf`)
      .query(selection()).set('Authorization', `Bearer ${workspaceToken}`)).status, 200);
    // A later invoice cannot retroactively relabel an earlier pre-invoice receipt.
    assert.equal((await api().get(`/api/v1/handyman/care/requests/${scope.handymanRequestId}/invoices/${invoiceId}/payments/${dpId}/receipt.pdf`)
      .query(selection()).set('Authorization', `Bearer ${workspaceToken}`)).status, 404);
    await revokeCareActorProperty({ careActorId: careActor, propertyId: realm.property.id, clientId: realm.client.id }, admin);
    assert.equal((await api().get(workspacePath(dpId)).query(selection()).set('Authorization', `Bearer ${workspaceToken}`)).status, 404);
  });

  it('keeps immutable checksum-verified artifacts after issuer changes and a database restart', async () => {
    const original = await downloadTenantPaymentReceipt(admin, ref(dpId));
    await updateHandymanDocumentIssuerProfile(issuerContent('PT Later Issuer', 1), admin);
    assert.deepEqual((await downloadTenantPaymentReceipt(admin, ref(dpId))).bytes, original.bytes);
    assert.equal((await issueTenantPaymentReceipt(admin, ref(dpId))).id, dpReceipt.id);
    await assert.rejects(q('UPDATE handyman_tenant_payment_receipts SET pdf_filename=$2 WHERE id=$1', [dpReceipt.id, 'changed.pdf']), /immutable/);
    await assert.rejects(q('DELETE FROM handyman_tenant_payment_receipts WHERE id=$1', [dpReceipt.id]), /immutable/);
    await assert.rejects(q('TRUNCATE handyman_tenant_payment_receipts'), /immutable/);
    assert.equal(await migrateDown(pool), '0508_handyman_inspection_work_links');
    try { await assert.rejects(migrateDown(pool), /Refusing to remove issued tenant payment receipts/); }
    finally { await migrateUp(pool); }
    await closePool(pool); await db.pg.stop(); await db.pg.start();
    const config = await ensureTestDatabase(); assert.ok(config); pool = await initDatabase(config);
    const downloaded = await downloadTenantPaymentReceipt(care, ref(dpId));
    assert.deepEqual(downloaded.bytes, original.bytes); assert.equal(sha(downloaded.bytes), dpReceipt.pdfChecksum);
  });
});
