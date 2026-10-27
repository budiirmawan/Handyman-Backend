import assert from 'node:assert/strict';
import { randomUUID as id } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { resetAppConfigCache } from '../src/config';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { initHandymanFixtures, realmFixture, locationChain, crewFixture } from './helpers/handyman-fixtures';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { credentialService } from '../src/modules/auth';
import { userService } from '../src/modules/users';
import { roleService } from '../src/modules/roles';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { serviceCatalogService } from '../src/modules/service-catalog';
import {
  handymanServiceRequestService, handymanServiceRequestTriageService,
  handymanServiceRequestDiagnosisService,
} from '../src/modules/handyman-requests';
import {
  addHandymanQuotationLine, createHandymanQuotation, createHandymanQuotationRevision,
  decideHandymanQuotation, issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import {
  updateHandymanDocumentIssuerProfile, updateHandymanDocumentSettings,
  createHandymanDocumentBankAccount, activateHandymanDocumentBankAccount,
} from '../src/modules/handyman-documents';

// One isolated, fully migrated PostgreSQL database; no RBAC, issuance,
// quotation-decision or evidence-service mocks. Mutations below use real bearer
// sessions, a current assigned Lead, an Operations actor and the actual PIC.
const PORT = 55978;
const DIR = `/tmp/handyman-variation-execution-pg-${process.pid}`;
const STORAGE = `/tmp/handyman-variation-execution-evidence-${process.pid}`;
const PASSWORD = 'ExecutionTestPass123';
const validUntil = () => new Date(Date.now() + 86_400_000).toISOString();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let db: Awaited<ReturnType<typeof startEmbeddedTestDatabase>> | undefined;
let pool: Pool;
let admin: string, adminToken: string, leadToken: string, picToken: string;
let realm: Awaited<ReturnType<typeof realmFixture>>;
let scope: string, quotationId: string, originalVersion: string;
let originalA: string, originalB: string, originalLabor: string, uom: string;
let evidence: string, materialA: string;
let firstReduce: string, rejectedAdd: string;
let rejectedVersion: string;

function responseData(response: any, status = 200) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body.data;
}
function rejection(response: any, status: number, code: string, reason?: string) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code, JSON.stringify(response.body));
  if (reason) assert.match(JSON.stringify(response.body), new RegExp(reason));
}
const materials = () => `/api/v1/handyman/execution-scopes/${scope}/material-lines`;
const opsVariations = () => `/api/v1/handyman/execution-scopes/${scope}/variations`;
const fieldVariations = () => `/api/v1/handyman/field/execution-scopes/${scope}/variations`;
function post(url: string, token: string, body: Record<string, unknown>) {
  return api().post(url).set(auth(token)).send(body);
}
const key = () => id();
async function material(lineId: string, action: string, quantity?: number, idempotencyKey = key(), token = leadToken) {
  return post(`${materials()}/${lineId}/${action}`, token, {
    ...(quantity === undefined ? {} : { quantity }), idempotencyKey,
  });
}
async function estimate(versionId: string, lineId: string, quantity: number, idempotencyKey = key()) {
  return post(`${materials()}/estimate`, leadToken, {
    quotationVersionId: versionId, quotationLineId: lineId, estimatedQty: quantity, idempotencyKey,
  });
}
async function proposal(type: 'ADD' | 'REDUCE', quantity: number, target?: string) {
  const body = { variationType: type, lineType: 'MATERIAL', quantity, uomId: uom,
    ...(target ? { targetQuotationLineId: target } : {}), title: `${type} pipe material`,
    description: 'Changed pipe material scope', technicalFinding: 'Verified site condition',
    evidenceReference: evidence, idempotencyKey: key(), quotedUnitAmount: 999999 };
  const created = responseData(await post(`${fieldVariations()}/proposals`, leadToken, body), 201);
  assert.equal(created.variation.quotedUnitAmount, undefined, 'field projection exposes no price');
  const row = await pool.query('SELECT quoted_unit_amount FROM handyman_scope_variations WHERE id=$1', [created.variation.id]);
  assert.equal(row.rows[0].quoted_unit_amount, null, 'field cannot author price');
  return created.variation.id as string;
}
async function operation(variationId: string, action: string, body: Record<string, unknown>, token = adminToken) {
  return post(`${opsVariations()}/${variationId}/${action}`, token, { idempotencyKey: key(), ...body });
}
async function review(variationId: string) {
  responseData(await operation(variationId, 'operations-review', { expectedVersion: 1 }));
}
async function addQuoteLine(version: string, type: 'LABOR' | 'MATERIAL', qty: number, price: number, name: string) {
  return addHandymanQuotationLine(version, { lineType: type, description: name, quantity: qty,
    uomId: uom, currency: 'IDR', finalQuotedUnitAmount: price }, admin);
}
// A real issued revised quote with the exact cumulative amount; these lines do
// not by themselves establish an ADD-to-execution identity (the blocker).
async function revision(a: number, b: number, add = false) {
  const v = await createHandymanQuotationRevision(quotationId, admin);
  await addQuoteLine(v.id, 'LABOR', 1, 100, 'Original labor');
  await addQuoteLine(v.id, 'MATERIAL', a, 25, 'Original material A');
  await addQuoteLine(v.id, 'MATERIAL', b, 25, 'Original material B');
  const added = add ? await addQuoteLine(v.id, 'MATERIAL', 2, 30, 'Additional material') : null;
  await issueHandymanQuotationVersion(v.id, { validUntil: validUntil() }, admin);
  return { id: v.id, addedLine: added?.id };
}
async function prepare(variationId: string, versionId: string, amount: number) {
  responseData(await operation(variationId, 'revised-quotation', {
    expectedVersion: 2, revisedQuotationVersionId: versionId, quotedUnitAmount: amount, currency: 'IDR',
  }));
}
async function decision(variationId: string, versionId: string, outcome: 'APPROVED' | 'REJECTED') {
  responseData(await operation(variationId, 'tenant-decision', {
    expectedVersion: 3, revisedQuotationVersionId: versionId, decision: outcome, evidenceReference: evidence,
  }, picToken));
}
async function authorize(variationId: string) {
  responseData(await operation(variationId, 'authorize-scope', { expectedVersion: 4 }));
}
// Queue both authenticated commands behind a held scope lock. This makes the
// authorization-versus-ISSUE race deterministic rather than timing-dependent.
async function waitForScopeLockWaiters(count: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const waiting = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE '%FROM handyman_execution_scopes%FOR UPDATE%'`);
    if (waiting.rows[0].n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Expected ${count} command(s) waiting on the execution-scope lock`);
}

