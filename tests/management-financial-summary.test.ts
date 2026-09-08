import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { parseManagementFinancialSummaryQuery } from '../src/modules/management-financial-summary';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-24 PART 06B focused tests — Financial Summary only. */

const PATH = '/api/v1/management/financial-summary';
const MANAGEMENT_PERMISSION = {
  code: 'management_read_model.read',
  name: 'Read Management and Owner Read Models',
} as const;

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerToken = '';
let managerUserId = '';
let plainToken = '';
let noAssignmentToken = '';
let fixture: Awaited<ReturnType<typeof seed>> | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE clients, users, roles, permissions CASCADE');

  const manager = await createAdminUser();
  managerToken = manager.token;
  managerUserId = manager.userId;
  plainToken = await createPlainSession();
  noAssignmentToken = await createSessionWithPermissions([
    MANAGEMENT_PERMISSION,
  ]);
  fixture = await seed();
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool || !fixture) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const auth = (token = managerToken) => ({ Authorization: `Bearer ${token}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

async function seed() {
  const scopeA = await createBuildingScope('A', true);
  const scopeB = await createBuildingScope('B', false);
  const hidden = await createBuildingScope('HIDDEN', false);
  for (const building of [scopeA.building, scopeA.secondBuilding!.building, scopeB.building]) {
    await buildingAssignmentService.createAssignment(managerUserId, {
      buildingId: building.id,
    });
  }

  const tenantA = await insertTenant(scopeA.client.id, 'A');
  const tenantB = await insertTenant(scopeB.client.id, 'B');
  const tenantHidden = await insertTenant(hidden.client.id, 'H');

  await insertCharge(scopeA, tenantA, 100, 'ACTIVE');
  await insertCharge(scopeA, tenantA, 20, 'CANCELLED');
  await insertUtilityBill(scopeA, tenantA, 200);
  const a1Future = await insertInvoice(scopeA, tenantA, 300, '2099-01-01', 100);
  const a1Overdue = await insertInvoice(scopeA, tenantA, 150, '2026-08-01', 0);
  await insertDraftInvoice(scopeA, tenantA, 50);
  await insertReceipt(scopeA, tenantA, a1Future, 80, 'ISSUED');
  await insertReceipt(scopeA, tenantA, a1Overdue, 20, 'VOID');
  await insertVendorCosts(scopeA, 70, true);
  await insertBasicExpense(scopeA, 30, null);

  const scopeA2 = {
    client: scopeA.client,
    property: scopeA.property,
    building: scopeA.secondBuilding!.building,
    space: scopeA.secondBuilding!.space,
    secondBuilding: null,
  };
  await insertCharge(scopeA2, tenantA, 50, 'ACTIVE');
  await insertUtilityBill(scopeA2, tenantA, 100);
  const a2Paid = await insertInvoice(scopeA2, tenantA, 200, '2099-01-01', 200);
  await insertReceipt(scopeA2, tenantA, a2Paid, 200, 'ISSUED');
  await insertVendorCosts(scopeA2, 40, false);
  await insertBasicExpense(scopeA2, 10, null);

  await insertCharge(scopeB, tenantB, 80, 'ACTIVE');
  await insertUtilityBill(scopeB, tenantB, 50);
  const bOverdue = await insertInvoice(scopeB, tenantB, 120, '2026-08-01', 20);
  await insertReceipt(scopeB, tenantB, bOverdue, 20, 'ISSUED');

  await insertCharge(hidden, tenantHidden, 999, 'ACTIVE');
  await insertInvoice(hidden, tenantHidden, 999, '2026-08-01', 0);

  return { scopeA, scopeB, hidden };
}

async function createBuildingScope(label: string, withSecond: boolean) {
  const client = await clientService.createClient({
    code: `FN_${label}_${suffix()}`,
    name: `Financial Client ${label}`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${label}_${suffix()}`,
    name: `Property ${label}`,
  });
  const first = await createBuildingWithSpace(property.id, label);
  const secondBuilding = withSecond
    ? await createBuildingWithSpace(property.id, `${label}2`)
    : null;
  return {
    client,
    property,
    building: first.building,
    space: first.space,
    secondBuilding,
  };
}

async function createBuildingWithSpace(propertyId: string, label: string) {
  const building = await buildingService.createBuilding({
    propertyId,
    code: `B_${label}_${suffix()}`,
    name: `Building ${label}`,
  });
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `F_${label}_${suffix()}`,
    name: 'Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A_${label}_${suffix()}`,
    name: 'Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R_${label}_${suffix()}`,
    name: 'Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `S_${label}_${suffix()}`,
    name: 'Space',
  });
  return { building, space };
}

