import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { resetAppConfigCache } from '../src/config';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { buildingService } from '../src/modules/buildings';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { openHandymanCustomerTransaction, composeHandymanChargeLine } from '../src/modules/handyman-customer-transactions';
import { recordHandymanCustomerPayment, confirmHandymanCustomerPayment } from '../src/modules/handyman-customer-payments';
import { allocateHandymanCustomerPayment } from '../src/modules/handyman-customer-payment-allocations';
import { reverseHandymanPaymentAllocation } from '../src/modules/handyman-customer-ledger-corrections';
import { createTenantCharge } from '../src/modules/tenant-charges';
import { createTenantInvoice, addTenantInvoiceLine, finalizeTenantInvoice } from '../src/modules/tenant-invoices';
import { recordInvoicePaymentStatus } from '../src/modules/invoice-payment-status';
import { handymanCareActorService, grantCareActorProperty } from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, resolveCareWorkspacePrincipal, signCareWorkspaceAssertion,
  type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { uploadCareHandymanPaymentProof, HANDYMAN_PAYMENT_PROOF_MAX_BYTES } from '../src/modules/handyman-care-workspace/care-workspace-payment-proof.service';
import { getCareWorkspaceOperationalProjection } from '../src/modules/handyman-care-workspace/care-workspace-operational.service';
import { startHandymanServiceWarranty } from '../src/modules/handyman-service-warranties';
import { addHandymanEvidenceFile, createHandymanEvidenceRecord } from '../src/modules/handyman-evidence-qc';
import { createEvidenceStorage, evidenceStorageKey } from '../src/modules/evidence/storage';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { createAdminUser } from './helpers/access';
import { initHandymanFixtures, realmFixture, locationChain, scopeFixture } from './helpers/handyman-fixtures';
import { arrangeGuardedBast } from './helpers/handyman-guarded-bast';

const ROOT = '/tmp/handyman-p0-contract-pg';
const DB_DIR = `${ROOT}/database`;
const STORAGE_DIR = `${ROOT}/evidence`;
const PORT = 55539;
const SECRET = 'p0-contract-care-workspace-secret';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const key = () => `p0-${randomUUID()}`;
let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let userId = '';
let userToken = '';
let principal: Awaited<ReturnType<typeof resolveCareWorkspacePrincipal>>;
let ungrantedPrincipal: Awaited<ReturnType<typeof resolveCareWorkspacePrincipal>>;
let careToken = '';
let careActorId = '';
let integrationCode = '';
let secretEnv = '';
let selection: { propertyId: string; tenantCompanyId: string; buildingId: string; spaceId: string };
let requestId = '';
let scopeId = '';
let invoiceId = '';
let paymentId = '';
let chargeLineId = '';
let chargeAmount = '';
const evidenceIds: string[] = [];

function careAssertion(): CareWorkspaceAssertion {
  return {
    purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode,
    assertionId: randomUUID(), issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 240_000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: 'p0-care-agent' },
  };
}

async function approvedLedger(realm: Awaited<ReturnType<typeof realmFixture>>, chain: Awaited<ReturnType<typeof locationChain>>) {
  const { scope } = await scopeFixture(realm, chain);
  assert.ok(scope);
  const ledger = await openHandymanCustomerTransaction({
    executionScopeId: scope.id, idempotencyKey: key(),
  }, userId);
  const line = await pool!.query<{ id: string }>(
    `SELECT id FROM handyman_quotation_lines
      WHERE quotation_version_id = $1 ORDER BY created_at, id LIMIT 1`,
    [scope.approvedQuotationVersionId]);
  assert.ok(line.rows[0]);
  const charge = await composeHandymanChargeLine({
    executionScopeId: scope.id, quotationLineId: line.rows[0].id,
    idempotencyKey: key(),
  }, userId);
  return { scope, transaction: ledger.transaction, chargeLine: charge.chargeLine };
}

