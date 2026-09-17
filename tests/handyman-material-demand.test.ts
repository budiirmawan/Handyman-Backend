import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, runSeeds } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { floorService } from '../src/modules/floors';
import {
  createHandymanJob,
} from '../src/modules/handyman-jobs';
import {
  cancelHandymanMaterialCommercialAddendum,
  cancelHandymanMaterialDemand,
  createCustomerSuppliedMaterialDemand,
  createHandymanMaterialCommercialAddendum,
  createNonChargeableMaterialDemand,
  createQuotationIncludedMaterialDemand,
  decideHandymanMaterialApprovalInApp,
  getHandymanMaterialCommercialAddendum,
  getHandymanMaterialApproval,
  getHandymanMaterialDemand,
  listHandymanMaterialDemands,
  recordHandymanMaterialApprovalAssistedDecision,
} from '../src/modules/handyman-material-demands';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  decideHandymanQuotationApprovalInApp,
  sendHandymanQuotation,
  submitHandymanQuotationRevision,
} from '../src/modules/handyman-quotations';
import {
  triageHandymanRequest,
} from '../src/modules/handyman-request-governance';
import { createHandymanRequest } from '../src/modules/handyman-requests';
import { inventoryItemService } from '../src/modules/inventory-items';
import { priceCatalogEntryService } from '../src/modules/price-catalog-entries';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-07 RUN 1 — focused embedded-PG service suite.
 *
 * This deliberately exercises only the new job-scoped material authority:
 * exact approved quotation-line demand, immutable customer-chargeable
 * addendum + dedicated decision, customer-supplied/non-chargeable scope,
 * idempotency/concurrency/history, privacy-safe reads, and the zero-inventory
 * write boundary. No HTTP/OpenAPI/mobile or Run-2 fulfilment test is present.
 */

const PORT = 55508;
const DIR = '/tmp/asentra-hm07-run1-pg';
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
let adminUserId = '';
let outsiderUserId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const CUSTOMER_NAME = 'MATERIAL-CANARY Rina Tenant';
const CUSTOMER_PHONE = '+6281298777007';
const CUSTOMER_EMAIL = 'material-canary@customer.example.com';

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
    TRUNCATE handyman_material_demands, handyman_material_approvals,
      handyman_material_commercial_addenda, handyman_job_assignments,
      handyman_jobs, vendor_works, vendor_assignments, work_orders,
      handyman_quotation_approval_links, handyman_quotation_approvals,
      handyman_quotation_lines, handyman_quotation_revisions,
      handyman_quotations, handyman_request_triages, handyman_request_services,
      handyman_inspections, handyman_requests, handyman_providers,
      tenant_space_relationships, tenant_building_contexts, tenant_pics,
      tenant_companies, price_catalog_entries, inventory_material_reservations,
      inventory_stock_movements, inventory_stock_balances, inventory_items,
      units_of_measure, operational_events CASCADE
  `);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const outsider = await userService.createUser({
    email: `hm07-outsider-${suffix().toLowerCase()}@example.com`,
    displayName: 'HM07 Outsider',
  });
  outsiderUserId = outsider.id;
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

async function expectError(
  promise: Promise<unknown>,
  code: string,
  statusCode: number,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const appError = error as { code?: string; statusCode?: number };
    assert.equal(appError.code, code);
    assert.equal(appError.statusCode, statusCode);
    return;
  }
  assert.fail(`Expected ${code} (${statusCode})`);
}

async function createHierarchy() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'HM07 Material Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'HM07 Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'HM07 Tower',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  await clientMonetaryContextService.setClientMonetaryContext(
    {
      clientId: client.id,
      baseCurrencyCode: 'IDR',
      defaultTransactionCurrencyCode: 'IDR',
      allowedCurrencyCodes: ['IDR', 'USD'],
    },
    adminUserId,
  );
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `F_${suffix()}`,
    name: 'HM07 Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A_${suffix()}`,
    name: 'HM07 Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R_${suffix()}`,
    name: 'HM07 Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `S_${suffix()}`,
    name: 'HM07 Unit',
  });
  return { client, building, space };
}