type Scope = {
  client: { id: string };
  building: { id: string };
  space: { id: string };
};
type Tenant = { id: string };

type InvoiceContext = {
  invoiceId: string;
  paymentStatusId: string;
};

async function insertTenant(clientId: string, label: string): Promise<Tenant> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO tenant_companies (id,client_id,tenant_code,tenant_name)
     VALUES ($1,$2,$3,$4)`,
    [id, clientId, `TEN_${label}_${suffix()}`, `Tenant ${label}`],
  );
  return { id };
}

async function insertCharge(
  scope: Scope,
  tenant: Tenant,
  amount: number,
  status: 'ACTIVE' | 'CANCELLED',
): Promise<void> {
  await pool!.query(
    `INSERT INTO tenant_charges
       (id,client_id,tenant_company_id,building_id,space_id,charge_type,
        description,amount,charge_date,status,created_by_user_id,
        cancelled_at,cancelled_by_user_id)
     VALUES ($1,$2,$3,$4,$5,'SERVICE','Charge',$6,'2026-08-05',$7,$8,$9,$10)`,
    [
      randomUUID(),
      scope.client.id,
      tenant.id,
      scope.building.id,
      scope.space.id,
      amount,
      status,
      managerUserId,
      status === 'CANCELLED' ? '2026-08-06T00:00:00.000Z' : null,
      status === 'CANCELLED' ? managerUserId : null,
    ],
  );
}

async function insertUtilityBill(
  scope: Scope,
  tenant: Tenant,
  amount: number,
): Promise<void> {
  const uomId = randomUUID();
  const meterId = randomUUID();
  const assignmentId = randomUUID();
  const previousReadingId = randomUUID();
  const currentReadingId = randomUUID();
  const consumptionId = randomUUID();
  const calculationId = randomUUID();
  await pool!.query(
    `INSERT INTO units_of_measure
       (id,client_id,code,name,symbol,category)
     VALUES ($1,$2,$3,'kWh','kWh','ENERGY')`,
    [uomId, scope.client.id, `UOM_${suffix()}`],
  );
  await pool!.query(
    `INSERT INTO utility_meters
       (id,client_id,building_id,code,name,utility_type,uom_id)
     VALUES ($1,$2,$3,$4,'Meter','ELECTRICITY',$5)`,
    [meterId, scope.client.id, scope.building.id, `MTR_${suffix()}`, uomId],
  );
  await pool!.query(
    `INSERT INTO utility_meter_tenant_assignments
       (id,client_id,building_id,meter_id,tenant_company_id,space_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      assignmentId,
      scope.client.id,
      scope.building.id,
      meterId,
      tenant.id,
      scope.space.id,
    ],
  );
  await pool!.query(
    `INSERT INTO utility_meter_readings
       (id,client_id,building_id,meter_id,uom_id,reading_value,reading_at,
        recorded_by_user_id,tenant_assignment_id,tenant_company_id)
     VALUES ($1,$2,$3,$4,$5,0,'2026-07-01',$6,$7,$8),
            ($9,$2,$3,$4,$5,100,'2026-08-01',$6,$7,$8)`,
    [
      previousReadingId,
      scope.client.id,
      scope.building.id,
      meterId,
      uomId,
      managerUserId,
      assignmentId,
      tenant.id,
      currentReadingId,
    ],
  );
  await pool!.query(
    `INSERT INTO utility_meter_consumptions
       (id,client_id,building_id,meter_id,previous_reading_id,current_reading_id,
        uom_id,consumption_value,period_start,period_end,
        calculated_by_user_id,tenant_assignment_id,tenant_company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,100,'2026-07-01','2026-08-01',$8,$9,$10)`,
    [
      consumptionId,
      scope.client.id,
      scope.building.id,
      meterId,
      previousReadingId,
      currentReadingId,
      uomId,
      managerUserId,
      assignmentId,
      tenant.id,
    ],
  );
  await pool!.query(
    `INSERT INTO utility_calculations
       (id,client_id,building_id,meter_id,utility_type,consumption_id,
        consumption_quantity,applied_rate_value,calculated_amount,uom_id,
        period_start,period_end,status,calculated_by_user_id,finalized_at,
        finalized_by_user_id,tenant_assignment_id,tenant_company_id)
     VALUES ($1,$2,$3,$4,'ELECTRICITY',$5,100,1,$6,$7,'2026-07-01',
             '2026-08-01','FINALIZED',$8,'2026-08-02',$8,$9,$10)`,
    [
      calculationId,
      scope.client.id,
      scope.building.id,
      meterId,
      consumptionId,
      amount,
      uomId,
      managerUserId,
      assignmentId,
      tenant.id,
    ],
  );
  await pool!.query(
    `INSERT INTO utility_bills
       (id,client_id,tenant_company_id,building_id,meter_id,
        tenant_assignment_id,calculation_id,utility_type,period_start,
        period_end,bill_amount,due_date,status,generated_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ELECTRICITY','2026-07-01',
             '2026-08-01',$8,'2026-08-31','ISSUED',$9)`,
    [
      randomUUID(),
      scope.client.id,
      tenant.id,
      scope.building.id,
      meterId,
      assignmentId,
      calculationId,
      amount,
      managerUserId,
    ],
  );
}

