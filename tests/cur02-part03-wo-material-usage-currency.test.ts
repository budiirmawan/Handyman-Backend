import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { clientService } from '../src/modules/clients';
import { currencyService } from '../src/modules/currencies';
import { inventoryItemService } from '../src/modules/inventory-items';
import { inventoryWarehouseService } from '../src/modules/inventory-warehouses';
import { materialRequestService } from '../src/modules/material-requests';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { workOrderService } from '../src/modules/work-orders';
import { workOrderProcurementBindingService } from '../src/modules/work-order-procurement-bindings';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-CUR-02 PART 03 — Work Order material usage currency pairing.
 *
 * Proofs: a costed usage requires an explicit governed currency; ACTIVE +
 * Client-allowed currency is accepted and snapshotted; INACTIVE and
 * Client-disallowed codes are rejected; a non-costed usage issues without a
 * currency (material issue is never blocked by currency governance alone);
 * historical cost+NULL rows remain readable; no IDR/default inference; and no
 * FX/conversion path is reachable (exact currency only, COMM-VAR semantics
 * preserved).
 */
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let ownerToken = '';
let ownerUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value: string) => ({ Authorization: `Bearer ${value}` });

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE inventory_work_order_material_usages,
            inventory_material_reservations, inventory_stock_adjustments,
            inventory_stock_movements, inventory_stock_balances,
            work_order_procurement_bindings, procurement_approval_bindings,
            material_requests, purchase_requests, operational_events,
            inventory_items, inventory_warehouses, work_orders,
            units_of_measure, users, roles, permissions, clients, properties,
            buildings CASCADE`,
  );
  const owner = await createAdminUser();
  ownerToken = owner.token;
  ownerUserId = owner.userId;
  database = db;
});
after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});
function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function fixture(codes: string[] = ['IDR', 'USD', 'JPY', 'EUR']) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Material Client',
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
  await buildingAssignmentService.createAssignment(ownerUserId, {
    buildingId: building.id,
  });
  await clientMonetaryContextService.setClientMonetaryContext({
    clientId: client.id,
    baseCurrencyCode: 'IDR',
    defaultTransactionCurrencyCode: 'IDR',
    allowedCurrencyCodes: codes,
  }, ownerUserId);
  const uomResponse = await api()
    .post(`/api/v1/clients/${client.id}/uoms`)
    .set(auth(ownerToken))
    .send({ code: `PCS_${suffix()}`, name: 'Pieces', symbol: 'pcs', category: 'QUANTITY' });
  assert.equal(uomResponse.status, 201, JSON.stringify(uomResponse.body));
  const uomId = uomResponse.body.data.id as string;
  const item = await inventoryItemService.createInventoryItem({
    clientId: client.id,
    code: `ITM_${suffix()}`,
    name: 'Material Item',
    itemType: 'MATERIAL',
    uomId,
  });
  const warehouse = await inventoryWarehouseService.createWarehouse({
    buildingId: building.id,
    code: `WH_${suffix()}`,
    name: 'Material Warehouse',
  });
  const workOrder = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Material Work Order',
    workType: 'REPAIR',
    createdByUserId: ownerUserId,
  });
  const purchaseRequest = await purchaseRequestService.createPurchaseRequest({
    clientId: client.id,
    buildingId: building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: 'MATERIAL',
    title: 'Material Demand',
    requestedByUserId: ownerUserId,
  });
  const materialRequest = await materialRequestService.createMaterialRequest({
    purchaseRequestId: purchaseRequest.id,
    itemId: item.id,
    warehouseId: warehouse.id,
    quantity: 100,
    requestedByUserId: ownerUserId,
  });
  const approval = await api()
    .post('/api/v1/procurement-approvals')
    .set(auth(ownerToken))
    .send({
      requestType: 'MATERIAL_REQUEST',
      requestId: materialRequest.id,
      approvalType: 'BUDGET_APPROVAL',
      approverUserId: ownerUserId,
    });
  assert.equal(approval.status, 201, JSON.stringify(approval.body));
  const approved = await api()
    .post(`/api/v1/procurement-approvals/${approval.body.data.id}/approve`)
    .set(auth(ownerToken))
    .send({});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  await workOrderProcurementBindingService.createBinding(
    {
      workOrderId: workOrder.id,
      purchaseRequestId: purchaseRequest.id,
      materialRequestId: materialRequest.id,
    },
    ownerUserId,
  );
  const seed = await api()
    .post(`/api/v1/warehouses/${warehouse.id}/stock-movements`)
    .set(auth(ownerToken))
    .send({ itemId: item.id, movementType: 'STOCK_IN', quantity: 100 });
  assert.equal(seed.status, 201, JSON.stringify(seed.body));
  return { client, property, building, item, warehouse, workOrder, materialRequest, uomId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function issue(f: Fixture, body: Record<string, unknown>) {
  return api()
    .post(`/api/v1/work-orders/${f.workOrder.id}/material-usages`)
    .set(auth(ownerToken))
    .send({ itemId: f.item.id, warehouseId: f.warehouse.id, materialRequestId: f.materialRequest.id, ...body });
}

describe('CR-BE-CUR-02 PART 03 — Work Order material usage currency pairing', () => {
  it('requires a governed currency for a costed new usage (no default/inference)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const missing = await issue(f, { quantity: 1, unitCost: 10 });
    assert.equal(missing.status, 400, JSON.stringify(missing.body));
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');
  });

  it('accepts an ACTIVE, Client-allowed currency and persists the exact snapshot', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await issue(f, { quantity: 2, unitCost: 12.5, currency: 'USD' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.unitCost, 12.5);
    assert.equal(created.body.data.totalCost, 25);
    assert.equal(created.body.data.currency, 'USD');
    const row = await pool!.query(
      'SELECT currency, unit_cost::text AS unitCost FROM inventory_work_order_material_usages WHERE id = $1',
      [created.body.data.id],
    );
    assert.equal(row.rows[0].currency, 'USD');
    assert.equal(Number(row.rows[0].unitCost), 12.5);
  });

  it('rejects an INACTIVE master code even when Client-allowed', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(['IDR', 'JPY']);
    await currencyService.setCurrencyStatus('JPY', 'INACTIVE', ownerUserId);
    try {
      const r = await issue(f, { quantity: 1, unitCost: 5, currency: 'JPY' });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error.code, 'CURRENCY_INACTIVE_OR_UNKNOWN');
    } finally {
      await currencyService.setCurrencyStatus('JPY', 'ACTIVE', ownerUserId);
    }
  });

  it('rejects a currency that is ACTIVE but not allowed for the resolved Client', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(['IDR', 'USD']);
    const r = await issue(f, { quantity: 1, unitCost: 5, currency: 'EUR' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'CLIENT_CURRENCY_NOT_ALLOWED');
  });

  it('is not blocked by currency governance for a non-costed usage', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const usage = await issue(f, { quantity: 5 });
    assert.equal(usage.status, 201, JSON.stringify(usage.body));
    assert.equal(usage.body.data.unitCost, null);
    assert.equal(usage.body.data.currency, null);
  });

  it('keeps a historical costed row with NULL currency readable', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const id = randomUUID();
    await pool!.query(
      `INSERT INTO inventory_work_order_material_usages
        (id, client_id, building_id, work_order_id, warehouse_id, item_id,
         material_request_id, quantity, uom_id, unit_cost, currency,
         cost_source, used_by_user_id, used_at, reference,
         resulting_quantity_on_hand, resulting_available_quantity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,9,NULL,'MANUAL',$9,NOW(),NULL,99,99)`,
      [id, f.client.id, f.building.id, f.workOrder.id, f.warehouse.id, f.item.id,
        f.materialRequest.id, f.uomId, ownerUserId],
    );
    const read = await api().get(`/api/v1/work-order-material-usages/${id}`).set(auth(ownerToken));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.unitCost, 9);
    assert.equal(read.body.data.currency, null);
  });

  it('does not introduce FX/conversion and preserves exact-currency material actualization', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(['IDR', 'USD']);
    // A costed issue in IDR succeeds; it is never converted into another currency.
    const created = await issue(f, { quantity: 2, unitCost: 1000, currency: 'IDR' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.currency, 'IDR');
    // A costed issue in USD also succeeds (exact snapshot), never normalized to IDR.
    const usd = await issue(f, { quantity: 1, unitCost: 5, currency: 'USD' });
    assert.equal(usd.status, 201, JSON.stringify(usd.body));
    assert.equal(usd.body.data.currency, 'USD');
    const usdRow = await pool!.query(
      'SELECT currency FROM inventory_work_order_material_usages WHERE id=$1',
      [usd.body.data.id],
    );
    assert.equal(usdRow.rows[0].currency, 'USD');
  });
});
