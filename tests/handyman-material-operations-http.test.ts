import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, runSeeds } from '../src/database';
import { areaService } from '../src/modules/areas';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { floorService } from '../src/modules/floors';
import { createHandymanJob } from '../src/modules/handyman-jobs';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  decideHandymanQuotationApprovalInApp,
  sendHandymanQuotation,
  submitHandymanQuotationRevision,
} from '../src/modules/handyman-quotations';
import { triageHandymanRequest } from '../src/modules/handyman-request-governance';
import { createHandymanRequest } from '../src/modules/handyman-requests';
import { inventoryItemService } from '../src/modules/inventory-items';
import { inventoryStockMovementService } from '../src/modules/inventory-stock-movements';
import { inventoryWarehouseService } from '../src/modules/inventory-warehouses';
import { priceCatalogEntryService } from '../src/modules/price-catalog-entries';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser, createPlainSession, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-07 RUN 3 — focused HTTP contract tests.
 *
 * Representative transport journeys over the already-authoritative Run-1/Run-2
 * services: demand lanes, addenda, direct/assisted approvals, reservation,
 * controlled issue (incl. pre-staged), actual use, return, derived
 * fulfillment, evidence parents, header idempotency, cross-scope denial,
 * privacy-safe responses, NULL-UOM normalization, and RBAC denials. Domain
 * depth and concurrency stay in the Run-1/Run-2 suites.
 */

const PORT = 55513;
const DIR = '/tmp/asentra-hm07-run3-pg';
const EM = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EM) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const key = (tag: string) => `HM07_R3_${tag}_${suffix()}`;

before(async () => {
  if (EM) {
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
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await runSeeds(pool);
  await pool.query(`
    TRUNCATE supporting_documents, documents, handyman_material_returns,
      handyman_material_actual_usages, handyman_material_controlled_issues,
      handyman_material_demands, handyman_material_approvals,
      handyman_material_commercial_addenda, handyman_job_assignments,
      handyman_jobs, vendor_works, vendor_assignments, work_orders,
      handyman_quotation_approval_links, handyman_quotation_approvals,
      handyman_quotation_lines, handyman_quotation_revisions, handyman_quotations,
      handyman_request_triages, handyman_request_services, handyman_inspections,
      handyman_requests, handyman_providers, tenant_space_relationships,
      tenant_building_contexts, tenant_pics, tenant_companies,
      price_catalog_entries, inventory_material_reservations,
      inventory_stock_movements, inventory_stock_balances, inventory_warehouses,
      inventory_items, units_of_measure, operational_events CASCADE
  `);
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    if (EM) await rm(DIR, { recursive: true, force: true });
  }
  pool = null;
  pg = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

function requirePool(): Pool {
  if (!pool) throw new Error('test pool unavailable');
  return pool;
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function assertNoLeak(value: unknown): void {
  const text = JSON.stringify(value);
  for (const forbidden of [
    'idempotencyFingerprint',
    'idempotency_fingerprint',
    'approvedForName',
    'approved_for_name',
    'decisionNotes',
    'terminalIdempotencyKey',
    'P0001',
    'HANDYMAN_MATERIAL_INVENTORY_ISSUE_INVALID',
    'HANDYMAN_MATERIAL_INVENTORY_RETURN_INVALID',
  ]) {
    assert.ok(!text.includes(forbidden), `response leaks ${forbidden}`);
  }
}

async function makeHierarchy() {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'HM07 Run3 Client' });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'HM07 Run3 Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'HM07 Run3 Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, { buildingId: building.id });
  await clientMonetaryContextService.setClientMonetaryContext(
    {
      clientId: client.id,
      baseCurrencyCode: 'IDR',
      defaultTransactionCurrencyCode: 'IDR',
      allowedCurrencyCodes: ['IDR'],
    },
    adminUserId,
  );
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `F_${suffix()}`,
    name: 'Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
  const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
  const space = await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Space' });
  return { client, building, space };
}