async function invoiceFor(scope: Awaited<ReturnType<typeof approvedLedger>>['scope']) {
  return createTenantInvoice({
    tenantCompanyId: scope.tenantCompanyId,
    buildingId: scope.buildingId,
    spaceId: scope.spaceId!,
    invoiceNumber: `HM-${suffix()}`,
    invoiceDate: '2026-10-01', dueDate: '2026-11-01',
    currencyCode: 'IDR',
  }, userId);
}

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.EVIDENCE_STORAGE_DIR = STORAGE_DIR;
  if (process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true') {
    Object.assign(process.env, {
      DB_HOST: '127.0.0.1', DB_PORT: String(PORT), DB_USER: 'postgres',
      DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false',
    });
    await rm(ROOT, { recursive: true, force: true });
    await mkdir(DB_DIR, { recursive: true });
    postgres = new EmbeddedPostgres({ databaseDir: DB_DIR, port: PORT,
      user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
    await postgres.initialise(); await postgres.start();
    const admin = postgres.getPgClient('postgres', '127.0.0.1');
    await admin.connect(); await admin.query('CREATE DATABASE asentra_test'); await admin.end();
  }
  const config = await ensureTestDatabase();
  assert.ok(config, 'P0 contract tests require PostgreSQL');
  pool = await initDatabase(config); await migrateUp(pool);
  const admin = await createAdminUser(); userId = admin.userId; userToken = admin.token;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN');
  assert.ok(discipline, 'GENERAL_HANDYMAN discipline seed missing');
  initHandymanFixtures({ adminUserId: userId, disciplineId: discipline.id,
    query: async (text, params = []) => pool!.query(text, params) });

  const realm = await realmFixture('P0');
  const chain = await locationChain(realm);
  const ledger = await approvedLedger(realm, chain);
  scopeId = ledger.scope.id; chargeLineId = ledger.chargeLine.id;
  chargeAmount = String(ledger.chargeLine.amount);
  const request = await pool.query<{ handyman_request_id: string }>(
    'SELECT handyman_request_id FROM handyman_execution_scopes WHERE id = $1', [scopeId]);
  requestId = request.rows[0].handyman_request_id;
  selection = {
    propertyId: realm.property.id,
    tenantCompanyId: ledger.scope.tenantCompanyId,
    buildingId: ledger.scope.buildingId,
    spaceId: ledger.scope.spaceId!,
  };
  await clientMonetaryContextService.setClientMonetaryContext({
    clientId: realm.client.id, baseCurrencyCode: 'IDR',
    defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR', 'USD'],
  }, userId);

  integrationCode = `P0_${suffix()}`;
  const integrationId = (await handoffRuntimeRepository.createIntegration({
    integrationCode, displayName: 'P0 Care host',
  })).id;
  await handymanCareActorService.setIntegrationActorCapability({
    integrationId, capability: 'CUSTOMER_CARE',
  });
  careActorId = (await handymanCareActorService.createCareActor({
    integrationId, actorReference: 'p0-care-agent', displayName: 'Care Operator',
  })).id;
  await grantCareActorProperty({ careActorId, propertyId: realm.property.id,
    clientId: realm.client.id }, userId);
  const ungrantedActorReference = 'p0-ungranted-care-agent';
  await handymanCareActorService.createCareActor({
    integrationId, actorReference: ungrantedActorReference, displayName: 'Unassigned Care Operator',
  });
  secretEnv = handoffIntegrationSecretEnvName(integrationCode);
  process.env[secretEnv] = SECRET;
  const assertion = careAssertion();
  careToken = (await admitCareWorkspace(assertion, signCareWorkspaceAssertion(assertion, SECRET))).workspaceToken;
  principal = await resolveCareWorkspacePrincipal(careToken);
  const ungrantedAssertion: CareWorkspaceAssertion = {
    ...careAssertion(),
    actor: { type: 'CUSTOMER_CARE', actorReference: ungrantedActorReference },
  };
  const ungrantedToken = (await admitCareWorkspace(ungrantedAssertion,
    signCareWorkspaceAssertion(ungrantedAssertion, SECRET))).workspaceToken;
  ungrantedPrincipal = await resolveCareWorkspacePrincipal(ungrantedToken);

  // Invoice source linkage is exercised through the existing invoice engine.
  const draft = await invoiceFor(ledger.scope);
  invoiceId = draft.id;
  const linked = await addTenantInvoiceLine(invoiceId, {
    sourceType: 'HANDYMAN_CHARGE', sourceId: chargeLineId,
  }, userId);
  assert.equal(linked.handymanExecutionScopeId, scopeId);
  assert.equal(linked.lines[0].handymanChargeLineId, chargeLineId);
  assert.equal(linked.lines[0].amount, Number(chargeAmount));

  // A sibling-scope source and a mixed-source invoice both fail closed.
  const secondInvoice = await invoiceFor(ledger.scope);
  await assert.rejects(() => addTenantInvoiceLine(secondInvoice.id, {
    sourceType: 'HANDYMAN_CHARGE', sourceId: chargeLineId,
  }, userId), (error: any) => error.statusCode === 409);
  const foreignRealm = await realmFixture('P0-Foreign');
  const foreignChain = await locationChain(foreignRealm);
  const foreignLedger = await approvedLedger(foreignRealm, foreignChain);
  await assert.rejects(() => addTenantInvoiceLine(invoiceId, {
    sourceType: 'HANDYMAN_CHARGE', sourceId: foreignLedger.chargeLine.id,
  }, userId), (error: any) => error.statusCode === 400);
  const tenantCharge = await createTenantCharge({
    tenantCompanyId: ledger.scope.tenantCompanyId,
    buildingId: ledger.scope.buildingId, spaceId: ledger.scope.spaceId!,
    chargeType: 'RENTAL_SERVICE', description: 'Non-Handyman source',
    amount: 1, currencyCode: 'IDR', chargeDate: '2026-10-01',
  }, userId);
  const mixedInvoice = await invoiceFor(ledger.scope);
  await addTenantInvoiceLine(mixedInvoice.id, { sourceType: 'TENANT_CHARGE', sourceId: tenantCharge.id }, userId);
  await assert.rejects(() => pool!.query(
    'UPDATE tenant_invoices SET handyman_execution_scope_id = $2 WHERE id = $1',
    [mixedInvoice.id, scopeId]), (error: any) => error.code === '23514');
});