async function makeTenantContext(h: {
  client: { id: string };
  building: { id: string };
  space: { id: string };
}) {
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: h.client.id,
      tenantCode: `TC_${suffix()}`,
      tenantName: 'HM07 Tenant Company',
    },
    adminUserId,
  );
  await tenantSpaceService.assignSpaceToTenant(
    {
      tenantCompanyId: company.id,
      buildingId: h.building.id,
      spaceId: h.space.id,
    },
    adminUserId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: company.id, buildingId: h.building.id },
    adminUserId,
  );
  const picUser = await userService.createUser({
    email: `hm07-pic-${suffix().toLowerCase()}@tenant.example.com`,
    displayName: 'HM07 Tenant PIC',
  });
  await buildingAssignmentService.createAssignment(picUser.id, {
    buildingId: h.building.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      userId: picUser.id,
      picName: 'HM07 PIC Name',
      email: `hm07-pic-contact-${suffix().toLowerCase()}@tenant.example.com`,
      phone: '+6281200000007',
    },
    adminUserId,
  );
  return { company, pic, picUser };
}

async function makeUom(clientId: string) {
  const id = randomUUID();
  const code = `EA${suffix()}`.slice(0, 12);
  await requirePool().query(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, clientId, code, 'Each', 'ea', 'COUNT'],
  );
  return { id, code };
}

async function makeMaterialPrice(
  clientId: string,
  itemId: string,
  uomId: string,
  unitPrice: number,
) {
  const created = await priceCatalogEntryService.createPriceCatalogEntry(
    {
      clientId,
      sourceMode: 'MATERIAL',
      itemId,
      uomId,
      currency: 'IDR',
      unitPrice,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      idempotencyKey: `HM07_PRICE_${suffix()}_${randomUUID()}`,
    },
    adminUserId,
  );
  return priceCatalogEntryService.activatePriceCatalogEntry(created.id, adminUserId);
}

/** Full real authority chain through an approved quotation MATERIAL line and job. */
async function makeMaterialJob() {
  const h = await createHierarchy();
  const tenant = await makeTenantContext(h);
  const uom = await makeUom(h.client.id);
  const item = await inventoryItemService.createInventoryItem({
    clientId: h.client.id,
    code: `ITEM_${suffix()}`,
    name: 'Quoted replacement valve',
    itemType: 'MATERIAL',
  });
  const referencePrice = await makeMaterialPrice(h.client.id, item.id, uom.id, 12500);
  const request = await createHandymanRequest(
    {
      buildingId: h.building.id,
      spaceId: h.space.id,
      tenantCompanyId: tenant.company.id,
      tenantPicId: tenant.pic.id,
      customerName: CUSTOMER_NAME,
      customerPhone: CUSTOMER_PHONE,
      customerEmail: CUSTOMER_EMAIL,
      inboundChannel: 'WHATSAPP',
      title: 'HM07 material fixture',
      description: 'Fixture scope only.',
      priority: 'HIGH',
    },
    adminUserId,
  );
  await triageHandymanRequest(
    { requestId: request.id, path: 'QUOTATION', notes: 'Known material scope' },
    adminUserId,
  );
  const quote = await createHandymanQuotation(
    { requestId: request.id, currency: 'IDR' },
    adminUserId,
  );
  const materialLine = await addHandymanQuotationLine(
    {
      revisionId: quote.revision.id,
      lineType: 'MATERIAL',
      inventoryItemId: item.id,
      uomId: uom.id,
      quantity: 4,
      unitPrice: 12500,
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
    tenant.picUser.id,
  );
  const created = await createHandymanJob(
    { handymanRequestId: request.id },
    adminUserId,
  );
  assert.equal(created.created, true);
  return {
    h,
    tenant,
    uom,
    item,
    referencePrice,
    request,
    quote,
    materialLine,
    job: created.job,
  };
}

async function stockWriteCounts() {
  const result = await requirePool().query<{
    balances: number;
    movements: number;
    reservations: number;
  }>(`
    SELECT
      (SELECT count(*)::int FROM inventory_stock_balances) AS balances,
      (SELECT count(*)::int FROM inventory_stock_movements) AS movements,
      (SELECT count(*)::int FROM inventory_material_reservations) AS reservations
  `);
  return result.rows[0];
}

async function demandRows(jobId: string) {
  const result = await requirePool().query<{
    id: string;
    status: string;
    commercial_basis: string;
    source_context: string;
    inventory_item_id: string | null;
    uom_id: string;
    quantity: string;
    handyman_quotation_line_id: string | null;
    commercial_addendum_id: string | null;
    handyman_material_approval_id: string | null;
  }>(`
    SELECT id, status, commercial_basis, source_context, inventory_item_id,
           uom_id, quantity, handyman_quotation_line_id,
           commercial_addendum_id, handyman_material_approval_id
    FROM handyman_material_demands
    WHERE handyman_job_id = $1
    ORDER BY created_at ASC, id ASC
  `, [jobId]);
  return result.rows;
}

async function eventsFor(entityId: string) {
  const result = await requirePool().query<{
    event_type: string;
    summary: string;
    metadata: Record<string, unknown>;
  }>(`
    SELECT event_type, summary, metadata
    FROM operational_events
    WHERE entity_id = $1
    ORDER BY occurred_at ASC, id ASC
  `, [entityId]);
  return result.rows;
}

function assertNoSensitiveMaterialEventData(events: Awaited<ReturnType<typeof eventsFor>>) {
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes(CUSTOMER_NAME), 'customer name leaked to material event');
  assert.ok(!serialized.includes(CUSTOMER_PHONE), 'customer phone leaked to material event');
  assert.ok(!serialized.includes(CUSTOMER_EMAIL), 'customer email leaked to material event');
  assert.ok(!serialized.includes('assisted-canary-note'), 'assisted narrative leaked to material event');
  assert.ok(!serialized.includes('unitCommercialAmount'), 'commercial amount leaked to material event');
  assert.ok(!serialized.includes('totalCommercialAmount'), 'commercial total leaked to material event');
  assert.ok(!serialized.includes('unitPrice'), 'price value leaked to material event');
  assert.ok(!serialized.includes('"currency"'), 'currency/price payload leaked to material event');
}

