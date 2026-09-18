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
import { createHandymanJob } from '../src/modules/handyman-jobs';
import {
  cancelHandymanMaterialDemand,
  createCustomerSuppliedMaterialDemand,
  createNonChargeableMaterialDemand,
  createQuotationIncludedMaterialDemand,
} from '../src/modules/handyman-material-demands';
import {
  cancelHandymanMaterialReservation,
  issueHandymanProviderStock,
  recordHandymanMaterialActualUsage,
  releaseHandymanMaterialReservation,
  reserveHandymanMaterialDemand,
  returnUnusedHandymanProviderStock,
} from '../src/modules/handyman-material-inventory';
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
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-07 RUN 2 — focused persistence/service tests.
 *
 * These cover the new typed reservation source, pre-staged controlled issue,
 * append-only Provider/customer actual-use lanes, ordinary STOCK_IN return,
 * capacity/locking/idempotency, source isolation, and demand-close guard.
 * Existing procurement reservation/Work Order suites remain separate regressions.
 */

const PORT = 55509;
const DIR = '/tmp/asentra-hm07-run2-pg';
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
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

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
    TRUNCATE handyman_material_returns, handyman_material_actual_usages,
      handyman_material_controlled_issues, handyman_material_demands,
      handyman_material_approvals, handyman_material_commercial_addenda,
      handyman_job_assignments, handyman_jobs, vendor_works, vendor_assignments,
      work_orders, handyman_quotation_approval_links, handyman_quotation_approvals,
      handyman_quotation_lines, handyman_quotation_revisions, handyman_quotations,
      handyman_request_triages, handyman_request_services, handyman_inspections,
      handyman_requests, handyman_providers, tenant_space_relationships,
      tenant_building_contexts, tenant_pics, tenant_companies,
      price_catalog_entries, inventory_material_reservations,
      inventory_stock_movements, inventory_stock_balances, inventory_warehouses,
      inventory_items, units_of_measure, operational_events CASCADE
  `);
  adminUserId = (await createAdminUser()).userId;
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
  statusCode = 409,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const actual = error as { code?: string; statusCode?: number };
    assert.equal(actual.code, code);
    assert.equal(actual.statusCode, statusCode);
    return;
  }
  assert.fail(`Expected ${code} (${statusCode})`);
}

async function makeHierarchy() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'HM07 Run2 Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'HM07 Run2 Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'HM07 Run2 Building',
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
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A_${suffix()}`,
    name: 'Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R_${suffix()}`,
    name: 'Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `S_${suffix()}`,
    name: 'Space',
  });
  return { client, building, space };
}

async function makeTenant(h: Awaited<ReturnType<typeof makeHierarchy>>) {
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: h.client.id, tenantCode: `TC_${suffix()}`, tenantName: 'Run2 Tenant' },
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
    email: `hm07-run2-pic-${suffix().toLowerCase()}@example.com`,
    displayName: 'Run2 Tenant PIC',
  });
  await buildingAssignmentService.createAssignment(user.id, { buildingId: h.building.id });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      userId: user.id,
      picName: 'Run2 PIC',
      email: `hm07-run2-contact-${suffix().toLowerCase()}@example.com`,
      phone: '+6281298765400',
    },
    adminUserId,
  );
  return { company, pic, user };
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