before(async () => {
  process.env.EVIDENCE_STORAGE_DIR = STORAGE;
  resetAppConfigCache();
  db = await startEmbeddedTestDatabase({ dir: DIR, port: PORT });
  pool = await initDatabase({ host: '127.0.0.1', port: PORT, name: 'asentra_test', user: 'postgres', password: '', ssl: false });
  await migrateUp(pool);
  const root = await createAdminUser(); admin = root.userId; adminToken = root.token;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN');
  assert.ok(discipline);
  initHandymanFixtures({ adminUserId: admin, disciplineId: discipline.id, query: (sql, values) => pool.query(sql, values) });
  realm = await realmFixture('Variation execution');
  const chain = await locationChain(realm);
  await clientMonetaryContextService.setClientMonetaryContext({ clientId: realm.client.id,
    baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR'] }, admin);
  const tenant = await tenantCompanyService.createTenantCompany({ clientId: realm.client.id,
    tenantCode: `T_${id().slice(0, 8).toUpperCase()}`, tenantName: 'Customer', legalName: 'PT Customer' }, admin);
  const customer = await userService.createUser({ email: `${id()}@variation.test`, displayName: 'Tenant PIC' });
  const picRole = await roleService.createRole({ code: `PIC_${id()}`, name: 'Tenant PIC' });
  const permission = await permissionRepository.findByCode('tenant_company.manage'); assert.ok(permission);
  await permissionService.assignPermissionToRole(picRole.id, permission.id);
  await roleService.assignRoleToUser(customer.id, picRole.id);
  await buildingAssignmentService.createAssignment(customer.id, { buildingId: realm.building.id });
  await credentialService.createInitialCredential({ userId: customer.id, password: PASSWORD });
  picToken = responseData(await api().post('/api/v1/auth/login').send({ email: customer.email, password: PASSWORD })).sessionToken;
  const pic = await tenantPicService.createTenantPic({ tenantCompanyId: tenant.id, picName: 'Customer PIC', userId: customer.id }, admin);
  await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: tenant.id, buildingId: realm.building.id, spaceId: chain.space.id }, admin);
  await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: tenant.id, buildingId: realm.building.id }, admin);
  const service = await serviceCatalogService.createServiceCatalogEntry({ clientId: realm.client.id,
    code: `S_${id().slice(0, 8).toUpperCase()}`, name: 'Pipe repair', category: 'HANDYMAN' }, admin);
  uom = id();
  await pool.query(`INSERT INTO units_of_measure(id,client_id,code,name,symbol,category)
    VALUES($1,$2,$3,'piece','pc','COUNT')`, [uom, realm.client.id, `U_${id().slice(0, 8).toUpperCase()}`]);
  const attr = await createChannelAttribution({ tenantCompanyId: tenant.id, buildingId: realm.building.id, tenantPicId: pic.id,
    spaceId: chain.space.id, originChannel: 'BM_SUPER_APP', originReference: `bm-handoff:BM_SUPER_APP:${id()}`,
    createdByUserId: customer.id });
  const request = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attr.id,
    serviceCatalogId: service.id, description: 'Repair pipes' }, admin);
  await handymanServiceRequestTriageService.recordHandymanRequestTriage({ handymanRequestId: request.id,
    triageDisposition: 'DIAGNOSIS', triageNote: 'Reviewed' }, admin);
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({ handymanRequestId: request.id,
    disciplineId: discipline.id, diagnosis: 'Replace damaged pipes' }, admin);
  await updateHandymanDocumentIssuerProfile({ clientId: realm.client.id, expectedVersion: null,
    legalName: 'PT Issuer', displayName: 'Handyman', registeredAddress: 'Jl. Merdeka 1', businessAddress: null,
    city: 'Jakarta', province: 'Jakarta', postalCode: '10110', email: 'issuer@example.test', phone: '+62 21 5000 1111',
    whatsapp: '+62 811 2000 3000', website: null, taxId: null, businessRegistrationId: null, logoReference: null }, admin);
  await updateHandymanDocumentSettings({ clientId: realm.client.id, documentKind: 'QUOTATION', language: 'id',
    expectedVersion: null, documentPrefix: 'QTN', termsLines: ['Work after approval'], paymentNote: null,
    warrantyNote: null, contactNote: null, footerNote: null, signatoryName: 'Manager', signatoryTitle: 'Operations' }, admin);
  const bank = await createHandymanDocumentBankAccount({ clientId: realm.client.id, bankCode: 'BANK', bankName: 'Test Bank',
    accountNumber: '1234567890', accountHolderName: 'PT Issuer', currency: 'IDR' }, admin);
  await activateHandymanDocumentBankAccount({ clientId: realm.client.id, bankAccountId: bank.bankAccountId,
    expectedVersion: bank.version, confirmAccountNumber: '1234567890', verificationReference: 'Verified bank statement',
    asDefault: true, authorizeReplacement: false }, admin);
  const quote = await createHandymanQuotation({ handymanRequestId: request.id }, admin);
  quotationId = quote.quotation.id; originalVersion = quote.versions[0].id;
  originalLabor = (await addQuoteLine(originalVersion, 'LABOR', 1, 100, 'Original labor')).id;
  originalA = (await addQuoteLine(originalVersion, 'MATERIAL', 10, 25, 'Original material A')).id;
  originalB = (await addQuoteLine(originalVersion, 'MATERIAL', 8, 25, 'Original material B')).id;
  await issueHandymanQuotationVersion(originalVersion, { validUntil: validUntil() }, admin);
  const originalDecision = await decideHandymanQuotation(originalVersion, { decision: 'APPROVE', tenantPicId: pic.id,
    idempotencyKey: key() }, customer.id);
  assert.ok(originalDecision.executionScope); scope = originalDecision.executionScope.id;
  const crew = await crewFixture(realm);
  await credentialService.createInitialCredential({ userId: crew.leadUser.id, password: PASSWORD });
  leadToken = responseData(await api().post('/api/v1/auth/login').send({ email: crew.leadUser.email, password: PASSWORD })).sessionToken;
  await assignHandymanExecutionScopeCrew({ executionScopeId: scope, providerContextId: crew.providerContext.id,
    crewId: crew.crew.id, idempotencyKey: key() }, admin);
  const upload = await api().post(`/api/v1/handyman/field/execution-scopes/${scope}/evidence/upload`)
    .set(auth(leadToken)).field('purpose', 'VARIATION_FINDING').field('idempotencyKey', key())
    .attach('file', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      { filename: 'site.png', contentType: 'image/png' });
  evidence = responseData(upload, 201).evidence.attachmentReference;
});