async function makeTenant(h: Awaited<ReturnType<typeof makeHierarchy>>) {
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: h.client.id, tenantCode: `TC_${suffix()}`, tenantName: 'Run3 Tenant' },
    adminUserId,
  );
  await tenantSpaceService.assignSpaceToTenant(
    { tenantCompanyId: company.id, buildingId: h.building.id, spaceId: h.space.id },
    adminUserId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: company.id, buildingId: h.building.id },
    adminUserId,
  );
  const user = await userService.createUser({
    email: `hm07-run3-pic-${suffix().toLowerCase()}@example.com`,
    displayName: 'Run3 Tenant PIC',
  });
  await buildingAssignmentService.createAssignment(user.id, { buildingId: h.building.id });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      userId: user.id,
      picName: 'Run3 PIC',
      email: `hm07-run3-contact-${suffix().toLowerCase()}@example.com`,
      phone: '+6281298765400',
    },
    adminUserId,
  );
  return { company, pic, user };
}

async function loginAs(userId: string, email: string): Promise<string> {
  const password = `PicPass${suffix()}123`;
  await credentialService.createInitialCredential({ userId, password });
  const login = await api().post('/api/v1/auth/login').send({ email, password });
  assert.equal(login.status, 200);
  return login.body.data.sessionToken as string;
}

