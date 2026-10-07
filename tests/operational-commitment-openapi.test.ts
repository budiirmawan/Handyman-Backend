import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { clientService } from '../src/modules/clients';
import {
  FOUNDATION_PERMISSIONS,
  UNASSIGNED_BY_DEFAULT_PERMISSION_CODES,
} from '../src/database/seeds/foundation-access.seed';
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
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-COMM-VAR-01 PART 06 — OpenAPI + cross-module validation.
 *
 * Confirms the contract documents exactly what runs, and re-proves the
 * cross-cutting financial invariants of PARTs 01–05 end to end.
 */

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const EMBEDDED_PORT = 55507;
const EMBEDDED_DIR = '/tmp/asentra-comm-var-part06-pg';
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

/** Every runtime operation this CR added, with its enforced permission. */
const CONTRACT_OPERATIONS: readonly (readonly [string, string, string])[] = [
  ['post', '/operational-budgets/{id}/overspend-policy', 'operational_budget.override'],
  ['post', '/operational-budgets/{budgetId}/commitments', 'operational_budget.manage'],
  ['get', '/operational-budgets/{budgetId}/commitments', 'operational_budget.read'],
  [
    'post',
    '/operational-budgets/{budgetId}/commitments/from-purchase-order-line',
    'operational_budget.manage',
  ],
  ['get', '/operational-commitments/{id}', 'operational_budget.read'],
  ['post', '/operational-commitments/{id}/adjust', 'operational_budget.manage'],
  ['post', '/operational-commitments/{id}/release', 'operational_budget.manage'],
  ['post', '/operational-commitments/{id}/cancel', 'operational_budget.manage'],
  ['get', '/operational-budgets/{budgetId}/variance', 'operational_budget.read'],
  ['get', '/operational-budget-variance', 'operational_budget.read'],
  [
    'get',
    '/buildings/{buildingId}/operational-budget-variance',
    'operational_budget.read',
  ],
  ['get', '/operational-budgets/{budgetId}/traceability', 'operational_budget.read'],
];

function spec(): Record<string, any> {
  return parse(
    readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
  ) as Record<string, any>;
}

function resolveLocalRef(document: Record<string, any>, reference: string): unknown {
  return reference
    .slice(2)
    .split('/')
    .reduce(
      (value: any, part) =>
        value?.[part.replace(/~1/g, '/').replace(/~0/g, '~')],
      document,
    );
}

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
      vendor_invoice_history, vendor_invoices,
      purchase_order_lines, purchase_orders, purchase_order_readiness,
      vendor_selection_readiness, procurement_approval_bindings,
      service_requests, material_requests, purchase_requests,
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
  const year = 2035 + Math.floor(periodCursor / 12);
  return { start: `${year}-${month}-01`, end: `${year}-${month}-28` };
}

async function scenario(
  plannedAmount = 1000000,
  overspendPolicy: 'STRICT' | 'ALLOW_WITH_OVERRIDE' = 'STRICT',
) {
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
    vendorName: 'Vendor',
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
    name: 'Item',
    itemType: 'MATERIAL',
  });
  const workOrder = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Work Order',
    workType: 'REPAIR',
    createdByUserId: userId,
  });
  const seed = await api()
    .post(`/api/v1/warehouses/${warehouse.id}/stock-movements`)
    .set(auth())
    .send({ itemId: item.id, movementType: 'STOCK_IN', quantity: 1000 });
  assert.equal(seed.status, 201, JSON.stringify(seed.body));

  const period = nextPeriod();
  const budget = await api()
    .post(`/api/v1/buildings/${building.id}/operational-budgets`)
    .set(auth())
    .send({ budgetPeriod: period, currency: 'IDR', plannedAmount, overspendPolicy });
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
    period,
    budgetId: budget.body.data.id as string,
    categoryId: category.body.data.id as string,
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