async function insertInvoice(
  scope: Scope,
  tenant: Tenant,
  total: number,
  dueDate: string,
  paidAmount: number,
): Promise<InvoiceContext> {
  const invoiceId = randomUUID();
  const paymentStatusId = randomUUID();
  const invoiceDate = dueDate < '2026-08-17' ? '2026-08-01' : '2026-08-10';
  await pool!.query(
    `INSERT INTO tenant_invoices
       (id,client_id,tenant_company_id,building_id,space_id,invoice_number,
        invoice_date,due_date,status,subtotal,total_amount,created_by_user_id,
        finalized_at,finalized_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'FINALIZED',$9,$9,$10,
             '2026-08-11',$10)`,
    [
      invoiceId,
      scope.client.id,
      tenant.id,
      scope.building.id,
      scope.space.id,
      `INV_${suffix()}`,
      invoiceDate,
      dueDate,
      total,
      managerUserId,
    ],
  );
  const outstanding = total - paidAmount;
  const paymentStatus =
    outstanding === 0
      ? 'PAID'
      : dueDate < '2026-08-17'
        ? 'OVERDUE'
        : paidAmount > 0
          ? 'PARTIALLY_PAID'
          : 'UNPAID';
  await pool!.query(
    `INSERT INTO invoice_payment_status
       (id,invoice_id,client_id,tenant_company_id,building_id,payment_status,
        paid_amount,outstanding_amount,paid_at,recorded_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      paymentStatusId,
      invoiceId,
      scope.client.id,
      tenant.id,
      scope.building.id,
      paymentStatus,
      paidAmount,
      outstanding,
      paidAmount > 0 ? '2026-08-12T00:00:00.000Z' : null,
      managerUserId,
    ],
  );
  return { invoiceId, paymentStatusId };
}

async function insertDraftInvoice(
  scope: Scope,
  tenant: Tenant,
  total: number,
): Promise<void> {
  await pool!.query(
    `INSERT INTO tenant_invoices
       (id,client_id,tenant_company_id,building_id,space_id,invoice_number,
        invoice_date,due_date,status,subtotal,total_amount,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,'2026-08-10','2099-01-01','DRAFT',$7,$7,$8)`,
    [
      randomUUID(),
      scope.client.id,
      tenant.id,
      scope.building.id,
      scope.space.id,
      `INV_${suffix()}`,
      total,
      managerUserId,
    ],
  );
}

async function insertReceipt(
  scope: Scope,
  tenant: Tenant,
  invoice: InvoiceContext,
  amount: number,
  status: 'ISSUED' | 'VOID',
): Promise<void> {
  await pool!.query(
    `INSERT INTO payment_receipts
       (id,receipt_number,invoice_id,invoice_payment_status_id,client_id,
        tenant_company_id,building_id,received_amount,received_at,status,
        issued_by_user_id,voided_at,voided_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'2026-08-15',$9,$10,$11,$12)`,
    [
      randomUUID(),
      `RCT_${suffix()}`,
      invoice.invoiceId,
      invoice.paymentStatusId,
      scope.client.id,
      tenant.id,
      scope.building.id,
      amount,
      status,
      managerUserId,
      status === 'VOID' ? '2026-08-16T00:00:00.000Z' : null,
      status === 'VOID' ? managerUserId : null,
    ],
  );
}

async function insertVendorCosts(
  scope: Scope,
  amount: number,
  linkExpense: boolean,
): Promise<void> {
  const vendorId = randomUUID();
  const workOrderId = randomUUID();
  const assignmentId = randomUUID();
  const vendorWorkId = randomUUID();
  const costId = randomUUID();
  await pool!.query(
    `INSERT INTO vendors (id,client_id,vendor_code,vendor_name)
     VALUES ($1,$2,$3,'Vendor')`,
    [vendorId, scope.client.id, `VEN_${suffix()}`],
  );
  await pool!.query(
    `INSERT INTO work_orders
       (id,client_id,building_id,work_order_number,title,work_type,status,
        created_by_user_id)
     VALUES ($1,$2,$3,$4,'Vendor Work','GENERAL','OPEN',$5)`,
    [workOrderId, scope.client.id, scope.building.id, `WO_${suffix()}`, managerUserId],
  );
  await pool!.query(
    `INSERT INTO vendor_assignments
       (id,vendor_id,work_order_id,building_id,status,assigned_by_user_id)
     VALUES ($1,$2,$3,$4,'ACTIVE',$5)`,
    [assignmentId, vendorId, workOrderId, scope.building.id, managerUserId],
  );
  await pool!.query(
    `INSERT INTO vendor_works
       (id,vendor_assignment_id,vendor_id,work_order_id,building_id,status,
        started_at,completed_at)
     VALUES ($1,$2,$3,$4,$5,'COMPLETED','2026-08-01','2026-08-02')`,
    [vendorWorkId, assignmentId, vendorId, workOrderId, scope.building.id],
  );
  await pool!.query(
    `INSERT INTO vendor_service_costs
       (id,client_id,building_id,vendor_id,context_type,vendor_work_id,
        work_order_id,cost_amount,cost_date,cost_type,cost_category,status,
        created_by_user_id,finalized_at,finalized_by_user_id)
     VALUES ($1,$2,$3,$4,'VENDOR_WORK',$5,$6,$7,'2026-08-12','SERVICE',
             'OPS','FINALIZED',$8,'2026-08-13',$8)`,
    [
      costId,
      scope.client.id,
      scope.building.id,
      vendorId,
      vendorWorkId,
      workOrderId,
      amount,
      managerUserId,
    ],
  );
  if (linkExpense) {
    await insertBasicExpense(scope, amount, costId);
  }
}

async function insertBasicExpense(
  scope: Scope,
  amount: number,
  vendorServiceCostId: string | null,
): Promise<void> {
  await pool!.query(
    `INSERT INTO basic_expenses
       (id,client_id,building_id,expense_number,expense_category,description,
        amount,expense_date,vendor_service_cost_id,status,created_by_user_id,
        finalized_at,finalized_by_user_id)
     VALUES ($1,$2,$3,$4,'OPS','Expense',$5,'2026-08-12',$6,'FINALIZED',$7,
             '2026-08-13',$7)`,
    [
      randomUUID(),
      scope.client.id,
      scope.building.id,
      `EXP_${suffix()}`,
      amount,
      vendorServiceCostId,
      managerUserId,
    ],
  );
}

describe('BE-24 PART 06B — Management Financial Summary', () => {
  it('documents the endpoint and delegates scope/period parsing to PART 01', () => {
    const parsed = parseManagementFinancialSummaryQuery({
      dateFrom: '2026-08-01',
      dateTo: '2026-08-31',
    });
    assert.equal(parsed.scope.dateFrom, '2026-08-01');
    assert.equal(parsed.scope.dateTo, '2026-08-31');

    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    ) as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
    assert.ok(spec.paths?.['/management/financial-summary']);
    assert.ok(spec.components?.schemas?.ManagementFinancialSummary);
  });

  it('enforces authentication and management-read RBAC', async (t) => {
    if (!ready(t)) return;
    const unauthenticated = await api().get(PATH);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbidden = await api().get(PATH).set(auth(plainToken));
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');
  });

  it('returns authoritative BE-19 summaries with paid, unpaid and overdue amounts', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(PATH)
      .query({ dateFrom: '2026-08-01', dateTo: '2026-08-31' })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data.data;
    assert.equal(data.buildingSummaries.length, 3);
    assert.equal(data.clientSummaries.length, 2);

    const clientA = data.clientSummaries.find(
      (row: any) => row.clientId === fixture!.scopeA.client.id,
    ).summary;
    assert.deepEqual(clientA.tenantCharges, {
      count: 2,
      amount: 150,
      cancelledCount: 1,
    });
    assert.deepEqual(clientA.utilityBills, {
      count: 2,
      amount: 300,
      cancelledCount: 0,
    });
    assert.deepEqual(clientA.invoices, {
      count: 3,
      amount: 650,
      draftCount: 1,
      cancelledCount: 0,
    });
    assert.deepEqual(clientA.payments, {
      paidAmount: 300,
      unpaidAmount: 200,
      overdueAmount: 150,
      outstandingAmount: 350,
      unpaidCount: 0,
      partiallyPaidCount: 1,
      paidCount: 1,
      overdueCount: 1,
    });
    assert.deepEqual(clientA.receipts, {
      issued: { count: 2, amount: 280 },
      void: { count: 1, amount: 20 },
    });
    assert.deepEqual(clientA.vendorServiceCosts, {
      finalized: { count: 2, amount: 110 },
      draftCount: 0,
      cancelledCount: 0,
    });
    assert.deepEqual(clientA.basicExpenses, {
      finalized: { count: 3, amount: 110 },
      draftCount: 0,
      cancelledCount: 0,
    });
    assert.deepEqual(clientA.outstandingBalance, {
      invoiceCount: 2,
      amount: 350,
    });
    assert.deepEqual(clientA.incomeVsOperationalCost, {
      billedIncome: 650,
      receivedIncome: 280,
      operationalCost: 150,
      netBilled: 500,
      netReceived: 130,
    });
  });

  it('partitions multi-Client money and supports single/Client/multi-Building scope', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;

    const single = await api()
      .get(PATH)
      .query({
        buildingId: f.scopeA.building.id,
        dateFrom: '2026-08-01',
        dateTo: '2026-08-31',
      })
      .set(auth());
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.data.scope.mode, 'SINGLE_BUILDING');
    assert.equal(single.body.data.data.clientSummaries.length, 1);
    assert.equal(single.body.data.data.clientSummaries[0].summary.invoices.amount, 450);
    assert.equal(
      single.body.data.data.clientSummaries[0].summary.incomeVsOperationalCost
        .operationalCost,
      100,
    );

    const client = await api()
      .get(PATH)
      .query({
        clientId: f.scopeA.client.id,
        dateFrom: '2026-08-01',
        dateTo: '2026-08-31',
      })
      .set(auth());
    assert.equal(client.status, 200, JSON.stringify(client.body));
    assert.equal(client.body.data.scope.mode, 'CLIENT');
    assert.equal(client.body.data.data.clientSummaries.length, 1);
    assert.equal(client.body.data.data.buildingSummaries.length, 2);
    assert.equal(client.body.data.data.clientSummaries[0].summary.invoices.amount, 650);

    const multi = await api()
      .get(PATH)
      .query({
        buildingIds: [
          f.scopeA.building.id,
          f.scopeA.secondBuilding!.building.id,
          f.scopeB.building.id,
        ],
        dateFrom: '2026-08-01',
        dateTo: '2026-08-31',
      })
      .set(auth());
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    assert.equal(multi.body.data.scope.mode, 'MULTI_BUILDING');
    assert.equal(multi.body.data.data.clientSummaries.length, 2);
    assert.equal(
      multi.body.data.data.clientSummaries.some(
        (row: any) => row.clientId === f.scopeA.client.id && row.summary.invoices.amount === 650,
      ),
      true,
    );
    assert.equal(
      multi.body.data.data.clientSummaries.some(
        (row: any) => row.clientId === f.scopeB.client.id && row.summary.invoices.amount === 120,
      ),
      true,
    );

    const inaccessible = await api()
      .get(PATH)
      .query({ buildingId: f.hidden.building.id })
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('applies the financial calendar period through BE-19I', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(PATH)
      .query({ dateFrom: '2025-01-01', dateTo: '2025-12-31' })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    for (const building of response.body.data.data.buildingSummaries) {
      assert.equal(building.summary.tenantCharges.amount, 0);
      assert.equal(building.summary.invoices.amount, 0);
      assert.equal(building.summary.receipts.issued.amount, 0);
      assert.equal(building.summary.vendorServiceCosts.finalized.amount, 0);
    }
  });

  it('returns a zeroed partition contract for a permitted user with no Building scope', async (t) => {
    if (!ready(t)) return;
    const response = await api().get(PATH).set(auth(noAssignmentToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.data.scope.buildingIds, []);
    assert.deepEqual(response.body.data.data, {
      clientSummaries: [],
      buildingSummaries: [],
    });
  });

  it('rejects invalid scope and period filters', async (t) => {
    if (!ready(t)) return;
    const f = fixture!;
    const cases = [
      { dateFrom: '2026-09-01', dateTo: '2026-08-01' },
      { dateFrom: '2026-02-30' },
      {
        buildingId: f.scopeA.building.id,
        buildingIds: f.scopeB.building.id,
      },
    ];
    for (const query of cases) {
      const response = await api().get(PATH).query(query).set(auth());
      assert.equal(response.status, 400, JSON.stringify({ query, body: response.body }));
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
  });
});