async function makeUom(clientId: string) {
  const id = randomUUID();
  await requirePool().query(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, 'Each', 'ea', 'COUNT')`,
    [id, clientId, `EA${suffix()}`.slice(0, 12)],
  );
  return { id };
}

async function makeJobFixture() {
  const h = await makeHierarchy();
  const tenant = await makeTenant(h);
  const uom = await makeUom(h.client.id);
  const item = await inventoryItemService.createInventoryItem({
    clientId: h.client.id,
    code: `ITEM_${suffix()}`,
    name: 'Run3 Provider Material',
    itemType: 'MATERIAL',
    uomId: uom.id,
  });
  const price = await priceCatalogEntryService.createPriceCatalogEntry(
    {
      clientId: h.client.id,
      sourceMode: 'MATERIAL',
      itemId: item.id,
      uomId: uom.id,
      currency: 'IDR',
      unitPrice: 10000,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      idempotencyKey: key('PRICE'),
    },
    adminUserId,
  );
  await priceCatalogEntryService.activatePriceCatalogEntry(price.id, adminUserId);
  const request = await createHandymanRequest(
    {
      buildingId: h.building.id,
      spaceId: h.space.id,
      tenantCompanyId: tenant.company.id,
      tenantPicId: tenant.pic.id,
      customerName: 'Run3 Customer',
      customerPhone: '+6281200000010',
      customerEmail: `hm07-run3-customer-${suffix().toLowerCase()}@example.com`,
      inboundChannel: 'WHATSAPP',
      title: 'Run3 operations fixture',
      description: 'HTTP fixture',
      priority: 'HIGH',
    },
    adminUserId,
  );
  await triageHandymanRequest(
    { requestId: request.id, path: 'QUOTATION', notes: 'Quoted material' },
    adminUserId,
  );
  const quote = await createHandymanQuotation({ requestId: request.id, currency: 'IDR' }, adminUserId);
  const line = await addHandymanQuotationLine(
    {
      revisionId: quote.revision.id,
      lineType: 'MATERIAL',
      inventoryItemId: item.id,
      uomId: uom.id,
      quantity: 4,
      unitPrice: 10000,
    },
    adminUserId,
  );
  await submitHandymanQuotationRevision(quote.revision.id, adminUserId);
  await sendHandymanQuotation(
    { quotationId: quote.quotation.id, revisionId: quote.revision.id },
    adminUserId,
  );
  await decideHandymanQuotationApprovalInApp(
    { quotationId: quote.quotation.id, decision: 'APPROVED' },
    tenant.user.id,
  );
  const job = await createHandymanJob({ handymanRequestId: request.id }, adminUserId);
  const warehouse = await inventoryWarehouseService.createWarehouse(
    { buildingId: h.building.id, code: `WH_${suffix()}`, name: 'Run3 Warehouse' },
    adminUserId,
  );
  await inventoryStockMovementService.postStockMovement({
    warehouseId: warehouse.id,
    itemId: item.id,
    movementType: 'STOCK_IN',
    quantity: 10,
    source: 'TEST_FIXTURE',
    performedByUserId: adminUserId,
  });
  return { h, tenant, uom, item, request, job: job.job, warehouse, line };
}

async function movementCount(prefix: string): Promise<number> {
  const result = await requirePool().query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM inventory_stock_movements WHERE source LIKE $1',
    [`${prefix}%`],
  );
  return Number(result.rows[0].count);
}

describe('CR-HM-BE-07 RUN 3: material operations HTTP contract', () => {
  it('lists demands and drives the quotation/operational/customer demand lanes with header idempotency', async (t) => {
    if (!ready(t)) return;
    const f = await makeJobFixture();

    const empty = await api()
      .get(`/api/v1/handyman-jobs/${f.job.id}/material-demands`)
      .set(auth(adminToken));
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.data, []);

    const qi = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-demands/quotation-included`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('QI') })
      .send({ handymanQuotationLineId: f.line.id });
    assert.equal(qi.status, 201);
    assert.equal(qi.body.data.replayed, false);
    assert.equal(qi.body.data.demand.commercialBasis, 'QUOTATION_INCLUDED');
    assert.equal(qi.body.data.demand.quantity, 4);
    assertNoLeak(qi.body);

    const qiReplayKey = key('QI_REPLAY');
    const first = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-demands/operational`)
      .set({ ...auth(adminToken), 'Idempotency-Key': qiReplayKey })
      .send({
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: f.item.id,
        uomId: f.uom.id,
        quantity: 2,
      });
    assert.equal(first.status, 201);
    const replay = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-demands/operational`)
      .set({ ...auth(adminToken), 'Idempotency-Key': qiReplayKey })
      .send({
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: f.item.id,
        uomId: f.uom.id,
        quantity: 2,
      });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.replayed, true);
    assert.equal(replay.body.data.demand.id, first.body.data.demand.id);

    const customer = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-demands/customer-supplied`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('CS') })
      .send({ uomId: f.uom.id, description: 'Customer gasket', quantity: 3 });
    assert.equal(customer.status, 201);
    assert.equal(customer.body.data.demand.supplySource, 'CUSTOMER_SUPPLIED');

    const pinned = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-demands/customer-supplied`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('CS_PIN') })
      .send({ supplySource: 'PROVIDER_STOCK', uomId: f.uom.id, quantity: 1 });
    assert.equal(pinned.status, 400);

    const listed = await api()
      .get(`/api/v1/handyman-jobs/${f.job.id}/material-demands`)
      .set(auth(adminToken));
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.length, 3);

    const one = await api()
      .get(`/api/v1/handyman-material-demands/${qi.body.data.demand.id}`)
      .set(auth(adminToken));
    assert.equal(one.status, 200);
    assert.equal(one.body.data.id, qi.body.data.demand.id);
    assertNoLeak(one.body);

    const superseded = await api()
      .post(`/api/v1/handyman-material-demands/${first.body.data.demand.id}/supersede`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('SUP') })
      .send({
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: f.item.id,
        uomId: f.uom.id,
        quantity: 5,
      });
    assert.equal(superseded.status, 201);
    assert.equal(superseded.body.data.demand.supersedesDemandId, first.body.data.demand.id);

    const cancelled = await api()
      .post(`/api/v1/handyman-material-demands/${customer.body.data.demand.id}/cancel`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('CX') })
      .send({ reason: 'SCOPE_NO_LONGER_REQUIRED' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.demand.status, 'CANCELLED');

    const missingKey = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-demands/operational`)
      .set(auth(adminToken))
      .send({
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: f.item.id,
        uomId: f.uom.id,
        quantity: 1,
      });
    assert.equal(missingKey.status, 400);
    assert.equal(missingKey.body.code ?? missingKey.body.error?.code, 'VALIDATION_ERROR');

    const protectedField = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-demands/operational`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('PROT') })
      .send({
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: f.item.id,
        uomId: f.uom.id,
        quantity: 1,
        clientId: f.h.client.id,
      });
    assert.equal(protectedField.status, 400);
  });

  it('creates addenda and preserves direct/assisted approval authority', async (t) => {
    if (!ready(t)) return;
    const f = await makeJobFixture();
    const picToken = await loginAs(f.tenant.user.id, f.tenant.user.email);

    const addendum = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-addenda`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('ADD') })
      .send({
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: f.item.id,
        uomId: f.uom.id,
        quantity: 2,
      });
    assert.equal(addendum.status, 201);
    assert.equal(addendum.body.data.addendum.status, 'PENDING');
    assert.equal(addendum.body.data.approval.status, 'PENDING');
    assertNoLeak(addendum.body);
    const approvalId = addendum.body.data.approval.id as string;

    const addenda = await api()
      .get(`/api/v1/handyman-jobs/${f.job.id}/material-addenda`)
      .set(auth(adminToken));
    assert.equal(addenda.status, 200);
    assert.equal(addenda.body.data.length, 1);

    const approvals = await api()
      .get(`/api/v1/handyman-jobs/${f.job.id}/material-approvals`)
      .set(auth(adminToken));
    assert.equal(approvals.status, 200);
    assert.equal(approvals.body.data.length, 1);

    // Staff is not the customer: direct decision fails closed.
    const staffDirect = await api()
      .post(`/api/v1/handyman-material-approvals/${approvalId}/decision/in-app`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('DIR_STAFF') })
      .send({ decision: 'APPROVED' });
    assert.equal(staffDirect.status, 403);
    assert.equal(
      staffDirect.body.code ?? staffDirect.body.error?.code,
      'HANDYMAN_MATERIAL_APPROVAL_NOT_AUTHORIZED',
    );

    const direct = await api()
      .post(`/api/v1/handyman-material-approvals/${approvalId}/decision/in-app`)
      .set({ ...auth(picToken), 'Idempotency-Key': key('DIR') })
      .send({ decision: 'APPROVED' });
    assert.equal(direct.status, 200);
    assert.equal(direct.body.data.approval.status, 'APPROVED');
    assert.equal(direct.body.data.approval.method, 'IN_APP');
    assert.equal(direct.body.data.approval.recordedByUserId, null);
    assertNoLeak(direct.body);

    const second = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-addenda`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('ADD2') })
      .send({
        supplySource: 'CUSTOMER_SUPPLIED',
        uomId: f.uom.id,
        description: 'Customer paint',
        quantity: 1,
      });
    assert.equal(second.status, 201);
    const assisted = await api()
      .post(
        `/api/v1/handyman-material-approvals/${second.body.data.approval.id}/decision/assisted`,
      )
      .set({ ...auth(adminToken), 'Idempotency-Key': key('AST') })
      .send({ decision: 'APPROVED', approvedFor: { type: 'TENANT_PIC' }, notes: 'Called PIC, approved.' });
    assert.equal(assisted.status, 200);
    assert.equal(assisted.body.data.approval.status, 'APPROVED');
    assert.equal(assisted.body.data.approval.method, 'ASSISTED');
    assert.equal(assisted.body.data.approval.recordedByUserId, adminUserId);
    assertNoLeak(assisted.body);

    // No identity shortcut: smuggled approver identity is rejected.
    const shortcut = await api()
      .post(
        `/api/v1/handyman-material-approvals/${second.body.data.approval.id}/decision/assisted`,
      )
      .set({ ...auth(adminToken), 'Idempotency-Key': key('SHORT') })
      .send({
        decision: 'APPROVED',
        approvedFor: { type: 'TENANT_PIC', tenantPicId: f.tenant.pic.id },
        notes: 'Shortcut attempt.',
      });
    assert.equal(shortcut.status, 400);

    const third = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-addenda`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('ADD3') })
      .send({
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: f.item.id,
        uomId: f.uom.id,
        quantity: 1,
      });
    assert.equal(third.status, 201);
    const cancelAddendum = await api()
      .post(`/api/v1/handyman-material-addenda/${third.body.data.addendum.id}/cancel`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('ADDCX') })
      .send({ reason: 'SCOPE_NO_LONGER_REQUIRED' });
    assert.equal(cancelAddendum.status, 200);
    assert.equal(cancelAddendum.body.data.addendum.status, 'CANCELLED');
  });

  it('reserves, issues pre-staged, uses, returns, and projects fulfillment', async (t) => {
    if (!ready(t)) return;
    const f = await makeJobFixture();
    const demand = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-demands/quotation-included`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('JQI') })
      .send({ handymanQuotationLineId: f.line.id });
    assert.equal(demand.status, 201);
    const demandId = demand.body.data.demand.id as string;

    const reserve = await api()
      .post(`/api/v1/handyman-material-demands/${demandId}/reservations`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('JRES') })
      .send({ warehouseId: f.warehouse.id, quantity: 3 });
    assert.equal(reserve.status, 201);
    assert.equal(reserve.body.data.reservation.remainingQuantity, 3);
    const reservationId = reserve.body.data.reservation.id as string;

    const reservations = await api()
      .get(`/api/v1/handyman-material-demands/${demandId}/reservations`)
      .set(auth(adminToken));
    assert.equal(reservations.status, 200);
    assert.equal(reservations.body.data.length, 1);

    const issue = await api()
      .post(`/api/v1/handyman-material-demands/${demandId}/issues`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('JISS') })
      .send({ warehouseId: f.warehouse.id, inventoryMaterialReservationId: reservationId, quantity: 2 });
    assert.equal(issue.status, 201);
    assert.equal(issue.body.data.issue.handymanServiceVisitId, null);
    assert.equal(issue.body.data.issue.handymanWorkSessionId, null);
    const issueId = issue.body.data.issue.id as string;
    assert.equal(await movementCount('HANDYMAN_MATERIAL_ISSUE:'), 1);

    const one = await api().get(`/api/v1/handyman-material-issues/${issueId}`).set(auth(adminToken));
    assert.equal(one.status, 200);
    assert.equal(one.body.data.id, issueId);

    const usage = await api()
      .post(`/api/v1/handyman-material-demands/${demandId}/usages`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('JUSE') })
      .send({ handymanMaterialControlledIssueId: issueId, usageKind: 'INSTALLED', quantity: 1 });
    assert.equal(usage.status, 201);
    assert.equal(usage.body.data.supplySource, 'PROVIDER_STOCK');

    const usages = await api()
      .get(`/api/v1/handyman-material-demands/${demandId}/usages`)
      .set(auth(adminToken));
    assert.equal(usages.status, 200);
    assert.equal(usages.body.data.length, 1);

    const returned = await api()
      .post(`/api/v1/handyman-material-issues/${issueId}/returns`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('JRET') })
      .send({ quantity: 1 });
    assert.equal(returned.status, 201);
    assert.equal(await movementCount('HANDYMAN_MATERIAL_RETURN:'), 1);

    const returns = await api()
      .get(`/api/v1/handyman-material-issues/${issueId}/returns`)
      .set(auth(adminToken));
    assert.equal(returns.status, 200);
    assert.equal(returns.body.data.length, 1);

    const fulfillment = await api()
      .get(`/api/v1/handyman-material-demands/${demandId}/fulfillment`)
      .set(auth(adminToken));
    assert.equal(fulfillment.status, 200);
    assert.deepEqual(
      {
        demandQuantity: fulfillment.body.data.demandQuantity,
        activeReservedQuantity: fulfillment.body.data.activeReservedQuantity,
        issuedQuantity: fulfillment.body.data.issuedQuantity,
        usedQuantity: fulfillment.body.data.usedQuantity,
        returnedQuantity: fulfillment.body.data.returnedQuantity,
        remainingDemandQuantity: fulfillment.body.data.remainingDemandQuantity,
        fulfillmentStatus: fulfillment.body.data.fulfillmentStatus,
      },
      {
        demandQuantity: 4,
        activeReservedQuantity: 1,
        issuedQuantity: 2,
        usedQuantity: 1,
        returnedQuantity: 1,
        remainingDemandQuantity: 1,
        fulfillmentStatus: 'PARTIALLY_FULFILLED',
      },
    );

    // Same key + changed facts => canonical conflict, no second fact.
    const conflictKey = key('JCON');
    const firstIssue = await api()
      .post(`/api/v1/handyman-material-demands/${demandId}/issues`)
      .set({ ...auth(adminToken), 'Idempotency-Key': conflictKey })
      .send({ warehouseId: f.warehouse.id, quantity: 0.5 });
    assert.equal(firstIssue.status, 201);
    const conflict = await api()
      .post(`/api/v1/handyman-material-demands/${demandId}/issues`)
      .set({ ...auth(adminToken), 'Idempotency-Key': conflictKey })
      .send({ warehouseId: f.warehouse.id, quantity: 1 });
    assert.equal(conflict.status, 409);
    assert.equal(
      conflict.body.code ?? conflict.body.error?.code,
      'HANDYMAN_MATERIAL_INVENTORY_IDEMPOTENCY_CONFLICT',
    );

    const released = await api()
      .post(`/api/v1/handyman-material-reservations/${reservationId}/release`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('JREL') })
      .send({});
    assert.equal(released.status, 200);
    assert.equal(released.body.data.reservation.status, 'RELEASED');

    // CUSTOMER_SUPPLIED demands cannot reserve provider stock.
    const cs = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-demands/customer-supplied`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('JCS') })
      .send({ uomId: f.uom.id, description: 'Customer nails', quantity: 2 });
    assert.equal(cs.status, 201);
    const csReserve = await api()
      .post(`/api/v1/handyman-material-demands/${cs.body.data.demand.id}/reservations`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('JCSR') })
      .send({ warehouseId: f.warehouse.id, quantity: 1 });
    assert.equal(csReserve.status, 409);
    assert.equal(
      csReserve.body.code ?? csReserve.body.error?.code,
      'HANDYMAN_MATERIAL_INVENTORY_DEMAND_NOT_EXECUTABLE',
    );
  });

  it('records customer-supplied usage with zero inventory movement', async (t) => {
    if (!ready(t)) return;
    const f = await makeJobFixture();
    const cs = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-demands/customer-supplied`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('CSD') })
      .send({ uomId: f.uom.id, description: 'Customer screws', quantity: 2 });
    assert.equal(cs.status, 201);
    const before = await movementCount('HANDYMAN_MATERIAL_');
    const usage = await api()
      .post(`/api/v1/handyman-material-demands/${cs.body.data.demand.id}/usages`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('CSU') })
      .send({ quantity: 1 });
    assert.equal(usage.status, 201);
    assert.equal(usage.body.data.supplySource, 'CUSTOMER_SUPPLIED');
    assert.equal(usage.body.data.usage.handymanMaterialControlledIssueId, null);
    assert.equal(await movementCount('HANDYMAN_MATERIAL_'), before);

    const fulfillment = await api()
      .get(`/api/v1/handyman-material-demands/${cs.body.data.demand.id}/fulfillment`)
      .set(auth(adminToken));
    assert.equal(fulfillment.status, 200);
    assert.equal(fulfillment.body.data.usedQuantity, 1);
    assert.equal(fulfillment.body.data.remainingDemandQuantity, 1);
    assert.equal(fulfillment.body.data.fulfillmentStatus, 'PARTIALLY_FULFILLED');
  });

  it('attaches evidence to CR07 parents without mutating them', async (t) => {
    if (!ready(t)) return;
    const f = await makeJobFixture();
    const demand = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-demands/operational`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('EVD') })
      .send({
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: f.item.id,
        uomId: f.uom.id,
        quantity: 1,
      });
    assert.equal(demand.status, 201);
    const demandId = demand.body.data.demand.id as string;

    const attached = await api()
      .post('/api/v1/supporting-documents')
      .set(auth(adminToken))
      .send({
        clientId: f.h.client.id,
        buildingId: f.h.building.id,
        contextType: 'INTERNAL',
        title: 'Delivery photo',
        fileReference: 'opaque-ref-001',
        documentNumber: `EV_${suffix()}`,
        documentType: 'PHOTO',
        parentType: 'HANDYMAN_MATERIAL_DEMAND',
        parentId: demandId,
      });
    assert.equal(attached.status, 201);
    assert.equal(attached.body.data.parentType, 'HANDYMAN_MATERIAL_DEMAND');

    const unknownParent = await api()
      .post('/api/v1/supporting-documents')
      .set(auth(adminToken))
      .send({
        clientId: f.h.client.id,
        buildingId: f.h.building.id,
        contextType: 'INTERNAL',
        title: 'Ghost photo',
        fileReference: 'opaque-ref-002',
        documentNumber: `EV_${suffix()}`,
        documentType: 'PHOTO',
        parentType: 'HANDYMAN_MATERIAL_DEMAND',
        parentId: randomUUID(),
      });
    assert.equal(unknownParent.status, 404);

    const other = await makeJobFixture();
    const crossClient = await api()
      .post('/api/v1/supporting-documents')
      .set(auth(adminToken))
      .send({
        clientId: other.h.client.id,
        buildingId: other.h.building.id,
        contextType: 'INTERNAL',
        title: 'Cross photo',
        fileReference: 'opaque-ref-003',
        documentNumber: `EV_${suffix()}`,
        documentType: 'PHOTO',
        parentType: 'HANDYMAN_MATERIAL_DEMAND',
        parentId: demandId,
      });
    assert.equal(crossClient.status, 400);

    const still = await api()
      .get(`/api/v1/handyman-material-demands/${demandId}`)
      .set(auth(adminToken));
    assert.equal(still.status, 200);
    assert.equal(still.body.data.status, 'ACTIVE');
  });

  it('normalizes the NULL-UOM fail-closed signature to a governed domain error', async (t) => {
    if (!ready(t)) return;
    const f = await makeJobFixture();
    const nullUomItem = await inventoryItemService.createInventoryItem({
      clientId: f.h.client.id,
      code: `ITEM_${suffix()}`,
      name: 'Null UOM Material',
      itemType: 'MATERIAL',
    });
    await inventoryStockMovementService.postStockMovement({
      warehouseId: f.warehouse.id,
      itemId: nullUomItem.id,
      movementType: 'STOCK_IN',
      quantity: 5,
      source: 'TEST_FIXTURE',
      performedByUserId: adminUserId,
    });
    const demand = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-demands/operational`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('NUO') })
      .send({
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: nullUomItem.id,
        uomId: f.uom.id,
        quantity: 2,
      });
    assert.equal(demand.status, 201);
    const reserve = await api()
      .post(`/api/v1/handyman-material-demands/${demand.body.data.demand.id}/reservations`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('NUR') })
      .send({ warehouseId: f.warehouse.id, quantity: 2 });
    assert.equal(reserve.status, 201);

    const issue = await api()
      .post(`/api/v1/handyman-material-demands/${demand.body.data.demand.id}/issues`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('NUI') })
      .send({
        warehouseId: f.warehouse.id,
        inventoryMaterialReservationId: reserve.body.data.reservation.id,
        quantity: 2,
      });
    assert.equal(issue.status, 400);
    assert.equal(
      issue.body.code ?? issue.body.error?.code,
      'HANDYMAN_MATERIAL_INVENTORY_UOM_INCOMPATIBLE',
    );
    assertNoLeak(issue.body);
  });

  it('rejects cross-client/building access', async (t) => {
    if (!ready(t)) return;
    const f = await makeJobFixture();
    const demand = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-demands/operational`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('XCD') })
      .send({
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: f.item.id,
        uomId: f.uom.id,
        quantity: 1,
      });
    assert.equal(demand.status, 201);

    // Fully permissioned but assigned to no building: denied by service scope.
    const unassigned = await createSessionWithPermissions([
      { code: 'handyman_material.read', name: 'Read Handyman Material Operations' },
      { code: 'handyman_material.manage', name: 'Manage Handyman Material Operations' },
      { code: 'handyman_material.approve', name: 'Record Handyman Material Approval Decisions' },
      { code: 'inventory_stock.read', name: 'Read Stock Balances' },
      { code: 'inventory_stock.manage', name: 'Manage Stock Balances' },
    ]);
    const deniedRead = await api()
      .get(`/api/v1/handyman-material-demands/${demand.body.data.demand.id}`)
      .set(auth(unassigned));
    assert.equal(deniedRead.status, 403);
    const deniedCommand = await api()
      .post(`/api/v1/handyman-material-demands/${demand.body.data.demand.id}/reservations`)
      .set({ ...auth(unassigned), 'Idempotency-Key': key('XCR') })
      .send({ warehouseId: f.warehouse.id, quantity: 1 });
    assert.equal(deniedCommand.status, 403);

    // A different client's actor cannot reach this demand either.
    const other = await makeJobFixture();
    const picToken = await loginAs(other.tenant.user.id, other.tenant.user.email);
    const crossDemand = await api()
      .get(`/api/v1/handyman-material-demands/${demand.body.data.demand.id}`)
      .set(auth(picToken));
    assert.equal(crossDemand.status, 403);
  });

  it('enforces representative RBAC denials', async (t) => {
    if (!ready(t)) return;
    const f = await makeJobFixture();
    const demand = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-demands/operational`)
      .set({ ...auth(adminToken), 'Idempotency-Key': key('RBD') })
      .send({
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: f.item.id,
        uomId: f.uom.id,
        quantity: 1,
      });
    assert.equal(demand.status, 201);
    const demandId = demand.body.data.demand.id as string;

    const plain = await createPlainSession();
    const plainRead = await api()
      .get(`/api/v1/handyman-jobs/${f.job.id}/material-demands`)
      .set(auth(plain));
    assert.equal(plainRead.status, 403);
    const plainCommand = await api()
      .post(`/api/v1/handyman-material-demands/${demandId}/reservations`)
      .set({ ...auth(plain), 'Idempotency-Key': key('RBP') })
      .send({ warehouseId: f.warehouse.id, quantity: 1 });
    assert.equal(plainCommand.status, 403);

    const readOnly = await createSessionWithPermissions([
      { code: 'handyman_material.read', name: 'Read Handyman Material Operations' },
    ]);
    const readOk = await api()
      .get(`/api/v1/handyman-jobs/${f.job.id}/material-demands`)
      .set(auth(readOnly));
    // RBAC passes; service building scope denies (no assignment) — still not 403-by-RBAC alone.
    assert.equal(readOk.status, 403);
    const manageDenied = await api()
      .post(`/api/v1/handyman-jobs/${f.job.id}/material-demands/operational`)
      .set({ ...auth(readOnly), 'Idempotency-Key': key('RBR') })
      .send({
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: f.item.id,
        uomId: f.uom.id,
        quantity: 1,
      });
    assert.equal(manageDenied.status, 403);

    // Manage without the composed inventory permission cannot reserve/issue.
    const noInventory = await createSessionWithPermissions([
      { code: 'handyman_material.read', name: 'Read Handyman Material Operations' },
      { code: 'handyman_material.manage', name: 'Manage Handyman Material Operations' },
    ]);
    const reserveDenied = await api()
      .post(`/api/v1/handyman-material-demands/${demandId}/reservations`)
      .set({ ...auth(noInventory), 'Idempotency-Key': key('RBN') })
      .send({ warehouseId: f.warehouse.id, quantity: 1 });
    assert.equal(reserveDenied.status, 403);
    const issueDenied = await api()
      .post(`/api/v1/handyman-material-demands/${demandId}/issues`)
      .set({ ...auth(noInventory), 'Idempotency-Key': key('RBI') })
      .send({ warehouseId: f.warehouse.id, quantity: 1 });
    assert.equal(issueDenied.status, 403);
  });
});
