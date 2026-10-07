import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewOperationalBudgetSourceBinding,
  OperationalBudgetSourceBindingRecord,
  OperationalFinanceSourceType,
} from './operational-finance.types';

type BindingRow = Omit<
  OperationalBudgetSourceBindingRecord,
  'removedAt' | 'createdAt' | 'updatedAt'
> & {
  removedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const BINDING_SELECT = `
  id,
  budget_id AS "budgetId",
  budget_category_id AS "budgetCategoryId",
  client_id AS "clientId",
  building_id AS "buildingId",
  source_type AS "sourceType",
  basic_expense_id AS "basicExpenseId",
  vendor_service_cost_id AS "vendorServiceCostId",
  vendor_invoice_id AS "vendorInvoiceId",
  purchase_order_id AS "purchaseOrderId",
  purchase_order_line_id AS "purchaseOrderLineId",
  work_order_material_usage_id AS "workOrderMaterialUsageId",
  currency_status AS "currencyStatus",
  status,
  created_by_user_id AS "createdByUserId",
  removed_by_user_id AS "removedByUserId",
  removed_at AS "removedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const BINDING_SELECT_QUALIFIED = `
  binding.id,
  binding.budget_id AS "budgetId",
  binding.budget_category_id AS "budgetCategoryId",
  binding.client_id AS "clientId",
  binding.building_id AS "buildingId",
  binding.source_type AS "sourceType",
  binding.basic_expense_id AS "basicExpenseId",
  binding.vendor_service_cost_id AS "vendorServiceCostId",
  binding.vendor_invoice_id AS "vendorInvoiceId",
  binding.purchase_order_id AS "purchaseOrderId",
  binding.purchase_order_line_id AS "purchaseOrderLineId",
  binding.work_order_material_usage_id AS "workOrderMaterialUsageId",
  binding.currency_status AS "currencyStatus",
  binding.status,
  binding.created_by_user_id AS "createdByUserId",
  binding.removed_by_user_id AS "removedByUserId",
  binding.removed_at AS "removedAt",
  binding.created_at AS "createdAt",
  binding.updated_at AS "updatedAt"
`;

function mapBinding(row: BindingRow): OperationalBudgetSourceBindingRecord {
  return {
    id: row.id,
    budgetId: row.budgetId,
    budgetCategoryId: row.budgetCategoryId,
    clientId: row.clientId,
    buildingId: row.buildingId,
    sourceType: row.sourceType,
    basicExpenseId: row.basicExpenseId,
    vendorServiceCostId: row.vendorServiceCostId,
    vendorInvoiceId: row.vendorInvoiceId,
    purchaseOrderId: row.purchaseOrderId,
    purchaseOrderLineId: row.purchaseOrderLineId,
    workOrderMaterialUsageId: row.workOrderMaterialUsageId,
    currencyStatus: row.currencyStatus,
    status: row.status,
    createdByUserId: row.createdByUserId,
    removedByUserId: row.removedByUserId,
    removedAt: row.removedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const SOURCE_COLUMNS: Record<OperationalFinanceSourceType, string> = {
  BASIC_EXPENSE: 'basic_expense_id',
  VENDOR_SERVICE_COST: 'vendor_service_cost_id',
  VENDOR_INVOICE: 'vendor_invoice_id',
  PURCHASE_ORDER: 'purchase_order_id',
  PO_LINE: 'purchase_order_line_id',
  WORK_ORDER_MATERIAL: 'work_order_material_usage_id',
};

async function createBinding(
  input: NewOperationalBudgetSourceBinding,
): Promise<OperationalBudgetSourceBindingRecord> {
  const result = await getPool().query<BindingRow>(
    `INSERT INTO operational_budget_source_bindings
       (id, budget_id, budget_category_id, client_id, building_id,
        source_type, basic_expense_id, vendor_service_cost_id, vendor_invoice_id,
        purchase_order_id, purchase_order_line_id, work_order_material_usage_id,
        currency_status, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING ${BINDING_SELECT}`,
    [
      randomUUID(),
      input.budgetId,
      input.budgetCategoryId,
      input.clientId,
      input.buildingId,
      input.sourceType,
      input.basicExpenseId,
      input.vendorServiceCostId,
      input.vendorInvoiceId,
      input.purchaseOrderId,
      input.purchaseOrderLineId,
      input.workOrderMaterialUsageId,
      input.currencyStatus,
      input.createdByUserId,
    ],
  );
  return mapBinding(result.rows[0]);
}

async function findById(
  id: string,
): Promise<OperationalBudgetSourceBindingRecord | null> {
  const result = await getPool().query<BindingRow>(
    `SELECT ${BINDING_SELECT}
       FROM operational_budget_source_bindings
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapBinding(result.rows[0]) : null;
}

async function listByBudget(
  budgetId: string,
): Promise<OperationalBudgetSourceBindingRecord[]> {
  const result = await getPool().query<BindingRow>(
    `SELECT ${BINDING_SELECT}
       FROM operational_budget_source_bindings
      WHERE budget_id = $1
      ORDER BY created_at ASC, id`,
    [budgetId],
  );
  return result.rows.map(mapBinding);
}

async function findActiveBySource(
  sourceType: OperationalFinanceSourceType,
  sourceId: string,
): Promise<OperationalBudgetSourceBindingRecord | null> {
  const column = SOURCE_COLUMNS[sourceType];
  const result = await getPool().query<BindingRow>(
    `SELECT ${BINDING_SELECT}
       FROM operational_budget_source_bindings
      WHERE status = 'ACTIVE' AND source_type = $1 AND ${column} = $2
      LIMIT 1`,
    [sourceType, sourceId],
  );
  return result.rows[0] ? mapBinding(result.rows[0]) : null;
}

/** Finds header/line bindings that occupy one Purchase Order. */
async function findActiveByPurchaseOrder(
  purchaseOrderId: string,
): Promise<OperationalBudgetSourceBindingRecord[]> {
  const result = await getPool().query<BindingRow>(
    `SELECT ${BINDING_SELECT_QUALIFIED}
       FROM operational_budget_source_bindings binding
       LEFT JOIN purchase_order_lines line
         ON line.id = binding.purchase_order_line_id
      WHERE binding.status = 'ACTIVE'
        AND (
          (binding.source_type = 'PURCHASE_ORDER'
            AND binding.purchase_order_id = $1)
          OR (binding.source_type = 'PO_LINE'
            AND line.purchase_order_id = $1)
        )
      ORDER BY binding.created_at ASC, binding.id`,
    [purchaseOrderId],
  );
  return result.rows.map(mapBinding);
}

/**
 * Finds actively bound vendor-cost/invoice lineage on the same Vendor Work or
 * Work Order. Same-work matches are treated as ambiguous, not automatically
 * summed, because those source modules do not prove a one-to-one amount.
 */
async function findActiveByVendorLineage(input: {
  vendorWorkId: string | null;
  workOrderId: string | null;
}): Promise<OperationalBudgetSourceBindingRecord[]> {
  const result = await getPool().query<BindingRow>(
    `SELECT ${BINDING_SELECT_QUALIFIED}
       FROM operational_budget_source_bindings binding
       LEFT JOIN vendor_service_costs cost
         ON cost.id = binding.vendor_service_cost_id
       LEFT JOIN basic_expenses expense
         ON expense.id = binding.basic_expense_id
       LEFT JOIN vendor_service_costs expense_cost
         ON expense_cost.id = expense.vendor_service_cost_id
       LEFT JOIN vendor_invoices invoice
         ON invoice.id = binding.vendor_invoice_id
      WHERE binding.status = 'ACTIVE'
        AND binding.source_type IN ('VENDOR_SERVICE_COST', 'BASIC_EXPENSE', 'VENDOR_INVOICE')
        AND (
          ($1::uuid IS NOT NULL AND (
            cost.vendor_work_id = $1 OR cost.work_order_id = $2
            OR expense_cost.vendor_work_id = $1 OR expense_cost.work_order_id = $2
            OR invoice.vendor_work_id = $1 OR invoice.work_order_id = $2
          ))
          OR ($2::uuid IS NOT NULL AND (
            cost.work_order_id = $2
            OR expense_cost.work_order_id = $2
            OR invoice.work_order_id = $2
          ))
        )
      ORDER BY binding.created_at ASC, binding.id`,
    [input.vendorWorkId, input.workOrderId],
  );
  return result.rows.map(mapBinding);
}

/** Direct Basic Expense → Vendor Service Cost representation lookup. */
async function findActiveBasicExpenseForVendorServiceCost(
  vendorServiceCostId: string,
): Promise<OperationalBudgetSourceBindingRecord[]> {
  const result = await getPool().query<BindingRow>(
    `SELECT ${BINDING_SELECT_QUALIFIED}
       FROM operational_budget_source_bindings binding
       JOIN basic_expenses expense
         ON expense.id = binding.basic_expense_id
      WHERE binding.status = 'ACTIVE'
        AND binding.source_type = 'BASIC_EXPENSE'
        AND expense.vendor_service_cost_id = $1
      ORDER BY binding.created_at ASC, binding.id`,
    [vendorServiceCostId],
  );
  return result.rows.map(mapBinding);
}

async function removeBinding(
  id: string,
  actorUserId: string,
): Promise<OperationalBudgetSourceBindingRecord | null> {
  const result = await getPool().query<BindingRow>(
    `UPDATE operational_budget_source_bindings
        SET status = 'REMOVED',
            removed_by_user_id = $2,
            removed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${BINDING_SELECT}`,
    [id, actorUserId],
  );
  return result.rows[0] ? mapBinding(result.rows[0]) : null;
}

export const operationalFinanceBindingRepository = {
  createBinding,
  findActiveBasicExpenseForVendorServiceCost,
  findActiveByPurchaseOrder,
  findActiveBySource,
  findActiveByVendorLineage,
  findById,
  listByBudget,
  removeBinding,
};
