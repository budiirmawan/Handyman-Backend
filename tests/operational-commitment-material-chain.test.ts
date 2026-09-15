import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { clientService } from '../src/modules/clients';
import { inventoryItemService } from '../src/modules/inventory-items';
import { inventoryWarehouseService } from '../src/modules/inventory-warehouses';
import { materialRequestService } from '../src/modules/material-requests';
import { propertyService } from '../src/modules/properties';
import { poReadinessService } from '../src/modules/purchase-order-readiness';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorComplianceDocumentService } from '../src/modules/vendor-compliance-documents';
import { vendorLicenseService } from '../src/modules/vendor-licenses';
import { vendorSelectionService } from '../src/modules/vendor-selection-readiness';
import { vendorService } from '../src/modules/vendors';
import { workOrderProcurementBindingService } from '../src/modules/work-order-procurement-bindings';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-COMM-VAR-01 PART 03 — Material Commitment / Actual Integration.
 *
 *   ISSUED PO line -> Commitment
 *   WO material usage total_cost -> Actual (via material_request_id)
 *
 * Also asserts what must NOT happen: no commitment from an approved Material
 * Request quantity or from receiving, no guess on ambiguous lineage, no
 * duplicate actualization, no double counting, and no budget gate on physical
 * material issue.
 */

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const EMBEDDED_PORT = 55499;
const EMBEDDED_DIR = '/tmp/asentra-comm-var-part03-pg';
if (EMBEDDED) {
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1',
    DB_PORT: String(EMBEDDED_PORT),
    DB_USER: 'postgres',
    DB_PASSWORD: 'postgres',
    DB_NAME: 'asentra_test',
    DB_SSL: 'false',
  });
}

let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const key = () => `IDEM-${randomUUID()}`;
const SERVICE_CODE = 'HVAC';

before(async () => {
  if (EMBEDDED) {
    await rm(EMBEDDED_DIR, { recursive: true, force: true });
    await mkdir(EMBEDDED_DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: EMBEDDED_DIR,
      port: EMBEDDED_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const setup = postgres.getPgClient('postgres', '127.0.0.1');
    await setup.connect();
    await setup.query('CREATE DATABASE asentra_test');
    await setup.end();
  }

  const db = await ensureTestDatabase();
  if (!db) return;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`
    TRUNCATE operational_commitment_entries, operational_commitments,
      operational_budget_source_bindings, operational_budget_categories,
      operational_budgets, operational_events,
      inventory_work_order_material_usages,
      purchase_order_lines, purchase_orders, purchase_order_readiness,
      vendor_selection_readiness, procurement_approval_bindings,
      material_requests, purchase_requests,
      buildings, properties, users, roles, permissions, clients CASCADE
  `);

  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(EMBEDDED_DIR, { recursive: true, force: true });
  }
  pool = null;
  postgres = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database is unavailable');
    return false;
  }
  return true;
}

let periodCursor = 0;
function nextPeriod() {
  periodCursor += 1;
  const month = String((periodCursor % 12) + 1).padStart(2, '0');
  const year = 2031 + Math.floor(periodCursor / 12);
  return { start: `${year}-${month}-01`, end: `${year}-${month}-28` };
}

