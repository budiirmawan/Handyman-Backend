import assert from 'node:assert/strict';
import { createHash, randomUUID as id } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { resetAppConfigCache } from '../src/config';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { initHandymanFixtures, realmFixture, locationChain, crewFixture } from './helpers/handyman-fixtures';
import { releaseDispatchFixture } from './helpers/handyman-dispatch';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { credentialService } from '../src/modules/auth';
import { userService } from '../src/modules/users';
import { roleService } from '../src/modules/roles';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { workOrderService } from '../src/modules/work-orders';
import { handymanDispatchService } from '../src/modules/handyman-dispatch';
import { createHandymanArrivalChallenge } from '../src/modules/handyman-arrival-challenges';
import { createHandymanArrivalLocationIdentifier } from '../src/modules/handyman-arrival-locations';
import { evaluateHandymanArrivalVerification } from '../src/modules/handyman-arrival-results';
import { saveHandymanBuildingGeospatialPolicy } from '../src/modules/handyman-geospatial-policies';
import { addHandymanCrewMember, handymanWorkerContextService } from '../src/modules/handyman-providers';
import { workforceService } from '../src/modules/workforce';
import { assignBuildingToWorkforce } from '../src/modules/workforce-building-assignments';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { inventoryItemService } from '../src/modules/inventory-items';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { grantCareActorProperty, revokeCareActorProperty, handymanCareActorService } from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { stableJson } from '../src/shared/stable-json';
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
let workOrder: string, foreignWorkOrder: string, materialItem: string;
let approvedAdd: string, addLine: string, approvedVersionId: string;
let crewId: string, leadUserId: string, leadWorkerId: string, helperToken: string;
let chain: Awaited<ReturnType<typeof locationChain>>;
let requestId: string, tenantId: string, careLocalToken: string, careToken: string, careActor: string, integrationCode: string;
let firstOfferBytes: Buffer, firstOfferHash: string;
const offerPins = new Map<string, { offerDocumentId: string; offerDocumentVersion: number; offerPdfSha256: string }>();
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const careSelection = () => ({ propertyId: realm.property.id, tenantCompanyId: tenantId, buildingId: realm.building.id, spaceId: chain.space.id });
const carePath = (variationId: string) => `/api/v1/handyman/care/requests/${requestId}/variations/${variationId}/offer.pdf`;
const localPath = (variationId: string) => `${opsVariations()}/${variationId}/offer.pdf`;

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
async function estimate(versionId: string, lineId: string, quantity: number, idempotencyKey = key(),
  binding?: { variationId: string; approvedVariationVersion: number; workOrderId?: string }) {
  return post(`${materials()}/estimate`, leadToken, {
    quotationVersionId: versionId, quotationLineId: lineId, estimatedQty: quantity, idempotencyKey, ...binding,
  });
}
async function proposal(type: 'ADD' | 'REDUCE', quantity: number, target?: string, lineType: 'LABOR' | 'MATERIAL' = 'MATERIAL') {
  const body = { variationType: type, lineType, quantity, uomId: uom,
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
async function addQuoteLine(version: string, type: 'LABOR' | 'MATERIAL', qty: number, price: number, name: string, sourceItemId?: string) {
  return addHandymanQuotationLine(version, { lineType: type, description: name, quantity: qty,
    uomId: uom, currency: 'IDR', finalQuotedUnitAmount: price, ...(sourceItemId ? { sourceItemId } : {}) }, admin);
}
// Real revisions contain original scope and separately identified additions.
async function revision(a: number, b: number, add = false, oneOff = false, extraLabor: Array<{ qty: number; price: number; name: string }> = [], withDp = false) {
  const v = await createHandymanQuotationRevision(quotationId, admin, withDp
    ? { dpRequired: true, dpPercentage: 20, dpTermsNotes: 'Deposit after Tenant approval' } : { dpRequired: false });
  const labor = await addQuoteLine(v.id, 'LABOR', 1, 100, 'Original labor');
  const lineA = await addQuoteLine(v.id, 'MATERIAL', a, 25, 'Original material A');
  await addQuoteLine(v.id, 'MATERIAL', b, 25, 'Original material B');
  const added = add ? await addQuoteLine(v.id, 'MATERIAL', 2, 30, 'Additional material', materialItem) : null;
  const oneOffLine = oneOff ? await addQuoteLine(v.id, 'MATERIAL', 0.3, 40, 'One-off seal') : null;
  const laborLines = [];
  for (const item of extraLabor) laborLines.push(await addQuoteLine(v.id, 'LABOR', item.qty, item.price, item.name));
  await issueHandymanQuotationVersion(v.id, { validUntil: validUntil() }, admin);
  return { id: v.id, addedLine: added?.id, oneOffLine: oneOffLine?.id, lineA: lineA.id, labor: labor.id, laborLines: laborLines.map((line) => line.id) };
}
async function prepare(variationId: string, versionId: string, amount: number, lineId?: string, idempotencyKey = key()) {
  const result = responseData(await operation(variationId, 'revised-quotation', {
    expectedVersion: 2, revisedQuotationVersionId: versionId, quotedUnitAmount: amount, currency: 'IDR', idempotencyKey,
    ...(lineId ? { revisedQuotationLineId: lineId, workOrderId: workOrder } : {}),
  }));
  const issued = result.events.find((event: any) => event.eventType === 'REVISED_QUOTATION').metadata.offerDocument;
  assert.ok(issued.id && issued.pdfSha256); assert.equal(issued.version, 3);
  offerPins.set(variationId, { offerDocumentId: issued.id, offerDocumentVersion: issued.version, offerPdfSha256: issued.pdfSha256 });
  return result;
}
async function decision(variationId: string, versionId: string, outcome: 'APPROVED' | 'REJECTED', lineId?: string) {
  const pin = offerPins.get(variationId); assert.ok(pin);
  responseData(await operation(variationId, 'tenant-decision', {
    expectedVersion: 3, revisedQuotationVersionId: versionId, decision: outcome, evidenceReference: evidence, ...pin,
    ...(lineId ? { revisedQuotationLineId: lineId, workOrderId: workOrder } : {}),
  }, picToken));
}
async function authorize(variationId: string) {
  responseData(await operation(variationId, 'authorize-scope', { expectedVersion: 4 }));
}
async function pdfText(bytes: Buffer) {
  const doc = await PDFDocument.load(bytes), out: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i)) : contents ? [contents] : [];
    for (const stream of streams) if (stream instanceof PDFRawStream) {
      const data = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      for (const match of data.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(match[1]!, 'hex').toString('latin1'));
    }
  }
  return out.join('\n').replace(/\s+/g, ' ');
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
  chain = await locationChain(realm);
  await clientMonetaryContextService.setClientMonetaryContext({ clientId: realm.client.id,
    baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR'] }, admin);
  const tenant = await tenantCompanyService.createTenantCompany({ clientId: realm.client.id,
    tenantCode: `T_${id().slice(0, 8).toUpperCase()}`, tenantName: 'Customer', legalName: 'PT Customer' }, admin);
  tenantId = tenant.id;
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
  const careUser = await userService.createUser({ email: `${id()}@care.test`, displayName: 'Building Care' });
  const careRole = await roleService.createRole({ code: `CARE_${id()}`, name: 'Building Care' });
  const carePermission = await permissionRepository.findByCode('handyman.care.building'); assert.ok(carePermission);
  await permissionService.assignPermissionToRole(careRole.id, carePermission.id);
  await roleService.assignRoleToUser(careUser.id, careRole.id);
  await buildingAssignmentService.createAssignment(careUser.id, { buildingId: realm.building.id });
  await credentialService.createInitialCredential({ userId: careUser.id, password: PASSWORD });
  careLocalToken = responseData(await api().post('/api/v1/auth/login').send({ email: careUser.email, password: PASSWORD })).sessionToken;
  integrationCode = `VO_${id().slice(0, 8).toUpperCase()}`;
  const secret = 'variation-offer-workspace-test-secret';
  const integration = await handoffRuntimeRepository.createIntegration({ integrationCode, displayName: 'Variation Care' });
  await handymanCareActorService.setIntegrationActorCapability({ integrationId: integration.id, capability: 'CUSTOMER_CARE' });
  careActor = (await handymanCareActorService.createCareActor({ integrationId: integration.id, actorReference: 'care', displayName: 'Care' })).id;
  process.env[handoffIntegrationSecretEnvName(integrationCode)] = secret;
  await grantCareActorProperty({ careActorId: careActor, propertyId: realm.property.id, clientId: realm.client.id }, admin);
  const assertion: CareWorkspaceAssertion = { purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode, assertionId: id(),
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: 'care' } };
  careToken = (await admitCareWorkspace(assertion, signCareWorkspaceAssertion(assertion, secret))).workspaceToken;
  const service = await serviceCatalogService.createServiceCatalogEntry({ clientId: realm.client.id,
    code: `S_${id().slice(0, 8).toUpperCase()}`, name: 'Pipe repair', category: 'HANDYMAN' }, admin);
  uom = id();
  await pool.query(`INSERT INTO units_of_measure(id,client_id,code,name,symbol,category)
    VALUES($1,$2,$3,'piece','pc','COUNT')`, [uom, realm.client.id, `U_${id().slice(0, 8).toUpperCase()}`]);
  materialItem = (await inventoryItemService.createInventoryItem({ clientId: realm.client.id,
    code: `I_${id().slice(0, 8).toUpperCase()}`, name: 'Copper pipe', itemType: 'MATERIAL', uomId: uom }, admin)).id;
  const otherBuilding = await buildingService.createBuilding({ propertyId: realm.property.id,
    code: `B_${id().slice(0, 8).toUpperCase()}`, name: 'Other building' });
  await buildingAssignmentService.createAssignment(admin, { buildingId: otherBuilding.id });
  workOrder = (await workOrderService.createWorkOrder({ clientId: realm.client.id, buildingId: realm.building.id,
    workOrderNumber: `WO_${id().slice(0, 8)}`, title: 'Pipe repair', workType: 'HANDYMAN', createdByUserId: admin })).id;
  foreignWorkOrder = (await workOrderService.createWorkOrder({ clientId: realm.client.id, buildingId: otherBuilding.id,
    workOrderNumber: `WO_${id().slice(0, 8)}`, title: 'Other building', workType: 'HANDYMAN', createdByUserId: admin })).id;
  const attr = await createChannelAttribution({ tenantCompanyId: tenant.id, buildingId: realm.building.id, tenantPicId: pic.id,
    spaceId: chain.space.id, originChannel: 'BM_SUPER_APP', originReference: `bm-handoff:BM_SUPER_APP:${id()}`,
    createdByUserId: customer.id });
  const request = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attr.id,
    serviceCatalogId: service.id, description: 'Repair pipes' }, admin);
  requestId = request.id;
  await handymanServiceRequestTriageService.recordHandymanRequestTriage({ handymanRequestId: request.id,
    triageDisposition: 'DIAGNOSIS', triageNote: 'Reviewed' }, admin);
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({ handymanRequestId: request.id,
    disciplineId: discipline.id, diagnosis: 'Replace damaged pipes' }, admin);
  await updateHandymanDocumentIssuerProfile({ clientId: realm.client.id, expectedVersion: null,
    legalName: 'PT Issuer', displayName: 'Handyman', registeredAddress: 'Jl. Merdeka 1', businessAddress: null,
    city: 'Jakarta', province: 'Jakarta', postalCode: '10110', email: 'issuer@example.test', phone: '+62 21 5000 1111',
    whatsapp: '+62 811 2000 3000', website: null, taxId: null, businessRegistrationId: null, logoReference: null }, admin);
  await updateHandymanDocumentSettings({ clientId: realm.client.id, documentKind: 'QUOTATION', language: 'id',
    expectedVersion: null, documentPrefix: 'QTN', termsLines: ['Work after approval'], paymentNote: 'Transfer within seven days',
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
  crewId = crew.crew.id; leadUserId = crew.leadUser.id; leadWorkerId = crew.workerContext.id;
  // A real helper attends check-in, but never authorizes or adds labor quantity.
  const helperUser = await userService.createUser({ email: `${id()}@helper.test`, displayName: 'Crew helper' });
  const helperProfile = await workforceService.createWorkforceProfile({ organizationId: realm.organization.id,
    departmentId: realm.department.id, positionId: realm.position.id, employeeCode: `H_${id().slice(0, 8)}`,
    fullName: 'Helper worker', workforceType: 'EXTERNAL', userId: helperUser.id });
  await assignBuildingToWorkforce({ workforceProfileId: helperProfile.id, buildingId: realm.building.id });
  await vendorWorkforceService.createVendorWorkforceBinding({ vendorId: crew.vendor.id, workforceProfileId: helperProfile.id,
    vendorPersonnelCode: `VP_${id().slice(0, 8)}` });
  const helperWorker = await handymanWorkerContextService.createHandymanWorkerContext({
    handymanProviderContextId: crew.providerContext.id, workforceProfileId: helperProfile.id }, admin);
  await addHandymanCrewMember({ handymanCrewId: crewId, handymanWorkerContextId: helperWorker.id }, admin);
  await buildingAssignmentService.createAssignment(helperUser.id, { buildingId: realm.building.id });
  await credentialService.createInitialCredential({ userId: helperUser.id, password: PASSWORD });
  helperToken = responseData(await api().post('/api/v1/auth/login').send({ email: helperUser.email, password: PASSWORD })).sessionToken;
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
  if (integrationCode) delete process.env[handoffIntegrationSecretEnvName(integrationCode)];
  resetAppConfigCache();
});