async function makeProviderFixture() {
  const h = await makeHierarchy();
  const tenant = await makeTenant(h);
  const uom = await makeUom(h.client.id);
  const item = await inventoryItemService.createInventoryItem({
    clientId: h.client.id,
    code: `ITEM_${suffix()}`,
    name: 'Run2 Provider Material',
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
      idempotencyKey: `HM07_R2_PRICE_${suffix()}`,
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
      customerName: 'Run2 Customer',
      customerPhone: '+6281200000010',
      customerEmail: `hm07-run2-customer-${suffix().toLowerCase()}@example.com`,
      inboundChannel: 'WHATSAPP',
      title: 'Run2 inventory fixture',
      description: 'Provider material fixture',
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
    { buildingId: h.building.id, code: `WH_${suffix()}`, name: 'Run2 Warehouse' },
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
  const demand = await createQuotationIncludedMaterialDemand(
    {
      handymanJobId: job.job.id,
      handymanQuotationLineId: line.id,
      idempotencyKey: `HM07_R2_DEMAND_${suffix()}`,
    },
    adminUserId,
  );
  return { h, tenant, uom, item, request, job: job.job, warehouse, demand: demand.demand };
}

async function balance(warehouseId: string, itemId: string) {
  const result = await requirePool().query<{
    quantityOnHand: string;
    reservedQuantity: string;
    availableQuantity: string;
  }>(
    `SELECT quantity_on_hand AS "quantityOnHand", reserved_quantity AS "reservedQuantity",
            available_quantity AS "availableQuantity"
     FROM inventory_stock_balances
     WHERE warehouse_id = $1 AND item_id = $2`,
    [warehouseId, itemId],
  );
  const row = result.rows[0];
  return {
    quantityOnHand: Number(row.quantityOnHand),
    reservedQuantity: Number(row.reservedQuantity),
    availableQuantity: Number(row.availableQuantity),
  };
}

async function movementCount(sourcePrefix: string) {
  const result = await requirePool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM inventory_stock_movements
     WHERE source LIKE $1`,
    [`${sourcePrefix}%`],
  );
  return Number(result.rows[0].count);
}

describe('CR-HM-BE-07 RUN 2: controlled Handyman material inventory', () => {
  it('reserves, pre-stages controlled STOCK_OUT, records append-only use, and returns unused stock through STOCK_IN', async (t) => {
    if (!ready(t)) return;
    const f = await makeProviderFixture();
    const reservationKey = `HM07_R2_RESERVE_${suffix()}`;
    const reservation = await reserveHandymanMaterialDemand(
      {
        handymanMaterialDemandId: f.demand.id,
        warehouseId: f.warehouse.id,
        itemId: f.item.id,
        uomId: f.uom.id,
        quantity: 3,
        idempotencyKey: reservationKey,
      },
      adminUserId,
    );
    const reservationReplay = await reserveHandymanMaterialDemand(
      {
        handymanMaterialDemandId: f.demand.id,
        warehouseId: f.warehouse.id,
        itemId: f.item.id,
        uomId: f.uom.id,
        quantity: 3,
        idempotencyKey: reservationKey,
      },
      adminUserId,
    );
    assert.equal(reservation.replayed, false);
    assert.equal(reservationReplay.replayed, true);
    assert.equal(reservationReplay.reservation.id, reservation.reservation.id);
    assert.deepEqual(await balance(f.warehouse.id, f.item.id), {
      quantityOnHand: 10,
      reservedQuantity: 3,
      availableQuantity: 7,
    });

    await expectError(
      cancelHandymanMaterialDemand(
        {
          handymanMaterialDemandId: f.demand.id,
          reason: 'SCOPE_NO_LONGER_REQUIRED',
          idempotencyKey: `HM07_R2_CANCEL_BLOCKED_${suffix()}`,
        },
        adminUserId,
      ),
      'HANDYMAN_MATERIAL_DEMAND_STATE_INVALID',
    );

    const issueKey = `HM07_R2_ISSUE_RESERVED_${suffix()}`;
    const issueInput = {
      handymanMaterialDemandId: f.demand.id,
      warehouseId: f.warehouse.id,
      inventoryMaterialReservationId: reservation.reservation.id,
      quantity: 2,
      idempotencyKey: issueKey,
    };
    const issue = await issueHandymanProviderStock(issueInput, adminUserId);
    const issueReplay = await issueHandymanProviderStock(issueInput, adminUserId);
    assert.equal(issue.replayed, false);
    assert.equal(issueReplay.replayed, true, 'server default issue time must replay');
    assert.equal(issueReplay.issue.id, issue.issue.id);
    await expectError(
      issueHandymanProviderStock({ ...issueInput, quantity: 1 }, adminUserId),
      'HANDYMAN_MATERIAL_INVENTORY_IDEMPOTENCY_CONFLICT',
    );
    assert.equal(issue.issue.handymanServiceVisitId, null, 'pre-staged issue needs no visit');
    assert.equal(issue.issue.handymanWorkSessionId, null, 'pre-staged issue needs no session');
    assert.equal(await movementCount('HANDYMAN_MATERIAL_ISSUE:'), 1);
    assert.deepEqual(await balance(f.warehouse.id, f.item.id), {
      quantityOnHand: 8,
      reservedQuantity: 1,
      availableQuantity: 7,
    });

    // An unreserved issue may use only unallocated capacity, not steal the
    // remaining reservation allocation. It brings gross issued to 3/4.
    const unreservedIssue = await issueHandymanProviderStock(
      {
        handymanMaterialDemandId: f.demand.id,
        warehouseId: f.warehouse.id,
        quantity: 1,
        idempotencyKey: `HM07_R2_ISSUE_UNRESERVED_${suffix()}`,
      },
      adminUserId,
    );
    assert.equal(unreservedIssue.issue.quantity, 1);
    await expectError(
      issueHandymanProviderStock(
        {
          handymanMaterialDemandId: f.demand.id,
          warehouseId: f.warehouse.id,
          quantity: 1,
          idempotencyKey: `HM07_R2_ISSUE_STEAL_${suffix()}`,
        },
        adminUserId,
      ),
      'HANDYMAN_MATERIAL_INVENTORY_ISSUE_EXCEEDED',
    );

    const usageKey = `HM07_R2_USE_${suffix()}`;
    const usage = await recordHandymanMaterialActualUsage(
      {
        handymanMaterialDemandId: f.demand.id,
        handymanMaterialControlledIssueId: issue.issue.id,
        usageKind: 'INSTALLED',
        quantity: 1,
        idempotencyKey: usageKey,
      },
      adminUserId,
    );
    const usageReplay = await recordHandymanMaterialActualUsage(
      {
        handymanMaterialDemandId: f.demand.id,
        handymanMaterialControlledIssueId: issue.issue.id,
        usageKind: 'INSTALLED',
        quantity: 1,
        idempotencyKey: usageKey,
      },
      adminUserId,
    );
    assert.equal(usage.replayed, false);
    assert.equal(usageReplay.replayed, true, 'server default use time must replay');

    const returnInput = {
      handymanMaterialControlledIssueId: issue.issue.id,
      quantity: 1,
      idempotencyKey: `HM07_R2_RETURN_${suffix()}`,
    };
    const returned = await returnUnusedHandymanProviderStock(returnInput, adminUserId);
    const returnReplay = await returnUnusedHandymanProviderStock(returnInput, adminUserId);
    assert.equal(returned.replayed, false);
    assert.equal(returnReplay.replayed, true, 'server default return time must replay');
    assert.equal(returned.return.handymanMaterialControlledIssueId, issue.issue.id);
    assert.equal(await movementCount('HANDYMAN_MATERIAL_RETURN:'), 1);
    await expectError(
      returnUnusedHandymanProviderStock(
        {
          handymanMaterialControlledIssueId: issue.issue.id,
          quantity: 0.1,
          idempotencyKey: `HM07_R2_RETURN_EXCESS_${suffix()}`,
        },
        adminUserId,
      ),
      'HANDYMAN_MATERIAL_INVENTORY_RETURN_EXCEEDED',
    );

    const released = await releaseHandymanMaterialReservation(
      {
        inventoryMaterialReservationId: reservation.reservation.id,
        idempotencyKey: `HM07_R2_RELEASE_${suffix()}`,
      },
      adminUserId,
    );
    assert.equal(released.reservation.status, 'RELEASED');
    assert.deepEqual(await balance(f.warehouse.id, f.item.id), {
      quantityOnHand: 8,
      reservedQuantity: 0,
      availableQuantity: 8,
    });
    const cancelled = await cancelHandymanMaterialDemand(
      {
        handymanMaterialDemandId: f.demand.id,
        reason: 'SCOPE_NO_LONGER_REQUIRED',
        idempotencyKey: `HM07_R2_CANCEL_OK_${suffix()}`,
      },
      adminUserId,
    );
    assert.equal(cancelled.demand.status, 'CANCELLED');
  });

  it('serializes Provider usage/return on the original issue and keeps customer-supplied use outside inventory', async (t) => {
    if (!ready(t)) return;
    const f = await makeProviderFixture();
    const issue = await issueHandymanProviderStock(
      {
        handymanMaterialDemandId: f.demand.id,
        warehouseId: f.warehouse.id,
        quantity: 2,
        idempotencyKey: `HM07_R2_CONCURRENT_ISSUE_${suffix()}`,
      },
      adminUserId,
    );
    const settled = await Promise.allSettled([
      recordHandymanMaterialActualUsage(
        {
          handymanMaterialDemandId: f.demand.id,
          handymanMaterialControlledIssueId: issue.issue.id,
          quantity: 1.5,
          idempotencyKey: `HM07_R2_CONCURRENT_USE_${suffix()}`,
        },
        adminUserId,
      ),
      returnUnusedHandymanProviderStock(
        {
          handymanMaterialControlledIssueId: issue.issue.id,
          quantity: 1,
          idempotencyKey: `HM07_R2_CONCURRENT_RETURN_${suffix()}`,
        },
        adminUserId,
      ),
    ]);
    assert.equal(settled.filter((row) => row.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((row) => row.status === 'rejected').length, 1);
    const rejected = settled.find((row) => row.status === 'rejected') as PromiseRejectedResult;
    assert.match(
      String((rejected.reason as { code?: string }).code),
      /HANDYMAN_MATERIAL_INVENTORY_(ACTUAL_USE|RETURN)_EXCEEDED/,
    );

    const movementsBefore = await movementCount('HANDYMAN_MATERIAL_');
    const customer = await createCustomerSuppliedMaterialDemand(
      {
        handymanJobId: f.job.id,
        uomId: f.uom.id,
        description: 'Customer supplied gasket',
        quantity: 2,
        idempotencyKey: `HM07_R2_CUSTOMER_DEMAND_${suffix()}`,
      },
      adminUserId,
    );
    const customerUsage = await recordHandymanMaterialActualUsage(
      {
        handymanMaterialDemandId: customer.demand.id,
        quantity: 1,
        idempotencyKey: `HM07_R2_CUSTOMER_USE_${suffix()}`,
      },
      adminUserId,
    );
    assert.equal(customerUsage.supplySource, 'CUSTOMER_SUPPLIED');
    assert.equal(customerUsage.usage.handymanMaterialControlledIssueId, null);
    assert.equal(await movementCount('HANDYMAN_MATERIAL_'), movementsBefore);
    await assert.rejects(
      requirePool().query(
        'UPDATE handyman_material_actual_usages SET quantity = 9 WHERE id = $1',
        [customerUsage.usage.id],
      ),
      /HANDYMAN_MATERIAL_INVENTORY_FACT_IMMUTABLE/,
      'actual-use facts are structurally append-only',
    );
    await expectError(
      recordHandymanMaterialActualUsage(
        {
          handymanMaterialDemandId: customer.demand.id,
          quantity: 2,
          idempotencyKey: `HM07_R2_CUSTOMER_USE_EXCESS_${suffix()}`,
        },
        adminUserId,
      ),
      'HANDYMAN_MATERIAL_INVENTORY_ACTUAL_USE_EXCEEDED',
    );
  });

  it('rejects cross-building warehouse sources and makes terminal reservation commands replay-safe', async (t) => {
    if (!ready(t)) return;
    const a = await makeProviderFixture();
    const b = await makeProviderFixture();
    await expectError(
      reserveHandymanMaterialDemand(
        {
          handymanMaterialDemandId: a.demand.id,
          warehouseId: b.warehouse.id,
          quantity: 1,
          idempotencyKey: `HM07_R2_CROSS_WH_${suffix()}`,
        },
        adminUserId,
      ),
      'HANDYMAN_MATERIAL_INVENTORY_ISSUE_CONTEXT_INVALID',
    );

    const nonChargeable = await createNonChargeableMaterialDemand(
      {
        handymanJobId: a.job.id,
        supplySource: 'PROVIDER_STOCK',
        inventoryItemId: a.item.id,
        uomId: a.uom.id,
        quantity: 1,
        idempotencyKey: `HM07_R2_SUPERSEDE_SOURCE_${suffix()}`,
      },
      adminUserId,
    );
    await reserveHandymanMaterialDemand(
      {
        handymanMaterialDemandId: nonChargeable.demand.id,
        warehouseId: a.warehouse.id,
        quantity: 1,
        idempotencyKey: `HM07_R2_SUPERSEDE_RESERVATION_${suffix()}`,
      },
      adminUserId,
    );
    await expectError(
      createNonChargeableMaterialDemand(
        {
          handymanJobId: a.job.id,
          supplySource: 'PROVIDER_STOCK',
          inventoryItemId: a.item.id,
          uomId: a.uom.id,
          quantity: 1,
          supersedesDemandId: nonChargeable.demand.id,
          idempotencyKey: `HM07_R2_SUPERSEDE_BLOCKED_${suffix()}`,
        },
        adminUserId,
      ),
      'HANDYMAN_MATERIAL_DEMAND_STATE_INVALID',
    );

    const reservation = await reserveHandymanMaterialDemand(
      {
        handymanMaterialDemandId: a.demand.id,
        warehouseId: a.warehouse.id,
        quantity: 1,
        idempotencyKey: `HM07_R2_CANCEL_RES_${suffix()}`,
      },
      adminUserId,
    );
    const key = `HM07_R2_CANCEL_RES_TERMINAL_${suffix()}`;
    const first = await cancelHandymanMaterialReservation(
      { inventoryMaterialReservationId: reservation.reservation.id, idempotencyKey: key },
      adminUserId,
    );
    const replay = await cancelHandymanMaterialReservation(
      { inventoryMaterialReservationId: reservation.reservation.id, idempotencyKey: key },
      adminUserId,
    );
    assert.equal(first.reservation.status, 'CANCELLED');
    assert.equal(replay.replayed, true);
  });
});