/** Building + vendor + warehouse + item + work order + ACTIVE budget. */
async function scenario(plannedAmount = 1000000) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  await buildingAssignmentService.createAssignment(userId, {
    buildingId: building.id,
  });
  await clientMonetaryContextService.setClientMonetaryContext({
    clientId: client.id,
    baseCurrencyCode: 'IDR',
    defaultTransactionCurrencyCode: 'IDR',
    allowedCurrencyCodes: ['IDR', 'USD'],
  }, userId);

  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Material Vendor',
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: building.id,
  });
  await vendorCapabilityService.createVendorCapability({
    vendorId: vendor.id,
    code: SERVICE_CODE,
    name: SERVICE_CODE,
  });
  await vendorComplianceDocumentService.createVendorComplianceDocument({
    vendorId: vendor.id,
    documentType: 'BUSINESS_LICENSE',
    documentNumber: `BL_${suffix()}`,
    documentName: 'Business License',
  });
  await vendorLicenseService.createVendorLicense({
    vendorId: vendor.id,
    recordType: 'LICENSE',
    name: 'Business License',
    number: `LIC_${suffix()}`,
  });

  const warehouse = await inventoryWarehouseService.createWarehouse({
    buildingId: building.id,
    code: `WH_${suffix()}`,
    name: 'Warehouse',
  });
  const item = await inventoryItemService.createInventoryItem({
    clientId: client.id,
    code: `ITM_${suffix()}`,
    name: 'Material Item',
    itemType: 'MATERIAL',
  });
  const workOrder = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Material Work Order',
    workType: 'REPAIR',
    createdByUserId: userId,
  });

  const seed = await api()
    .post(`/api/v1/warehouses/${warehouse.id}/stock-movements`)
    .set(auth())
    .send({ itemId: item.id, movementType: 'STOCK_IN', quantity: 1000 });
  assert.equal(seed.status, 201, JSON.stringify(seed.body));

  const budget = await api()
    .post(`/api/v1/buildings/${building.id}/operational-budgets`)
    .set(auth())
    .send({
      budgetPeriod: nextPeriod(),
      currency: 'IDR',
      plannedAmount,
    });
  assert.equal(budget.status, 201, JSON.stringify(budget.body));
  const category = await api()
    .post(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
    .set(auth())
    .send({ code: 'MATERIALS', name: 'Materials', plannedAmount });
  assert.equal(category.status, 201, JSON.stringify(category.body));
  const activated = await api()
    .post(`/api/v1/operational-budgets/${budget.body.data.id}/activate`)
    .set(auth())
    .send({});
  assert.equal(activated.status, 200, JSON.stringify(activated.body));

  return {
    client,
    building,
    vendor,
    warehouse,
    item,
    workOrder,
    budgetId: budget.body.data.id as string,
    categoryId: category.body.data.id as string,
    budgetPeriod: budget.body.data.budgetPeriod as { start: string; end: string },
  };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

async function approveProcurement(requestType: string, requestId: string) {
  const created = await api()
    .post('/api/v1/procurement-approvals')
    .set(auth())
    .send({
      requestType,
      requestId,
      approvalType: 'BUDGET_APPROVAL',
      approverUserId: userId,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const decided = await api()
    .post(`/api/v1/procurement-approvals/${created.body.data.id}/approve`)
    .set(auth())
    .send({});
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
}

/** Approved Material Request + ISSUED Purchase Order line at `unitPrice`. */
async function issuedPurchaseOrderLine(
  s: Scenario,
  unitPrice: number,
  quantity = 10,
  bindWorkOrder = true,
) {
  const purchaseRequest = await purchaseRequestService.createPurchaseRequest({
    clientId: s.client.id,
    buildingId: s.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'Material demand',
    requestedByUserId: userId,
  });
  const materialRequest = await materialRequestService.createMaterialRequest({
    purchaseRequestId: purchaseRequest.id,
    itemId: s.item.id,
    warehouseId: s.warehouse.id,
    quantity,
    requestedByUserId: userId,
  });

  // A Purchase Request approval cascades: every still-OPEN Material Request
  // line defaults to approved = requested. That approved quantity is the
  // fulfilment authority — and it is still priceless.
  await approveProcurement('PURCHASE_REQUEST', purchaseRequest.id);

  // Existing BE-17H demand binding: the Work Order may only consume material
  // that its own Material Request demand authorises.
  if (bindWorkOrder) {
    await workOrderProcurementBindingService.createBinding(
      {
        workOrderId: s.workOrder.id,
        purchaseRequestId: purchaseRequest.id,
        materialRequestId: materialRequest.id,
      },
      userId,
    );
  }

  const selection = await vendorSelectionService.createVendorSelection(
    {
      requestType: 'PURCHASE_REQUEST',
      requestId: purchaseRequest.id,
      vendorId: s.vendor.id,
    },
    userId,
  );
  assert.equal(selection.readiness, 'READY');
  const readiness = await poReadinessService.createPOReadiness(
    {
      requestType: 'PURCHASE_REQUEST',
      requestId: purchaseRequest.id,
      vendorId: s.vendor.id,
    },
    userId,
  );
  assert.equal(readiness.readiness, 'READY');

  const po = await api()
    .post('/api/v1/purchase-orders')
    .set(auth())
    .send({
      poReadinessId: readiness.id,
      poNumber: `PO-${suffix()}`,
      poDate: s.budgetPeriod.start,
      currency: 'IDR',
    });
  assert.equal(po.status, 201, JSON.stringify(po.body));

  const line = await api()
    .post(`/api/v1/purchase-orders/${po.body.data.id}/lines`)
    .set(auth())
    .send({
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: materialRequest.id,
      unitPrice,
    });
  assert.equal(line.status, 201, JSON.stringify(line.body));

  return {
    purchaseRequest,
    materialRequest,
    purchaseOrder: po.body.data,
    line: line.body.data,
  };
}

async function issuePurchaseOrder(purchaseOrderId: string) {
  const issued = await api()
    .post(`/api/v1/purchase-orders/${purchaseOrderId}/issue`)
    .set(auth())
    .send({});
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return issued.body.data;
}

const commitFromLine = (
  budgetId: string,
  body: Record<string, unknown>,
  tok = token,
) =>
  api()
    .post(`/api/v1/operational-budgets/${budgetId}/commitments/from-purchase-order-line`)
    .set(auth(tok))
    .send(body);

async function issueMaterial(
  s: Scenario,
  materialRequestId: string,
  body: Record<string, unknown>,
) {
  return api()
    .post(`/api/v1/work-orders/${s.workOrder.id}/material-usages`)
    .set(auth())
    .send({
      itemId: s.item.id,
      warehouseId: s.warehouse.id,
      materialRequestId,
      usedAt: `${s.budgetPeriod.start}T03:00:00.000Z`,
      ...body,
    });
}

async function commitmentRow(id: string) {
  const result = await pool!.query<{
    status: string;
    committedAmount: string;
    actualizedAmount: string;
    openAmount: string;
    origin: string;
    sourceType: string | null;
    materialRequestId: string | null;
    vendorId: string | null;
  }>(
    `SELECT status,
            committed_amount::text AS "committedAmount",
            actualized_amount::text AS "actualizedAmount",
            open_amount::text AS "openAmount",
            origin,
            source_type AS "sourceType",
            material_request_id AS "materialRequestId",
            vendor_id AS "vendorId"
       FROM operational_commitments WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

async function eventsFor(entityId: string, eventType: string) {
  const result = await pool!.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM operational_events
      WHERE entity_id = $1 AND event_type = $2 ORDER BY created_at`,
    [entityId, eventType],
  );
  return result.rows;
}

describe('CR-BE-COMM-VAR-01 PART 03 — Material commitment / actual integration', () => {
  it('creates a commitment only from an ISSUED purchase order line', async (t) => {
    if (!ready(t)) return;
    const s = await scenario();
    const chain = await issuedPurchaseOrderLine(s, 20000, 10);

    // A DRAFT purchase order is not an approved obligation.
    const draft = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    assert.equal(draft.status, 409, JSON.stringify(draft.body));
    assert.equal(
      draft.body.error.code,
      'OPERATIONAL_COMMITMENT_SOURCE_NOT_ELIGIBLE',
    );

    await issuePurchaseOrder(chain.purchaseOrder.id);

    const created = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const body = created.body.data;
    assert.equal(body.origin, 'PO_LINE');
    assert.equal(body.sourceType, 'PO_LINE');
    assert.equal(body.purchaseOrderLineId, chain.line.id);
    // Amount, currency, vendor and MR lineage are derived from the line.
    assert.equal(body.committedAmount, 200000);
    assert.equal(body.currency, 'IDR');
    assert.equal(body.vendorId, s.vendor.id);
    assert.equal(body.materialRequestId, chain.materialRequest.id);
    assert.equal(body.status, 'COMMITTED');

    // A PO line backs at most one live commitment.
    const again = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(
      again.body.error.code,
      'OPERATIONAL_COMMITMENT_SOURCE_ALREADY_COMMITTED',
    );
  });

  it('is idempotent and rejects a purchase order line the caller may not use', async (t) => {
    if (!ready(t)) return;
    const s = await scenario();
    const chain = await issuedPurchaseOrderLine(s, 10000, 5);
    await issuePurchaseOrder(chain.purchaseOrder.id);

    const idempotencyKey = key();
    const first = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey,
    });
    const replay = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.id, first.body.data.id);

    const count = await pool!.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM operational_commitments WHERE budget_id = $1',
      [s.budgetId],
    );
    assert.equal(count.rows[0].count, '1');

    // A line from another Building can never be committed here.
    const foreign = await scenario();
    const foreignChain = await issuedPurchaseOrderLine(foreign, 1000, 2);
    await issuePurchaseOrder(foreignChain.purchaseOrder.id);
    const crossBuilding = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: foreignChain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    assert.equal(crossBuilding.status, 409, JSON.stringify(crossBuilding.body));
    assert.equal(
      crossBuilding.body.error.code,
      'OPERATIONAL_COMMITMENT_SOURCE_NOT_ELIGIBLE',
    );

    // Derived financial fields must never be supplied by the caller.
    for (const injected of [
      { amount: 1 },
      { committedAmount: 1 },
      { currency: 'USD' },
      { vendorId: randomUUID() },
      { materialRequestId: randomUUID() },
      { origin: 'MANUAL' },
    ]) {
      const rejected = await commitFromLine(s.budgetId, {
        purchaseOrderLineId: chain.line.id,
        budgetCategoryId: s.categoryId,
        idempotencyKey: key(),
        ...injected,
      });
      assert.equal(
        rejected.status,
        400,
        `expected rejection for ${JSON.stringify(injected)}`,
      );
    }
  });

  it('creates no commitment from an approved Material Request or a receiving', async (t) => {
    if (!ready(t)) return;
    const s = await scenario();
    const chain = await issuedPurchaseOrderLine(s, 15000, 4);

    // The Material Request is APPROVED (quantity authority) but priceless.
    const approvedQuantity = await pool!.query<{
      status: string;
      approvedQuantity: string | null;
    }>(
      `SELECT status, approved_quantity::text AS "approvedQuantity"
         FROM material_requests WHERE id = $1`,
      [chain.materialRequest.id],
    );
    assert.equal(approvedQuantity.rows[0].status, 'APPROVED');
    assert.ok(approvedQuantity.rows[0].approvedQuantity);

    const commitments = await pool!.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM operational_commitments WHERE budget_id = $1',
      [s.budgetId],
    );
    assert.equal(commitments.rows[0].count, '0');

    // Issuing the PO also creates nothing on its own: commitment is an
    // explicit, categorised financial act, never a procurement side effect.
    await issuePurchaseOrder(chain.purchaseOrder.id);
    const afterIssue = await pool!.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM operational_commitments WHERE budget_id = $1',
      [s.budgetId],
    );
    assert.equal(afterIssue.rows[0].count, '0');
  });

  it('actualizes material cost through material_request_id without double counting', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(1000000);
    const chain = await issuedPurchaseOrderLine(s, 20000, 10);
    await issuePurchaseOrder(chain.purchaseOrder.id);

    const commitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    assert.equal(commitment.status, 201, JSON.stringify(commitment.body));
    const commitmentId = commitment.body.data.id as string;

    // Partial issue: 4 x 20000 = 80000 of the 200000 obligation.
    const first = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 4,
      unitCost: 20000,
      currency: 'IDR',
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    let row = await commitmentRow(commitmentId);
    assert.equal(row.status, 'PARTIALLY_ACTUALIZED');
    assert.equal(row.actualizedAmount, '80000.00');
    assert.equal(row.openAmount, '120000.00');

    // Lineage is preserved and linked to the ledger entry.
    const binding = await pool!.query<{ id: string; budgetCategoryId: string }>(
      `SELECT id, budget_category_id AS "budgetCategoryId"
         FROM operational_budget_source_bindings
        WHERE work_order_material_usage_id = $1 AND status = 'ACTIVE'`,
      [first.body.data.id],
    );
    assert.equal(binding.rowCount, 1);
    assert.equal(binding.rows[0].budgetCategoryId, s.categoryId);

    const entry = await pool!.query<{
      signedAmount: string;
      sourceBindingId: string;
    }>(
      `SELECT signed_amount::text AS "signedAmount",
              source_binding_id AS "sourceBindingId"
         FROM operational_commitment_entries
        WHERE commitment_id = $1 AND entry_type = 'ACTUALIZE'`,
      [commitmentId],
    );
    assert.equal(entry.rowCount, 1);
    assert.equal(entry.rows[0].signedAmount, '-80000.00');
    assert.equal(entry.rows[0].sourceBindingId, binding.rows[0].id);

    // Actualization must not free budget: consumption is still the full
    // committed amount, not committed minus actualized.
    const consumed = await pool!.query<{ total: string }>(
      `SELECT COALESCE(SUM(committed_amount - released_amount), 0)::text AS total
         FROM operational_commitments
        WHERE budget_id = $1 AND status <> 'CANCELLED'`,
      [s.budgetId],
    );
    assert.equal(consumed.rows[0].total, '200000.00');

    // Remaining issue closes the obligation exactly once.
    const second = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 6,
      unitCost: 20000,
      currency: 'IDR',
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));

    row = await commitmentRow(commitmentId);
    assert.equal(row.status, 'ACTUALIZED');
    assert.equal(row.actualizedAmount, '200000.00');
    assert.equal(row.openAmount, '0.00');

    const allEntries = await pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM operational_commitment_entries
        WHERE commitment_id = $1 AND entry_type = 'ACTUALIZE'`,
      [commitmentId],
    );
    assert.equal(allEntries.rows[0].count, '2');

    // One usage actualizes its commitment exactly once — never twice.
    const perUsage = await pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM operational_commitment_entries e
         JOIN operational_budget_source_bindings b ON b.id = e.source_binding_id
        WHERE e.entry_type = 'ACTUALIZE'
          AND b.work_order_material_usage_id = $1`,
      [first.body.data.id],
    );
    assert.equal(perUsage.rows[0].count, '1');
  });

  it('caps actualization at the open amount and leaves the excess uncommitted', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(1000000);
    const chain = await issuedPurchaseOrderLine(s, 10000, 10);
    await issuePurchaseOrder(chain.purchaseOrder.id);
    const commitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    const commitmentId = commitment.body.data.id as string;
    assert.equal(commitment.body.data.committedAmount, 100000);

    // Issue at a higher operational unit cost than the ordered price.
    const usage = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 10,
      unitCost: 12000,
      currency: 'IDR',
    });
    assert.equal(usage.status, 201, JSON.stringify(usage.body));

    const row = await commitmentRow(commitmentId);
    assert.equal(row.status, 'ACTUALIZED');
    // The commitment absorbs only its own open amount; nothing is inflated.
    assert.equal(row.actualizedAmount, '100000.00');
    assert.equal(row.committedAmount, '100000.00');

    // The 20000 excess is real incurred cost with no obligation behind it, so
    // it consumes budget as an uncommitted actual (budget scope only).
    const probe = await api()
      .post(`/api/v1/operational-budgets/${s.budgetId}/commitments`)
      .set(auth())
      .send({
        budgetCategoryId: s.categoryId,
        title: 'Probe',
        amount: 899990,
        currency: 'IDR',
        reason: 'Availability probe.',
        idempotencyKey: key(),
      });
    assert.equal(probe.status, 409, JSON.stringify(probe.body));
    const fields = Object.fromEntries(
      probe.body.error.details.map(
        (entry: { field: string; message: string }) => [entry.field, entry.message],
      ),
    );
    assert.equal(fields.scope, 'BUDGET');
    assert.equal(fields.consumedAmount, '120000.00');
    assert.equal(fields.availableAmount, '880000.00');
  });

  it('counts an uncommitted costed issue against the budget', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(100000);
    const chain = await issuedPurchaseOrderLine(s, 5000, 10);
    // No commitment is raised for this PO line at all.

    const usage = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 3,
      unitCost: 10000,
      currency: 'IDR',
    });
    assert.equal(usage.status, 201, JSON.stringify(usage.body));

    const commitments = await pool!.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM operational_commitments WHERE budget_id = $1',
      [s.budgetId],
    );
    assert.equal(commitments.rows[0].count, '0');

    const probe = await api()
      .post(`/api/v1/operational-budgets/${s.budgetId}/commitments`)
      .set(auth())
      .send({
        budgetCategoryId: s.categoryId,
        title: 'Probe',
        amount: 80000,
        currency: 'IDR',
        reason: 'Availability probe.',
        idempotencyKey: key(),
      });
    assert.equal(probe.status, 409, JSON.stringify(probe.body));
    const fields = Object.fromEntries(
      probe.body.error.details.map(
        (entry: { field: string; message: string }) => [entry.field, entry.message],
      ),
    );
    assert.equal(fields.consumedAmount, '30000.00');
    assert.equal(fields.availableAmount, '70000.00');
  });

  it('fails closed when more than one open commitment matches the Material Request', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(1000000);
    const chain = await issuedPurchaseOrderLine(s, 10000, 10);
    await issuePurchaseOrder(chain.purchaseOrder.id);

    const first = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    // Simulate a second live commitment on ANOTHER purchase order pointing at
    // the same Material Request — e.g. the same demand ordered from a second
    // vendor. This is the ambiguity the mapping must never guess on. (A single
    // PO already forbids two lines for one Material Request.)
    const secondChain = await issuedPurchaseOrderLine(s, 1000, 10, false);
    await issuePurchaseOrder(secondChain.purchaseOrder.id);
    await pool!.query(
      `UPDATE purchase_order_lines SET material_request_id = $2 WHERE id = $1`,
      [secondChain.line.id, chain.materialRequest.id],
    );
    const duplicate = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: secondChain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    assert.equal(duplicate.status, 201, JSON.stringify(duplicate.body));

    const usage = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 2,
      unitCost: 10000,
      currency: 'IDR',
    });
    // The material issue still succeeds — finance never blocks the warehouse.
    assert.equal(usage.status, 201, JSON.stringify(usage.body));

    // Nothing was actualized and nothing was guessed.
    const actualized = await pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM operational_commitment_entries entry
         JOIN operational_commitments commitment
           ON commitment.id = entry.commitment_id
        WHERE entry.entry_type = 'ACTUALIZE'
          AND commitment.budget_id = $1`,
      [s.budgetId],
    );
    assert.equal(actualized.rows[0].count, '0');

    const ambiguity = await eventsFor(
      usage.body.data.id,
      'OPERATIONAL_COMMITMENT_MATERIAL_LINEAGE_AMBIGUOUS',
    );
    assert.equal(ambiguity.length, 1);
    assert.equal(
      (ambiguity[0].metadata.candidateCommitmentIds as string[]).length,
      2,
    );
  });

  it('does not actualize a currency-mismatched or cost-less issue, and never blocks the issue', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(1000000);
    const chain = await issuedPurchaseOrderLine(s, 10000, 10);
    await issuePurchaseOrder(chain.purchaseOrder.id);
    const commitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    const commitmentId = commitment.body.data.id as string;

    const mismatched = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 1,
      unitCost: 10000,
      currency: 'USD',
    });
    assert.equal(mismatched.status, 201, JSON.stringify(mismatched.body));
    let row = await commitmentRow(commitmentId);
    assert.equal(row.actualizedAmount, '0.00');
    assert.equal(
      (
        await eventsFor(
          mismatched.body.data.id,
          'OPERATIONAL_COMMITMENT_MATERIAL_CURRENCY_MISMATCH',
        )
      ).length,
      1,
    );

    const costless = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 1,
    });
    assert.equal(costless.status, 201, JSON.stringify(costless.body));
    row = await commitmentRow(commitmentId);
    assert.equal(row.actualizedAmount, '0.00');
    assert.equal(row.status, 'COMMITTED');
  });

  it('never blocks material issue when the budget is exhausted', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(10000);
    const chain = await issuedPurchaseOrderLine(s, 1000, 10);
    await issuePurchaseOrder(chain.purchaseOrder.id);
    const commitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    assert.equal(commitment.status, 201, JSON.stringify(commitment.body));
    assert.equal(commitment.body.data.committedAmount, 10000);

    // The budget is now fully consumed, yet the physical issue must succeed —
    // and its cost far exceeds the plan.
    const usage = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 10,
      unitCost: 9000,
      currency: 'IDR',
    });
    assert.equal(usage.status, 201, JSON.stringify(usage.body));

    const onHand = await pool!.query<{ quantity: string }>(
      `SELECT quantity_on_hand::text AS quantity FROM inventory_stock_balances
        WHERE warehouse_id = $1 AND item_id = $2`,
      [s.warehouse.id, s.item.id],
    );
    assert.equal(Number(onHand.rows[0].quantity), 990);

    const row = await commitmentRow(commitment.body.data.id);
    assert.equal(row.actualizedAmount, '10000.00');
    assert.equal(row.status, 'ACTUALIZED');

    // A further commitment is still correctly refused.
    const refused = await api()
      .post(`/api/v1/operational-budgets/${s.budgetId}/commitments`)
      .set(auth())
      .send({
        budgetCategoryId: s.categoryId,
        title: 'Probe',
        amount: 1,
        currency: 'IDR',
        reason: 'Availability probe.',
        idempotencyKey: key(),
      });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
  });

  it('refuses a ledger commitment for a purchase order already bound to a budget', async (t) => {
    if (!ready(t)) return;
    const s = await scenario();
    const chain = await issuedPurchaseOrderLine(s, 10000, 3);
    await issuePurchaseOrder(chain.purchaseOrder.id);

    const binding = await api()
      .post(`/api/v1/operational-budgets/${s.budgetId}/source-bindings`)
      .set(auth())
      .send({
        budgetCategoryId: s.categoryId,
        sourceType: 'PO_LINE',
        purchaseOrderLineId: chain.line.id,
      });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    const rejected = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(
      rejected.body.error.code,
      'OPERATIONAL_COMMITMENT_SOURCE_ALREADY_COMMITTED',
    );
  });
});