after(async () => {
  if (secretEnv) delete process.env[secretEnv];
  if (pool) await closePool(pool);
  if (postgres) {
    await postgres.stop();
    await rm(ROOT, { recursive: true, force: true });
  }
  pool = null; postgres = null;
  delete process.env.EVIDENCE_STORAGE_DIR;
  resetAppConfigCache();
});

describe('ARENA Handyman P0 contract boundaries', () => {
  it('uploads one pending-claim proof via Care, denies unsafe rebinding, and replays idempotently', async (t) => {
    if (!pool) { t.skip('PostgreSQL unavailable'); return; }
    const payment = await recordHandymanCustomerPayment({
      executionScopeId: scopeId, amount: chargeAmount, channel: 'BANK_TRANSFER',
      externalReference: `p0-${randomUUID()}`, providerName: 'Test bank',
      idempotencyKey: key(),
    }, userId);
    paymentId = payment.payment.id;
    assert.equal(payment.payment.status, 'PENDING');
    const early = await recordHandymanCustomerPayment({
      executionScopeId: scopeId, amount: chargeAmount, channel: 'BANK_TRANSFER',
      externalReference: `p0-draft-${randomUUID()}`, idempotencyKey: key(),
    }, userId);
    await confirmHandymanCustomerPayment({
      executionScopeId: scopeId, paymentId: early.payment.id, idempotencyKey: key(),
    }, userId);
    await assert.rejects(() => allocateHandymanCustomerPayment({
      executionScopeId: scopeId, paymentId: early.payment.id,
      chargeLineId, amount: chargeAmount, idempotencyKey: key(),
    }, userId), (error: any) => error.statusCode === 409);
    assert.equal((await pool!.query('SELECT count(*)::int AS n FROM handyman_payment_allocations WHERE payment_id = $1',
      [early.payment.id])).rows[0].n, 0);
    const finalized = await finalizeTenantInvoice(invoiceId, userId);
    assert.equal(finalized.status, 'FINALIZED');

    const file = Buffer.from('\x89PNG\r\n\x1a\nP0 proof bytes');
    const input = {
      principal, selection, requestId, invoiceId, paymentId,
      evidenceType: 'PHOTO',
      file: { buffer: file, mimetype: 'image/png', originalname: 'payment.png', size: file.length },
    } as const;
    await assert.rejects(() => uploadCareHandymanPaymentProof({
      ...input, principal: ungrantedPrincipal,
    }), (error: any) => error.statusCode === 404);
    assert.equal((await pool!.query(
      `SELECT count(*)::int AS n FROM evidence_submissions
        WHERE execution_type = 'HANDYMAN_CUSTOMER_PAYMENT' AND execution_id = $1`,
      [paymentId])).rows[0].n, 0);
    const uploaded = await uploadCareHandymanPaymentProof(input);
    assert.equal(uploaded.replayed, false);
    assert.equal(uploaded.proof.executionId, paymentId);
    assert.equal(uploaded.proof.evidenceType, 'PHOTO');
    assert.equal(uploaded.proof.contentSha256.length, 64);
    evidenceIds.push(String(uploaded.proof.id));
    const replay = await uploadCareHandymanPaymentProof(input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.proof.id, uploaded.proof.id);

    await assert.rejects(() => uploadCareHandymanPaymentProof({
      ...input, file: { ...input.file, buffer: Buffer.from('different proof'), size: 15 },
    }), (error: any) => error.statusCode === 409);
    await assert.rejects(() => uploadCareHandymanPaymentProof({
      ...input, invoiceId: randomUUID(),
    }), (error: any) => error.statusCode === 404);
    await assert.rejects(() => uploadCareHandymanPaymentProof({
      ...input, paymentId: randomUUID(),
    }), (error: any) => error.statusCode === 404);
    await assert.rejects(() => uploadCareHandymanPaymentProof({
      ...input, evidenceType: 'SIGNATURE',
    }), (error: any) => error.statusCode === 400);
    await assert.rejects(() => uploadCareHandymanPaymentProof({
      ...input, file: { ...input.file, buffer: Buffer.alloc(HANDYMAN_PAYMENT_PROOF_MAX_BYTES + 1),
        size: HANDYMAN_PAYMENT_PROOF_MAX_BYTES + 1 },
    }), (error: any) => error.statusCode === 400);
    await assert.rejects(() => resolveCareWorkspacePrincipal('not-a-care-token'),
      (error: any) => error.statusCode === 401);

    const counts = await pool.query<{ proofs: number; allocations: number; paymentStatus: string; invoiceStatus: string }>(
      `SELECT (SELECT count(*)::int FROM evidence_submissions
                WHERE execution_type = 'HANDYMAN_CUSTOMER_PAYMENT' AND execution_id = $1) AS proofs,
              (SELECT count(*)::int FROM handyman_payment_allocations WHERE payment_id = $1) AS allocations,
              (SELECT status FROM handyman_customer_payments WHERE id = $1) AS "paymentStatus",
              (SELECT status FROM tenant_invoices WHERE id = $2) AS "invoiceStatus"`,
      [paymentId, invoiceId]);
    assert.equal(counts.rows[0].proofs, 1);
    assert.equal(counts.rows[0].allocations, 0);
    assert.equal(counts.rows[0].paymentStatus, 'PENDING');
    assert.equal(counts.rows[0].invoiceStatus, 'FINALIZED');

    // The legacy generic User file door cannot overwrite this proof.
    const genericUpload = await api().post(`/api/v1/evidence/${uploaded.proof.id}/file`)
      .set({ Authorization: `Bearer ${userToken}` })
      .attach('file', file, { filename: 'payment.png', contentType: 'image/png' });
    assert.equal(genericUpload.status, 404, JSON.stringify(genericUpload.body));
    const genericMetadata = await api().get(`/api/v1/evidence/${uploaded.proof.id}`)
      .set({ Authorization: `Bearer ${userToken}` });
    assert.equal(genericMetadata.status, 404, JSON.stringify(genericMetadata.body));
    const genericContent = await api().get(`/api/v1/evidence/${uploaded.proof.id}/file/content`)
      .set({ Authorization: `Bearer ${userToken}` });
    assert.equal(genericContent.status, 404, JSON.stringify(genericContent.body));
    const genericRemove = await api().patch(`/api/v1/evidence/${uploaded.proof.id}`)
      .set({ Authorization: `Bearer ${userToken}` });
    assert.equal(genericRemove.status, 404, JSON.stringify(genericRemove.body));
    const genericList = await api().get('/api/v1/evidence')
      .set({ Authorization: `Bearer ${userToken}` }).query({ executionId: paymentId });
    assert.equal(genericList.status, 200, JSON.stringify(genericList.body));
    assert.equal(genericList.body.data.some((row: { id: string }) => row.id === uploaded.proof.id), false);
  });

  it('allocates confirmed funds, derives invoice balance exactly, and nets reversed allocations', async (t) => {
    if (!pool) { t.skip('PostgreSQL unavailable'); return; }
    const payment = await recordHandymanCustomerPayment({
      executionScopeId: scopeId, amount: chargeAmount, channel: 'BANK_TRANSFER',
      externalReference: `p0-alloc-${randomUUID()}`, idempotencyKey: key(),
    }, userId);
    const confirmed = await confirmHandymanCustomerPayment({
      executionScopeId: scopeId, paymentId: payment.payment.id, idempotencyKey: key(),
    }, userId);
    assert.equal(confirmed.payment.status, 'CONFIRMED');
    assert.equal((await pool!.query('SELECT status FROM tenant_invoices WHERE id = $1', [invoiceId])).rows[0].status, 'FINALIZED');
    const allocation = await allocateHandymanCustomerPayment({
      executionScopeId: scopeId, paymentId: payment.payment.id,
      chargeLineId, amount: chargeAmount, idempotencyKey: key(),
    }, userId);
    assert.equal(allocation.replayed, false);
    assert.equal(allocation.chargeLineOutstanding, '0.00');
    const replay = await allocateHandymanCustomerPayment({
      executionScopeId: scopeId, paymentId: payment.payment.id,
      chargeLineId, amount: chargeAmount, idempotencyKey: allocation.allocation.idempotencyKey,
    }, userId);
    assert.equal(replay.replayed, true);
    await assert.rejects(() => recordInvoicePaymentStatus({
      invoiceId, paidAmount: Number(chargeAmount), paidAt: new Date(),
    }, userId), (error: any) => error.statusCode === 400);

    const projection = await getCareWorkspaceOperationalProjection(careToken, requestId, selection);
    assert.equal((projection.invoicePayment as any).paymentStatus.status, 'PAID');
    assert.equal((projection.invoicePayment as any).paymentStatus.appliedAmount, chargeAmount);
    assert.equal((projection.invoicePayment as any).paymentStatus.allocatedAmount, chargeAmount);
    assert.equal((projection.invoicePayment as any).paymentStatus.reversedAllocationAmount, '0.00');
    assert.equal((projection.invoicePayment as any).payments.length, 3);
    assert.ok((projection.activityTimeline as unknown[]).length <= 100);

    await reverseHandymanPaymentAllocation({
      executionScopeId: scopeId, allocationId: allocation.allocation.id,
      reason: 'P0 reversal projection test', idempotencyKey: key(),
    }, userId);
    const netProjection = await getCareWorkspaceOperationalProjection(careToken, requestId, selection);
    const paymentStatus = (netProjection.invoicePayment as any).paymentStatus;
    assert.equal(paymentStatus.status, 'UNPAID');
    assert.equal(paymentStatus.allocatedAmount, chargeAmount);
    assert.equal(paymentStatus.reversedAllocationAmount, chargeAmount);
    assert.equal(paymentStatus.appliedAmount, '0.00');
    assert.equal(paymentStatus.outstandingAmount, chargeAmount);
    const reversedPayment = (netProjection.invoicePayment as any).payments
      .find((row: { id: string }) => row.id === payment.payment.id);
    assert.equal(reversedPayment.allocatedToInvoice, '0.00');
  });

  it('rereads persisted request items, quotation, QC/BAST, warranty and safe evidence metadata through exact Care scope', async (t) => {
    if (!pool) { t.skip('PostgreSQL unavailable'); return; }
    const arranged = await arrangeGuardedBast({
      adminUserId: userId,
      q: async (text, params = []) => pool!.query(text, params),
      until: 'ACCEPTED',
      includeStructuredRequestItem: true,
    });
    await startHandymanServiceWarranty({ executionScopeId: arranged.scope.id,
      idempotencyKey: key() }, userId);
    const evidence = await createHandymanEvidenceRecord({
      executionScopeId: arranged.scope.id, stage: 'AFTER', idempotencyKey: key(),
    }, arranged.crew.leadUser.id);
    const privateEvidenceBytes = Buffer.from('private Care evidence bytes must never enter this projection');
    const privateEvidenceKey = evidenceStorageKey(randomUUID());
    await createEvidenceStorage().put(privateEvidenceKey, { buffer: privateEvidenceBytes, mimeType: 'image/png' });
    await addHandymanEvidenceFile({
      evidenceRecordId: evidence.record.id, mediaKind: 'PHOTO',
      storageKey: privateEvidenceKey, contentType: 'image/png', byteSize: privateEvidenceBytes.byteLength,
      sha256Digest: createHash('sha256').update(privateEvidenceBytes).digest('hex'),
      captureTime: new Date().toISOString(), idempotencyKey: key(),
    }, arranged.crew.leadUser.id);
    await grantCareActorProperty({ careActorId, propertyId: arranged.realm.property.id,
      clientId: arranged.realm.client.id }, userId);
    const assertion = careAssertion();
    const workspace = await admitCareWorkspace(assertion,
      signCareWorkspaceAssertion(assertion, SECRET));
    const selected = {
      propertyId: arranged.realm.property.id,
      tenantCompanyId: arranged.scope.tenantCompanyId,
      buildingId: arranged.scope.buildingId,
      spaceId: arranged.scope.spaceId!,
    };
    const projection = await getCareWorkspaceOperationalProjection(
      workspace.workspaceToken, arranged.scope.handymanRequestId, selected);
    assert.deepEqual(projection.documentAvailability,
      { quotation: 'PRESENT', bast: 'PRESENT', warranty: 'PRESENT' });
    const item = (projection.request as any).items[0];
    assert.ok(item);
    const persistedItem = await pool!.query(`SELECT id, service_catalog_id, quantity::text,
        item_description, attribute_values FROM handyman_service_request_items
      WHERE handyman_request_id = $1 AND status = 'ACTIVE' ORDER BY created_at, id LIMIT 1`,
    [arranged.scope.handymanRequestId]);
    assert.equal(item.id, persistedItem.rows[0].id);
    assert.equal(item.serviceCatalogId, persistedItem.rows[0].service_catalog_id);
    assert.equal(item.quantity, persistedItem.rows[0].quantity);
    assert.equal(Number(item.quantity), 1);
    assert.equal(item.itemDescription, 'Existing persisted structured request item');
    const quotation = projection.quotation as any;
    assert.ok(quotation?.versions.length);
    assert.ok(quotation.versions[0].lines.length);
    const qc = (projection.quality as any).qcRuns.find((row: any) => row.id === arranged.qcRunId);
    assert.equal(qc.status, 'PASSED');
    const bast = (projection.bast as any[]).find(row => row.id === arranged.bastId);
    assert.equal(bast.status, 'ACCEPTED');
    assert.equal(bast.serviceRequestId, arranged.scope.handymanRequestId);
    assert.ok(bast.workSessions.length);
    assert.ok(bast.signOffs.some((signOff: any) => signOff.decision === 'ACCEPT' && signOff.signerUserId));
    const warranty = projection.warranty as any;
    assert.equal(warranty.status, 'ACTIVE');
    assert.equal(warranty.bastId, arranged.bastId);
    assert.equal(warranty.coveredRequestItems[0].requestItemId, item.id);
    const fileMetadata = (projection.quality as any).evidence.flatMap((row: any) => row.files);
    assert.ok(fileMetadata.length);
    for (const file of fileMetadata) {
      assert.match(file.sha256Digest, /^[0-9a-f]{64}$/);
      assert.equal(Object.keys(file).some(key => /^content$|fileReference|storageKey|url/i.test(key)), false);
    }
    const serialized = JSON.stringify(projection);
    for (const secret of [workspace.workspaceToken, SECRET, privateEvidenceBytes.toString(),
      privateEvidenceBytes.toString('base64'), 'fileReference', 'storageKey', 'signedUrl']) {
      assert.equal(serialized.includes(secret), false);
    }
    const otherBuilding = await buildingService.createBuilding({
      propertyId: arranged.realm.property.id, code: `CARE_${suffix()}`,
      name: 'Different building in the same property',
    });
    await assert.rejects(() => getCareWorkspaceOperationalProjection(
      workspace.workspaceToken, arranged.scope.handymanRequestId, {
        ...selected, buildingId: otherBuilding.id,
      }), (error: any) => error.statusCode === 404);
    const foreign = await realmFixture('projection-foreign');
    await assert.rejects(() => getCareWorkspaceOperationalProjection(
      workspace.workspaceToken, arranged.scope.handymanRequestId, {
        ...selected, propertyId: foreign.property.id, buildingId: foreign.building.id,
      }), (error: any) => error.statusCode === 404);
  });

  it('enforces the payment-proof parent binding in PostgreSQL, not only in Care service code', async (t) => {
    if (!pool) { t.skip('PostgreSQL unavailable'); return; }
    const id = randomUUID();
    await assert.rejects(() => pool!.query(
      `INSERT INTO evidence_submissions (
         id, client_id, evidence_requirement_id, execution_type, execution_id,
         evidence_type, file_reference, original_file_name, mime_type, file_size,
         submitted_by_user_id, content_sha256, content_hashed_at, hash_algorithm)
       VALUES ($1, $2, NULL, 'HANDYMAN_CUSTOMER_PAYMENT', $3,
         'PHOTO', $4, 'forged.png', 'image/png', 4, NULL, repeat('a',64), NOW(), 'SHA-256')`,
      [id, randomUUID(), paymentId,
        evidenceStorageKey(id)]), (error: any) => error.code === '23514');
    const absent = await pool!.query('SELECT 1 FROM evidence_submissions WHERE id = $1', [id]);
    assert.equal(absent.rowCount, 0);
  });
});