async function issuedMaterialPurchaseOrder(s: Scenario, unitPrice: number, quantity = 10) {
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
  await approveProcurement('PURCHASE_REQUEST', purchaseRequest.id);
  await workOrderProcurementBindingService.createBinding(
    {
      workOrderId: s.workOrder.id,
      purchaseRequestId: purchaseRequest.id,
      materialRequestId: materialRequest.id,
    },
    userId,
  );
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
      poDate: s.period.start,
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
  const issued = await api()
    .post(`/api/v1/purchase-orders/${po.body.data.id}/issue`)
    .set(auth())
    .send({});
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return { materialRequest, purchaseOrder: issued.body.data, line: line.body.data };
}

const commitFromLine = (budgetId: string, body: Record<string, unknown>) =>
  api()
    .post(`/api/v1/operational-budgets/${budgetId}/commitments/from-purchase-order-line`)
    .set(auth())
    .send(body);

const manualCommit = (budgetId: string, body: Record<string, unknown>, tok = token) =>
  api()
    .post(`/api/v1/operational-budgets/${budgetId}/commitments`)
    .set(auth(tok))
    .send({
      title: 'Manual obligation',
      currency: 'IDR',
      reason: 'No priced source authority yet.',
      idempotencyKey: key(),
      ...body,
    });

const issueMaterial = (s: Scenario, materialRequestId: string, body: Record<string, unknown>) =>
  api()
    .post(`/api/v1/work-orders/${s.workOrder.id}/material-usages`)
    .set(auth())
    .send({
      itemId: s.item.id,
      warehouseId: s.warehouse.id,
      materialRequestId,
      usedAt: `${s.period.start}T03:00:00.000Z`,
      ...body,
    });

const variance = (budgetId: string) =>
  api().get(`/api/v1/operational-budgets/${budgetId}/variance`).set(auth());

function detailField(body: any, field: string): string {
  return body.error.details.find(
    (entry: { field: string }) => entry.field === field,
  ).message;
}