describe('approved variation and real material execution', () => {
  it('fails closed when a historical issued quotation has no official source artifact', async () => {
    const variation = await proposal('ADD', 1, undefined, 'LABOR'); await review(variation);
    const old = await createHandymanQuotationRevision(quotationId, admin, { dpRequired: false });
    await addQuoteLine(old.id, 'LABOR', 1, 100, 'Original labor');
    await addQuoteLine(old.id, 'MATERIAL', 10, 25, 'Original material A');
    await addQuoteLine(old.id, 'MATERIAL', 8, 25, 'Original material B');
    await addQuoteLine(old.id, 'LABOR', 1, 25, 'Legacy addition');
    // Simulate a version issued before migration 0509; no artifact is invented.
    await pool.query('ALTER TABLE handyman_quotation_versions DISABLE TRIGGER hm_quotation_issue_requires_document');
    try {
      await pool.query(`UPDATE handyman_quotation_versions SET status='ISSUED',valid_until=$2 WHERE id=$1`, [old.id, validUntil()]);
    } finally {
      await pool.query('ALTER TABLE handyman_quotation_versions ENABLE TRIGGER hm_quotation_issue_requires_document');
    }
    rejection(await operation(variation, 'revised-quotation', { expectedVersion: 2, revisedQuotationVersionId: old.id,
      quotedUnitAmount: 25, currency: 'IDR' }), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION', 'historical missing documents');
    const state = (await pool.query('SELECT status,revised_quotation_version_id FROM handyman_scope_variations WHERE id=$1', [variation])).rows[0];
    assert.equal(state.status, 'OPERATIONS_REVIEW'); assert.equal(state.revised_quotation_version_id, null);
    assert.equal((await pool.query('SELECT count(*)::int n FROM handyman_variation_offer_documents WHERE variation_id=$1', [variation])).rows[0].n, 0);
  });

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
    const v2 = await revision(6, 8, false, false, [], true);
    rejection(await operation(firstReduce, 'revised-quotation', { expectedVersion: 2,
      revisedQuotationVersionId: v2.id, quotedUnitAmount: 25, currency: 'USD' }),
    409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    // PostgreSQL rejects even a direct state change without an artifact in the
    // same transaction; the failed attempt leaves the reviewed state intact.
    await assert.rejects(pool.query(`UPDATE handyman_scope_variations SET status='REVISED_QUOTATION',
      revised_quotation_version_id=$2, quoted_unit_amount=25, quoted_total_delta=-100, currency='IDR',version=version+1 WHERE id=$1`,
    [firstReduce, v2.id]), /requires its official immutable PDF/);
    assert.equal((await pool.query('SELECT status FROM handyman_scope_variations WHERE id=$1', [firstReduce])).rows[0].status, 'OPERATIONS_REVIEW');
    const issueKey = key();
    const prepared = await prepare(firstReduce, v2.id, 25, undefined, issueKey);
    const pin = offerPins.get(firstReduce)!;
    const replayed = await prepare(firstReduce, v2.id, 25, undefined, issueKey);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.events.find((e: any) => e.eventType === 'REVISED_QUOTATION').metadata.offerDocument.id, pin.offerDocumentId);
    assert.equal(prepared.variation.tenantDecisionOutcome, null);
    const doc = (await pool.query('SELECT * FROM handyman_variation_offer_documents WHERE variation_id=$1', [firstReduce])).rows[0];
    const originalDoc = (await pool.query('SELECT * FROM handyman_quotation_documents WHERE quotation_version_id=$1', [originalVersion])).rows[0];
    const revisedDoc = (await pool.query('SELECT * FROM handyman_quotation_documents WHERE quotation_version_id=$1', [v2.id])).rows[0];
    assert.match(doc.document_number, /^QTN-VO-\d+$/);
    assert.equal(doc.variation_version, 3); assert.equal(doc.revised_quotation_version_id, v2.id);
    assert.equal(doc.original_quotation_document_id, originalDoc.id); assert.equal(doc.revised_quotation_document_id, revisedDoc.id);
    assert.deepEqual(doc.source_snapshot.original, originalDoc.source_snapshot);
    assert.deepEqual(doc.source_snapshot.revised, revisedDoc.source_snapshot);
    assert.equal(doc.source_snapshot.variation.targetQuotationLineId, originalA);
    assert.equal(doc.source_snapshot.variation.quotedTotalDelta, '-100.00');
    assert.equal(doc.source_snapshot.revised.quotation.dpRequired, true);
    assert.equal(Number(doc.source_snapshot.revised.quotation.dpAmount), 90);
    assert.equal(stableJson(doc.source_snapshot), doc.source_canonical);
    assert.equal(sha(doc.source_canonical), doc.source_sha256); assert.equal(sha(doc.pdf_bytes), doc.pdf_sha256);
    firstOfferBytes = doc.pdf_bytes; firstOfferHash = doc.pdf_sha256;
    const text = await pdfText(firstOfferBytes);
    for (const fact of ['Scope Variation Offer', 'NOT APPROVED', 'ISSUED - OFFER ONLY', 'REDUCE MATERIAL',
      '4.000 pc', '-100.00', '450.00', 'Original material A', 'Original labor', 'Deposit after Tenant approval',
      'Transfer within seven days', originalDoc.document_number, revisedDoc.document_number]) {
      assert.ok(text.includes(fact), `PDF must contain ${fact}: ${text}`);
    }
    await assert.rejects(pool.query('UPDATE handyman_variation_offer_documents SET pdf_bytes=$2 WHERE id=$1',
      [doc.id, Buffer.from('%PDF-tampered')]), /immutable/);
    await assert.rejects(pool.query('DELETE FROM handyman_variation_offer_documents WHERE id=$1', [doc.id]), /immutable/);
    await assert.rejects(pool.query('UPDATE handyman_scope_variations SET quoted_unit_amount=26 WHERE id=$1', [firstReduce]), /immutable/);
    await assert.rejects(pool.query(`INSERT INTO handyman_scope_variation_events
      (id,client_id,variation_id,execution_scope_id,event_type,from_status,to_status,actor_user_id,actor_role,evidence_reference,idempotency_key,metadata)
      VALUES($1,$2,$3,$4,'TENANT_DECISION','REVISED_QUOTATION','TENANT_DECISION',$5,'TENANT',$6,$7,'{}')`,
    [id(), realm.client.id, firstReduce, scope, admin, evidence, key()]), /exact issued variation PDF and version/);
    const local = await api().get(localPath(firstReduce)).set(auth(careLocalToken)).buffer(true);
    assert.equal(local.status, 200, JSON.stringify(local.body)); assert.deepEqual(local.body, firstOfferBytes);
    assert.equal(local.headers['x-content-sha256'], firstOfferHash); assert.equal(local.headers['x-variation-offer-id'], doc.id);
    assert.equal(local.headers['x-variation-offer-version'], '3'); assert.equal(local.headers['cache-control'], 'private, no-store');
    assert.equal((await api().get(localPath(firstReduce)).set(auth(adminToken))).status, 200);
    assert.equal((await api().get(localPath(firstReduce)).set(auth(picToken))).status, 403);
    assert.equal((await api().get(localPath(firstReduce)).set(auth(leadToken))).status, 403);
    const care = await api().get(carePath(firstReduce)).query(careSelection()).set(auth(careToken)).buffer(true);
    assert.equal(care.status, 200, JSON.stringify(care.body)); assert.deepEqual(care.body, firstOfferBytes);
    for (const query of [{ ...careSelection(), tenantCompanyId: id() }, { ...careSelection(), spaceId: id() },
      { ...careSelection(), propertyId: id() }]) {
      assert.equal((await api().get(carePath(firstReduce)).query(query).set(auth(careToken))).status, 404);
    }
    const projection = await api().get(`/api/v1/handyman/care/requests/${requestId}/projection`).query(careSelection()).set(auth(careToken));
    assert.equal(projection.status, 200, JSON.stringify(projection.body));
    const projected = projection.body.data.variationOffers.find((offer: any) => offer.variationId === firstReduce);
    assert.equal(projected.offerStatus, 'ISSUED'); assert.equal(projected.tenantDecision, null);
    assert.equal(projected.pdfSha256, firstOfferHash); assert.equal(projected.downloadPath, carePath(firstReduce));
    rejection(await operation(firstReduce, 'authorize-scope', { expectedVersion: 3 }), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    const consent = { expectedVersion: 3, revisedQuotationVersionId: v2.id, decision: 'APPROVED', evidenceReference: evidence };
    rejection(await operation(firstReduce, 'tenant-decision', consent), 403, 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
    rejection(await operation(firstReduce, 'tenant-decision', consent, picToken), 400, 'VALIDATION_ERROR');
    rejection(await operation(firstReduce, 'tenant-decision', { ...consent, ...pin, offerDocumentId: id() }, picToken), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    rejection(await operation(firstReduce, 'tenant-decision', { ...consent, ...pin, offerDocumentVersion: 4 }, picToken), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    rejection(await operation(firstReduce, 'tenant-decision', { ...consent, ...pin, offerPdfSha256: '0'.repeat(64) }, picToken), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    await decision(firstReduce, v2.id, 'APPROVED');
    const decisionEvent = (await pool.query(`SELECT metadata FROM handyman_scope_variation_events
      WHERE variation_id=$1 AND event_type='TENANT_DECISION'`, [firstReduce])).rows[0];
    assert.equal(decisionEvent.metadata.consentSnapshot.offerDocumentId, doc.id);
    assert.equal(decisionEvent.metadata.consentSnapshot.offerDocumentVersion, 3);
    assert.equal(decisionEvent.metadata.consentSnapshot.offerPdfSha256, firstOfferHash);
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
    const laterDoc = (await pool.query('SELECT * FROM handyman_variation_offer_documents WHERE variation_id=$1', [reduceAgain])).rows[0];
    assert.notEqual(laterDoc.id, pin.offerDocumentId); assert.notEqual(laterDoc.document_number, doc.document_number);
    assert.equal(laterDoc.source_snapshot.reconciliation.mode, 'CUMULATIVE');
    assert.ok(laterDoc.source_snapshot.previousAuthorizedVariations.some((v: any) => v.id === firstReduce));
    const historic = await api().get(localPath(firstReduce)).set(auth(careLocalToken)).buffer(true);
    assert.deepEqual(historic.body, firstOfferBytes); assert.equal(historic.headers['x-content-sha256'], firstOfferHash);
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

  it('binds the approved ADD to the exact material line, consent version and Work Order', async () => {
    rejectedAdd = await proposal('ADD', 2); await review(rejectedAdd);
    const refusedOffer = await revision(3, 6, true); rejectedVersion = refusedOffer.id;
    assert.ok(refusedOffer.addedLine);
    const terms = { expectedVersion: 2, revisedQuotationVersionId: refusedOffer.id,
      revisedQuotationLineId: refusedOffer.addedLine, workOrderId: workOrder, quotedUnitAmount: 30, currency: 'IDR' };
    rejection(await operation(rejectedAdd, 'revised-quotation', terms, leadToken), 403, 'HANDYMAN_VARIATION_ROLE_FORBIDDEN');
    rejection(await operation(rejectedAdd, 'revised-quotation', { ...terms, revisedQuotationLineId: undefined }), 400, 'VALIDATION_ERROR');
    rejection(await operation(rejectedAdd, 'revised-quotation', { ...terms, workOrderId: foreignWorkOrder }), 403, 'BUILDING_ACCESS_DENIED');
    rejection(await operation(rejectedAdd, 'revised-quotation', { ...terms, revisedQuotationLineId: refusedOffer.lineA }), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    rejection(await operation(rejectedAdd, 'revised-quotation', { ...terms, revisedQuotationLineId: refusedOffer.labor }), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    await prepare(rejectedAdd, refusedOffer.id, 30, refusedOffer.addedLine);
    const offeredMaterial = (await pool.query('SELECT * FROM handyman_variation_offer_documents WHERE variation_id=$1', [rejectedAdd])).rows[0];
    const materialText = await pdfText(offeredMaterial.pdf_bytes);
    for (const fact of ['ADD MATERIAL', '2.000 pc', '60.00', 'Additional material']) assert.ok(materialText.includes(fact), fact);
    assert.equal(offeredMaterial.source_snapshot.variation.revisedQuotationLineId, refusedOffer.addedLine);
    assert.equal(offeredMaterial.source_snapshot.variation.workOrderId, workOrder);
    const refusedBinding = { variationId: rejectedAdd, approvedVariationVersion: 3, workOrderId: workOrder };
    rejection(await estimate(refusedOffer.id, refusedOffer.addedLine!, 1, key(), refusedBinding), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    rejection(await operation(rejectedAdd, 'tenant-decision', { expectedVersion: 3, revisedQuotationVersionId: refusedOffer.id,
      revisedQuotationLineId: refusedOffer.addedLine, workOrderId: workOrder, decision: 'APPROVED', evidenceReference: evidence }, leadToken),
    403, 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
    await decision(rejectedAdd, refusedOffer.id, 'REJECTED', refusedOffer.addedLine);
    rejection(await operation(rejectedAdd, 'authorize-scope', { expectedVersion: 4 }), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    rejection(await estimate(refusedOffer.id, refusedOffer.addedLine!, 1, key(), refusedBinding), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');

    approvedAdd = await proposal('ADD', 2); await review(approvedAdd);
    rejection(await operation(approvedAdd, 'revised-quotation', { ...terms, revisedQuotationVersionId: rejectedVersion }),
      409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    const offer = await revision(3, 6, true); assert.ok(offer.addedLine);
    approvedVersionId = offer.id;
    await prepare(approvedAdd, offer.id, 30, offer.addedLine);
    const consent = { expectedVersion: 3, revisedQuotationVersionId: offer.id, revisedQuotationLineId: offer.addedLine,
      workOrderId: workOrder, decision: 'APPROVED', evidenceReference: evidence };
    rejection(await operation(approvedAdd, 'tenant-decision', { ...consent, revisedQuotationVersionId: rejectedVersion }, picToken),
      409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    rejection(await operation(approvedAdd, 'tenant-decision', { ...consent, workOrderId: foreignWorkOrder }, picToken),
      409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    rejection(await operation(approvedAdd, 'tenant-decision', { ...consent, revisedQuotationLineId: offer.lineA }, picToken),
      409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    await decision(approvedAdd, offer.id, 'APPROVED', offer.addedLine); await authorize(approvedAdd);
    const field = responseData(await api().get(fieldVariations()).set(auth(leadToken))).variations
      .find((v: any) => v.id === approvedAdd);
    assert.equal(field.revisedQuotationVersionId, offer.id);
    assert.equal(field.revisedQuotationLineId, offer.addedLine);
    assert.equal(field.workOrderId, workOrder);
    assert.equal(field.approvedVariationVersion, 3);
    assert.equal(field.quotedUnitAmount, undefined);
    const binding = { variationId: approvedAdd, approvedVariationVersion: 3, workOrderId: workOrder };
    rejection(await estimate(offer.id, offer.addedLine!, 1), 409, 'HANDYMAN_MATERIAL_EXECUTION_LINK_INVALID', 'version-not-approved-snapshot');
    rejection(await estimate(offer.id, offer.addedLine!, 1, key(), { ...binding, approvedVariationVersion: 4 }),
      409, 'HANDYMAN_VARIATION_VERSION_CONFLICT');
    rejection(await estimate(offer.id, offer.addedLine!, 1, key(), { ...binding, workOrderId: foreignWorkOrder }),
      409, 'HANDYMAN_MATERIAL_EXECUTION_LINK_INVALID', 'add-material-binding-mismatch');
    rejection(await estimate(offer.id, offer.lineA, 1, key(), binding),
      409, 'HANDYMAN_MATERIAL_EXECUTION_LINK_INVALID', 'add-material-binding-mismatch');
    rejection(await estimate(originalVersion, originalA, 1, key(), binding),
      409, 'HANDYMAN_MATERIAL_EXECUTION_LINK_INVALID', 'add-requires-revised-quotation');
    rejection(await estimate(offer.id, offer.addedLine!, 2.001, key(), binding),
      400, 'HANDYMAN_MATERIAL_EXECUTION_ESTIMATE_INVALID');
    const keys = [key(), key()];
    const concurrent = await Promise.all(keys.map((k) => estimate(offer.id, offer.addedLine!, 2, k, binding)));
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
    const winner = concurrent.findIndex((r) => r.status === 200);
    const execution = responseData(concurrent[winner]);
    addLine = execution.line.id;
    assert.equal(execution.line.variationId, approvedAdd);
    assert.equal(execution.line.approvedVariationVersion, 3);
    assert.equal(execution.line.workOrderId, workOrder);
    assert.equal(execution.line.quotationLineId, offer.addedLine);
    assert.equal(execution.line.sourceItemId, materialItem);
    assert.equal(execution.line.approvedQty, 2);
    assert.equal(responseData(await estimate(offer.id, offer.addedLine!, 2, keys[winner], binding)).replayed, true);
    rejection(await estimate(offer.id, offer.addedLine!, 1, keys[winner], binding), 409, 'HANDYMAN_MATERIAL_EXECUTION_LINK_CONFLICT');
    rejection(await estimate(offer.id, offer.addedLine!, 2, key(), binding), 409, 'HANDYMAN_MATERIAL_EXECUTION_LINK_CONFLICT');
    responseData(await material(addLine, 'approve'));
    rejection(await material(addLine, 'issue', 2.001), 400, 'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED');
    const issueKey = key(); responseData(await material(addLine, 'issue', 2, issueKey));
    assert.equal(responseData(await material(addLine, 'issue', 2, issueKey)).replayed, true);
    rejection(await material(addLine, 'issue', 1, issueKey), 409, 'IDEMPOTENCY_CONFLICT');
    const useKey = key(); assert.equal(responseData(await material(addLine, 'use', 1, useKey)).line.usedQty, 1);
    assert.equal(responseData(await material(addLine, 'use', 1, useKey)).replayed, true);
    rejection(await material(addLine, 'use', 0.5, useKey), 409, 'IDEMPOTENCY_CONFLICT');
    rejection(await material(addLine, 'use', 0.0001), 400, 'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED', 'precision');
    await assert.rejects(pool.query('UPDATE handyman_material_execution_lines SET work_order_id=$2 WHERE id=$1', [addLine, foreignWorkOrder]), /immutable/);
    await assert.rejects(pool.query('UPDATE handyman_material_execution_lines SET approved_qty=3 WHERE id=$1', [addLine]), /immutable/);
    const events = await pool.query('SELECT id FROM handyman_material_execution_events WHERE line_id=$1 AND event_type=$2', [addLine, 'USE']);
    await assert.rejects(pool.query('UPDATE handyman_material_execution_events SET quantity_delta=2 WHERE id=$1', [events.rows[0].id]), /append-only/);
  });

  it('uses immutable one-off material identity and keeps earlier approved ADD usable after a later quote', async () => {
    const oneOff = await proposal('ADD', 0.3); await review(oneOff);
    const later = await revision(3, 6, true, true); assert.ok(later.oneOffLine);
    await prepare(oneOff, later.id, 40, later.oneOffLine);
    await decision(oneOff, later.id, 'APPROVED', later.oneOffLine); await authorize(oneOff);
    const prior = await pool.query('SELECT status FROM handyman_quotation_versions WHERE id=$1', [approvedVersionId]);
    assert.equal(prior.rows[0].status, 'SUPERSEDED');
    // Superseding an already-consented offer does not silently revoke its ADD.
    const raced = await Promise.all([material(addLine, 'use', 0.6), material(addLine, 'use', 0.6)]);
    assert.deepEqual(raced.map((r) => r.status).sort(), [200, 400]);
    assert.equal(responseData(await material(addLine, 'use', 0.4)).line.usedQty, 2);
    rejection(await material(addLine, 'use', 0.001), 400, 'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED');
    const binding = { variationId: oneOff, approvedVariationVersion: 3, workOrderId: workOrder };
    const line = responseData(await estimate(later.id, later.oneOffLine!, 0.3, key(), binding)).line;
    assert.equal(line.sourceItemId, null, 'one-off identity is the immutable quotation line, not a fabricated catalog item');
    assert.equal(line.quotationLineId, later.oneOffLine);
    responseData(await material(line.id, 'approve'));
    responseData(await material(line.id, 'purchase', 0.1));
    assert.equal(responseData(await material(line.id, 'purchase', 0.2)).line.purchasedQty, 0.3);
    responseData(await material(line.id, 'use', 0.1));
    responseData(await material(line.id, 'return', 0.1));
    assert.equal(responseData(await material(line.id, 'use', 0.1)).line.usedQty, 0.2);
    rejection(await material(line.id, 'use', 0.001), 400, 'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED');
    const original = await pool.query('SELECT quantity FROM handyman_quotation_lines WHERE id=$1', [originalA]);
    assert.equal(Number(original.rows[0].quantity), 10);
    const history = await pool.query(`SELECT event_type, quantity_delta FROM handyman_material_execution_events
      WHERE line_id=$1 ORDER BY occurred_at, created_at, id`, [addLine]);
    assert.ok(history.rows.some((e) => e.event_type === 'USE' && Number(e.quantity_delta) === 1));
    assert.ok(history.rows.some((e) => e.event_type === 'USE' && Number(e.quantity_delta) === 0.6));
  });

  it('records only PIC-approved ADD labor against the real Lead session, exact service line and evidence', async () => {
    const sessions = `/api/v1/handyman/execution-scopes/${scope}/work-sessions`;
    const sessionAction = (action: string) => post(`${sessions}/${action}`, leadToken, { idempotencyKey: key() });
    const uploadWorkEvidence = async () => {
      const upload = await api().post(`/api/v1/handyman/field/execution-scopes/${scope}/evidence/upload`)
        .set(auth(leadToken)).field('purpose', 'BEFORE_AFTER_WORK').field('idempotencyKey', key())
        .attach('file', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
          { filename: 'completed-work.png', contentType: 'image/png' });
      return responseData(upload, 201).evidence.attachmentReference as string;
    };
    await releaseDispatchFixture({ executionScopeId: scope, handymanCrewId: crewId,
      actorUserId: admin, query: (sql, values) => pool.query(sql, values) });
    await saveHandymanBuildingGeospatialPolicy({ buildingId: realm.building.id, referenceLatitude: -6.2,
      referenceLongitude: 106.816666, geofenceRadiusMeters: 100, maxAccuracyMeters: 40, maxLocationAgeSeconds: 900 }, admin);
    const location = await createHandymanArrivalLocationIdentifier({ buildingId: realm.building.id,
      floorId: chain.floor.id, areaId: chain.area.id, roomId: chain.room.id, spaceId: chain.space.id }, admin);
    const challenge = await createHandymanArrivalChallenge({ executionScopeId: scope }, leadUserId);
    const arrival = await evaluateHandymanArrivalVerification({ executionScopeId: scope,
      challengeToken: challenge.token, qrOpaqueCode: location.value,
      deviceLocation: { latitude: -6.2, longitude: 106.816666, accuracyMeters: 10, capturedAt: new Date().toISOString() } }, leadUserId);
    assert.equal(arrival.status, 'VERIFIED');
    const beforeStartEvidence = await uploadWorkEvidence();
    const firstSession = responseData(await sessionAction('check-in')).session.id as string;
    responseData(await sessionAction('start-work'));
    const workEvidence = await uploadWorkEvidence();
    const presence = await pool.query('SELECT COUNT(*)::int AS n FROM handyman_work_session_helper_presence WHERE session_id=$1', [firstSession]);
    assert.equal(presence.rows[0].n, 1);
    const record = (session: string, body: Record<string, unknown>, token = leadToken) =>
      post(`${sessions}/${session}/add-labor-executions`, token, { idempotencyKey: key(), ...body });

    const rejected = await proposal('ADD', 1.5, undefined, 'LABOR'); await review(rejected);
    const rejectedQuote = await revision(3, 6, true, true, [{ qty: 1.5, price: 80, name: 'Additional pipe service' }]);
    const rejectedLine = rejectedQuote.laborLines[0];
    const terms = { expectedVersion: 2, revisedQuotationVersionId: rejectedQuote.id, revisedQuotationLineId: rejectedLine,
      workOrderId: workOrder, quotedUnitAmount: 80, currency: 'IDR' };
    rejection(await operation(rejected, 'revised-quotation', terms, leadToken), 403, 'HANDYMAN_VARIATION_ROLE_FORBIDDEN');
    rejection(await operation(rejected, 'revised-quotation', { ...terms, workOrderId: foreignWorkOrder }), 403, 'BUILDING_ACCESS_DENIED');
    rejection(await operation(rejected, 'revised-quotation', { ...terms, revisedQuotationLineId: rejectedQuote.addedLine }),
      409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    rejection(await operation(rejected, 'revised-quotation', { ...terms, revisedQuotationLineId: rejectedQuote.labor }),
      409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    await prepare(rejected, rejectedQuote.id, 80, rejectedLine);
    const offeredLabor = (await pool.query('SELECT * FROM handyman_variation_offer_documents WHERE variation_id=$1', [rejected])).rows[0];
    const laborText = await pdfText(offeredLabor.pdf_bytes);
    for (const fact of ['ADD LABOR', '1.500 pc', '120.00', 'Additional pipe service']) assert.ok(laborText.includes(fact), fact);
    const rejectedBody = { variationId: rejected, approvedVariationVersion: 3, quotationLineId: rejectedLine,
      workOrderId: workOrder, quantity: 0.7, evidenceReference: workEvidence };
    rejection(await record(firstSession, rejectedBody), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    await decision(rejected, rejectedQuote.id, 'REJECTED', rejectedLine);
    rejection(await record(firstSession, rejectedBody), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    rejection(await operation(rejected, 'authorize-scope', { expectedVersion: 4 }), 409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');

    const variation = await proposal('ADD', 1.5, undefined, 'LABOR'); await review(variation);
    const offer = await revision(3, 6, true, true, [{ qty: 1.5, price: 80, name: 'Additional pipe service' }]);
    const line = offer.laborLines[0];
    await prepare(variation, offer.id, 80, line);
    const consent = { expectedVersion: 3, revisedQuotationVersionId: offer.id, revisedQuotationLineId: line,
      workOrderId: workOrder, decision: 'APPROVED', evidenceReference: evidence };
    rejection(await operation(variation, 'tenant-decision', { ...consent, workOrderId: foreignWorkOrder }, picToken),
      409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    rejection(await operation(variation, 'tenant-decision', { ...consent, revisedQuotationLineId: offer.labor }, picToken),
      409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    rejection(await operation(variation, 'tenant-decision', consent, leadToken), 403, 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
    await decision(variation, offer.id, 'APPROVED', line); await authorize(variation);
    const field = responseData(await api().get(fieldVariations()).set(auth(leadToken))).variations.find((v: any) => v.id === variation);
    assert.equal(field.revisedQuotationLineId, line);
    assert.equal(field.workOrderId, workOrder);
    assert.equal(field.approvedVariationVersion, 3);
    assert.equal(field.quotedUnitAmount, undefined);
    const body = { variationId: variation, approvedVariationVersion: 3, quotationLineId: line,
      workOrderId: workOrder, quantity: 0.7, evidenceReference: workEvidence };
    rejection(await record(firstSession, { ...body, approvedVariationVersion: 4 }), 409, 'HANDYMAN_VARIATION_VERSION_CONFLICT');
    rejection(await record(firstSession, { ...body, quotationLineId: offer.labor }), 409, 'HANDYMAN_ADD_LABOR_BINDING_MISMATCH');
    rejection(await record(firstSession, { ...body, workOrderId: foreignWorkOrder }), 409, 'HANDYMAN_ADD_LABOR_BINDING_MISMATCH');
    rejection(await record(id(), body), 404, 'HANDYMAN_WORK_SESSION_NOT_FOUND');
    rejection(await record(firstSession, body, helperToken), 403, 'HANDYMAN_WORK_SESSION_NOT_AUTHORIZED');
    rejection(await record(firstSession, body, picToken), 403, 'HANDYMAN_WORK_SESSION_NOT_AUTHORIZED');
    rejection(await record(firstSession, { ...body, quotedUnitAmount: 1 }), 400, 'VALIDATION_ERROR');
    rejection(await record(firstSession, { ...body, helperCount: 50 }), 400, 'VALIDATION_ERROR');
    rejection(await record(firstSession, { ...body, quantity: 0.0001 }), 400, 'VALIDATION_ERROR');
    rejection(await record(firstSession, { ...body, quantity: 1.501 }), 400, 'HANDYMAN_ADD_LABOR_QUANTITY_EXCEEDED');
    rejection(await record(firstSession, { ...body, evidenceReference: evidence }), 409, 'HANDYMAN_ADD_LABOR_EVIDENCE_INVALID');
    rejection(await record(firstSession, { ...body, evidenceReference: beforeStartEvidence }), 409, 'HANDYMAN_ADD_LABOR_EVIDENCE_INVALID');
    rejection(await record(firstSession, { ...body, evidenceReference: 'unverified' }), 400, 'HANDYMAN_EVIDENCE_REFERENCE_UNVERIFIED');
    responseData(await sessionAction('pause'));
    rejection(await record(firstSession, body), 409, 'HANDYMAN_WORK_SESSION_ILLEGAL_TRANSITION');
    responseData(await sessionAction('resume'));
    const keys = [key(), key()];
    const raced = await Promise.all(keys.map((k) => record(firstSession, { ...body, idempotencyKey: k })));
    assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409]);
    const winner = raced.findIndex((r) => r.status === 200);
    const execution = responseData(raced[winner]).execution;
    assert.equal(execution.variationId, variation);
    assert.equal(execution.approvedVariationVersion, 3);
    assert.equal(execution.quotationVersionId, offer.id);
    assert.equal(execution.quotationLineId, line);
    assert.equal(execution.workOrderId, workOrder);
    assert.equal(execution.workSessionId, firstSession);
    assert.equal(execution.leadUserId, leadUserId);
    assert.equal(execution.leadWorkerId, leadWorkerId);
    assert.equal(execution.approvedQty, 1.5);
    assert.equal(execution.actualQty, 0.7);
    assert.equal(execution.evidenceReference, workEvidence);
    assert.equal(execution.price, undefined);
    const replay = responseData(await record(firstSession, { ...body, idempotencyKey: keys[winner] }));
    assert.equal(replay.replayed, true); assert.equal(replay.execution.id, execution.id);
    rejection(await record(firstSession, { ...body, quantity: 0.8, idempotencyKey: keys[winner] }), 409, 'IDEMPOTENCY_CONFLICT');
    rejection(await record(firstSession, body), 409, 'HANDYMAN_ADD_LABOR_DUPLICATE');
    const listed = responseData(await api().get(`${sessions}/${firstSession}/add-labor-executions`).set(auth(leadToken))).executions;
    assert.equal(listed.length, 1); assert.equal(listed[0].actualQty, 0.7);
    await assert.rejects(pool.query('UPDATE handyman_add_labor_executions SET actual_qty=1 WHERE id=$1', [execution.id]), /append-only/);
    await assert.rejects(pool.query('DELETE FROM handyman_add_labor_executions WHERE id=$1', [execution.id]), /append-only/);

    // Historical approvals without an item-specific PIC pin remain history;
    // they cannot be silently upgraded to a labor-execution authorization.
    const legacy = await proposal('ADD', 0.5, undefined, 'LABOR'); await review(legacy);
    const legacyQuote = await revision(3, 6, true, true, [
      { qty: 1.5, price: 80, name: 'Additional pipe service' }, { qty: 0.5, price: 70, name: 'Legacy labor' },
    ]);
    await prepare(legacy, legacyQuote.id, 70); await decision(legacy, legacyQuote.id, 'APPROVED'); await authorize(legacy);
    rejection(await record(firstSession, { ...body, variationId: legacy, quotationLineId: legacyQuote.laborLines[1] }),
      409, 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    const oldVersion = await pool.query('SELECT status FROM handyman_quotation_versions WHERE id=$1', [offer.id]);
    assert.equal(oldVersion.rows[0].status, 'SUPERSEDED');

    responseData(await sessionAction('complete')); responseData(await sessionAction('check-out'));
    const dispatch = await pool.query('SELECT appointment_id FROM handyman_dispatch_releases WHERE execution_scope_id=$1 ORDER BY created_at DESC LIMIT 1', [scope]);
    await handymanDispatchService.releaseHandymanDispatch({ executionScopeId: scope, appointmentId: dispatch.rows[0].appointment_id }, admin);
    const secondSession = responseData(await sessionAction('check-in')).session.id as string;
    assert.notEqual(secondSession, firstSession);
    responseData(await sessionAction('start-work'));
    const secondEvidence = await uploadWorkEvidence();
    rejection(await record(secondSession, { ...body, evidenceReference: workEvidence }), 409, 'HANDYMAN_ADD_LABOR_EVIDENCE_INVALID');
    rejection(await record(secondSession, { ...body, quantity: 0.801, evidenceReference: secondEvidence }),
      400, 'HANDYMAN_ADD_LABOR_QUANTITY_EXCEEDED');
    const second = responseData(await record(secondSession, { ...body, quantity: 0.8, evidenceReference: secondEvidence })).execution;
    assert.equal(second.actualQty, 0.8);
    const sum = await pool.query(`SELECT SUM(actual_qty)::text AS actual, COUNT(*)::int AS records
      FROM handyman_add_labor_executions WHERE variation_id=$1`, [variation]);
    assert.equal(Number(sum.rows[0].actual), 1.5); assert.equal(sum.rows[0].records, 2);
    const original = await pool.query('SELECT quantity FROM handyman_quotation_lines WHERE id=$1', [originalLabor]);
    assert.equal(Number(original.rows[0].quantity), 1);
  });

  it('keeps historic bytes after settings changes and immediately revokes Care workspace access', async () => {
    await updateHandymanDocumentSettings({ clientId: realm.client.id, documentKind: 'QUOTATION', language: 'id',
      expectedVersion: 1, documentPrefix: 'QTN', termsLines: ['Updated current terms'], paymentNote: 'New payment terms',
      warrantyNote: null, contactNote: null, footerNote: null, signatoryName: 'Manager', signatoryTitle: 'Operations' }, admin);
    const historic = await api().get(carePath(firstReduce)).query(careSelection()).set(auth(careToken)).buffer(true);
    assert.equal(historic.status, 200); assert.deepEqual(historic.body, firstOfferBytes);
    const text = await pdfText(historic.body);
    assert.ok(text.includes('Transfer within seven days')); assert.ok(!text.includes('New payment terms'));
    await revokeCareActorProperty({ careActorId: careActor, propertyId: realm.property.id, clientId: realm.client.id }, admin);
    assert.equal((await api().get(carePath(firstReduce)).query(careSelection()).set(auth(careToken))).status, 404);
    await assert.rejects(migrateDown(pool), /Refusing to remove issued variation offer documents/);
  });

});