after(async () => {
  await closePool();
  if (db) await db.stop();
  await rm(STORAGE, { recursive: true, force: true });
  resetAppConfigCache();
});

describe('approved variation and real material execution', () => {
  it('serializes authorized REDUCE against issue/use, permits remaining work and preserves history and returns', async () => {
    const estimateKey = key();
    const created = responseData(await estimate(originalVersion, originalA, 10, estimateKey));
    materialA = created.line.id;
    assert.equal(created.line.approvedQty, 10);
    responseData(await material(materialA, 'approve'));
    const initialIssueKey = key();
    responseData(await material(materialA, 'issue', 6, initialIssueKey));
    rejection(await material(materialA, 'issue', 1, key(), picToken), 403, 'HANDYMAN_MATERIAL_EXECUTION_NOT_AUTHORIZED');
    rejection(await post(`${fieldVariations()}/proposals`, leadToken, { variationType: 'REDUCE', lineType: 'MATERIAL',
      targetQuotationLineId: originalLabor, quantity: 1, uomId: uom, title: 'Mismatch', description: 'Mismatch',
      technicalFinding: 'Mismatch', evidenceReference: evidence, idempotencyKey: key() }), 400,
    'HANDYMAN_VARIATION_TARGET_LINE_INVALID');
    firstReduce = await proposal('REDUCE', 4, originalA);
    responseData(await material(materialA, 'issue', 1)); // proposal alone cannot remove original authority
    rejection(await operation(firstReduce, 'operations-review', { expectedVersion: 1 }, leadToken), 403, 'HANDYMAN_VARIATION_ROLE_FORBIDDEN');
    rejection(await operation(firstReduce, 'operations-review', { expectedVersion: 2 }), 409, 'HANDYMAN_VARIATION_VERSION_CONFLICT');
    await review(firstReduce);
    const v2 = await revision(6, 8);
    rejection(await operation(firstReduce, 'revised-quotation', { expectedVersion: 2,
      revisedQuotationVersionId: v2.id, quotedUnitAmount: 25, currency: 'USD' }),
    409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    await prepare(firstReduce, v2.id, 25);
    rejection(await operation(firstReduce, 'authorize-scope', { expectedVersion: 3 }), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    rejection(await operation(firstReduce, 'tenant-decision', { expectedVersion: 3, revisedQuotationVersionId: v2.id,
      decision: 'APPROVED', evidenceReference: evidence }), 403, 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
    await decision(firstReduce, v2.id, 'APPROVED');
    responseData(await material(materialA, 'issue', 1)); // consent alone is not scope authorization
    const gate = await pool.connect();
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE', [scope]);
    let authorization!: Promise<any>, competingIssue!: Promise<any>;
    let committed = false;
    try {
      authorization = Promise.resolve(operation(firstReduce, 'authorize-scope', { expectedVersion: 4 }));
      await waitForScopeLockWaiters(1);
      competingIssue = Promise.resolve(material(materialA, 'issue', 0.001));
      await waitForScopeLockWaiters(2);
      await gate.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }
    const [authorized, refused] = await Promise.all([authorization, competingIssue]);
    responseData(authorized);
    rejection(refused, 400, 'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED', 'exceeds-remaining-scope-after-reduction');
    const issueReplay = responseData(await material(materialA, 'issue', 6, initialIssueKey));
    assert.equal(issueReplay.replayed, true); assert.equal(issueReplay.line.issuedQty, 8);
    assert.equal(responseData(await estimate(originalVersion, originalA, 10, estimateKey)).replayed, true);
    const useKey = key();
    assert.equal(responseData(await material(materialA, 'use', 4, useKey)).line.usedQty, 4);
    const raced = await Promise.all([material(materialA, 'use', 1.5), material(materialA, 'use', 1.5)]);
    assert.deepEqual(raced.map((r) => r.status).sort(), [200, 400]);
    rejection(raced.find((r) => r.status === 400), 400, 'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED', 'exceeds-remaining-scope-after-reduction');
    assert.equal(responseData(await material(materialA, 'use', 0.5)).line.usedQty, 6);
    rejection(await material(materialA, 'use', 0.001), 400, 'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED', 'exceeds-remaining-scope-after-reduction');
    const reduceAgain = await proposal('REDUCE', 3, originalA);
    await review(reduceAgain);
    const v3 = await revision(3, 8); await prepare(reduceAgain, v3.id, 25);
    await decision(reduceAgain, v3.id, 'APPROVED'); await authorize(reduceAgain);
    rejection(await material(materialA, 'use', 0.001), 400, 'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED', 'exceeds-remaining-scope-after-reduction');
    const replay = responseData(await material(materialA, 'use', 4, useKey));
    assert.equal(replay.replayed, true); assert.equal(replay.line.usedQty, 6);
    const returned = responseData(await material(materialA, 'return', 2));
    assert.equal(returned.line.returnedQty, 2); assert.equal(returned.line.usedQty, 6);
    const row = await pool.query('SELECT quantity FROM handyman_quotation_lines WHERE id=$1', [originalA]);
    assert.equal(Number(row.rows[0].quantity), 10, 'original quotation was not rewritten');
  });

  it('limits a new estimate and purchase to the remaining original material line', async () => {
    const v = await proposal('REDUCE', 2, originalB); await review(v);
    const v4 = await revision(3, 6); await prepare(v, v4.id, 25);
    await decision(v, v4.id, 'APPROVED'); await authorize(v);
    rejection(await estimate(originalVersion, originalB, 8), 400, 'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED', 'exceeds-remaining-scope-after-reduction');
    const line = responseData(await estimate(originalVersion, originalB, 6)).line;
    assert.equal(line.approvedQty, 8, 'snapshot quantity remains immutable');
    responseData(await material(line.id, 'approve'));
    rejection(await material(line.id, 'purchase', 7), 400, 'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED', 'exceeds-remaining-scope-after-reduction');
    const purchaseKey = key();
    assert.equal(responseData(await material(line.id, 'purchase', 6, purchaseKey)).line.purchasedQty, 6);
    assert.equal(responseData(await material(line.id, 'use', 6)).line.usedQty, 6);
    assert.equal(responseData(await material(line.id, 'purchase', 6, purchaseKey)).replayed, true);
  });

  it('does not pretend rejected or even approved ADD has a material execution binding', async () => {
    rejectedAdd = await proposal('ADD', 2); await review(rejectedAdd);
    const refusedOffer = await revision(3, 6, true); rejectedVersion = refusedOffer.id;
    assert.ok(refusedOffer.addedLine);
    await prepare(rejectedAdd, refusedOffer.id, 30);
    rejection(await estimate(refusedOffer.id, refusedOffer.addedLine!, 1), 409, 'HANDYMAN_MATERIAL_EXECUTION_LINK_INVALID', 'version-not-approved-snapshot');
    await decision(rejectedAdd, refusedOffer.id, 'REJECTED');
    rejection(await operation(rejectedAdd, 'authorize-scope', { expectedVersion: 4 }), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    rejection(await estimate(refusedOffer.id, refusedOffer.addedLine!, 1), 409, 'HANDYMAN_MATERIAL_EXECUTION_LINK_INVALID', 'version-not-approved-snapshot');
    const approvedAdd = await proposal('ADD', 2); await review(approvedAdd);
    rejection(await operation(approvedAdd, 'revised-quotation', { expectedVersion: 2,
      revisedQuotationVersionId: rejectedVersion, quotedUnitAmount: 30, currency: 'IDR' }), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    const offer = await revision(3, 6, true); assert.ok(offer.addedLine);
    await prepare(approvedAdd, offer.id, 30);
    rejection(await operation(approvedAdd, 'tenant-decision', { expectedVersion: 3,
      revisedQuotationVersionId: rejectedVersion, decision: 'APPROVED', evidenceReference: evidence }, picToken), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    await decision(approvedAdd, offer.id, 'APPROVED'); await authorize(approvedAdd);
    rejection(await estimate(offer.id, offer.addedLine!, 2), 409, 'HANDYMAN_MATERIAL_EXECUTION_LINK_INVALID', 'version-not-approved-snapshot');
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM handyman_material_execution_lines WHERE quotation_line_id=$1', [offer.addedLine]);
    assert.equal(count.rows[0].n, 0, 'no fabricated additional execution record');
  });

  it('documents the missing labor item binding rather than treating a generic session as item execution', async () => {
    const columns = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='handyman_work_sessions'`);
    const names = new Set(columns.rows.map((row) => row.column_name));
    assert.equal(names.has('variation_id'), false);
    assert.equal(names.has('quotation_line_id'), false);
    assert.equal(names.has('quantity'), false);
  });
});