describe('CR-BE-COMM-VAR-01 PART 06 — OpenAPI contract and cross-module validation', () => {
  it('documents every runtime operation with its enforced permission', () => {
    const document = spec();
    for (const [method, path, permission] of CONTRACT_OPERATIONS) {
      const operation = document.paths?.[path]?.[method];
      assert.ok(operation, `${method.toUpperCase()} ${path} must be documented`);
      assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
      assert.equal(
        operation['x-required-permission'],
        permission,
        `${method.toUpperCase()} ${path} permission`,
      );
      assert.equal(operation['x-building-scoped'], true);
      for (const status of ['401', '403']) {
        assert.ok(
          operation.responses?.[status],
          `${method.toUpperCase()} ${path} must document ${status}`,
        );
      }
      if (method === 'post') {
        assert.ok(
          operation.responses?.['409'],
          `${method.toUpperCase()} ${path} must document 409`,
        );
        assert.ok(operation.requestBody?.required === true);
      }
    }
  });

  it('documents the overspend policy, ledger and variance schemas and resolves every reference', () => {
    const document = spec();
    const schemas = document.components.schemas;

    assert.deepEqual(schemas.OperationalBudgetOverspendPolicy.enum, [
      'STRICT',
      'ALLOW_WITH_OVERRIDE',
    ]);
    assert.ok(schemas.OperationalBudget.properties.overspendPolicy);
    assert.ok(schemas.OperationalBudget.required.includes('overspendPolicy'));
    assert.ok(schemas.CreateOperationalBudgetRequest.properties.overspendPolicy);
    assert.ok(schemas.UpdateOperationalBudgetRequest.properties.overspendPolicy);

    assert.deepEqual(schemas.OperationalCommitmentStatus.enum, [
      'COMMITTED',
      'PARTIALLY_ACTUALIZED',
      'ACTUALIZED',
      'RELEASED',
      'CANCELLED',
    ]);
    assert.deepEqual(schemas.OperationalCommitmentEntryType.enum, [
      'CREATE',
      'ADJUST_INCREASE',
      'ADJUST_DECREASE',
      'ACTUALIZE',
      'ACTUALIZE_REVERSAL',
      'RELEASE',
      'CANCEL',
      'OVERRIDE',
    ]);

    // The override boundary must be visible in the contract, not just in code.
    const policyOperation =
      document.paths['/operational-budgets/{id}/overspend-policy'].post;
    assert.match(policyOperation.description, /operational_budget\.override/);
    assert.ok(
      schemas.CreateOperationalCommitmentRequest.properties.overspendOverrideReason,
    );
    assert.match(
      schemas.CreateOperationalCommitmentRequest.properties.overspendOverrideReason
        .description,
      /ALLOW_WITH_OVERRIDE/,
    );
    assert.deepEqual(
      schemas.ChangeOperationalBudgetOverspendPolicyRequest.required,
      ['overspendPolicy', 'reason'],
    );

    // Gaps are contract-visible and carry no amount.
    assert.deepEqual(schemas.OperationalBudgetVarianceGap.enum, undefined);
    assert.deepEqual(schemas.OperationalBudgetVarianceGap.properties.reference.enum, [
      'B-02',
      'B-03',
    ]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        schemas.OperationalBudgetVarianceGap.properties,
        'amount',
      ),
      false,
    );

    const references: string[] = [];
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if ('$ref' in value && typeof (value as { $ref?: unknown }).$ref === 'string') {
        references.push((value as { $ref: string }).$ref);
      }
      for (const child of Object.values(value)) walk(child);
    };
    walk(document);
    for (const reference of references) {
      assert.notEqual(resolveLocalRef(document, reference), undefined, reference);
    }

    // No accounting/FX concept leaked into the contract.
    const text = readFileSync(
      resolve(__dirname, '../docs/api/openapi.yaml'),
      'utf8',
    );
    for (const forbidden of [
      'exchangeRate',
      'fxRate',
      'journalEntry',
      'generalLedger',
      'glAccount',
    ]) {
      assert.equal(
        text.includes(forbidden),
        false,
        `${forbidden} must not appear in the contract`,
      );
    }
  });

  it('keeps the ledger and legacy sources free of double counting', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(1000000);
    const chain = await issuedMaterialPurchaseOrder(s, 20000, 10);

    const commitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    assert.equal(commitment.status, 201, JSON.stringify(commitment.body));

    // The same purchase order can no longer be bound as a legacy commitment,
    // and the ledger refuses a second commitment for the line.
    const duplicate = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));

    // Issue material: actual is recognised once, and the obligation stays
    // consumed in full.
    const usage = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 5,
      unitCost: 20000,
      currency: 'IDR',
    });
    assert.equal(usage.status, 201, JSON.stringify(usage.body));

    const data = (await variance(s.budgetId)).body.data;
    assert.equal(data.totals.ledgerCommittedAmount, 200000);
    assert.equal(data.totals.ledgerActualizedAmount, 100000);
    assert.equal(data.totals.legacyCommittedAmount, 0);
    assert.equal(data.totals.unallocatedActualAmount, 0);
    assert.equal(data.totals.actualAmount, 100000);
    assert.equal(data.totals.consumedAmount, 200000);

    // Exactly one actualization entry exists for that usage.
    const entries = await pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM operational_commitment_entries entry
         JOIN operational_budget_source_bindings binding
           ON binding.id = entry.source_binding_id
        WHERE entry.entry_type = 'ACTUALIZE'
          AND binding.work_order_material_usage_id = $1`,
      [usage.body.data.id],
    );
    assert.equal(entries.rows[0].count, '1');
  });

  it('keeps SUM(entries.signed_amount) equal to open_amount for every commitment', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(1000000);
    const chain = await issuedMaterialPurchaseOrder(s, 10000, 10);
    const poCommitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    assert.equal(poCommitment.status, 201, JSON.stringify(poCommitment.body));
    await issueMaterial(s, chain.materialRequest.id, {
      quantity: 4,
      unitCost: 10000,
      currency: 'IDR',
    });

    const adjusted = await manualCommit(s.budgetId, {
      budgetCategoryId: s.categoryId,
      amount: 200000,
    });
    await api()
      .post(`/api/v1/operational-commitments/${adjusted.body.data.id}/adjust`)
      .set(auth())
      .send({ amount: 50000, reason: 'Scope grew.', idempotencyKey: key() });
    await api()
      .post(`/api/v1/operational-commitments/${adjusted.body.data.id}/adjust`)
      .set(auth())
      .send({ amount: -30000, reason: 'Scope trimmed.', idempotencyKey: key() });

    const released = await manualCommit(s.budgetId, {
      budgetCategoryId: s.categoryId,
      amount: 60000,
    });
    await api()
      .post(`/api/v1/operational-commitments/${released.body.data.id}/release`)
      .set(auth())
      .send({ reason: 'Not required.', idempotencyKey: key() });

    const cancelled = await manualCommit(s.budgetId, {
      budgetCategoryId: s.categoryId,
      amount: 20000,
    });
    await api()
      .post(`/api/v1/operational-commitments/${cancelled.body.data.id}/cancel`)
      .set(auth())
      .send({ reason: 'Raised in error.', idempotencyKey: key() });

    const drift = await pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM operational_commitments commitment
         LEFT JOIN (
           SELECT commitment_id, COALESCE(SUM(signed_amount), 0) AS total
             FROM operational_commitment_entries
            GROUP BY commitment_id
         ) entries ON entries.commitment_id = commitment.id
        WHERE commitment.budget_id = $1
          AND commitment.status <> 'CANCELLED'
          AND COALESCE(entries.total, 0) <> commitment.open_amount`,
      [s.budgetId],
    );
    assert.equal(drift.rows[0].count, '0');

    // A cancelled commitment keeps its full ledger history and consumes nothing.
    const cancelledRow = await pool!.query<{ status: string; total: string }>(
      `SELECT commitment.status,
              COALESCE(SUM(entry.signed_amount), 0)::text AS total
         FROM operational_commitments commitment
         LEFT JOIN operational_commitment_entries entry
           ON entry.commitment_id = commitment.id
        WHERE commitment.id = $1
        GROUP BY commitment.status`,
      [cancelled.body.data.id],
    );
    assert.equal(cancelledRow.rows[0].status, 'CANCELLED');
    assert.equal(cancelledRow.rows[0].total, '0.00');
  });

  it('uses one consumption definition for the write gate and the read model', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(500000);
    const chain = await issuedMaterialPurchaseOrder(s, 10000, 10);
    await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    await issueMaterial(s, chain.materialRequest.id, {
      quantity: 10,
      unitCost: 12000,
      currency: 'IDR',
    });

    const data = (await variance(s.budgetId)).body.data;
    const rejected = await manualCommit(s.budgetId, {
      budgetCategoryId: s.categoryId,
      amount: data.totals.availableAmount + 0.01,
    });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    // The rejection payload and the report agree exactly.
    assert.equal(
      Number(detailField(rejected.body, 'availableAmount')),
      data.totals.availableAmount,
    );
    assert.equal(
      Number(detailField(rejected.body, 'consumedAmount')),
      data.totals.consumedAmount,
    );

    // Spending exactly the reported availability is allowed.
    const accepted = await manualCommit(s.budgetId, {
      budgetCategoryId: s.categoryId,
      amount: data.totals.availableAmount,
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    const after = (await variance(s.budgetId)).body.data;
    assert.equal(after.totals.availableAmount, 0);
  });

  it('respects the budget period for material and vendor-invoice actualization', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(1000000);
    const chain = await issuedMaterialPurchaseOrder(s, 10000, 10);
    const commitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    const commitmentId = commitment.body.data.id as string;

    // Material issued outside the budget period must not actualize it.
    const outside = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 2,
      unitCost: 10000,
      currency: 'IDR',
      usedAt: '2021-02-03T03:00:00.000Z',
    });
    assert.equal(outside.status, 201, JSON.stringify(outside.body));

    let row = await pool!.query<{ actualizedAmount: string }>(
      `SELECT actualized_amount::text AS "actualizedAmount"
         FROM operational_commitments WHERE id = $1`,
      [commitmentId],
    );
    assert.equal(row.rows[0].actualizedAmount, '0.00');

    // An invoice dated outside the period must not actualize it either.
    const invoice = await api()
      .post(`/api/v1/vendors/${s.vendor.id}/invoices`)
      .set(auth())
      .send({
        buildingId: s.building.id,
        invoiceNumber: `INV-${suffix()}`,
        invoiceDate: '2021-02-03',
        receivedDate: '2021-02-03',
        currency: 'IDR',
        invoiceAmount: 100000,
      });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
    await api()
      .post(`/api/v1/vendor-invoices/${invoice.body.data.id}/finalize`)
      .set(auth())
      .send({});
    const verified = await api()
      .post(`/api/v1/vendor-invoices/${invoice.body.data.id}/verify`)
      .set(auth())
      .send({});
    assert.equal(verified.status, 200, JSON.stringify(verified.body));

    row = await pool!.query<{ actualizedAmount: string }>(
      `SELECT actualized_amount::text AS "actualizedAmount"
         FROM operational_commitments WHERE id = $1`,
      [commitmentId],
    );
    assert.equal(row.rows[0].actualizedAmount, '0.00');

    // Neither out-of-period source consumes this budget.
    const data = (await variance(s.budgetId)).body.data;
    assert.equal(data.totals.unallocatedActualAmount, 0);
    assert.equal(data.totals.actualAmount, 0);
    assert.equal(data.totals.consumedAmount, 100000);
  });

  it('keeps currency mismatch fail-closed and never converts', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(1000000);
    const chain = await issuedMaterialPurchaseOrder(s, 10000, 10);
    const commitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });

    const foreign = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 2,
      unitCost: 10000,
      currency: 'USD',
    });
    assert.equal(foreign.status, 201, JSON.stringify(foreign.body));

    const wrongCurrency = await manualCommit(s.budgetId, {
      budgetCategoryId: s.categoryId,
      amount: 1000,
      currency: 'USD',
    });
    assert.equal(wrongCurrency.status, 400, JSON.stringify(wrongCurrency.body));
    assert.equal(
      wrongCurrency.body.error.code,
      'OPERATIONAL_COMMITMENT_CURRENCY_MISMATCH',
    );

    const data = (await variance(s.budgetId)).body.data;
    assert.equal(data.totals.actualAmount, 0);
    assert.equal(data.totals.uncommittedMaterialActualAmount, 0);
    const row = await pool!.query<{ actualizedAmount: string }>(
      `SELECT actualized_amount::text AS "actualizedAmount"
         FROM operational_commitments WHERE id = $1`,
      [commitment.body.data.id],
    );
    assert.equal(row.rows[0].actualizedAmount, '0.00');
  });

  it('keeps B-02 and B-03 explicit gaps rather than fabricated values', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(5000000);

    // B-02: neither currency-less cost authority may enter any figure.
    for (const table of ['vendor_service_costs', 'basic_expenses']) {
      const currency = await pool!.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'currency'`,
        [table],
      );
      assert.equal(currency.rows[0].count, '0');
    }

    // B-03: a verified invoice with no purchase order is actual with no
    // commitment; the gap is reported, the amount is not invented.
    const invoice = await api()
      .post(`/api/v1/vendors/${s.vendor.id}/invoices`)
      .set(auth())
      .send({
        buildingId: s.building.id,
        invoiceNumber: `INV-${suffix()}`,
        invoiceDate: s.period.start,
        receivedDate: s.period.start,
        currency: 'IDR',
        invoiceAmount: 400000,
      });
    await api()
      .post(`/api/v1/vendor-invoices/${invoice.body.data.id}/finalize`)
      .set(auth())
      .send({});
    await api()
      .post(`/api/v1/vendor-invoices/${invoice.body.data.id}/verify`)
      .set(auth())
      .send({});

    const data = (await variance(s.budgetId)).body.data;
    const gap = data.gaps.find(
      (entry: { reference: string }) => entry.reference === 'B-03',
    );
    assert.ok(gap, JSON.stringify(data.gaps));
    assert.equal(Object.prototype.hasOwnProperty.call(gap, 'amount'), false);
    assert.equal(data.totals.openCommitmentAmount, 0);
    assert.equal(data.totals.actualAmount, 400000);

    const trace = await api()
      .get(`/api/v1/operational-budgets/${s.budgetId}/traceability`)
      .set(auth());
    const invoiceRow = trace.body.data.rows.find(
      (row: { vendorInvoiceId: string | null }) =>
        row.vendorInvoiceId === invoice.body.data.id,
    );
    assert.equal(invoiceRow.classification, 'ACTUAL');
    assert.equal(invoiceRow.commitmentId, null);
  });

  it('never grants the override permission by default and keeps STRICT strict', async (t) => {
    if (!ready(t)) return;
    assert.ok(
      FOUNDATION_PERMISSIONS.some(
        (permission) => permission.code === 'operational_budget.override',
      ),
    );
    assert.ok(
      UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('operational_budget.override'),
    );
    const granted = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM role_permission_assignments assignment
         JOIN permissions permission ON permission.id = assignment.permission_id
        WHERE permission.code = 'operational_budget.override'
          AND assignment.status = 'ACTIVE'`,
    );
    assert.equal(granted.rows[0].count, '0');

    // STRICT: overspend rejected, and not overridable even with a reason.
    const strict = await scenario(100000, 'STRICT');
    const rejected = await manualCommit(strict.budgetId, {
      budgetCategoryId: strict.categoryId,
      amount: 150000,
    });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(
      rejected.body.error.code,
      'OPERATIONAL_BUDGET_OVERSPEND_REJECTED',
    );
    const notOverridable = await manualCommit(strict.budgetId, {
      budgetCategoryId: strict.categoryId,
      amount: 150000,
      overspendOverrideReason: 'Emergency.',
    });
    assert.equal(notOverridable.status, 409, JSON.stringify(notOverridable.body));
    assert.equal(
      notOverridable.body.error.code,
      'OPERATIONAL_BUDGET_OVERSPEND_OVERRIDE_NOT_ALLOWED',
    );

    // ALLOW_WITH_OVERRIDE: still rejected without the separate authority.
    const permissive = await scenario(100000, 'ALLOW_WITH_OVERRIDE');
    const withoutAuthority = await manualCommit(permissive.budgetId, {
      budgetCategoryId: permissive.categoryId,
      amount: 150000,
      overspendOverrideReason: 'Emergency.',
    });
    assert.equal(withoutAuthority.status, 403, JSON.stringify(withoutAuthority.body));
    assert.equal(withoutAuthority.body.error.code, 'PERMISSION_DENIED');
  });

  it('preserves Client/Building isolation across the whole surface', async (t) => {
    if (!ready(t)) return;
    const s = await scenario();
    const commitment = await manualCommit(s.budgetId, {
      budgetCategoryId: s.categoryId,
      amount: 1000,
    });
    assert.equal(commitment.status, 201, JSON.stringify(commitment.body));

    const plain = await createPlainSession();
    const other = await createAdminUser();

    const reads = [
      `/api/v1/operational-budgets/${s.budgetId}/variance`,
      `/api/v1/operational-budgets/${s.budgetId}/traceability`,
      `/api/v1/operational-budgets/${s.budgetId}/commitments`,
      `/api/v1/operational-commitments/${commitment.body.data.id}`,
    ];
    for (const path of reads) {
      assert.equal((await api().get(path).set(auth(plain))).status, 403, path);
      const denied = await api().get(path).set(auth(other.token));
      assert.equal(denied.status, 403, path);
      assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED', path);
    }

    const write = await manualCommit(
      s.budgetId,
      { budgetCategoryId: s.categoryId, amount: 1000 },
      other.token,
    );
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');

    const portfolio = await api()
      .get('/api/v1/operational-budget-variance')
      .set(auth(other.token));
    assert.equal(portfolio.status, 200, JSON.stringify(portfolio.body));
    assert.equal(
      portfolio.body.data.some(
        (entry: { budgetId: string }) => entry.budgetId === s.budgetId,
      ),
      false,
    );
  });
});