describe('CR-HM-BE-07 RUN 1: job-scoped material demand authority', () => {
  it('derives one immutable quotation-included demand from the exact approved MATERIAL line', async (t) => {
    if (!ready(t)) return;
    const base = await makeMaterialJob();
    const stockBefore = await stockWriteCounts();
    const includedKey = `HM07_INCLUDED_${suffix()}`;
    const first = await createQuotationIncludedMaterialDemand(
      {
        handymanJobId: base.job.id,
        handymanQuotationLineId: base.materialLine.id,
        idempotencyKey: includedKey,
      },
      adminUserId,
    );
    const replay = await createQuotationIncludedMaterialDemand(
      {
        handymanJobId: base.job.id,
        handymanQuotationLineId: base.materialLine.id,
        idempotencyKey: includedKey,
      },
      adminUserId,
    );
    // Same-key replay returns the original fact. A separately keyed command
    // cannot silently borrow this fact and later reuse its key for new scope.
    await expectError(
      createQuotationIncludedMaterialDemand(
        {
          handymanJobId: base.job.id,
          handymanQuotationLineId: base.materialLine.id,
          idempotencyKey: `HM07_INCLUDED_DIFFERENT_KEY_${suffix()}`,
        },
        adminUserId,
      ),
      'HANDYMAN_MATERIAL_DEMAND_STATE_INVALID',
      409,
    );
    assert.equal(first.demand.commercialBasis, 'QUOTATION_INCLUDED');
    assert.equal(first.demand.supplySource, 'PROVIDER_STOCK');
    assert.equal(first.demand.inventoryItemId, base.item.id);
    assert.equal(first.demand.uomId, base.uom.id);
    assert.equal(first.demand.quantity, base.materialLine.quantity);
    assert.equal(first.demand.quotationRevisionId, base.quote.revision.id);
    assert.equal(first.demand.handymanQuotationLineId, base.materialLine.id);
    assert.equal(replay.demand.id, first.demand.id);
    assert.equal(replay.replayed, true);
    const rows = await demandRows(base.job.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].handyman_quotation_line_id, base.materialLine.id);
    assert.equal(rows[0].commercial_basis, 'QUOTATION_INCLUDED');
    await assert.rejects(
      requirePool().query(
        `UPDATE handyman_material_demands SET quantity = 9 WHERE id = $1`,
        [first.demand.id],
      ),
      /HANDYMAN_MATERIAL_DEMAND_STATE_INVALID/,
    );
    const cancelled = await cancelHandymanMaterialDemand(
      {
        handymanMaterialDemandId: first.demand.id,
        reason: 'SCOPE_NO_LONGER_REQUIRED',
        idempotencyKey: `HM07_INCLUDED_CANCEL_${suffix()}`,
      },
      adminUserId,
    );
    assert.equal(cancelled.demand.status, 'CANCELLED');
    await expectError(
      createQuotationIncludedMaterialDemand(
        {
          handymanJobId: base.job.id,
          handymanQuotationLineId: base.materialLine.id,
          idempotencyKey: `HM07_INCLUDED_CLOSED_RECREATE_${suffix()}`,
        },
        adminUserId,
      ),
      'HANDYMAN_MATERIAL_DEMAND_STATE_INVALID',
      409,
    );
    assert.deepEqual(await stockWriteCounts(), stockBefore);
    assertNoSensitiveMaterialEventData(await eventsFor(first.demand.id));
  });

  it('uses only a matched price-catalog snapshot for additional Provider-stock scope and creates demand only on direct approval', async (t) => {
    if (!ready(t)) return;
    const base = await makeMaterialJob();
    const stockBefore = await stockWriteCounts();
    const addendumResult = await createHandymanMaterialCommercialAddendum(
      {
        handymanJobId: base.job.id,
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: base.item.id,
        uomId: base.uom.id,
        quantity: 2,
        description: 'Additional replacement valve',
        idempotencyKey: `HM07_ADDENDUM_${suffix()}`,
      },
      adminUserId,
    );
    assert.equal(addendumResult.addendum.status, 'PENDING');
    assert.equal(addendumResult.approval.status, 'PENDING');
    assert.equal(addendumResult.addendum.currency, 'IDR');
    assert.equal(addendumResult.addendum.unitCommercialAmount, 12500);
    assert.equal(addendumResult.addendum.totalCommercialAmount, 25000);
    assert.equal(
      addendumResult.addendum.referencePriceCatalogEntryId,
      base.referencePrice.id,
    );
    await assert.rejects(
      requirePool().query(
        `UPDATE handyman_material_commercial_addenda
         SET unit_commercial_amount = 1
         WHERE id = $1`,
        [addendumResult.addendum.id],
      ),
      /HANDYMAN_MATERIAL_ADDENDUM_STATE_INVALID/,
    );
    assert.equal((await demandRows(base.job.id)).length, 0);

    const approved = await decideHandymanMaterialApprovalInApp(
      {
        handymanMaterialApprovalId: addendumResult.approval.id,
        decision: 'APPROVED',
        idempotencyKey: `HM07_DIRECT_APPROVE_${suffix()}`,
      },
      base.tenant.picUser.id,
    );
    assert.equal(approved.approval.status, 'APPROVED');
    assert.equal(approved.approval.method, 'IN_APP');
    assert.equal(approved.approval.approvedForType, 'TENANT_PIC');
    assert.equal(approved.approval.approvedForTenantPicId, base.tenant.pic.id);
    assert.equal(approved.approval.recordedByUserId, null);
    assert.equal(approved.demand?.commercialBasis, 'ADDITIONAL_CUSTOMER_CHARGEABLE');
    assert.equal(approved.demand?.commercialAddendumId, addendumResult.addendum.id);
    assert.equal(approved.demand?.handymanMaterialApprovalId, addendumResult.approval.id);
    assert.equal((await demandRows(base.job.id)).length, 1);
    assert.deepEqual(await stockWriteCounts(), stockBefore);
    assertNoSensitiveMaterialEventData(await eventsFor(addendumResult.addendum.id));
    assertNoSensitiveMaterialEventData(await eventsFor(addendumResult.approval.id));
  });

  it('records assisted rejection separately from Approved For, exposes no customer narrative, and serializes decision races', async (t) => {
    if (!ready(t)) return;
    const base = await makeMaterialJob();
    const rejectedAddendum = await createHandymanMaterialCommercialAddendum(
      {
        handymanJobId: base.job.id,
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: base.item.id,
        uomId: base.uom.id,
        quantity: 1,
        idempotencyKey: `HM07_REJECT_ADDENDUM_${suffix()}`,
      },
      adminUserId,
    );
    const rejected = await recordHandymanMaterialApprovalAssistedDecision(
      {
        handymanMaterialApprovalId: rejectedAddendum.approval.id,
        decision: 'REJECTED',
        approvedFor: { type: 'CUSTOMER' },
        notes: 'assisted-canary-note customer declined this scope',
        idempotencyKey: `HM07_ASSISTED_REJECT_${suffix()}`,
      },
      adminUserId,
    );
    assert.equal(rejected.approval.status, 'REJECTED');
    assert.equal(rejected.approval.method, 'ASSISTED');
    assert.equal(rejected.approval.approvedForType, 'CUSTOMER');
    assert.equal(rejected.approval.recordedByUserId, adminUserId);
    assert.equal(rejected.demand, null);
    const publicApproval = await getHandymanMaterialApproval(
      rejected.approval.id,
      adminUserId,
    );
    const publicSerialized = JSON.stringify(publicApproval);
    assert.ok(!publicSerialized.includes(CUSTOMER_NAME));
    assert.ok(!publicSerialized.includes('assisted-canary-note'));
    assertNoSensitiveMaterialEventData(await eventsFor(rejected.approval.id));

    const racedAddendum = await createHandymanMaterialCommercialAddendum(
      {
        handymanJobId: base.job.id,
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: base.item.id,
        uomId: base.uom.id,
        quantity: 3,
        idempotencyKey: `HM07_RACE_ADDENDUM_${suffix()}`,
      },
      adminUserId,
    );
    const race = await Promise.allSettled([
      decideHandymanMaterialApprovalInApp(
        {
          handymanMaterialApprovalId: racedAddendum.approval.id,
          decision: 'APPROVED',
          idempotencyKey: `HM07_RACE_DIRECT_${suffix()}`,
        },
        base.tenant.picUser.id,
      ),
      recordHandymanMaterialApprovalAssistedDecision(
        {
          handymanMaterialApprovalId: racedAddendum.approval.id,
          decision: 'REJECTED',
          approvedFor: { type: 'CUSTOMER' },
          notes: 'assisted-canary-note competing decision',
          idempotencyKey: `HM07_RACE_ASSISTED_${suffix()}`,
        },
        adminUserId,
      ),
    ]);
    assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(race.filter((result) => result.status === 'rejected').length, 1);
    const rows = await demandRows(base.job.id);
    const fromRace = rows.filter(
      (row) => row.handyman_material_approval_id === racedAddendum.approval.id,
    );
    const finalRaceApproval = await getHandymanMaterialApproval(
      racedAddendum.approval.id,
      adminUserId,
    );
    assert.ok(
      finalRaceApproval.status === 'APPROVED' || finalRaceApproval.status === 'REJECTED',
    );
    assert.equal(
      fromRace.length,
      finalRaceApproval.status === 'APPROVED' ? 1 : 0,
    );
  });

  it('supports customer-supplied/non-chargeable scope without item creation or inventory writes, with strict idempotency and successor history', async (t) => {
    if (!ready(t)) return;
    const base = await makeMaterialJob();
    const stockBefore = await stockWriteCounts();
    const customerSuppliedKey = `HM07_CUSTOMER_SUPPLIED_${suffix()}`;
    const customerSupplied = await createCustomerSuppliedMaterialDemand(
      {
        handymanJobId: base.job.id,
        uomId: base.uom.id,
        description: 'Customer supplied compatible gasket',
        quantity: '1.5',
        idempotencyKey: customerSuppliedKey,
      },
      adminUserId,
    );
    assert.equal(customerSupplied.demand.supplySource, 'CUSTOMER_SUPPLIED');
    assert.equal(customerSupplied.demand.commercialBasis, 'NON_CHARGEABLE_OPERATIONAL');
    assert.equal(customerSupplied.demand.inventoryItemId, null);
    assert.deepEqual(await stockWriteCounts(), stockBefore);

    await expectError(
      createCustomerSuppliedMaterialDemand(
        {
          handymanJobId: base.job.id,
          uomId: base.uom.id,
          description: 'changed facts must conflict',
          quantity: '1.5',
          idempotencyKey: customerSuppliedKey,
        },
        adminUserId,
      ),
      'HANDYMAN_MATERIAL_DEMAND_IDEMPOTENCY_CONFLICT',
      409,
    );
    const originalKey = `HM07_SAME_KEY_${suffix()}`;
    const initial = await createNonChargeableMaterialDemand(
      {
        handymanJobId: base.job.id,
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: base.item.id,
        uomId: base.uom.id,
        quantity: 1,
        idempotencyKey: originalKey,
      },
      adminUserId,
    );
    await expectError(
      createNonChargeableMaterialDemand(
        {
          handymanJobId: base.job.id,
          supplySource: 'PROVIDER_STOCK',
          inventoryItemId: base.item.id,
          uomId: base.uom.id,
          quantity: 2,
          idempotencyKey: originalKey,
        },
        adminUserId,
      ),
      'HANDYMAN_MATERIAL_DEMAND_IDEMPOTENCY_CONFLICT',
      409,
    );
    const successor = await createNonChargeableMaterialDemand(
      {
        handymanJobId: base.job.id,
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: base.item.id,
        uomId: base.uom.id,
        quantity: 2,
        supersedesDemandId: initial.demand.id,
        idempotencyKey: `HM07_SUCCESSOR_${suffix()}`,
      },
      adminUserId,
    );
    assert.equal(successor.demand.supersedesDemandId, initial.demand.id);
    const history = await listHandymanMaterialDemands(base.job.id, adminUserId);
    assert.equal(history.find((row) => row.id === initial.demand.id)?.status, 'SUPERSEDED');
    assert.equal(history.find((row) => row.id === successor.demand.id)?.status, 'ACTIVE');
    await expectError(
      createNonChargeableMaterialDemand(
        {
          handymanJobId: base.job.id,
          supplySource: 'CUSTOMER_SUPPLIED',
          uomId: base.uom.id,
          description: 'Field item without visit',
          quantity: 1,
          sourceContext: 'FIELD_DISCOVERED',
          idempotencyKey: `HM07_FIELD_NO_VISIT_${suffix()}`,
        },
        adminUserId,
      ),
      'HANDYMAN_MATERIAL_DEMAND_CONTEXT_INVALID',
      409,
    );
    await expectError(
      getHandymanMaterialDemand(customerSupplied.demand.id, outsiderUserId),
      'BUILDING_ACCESS_DENIED',
      403,
    );
  });

  it('fails closed without an authoritative Provider-stock price and preserves pending addendum succession/cancellation history', async (t) => {
    if (!ready(t)) return;
    const base = await makeMaterialJob();
    const unpriced = await inventoryItemService.createInventoryItem({
      clientId: base.h.client.id,
      code: `UNPRICED_${suffix()}`,
      name: 'No authoritative price material',
      itemType: 'MATERIAL',
    });
    await expectError(
      createHandymanMaterialCommercialAddendum(
        {
          handymanJobId: base.job.id,
          supplySource: 'PROVIDER_STOCK',
          inventoryItemId: unpriced.id,
          uomId: base.uom.id,
          quantity: 1,
          idempotencyKey: `HM07_UNPRICED_${suffix()}`,
        },
        adminUserId,
      ),
      'HANDYMAN_MATERIAL_ADDENDUM_PRICE_UNRESOLVED',
      409,
    );

    const pending = await createHandymanMaterialCommercialAddendum(
      {
        handymanJobId: base.job.id,
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: base.item.id,
        uomId: base.uom.id,
        quantity: 1,
        idempotencyKey: `HM07_PENDING_ADDENDUM_${suffix()}`,
      },
      adminUserId,
    );
    const successor = await createHandymanMaterialCommercialAddendum(
      {
        handymanJobId: base.job.id,
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: base.item.id,
        uomId: base.uom.id,
        quantity: 2,
        supersedesAddendumId: pending.addendum.id,
        idempotencyKey: `HM07_PENDING_SUCCESSOR_${suffix()}`,
      },
      adminUserId,
    );
    const superseded = await getHandymanMaterialCommercialAddendum(
      pending.addendum.id,
      adminUserId,
    );
    const cancelledPendingApproval = await getHandymanMaterialApproval(
      pending.approval.id,
      adminUserId,
    );
    assert.equal(superseded.status, 'SUPERSEDED');
    assert.equal(cancelledPendingApproval.status, 'CANCELLED');
    assert.equal(successor.addendum.supersedesAddendumId, pending.addendum.id);
    const cancellationKey = `HM07_ADDENDUM_CANCEL_${suffix()}`;
    const cancelled = await cancelHandymanMaterialCommercialAddendum(
      {
        handymanMaterialCommercialAddendumId: successor.addendum.id,
        reason: 'SCOPE_NO_LONGER_REQUIRED',
        idempotencyKey: cancellationKey,
      },
      adminUserId,
    );
    const replay = await cancelHandymanMaterialCommercialAddendum(
      {
        handymanMaterialCommercialAddendumId: successor.addendum.id,
        reason: 'SCOPE_NO_LONGER_REQUIRED',
        idempotencyKey: cancellationKey,
      },
      adminUserId,
    );
    assert.equal(cancelled.addendum.status, 'CANCELLED');
    assert.equal(cancelled.approval.status, 'CANCELLED');
    assert.equal(replay.replayed, true);
  });
});
