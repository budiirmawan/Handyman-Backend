import { getPool } from '../../database';
import type { OperationalFinanceAggregationSourceRow } from './operational-finance-aggregation.types';

type AggregationSourceRow = OperationalFinanceAggregationSourceRow;

/**
 * CR-BE-FIN-01 PART 04 — read-time source projection.
 *
 * This repository owns no table and writes nothing. Amounts, statuses, dates,
 * currencies and upstream relationships are read from the authoritative source
 * tables for every aggregation request. No monetary snapshot is stored in
 * Operational Finance.
 */

const SOURCE_SELECT = `
  binding.id AS "bindingId",
  binding.budget_category_id AS "budgetCategoryId",
  binding.source_type AS "sourceType",
  CASE
    WHEN binding.source_type = 'BASIC_EXPENSE' THEN binding.basic_expense_id
    WHEN binding.source_type = 'VENDOR_SERVICE_COST' THEN binding.vendor_service_cost_id
    WHEN binding.source_type = 'VENDOR_INVOICE' THEN binding.vendor_invoice_id
    WHEN binding.source_type = 'PURCHASE_ORDER' THEN binding.purchase_order_id
    WHEN binding.source_type = 'PO_LINE' THEN binding.purchase_order_line_id
    WHEN binding.source_type = 'WORK_ORDER_MATERIAL'
      THEN binding.work_order_material_usage_id
  END AS "sourceId",
  CASE
    WHEN binding.source_type = 'BASIC_EXPENSE' THEN expense.amount::text
    WHEN binding.source_type = 'VENDOR_SERVICE_COST' THEN cost.cost_amount::text
    WHEN binding.source_type = 'VENDOR_INVOICE' THEN invoice.invoice_amount::text
    WHEN binding.source_type = 'PURCHASE_ORDER'
      AND po_totals.line_count = 1 THEN po_totals.total_amount
    WHEN binding.source_type = 'PO_LINE' THEN po_line.line_amount::text
    WHEN binding.source_type = 'WORK_ORDER_MATERIAL'
      THEN material.total_cost::text
  END AS "sourceAmount",
  CASE
    WHEN binding.source_type = 'VENDOR_INVOICE' THEN invoice.currency
    WHEN binding.source_type IN ('PURCHASE_ORDER', 'PO_LINE') THEN direct_po.currency
    WHEN binding.source_type = 'WORK_ORDER_MATERIAL' THEN material.currency
    /* CUR-02 PART 05: read the real persisted currency snapshot for the
       B-02 cost authorities (NULL stays UNKNOWN; never inferred). */
    WHEN binding.source_type = 'BASIC_EXPENSE' THEN expense.currency_code
    WHEN binding.source_type = 'VENDOR_SERVICE_COST' THEN cost.currency_code
    ELSE NULL
  END AS "sourceCurrency",
  CASE
    WHEN binding.source_type = 'BASIC_EXPENSE' THEN expense.expense_date::text
    WHEN binding.source_type = 'VENDOR_SERVICE_COST' THEN cost.cost_date::text
    WHEN binding.source_type = 'VENDOR_INVOICE' THEN invoice.invoice_date::text
    WHEN binding.source_type IN ('PURCHASE_ORDER', 'PO_LINE')
      THEN (direct_po.issued_at AT TIME ZONE 'UTC')::date::text
    WHEN binding.source_type = 'WORK_ORDER_MATERIAL'
      THEN (material.used_at AT TIME ZONE 'UTC')::date::text
  END AS "sourceDate",
  CASE
    WHEN binding.source_type = 'BASIC_EXPENSE' THEN expense.status
    WHEN binding.source_type = 'VENDOR_SERVICE_COST' THEN cost.status
    WHEN binding.source_type = 'VENDOR_INVOICE' THEN invoice.status
    WHEN binding.source_type IN ('PURCHASE_ORDER', 'PO_LINE') THEN direct_po.status
    WHEN binding.source_type = 'WORK_ORDER_MATERIAL'
      THEN CASE WHEN material.total_cost IS NULL THEN NULL ELSE 'COSTED' END
  END AS "sourceStatus",
  CASE WHEN binding.source_type = 'VENDOR_INVOICE'
    THEN invoice.verification_status ELSE NULL END AS "sourceVerificationStatus",
  binding.currency_status AS "bindingCurrencyStatus",
  CASE
    WHEN binding.source_type = 'VENDOR_SERVICE_COST' THEN cost_pos.purchase_order_ids
    WHEN binding.source_type = 'BASIC_EXPENSE' THEN cost_pos.purchase_order_ids
    WHEN binding.source_type = 'VENDOR_INVOICE' THEN invoice_pos.purchase_order_ids
    WHEN binding.source_type IN ('PURCHASE_ORDER', 'PO_LINE')
      AND direct_po.id IS NOT NULL THEN ARRAY[direct_po.id]::uuid[]
    ELSE ARRAY[]::uuid[]
  END AS "purchaseOrderIds",
  CASE WHEN binding.source_type IN ('BASIC_EXPENSE', 'VENDOR_SERVICE_COST')
    THEN cost.id ELSE NULL END AS "sourceCostId",
  CASE
    WHEN binding.source_type IN ('BASIC_EXPENSE', 'VENDOR_SERVICE_COST')
      THEN cost.vendor_work_id
    WHEN binding.source_type = 'VENDOR_INVOICE' THEN invoice.vendor_work_id
    ELSE NULL
  END AS "sourceVendorWorkId",
  CASE
    WHEN binding.source_type IN ('BASIC_EXPENSE', 'VENDOR_SERVICE_COST')
      THEN cost.work_order_id
    WHEN binding.source_type = 'VENDOR_INVOICE' THEN invoice.work_order_id
    WHEN binding.source_type = 'WORK_ORDER_MATERIAL' THEN material.work_order_id
    ELSE NULL
  END AS "sourceWorkOrderId"
`;

async function listAggregationSources(
  budgetId: string,
): Promise<AggregationSourceRow[]> {
  const result = await getPool().query<AggregationSourceRow>(
    `WITH po_totals AS (
       SELECT purchase_order_id,
              COUNT(*)::int AS line_count,
              COALESCE(SUM(line_amount), 0)::text AS total_amount
         FROM purchase_order_lines
        GROUP BY purchase_order_id
     )
     SELECT ${SOURCE_SELECT}
       FROM operational_budget_source_bindings binding
       LEFT JOIN basic_expenses expense
         ON expense.id = binding.basic_expense_id
       LEFT JOIN vendor_service_costs cost
         ON cost.id = CASE
              WHEN binding.source_type = 'VENDOR_SERVICE_COST'
                THEN binding.vendor_service_cost_id
              WHEN binding.source_type = 'BASIC_EXPENSE'
                THEN expense.vendor_service_cost_id
            END
       LEFT JOIN vendor_invoices invoice
         ON invoice.id = binding.vendor_invoice_id
       LEFT JOIN purchase_order_lines po_line
         ON po_line.id = binding.purchase_order_line_id
       LEFT JOIN purchase_orders direct_po
         ON direct_po.id = CASE
              WHEN binding.source_type = 'PURCHASE_ORDER'
                THEN binding.purchase_order_id
              WHEN binding.source_type = 'PO_LINE'
                THEN po_line.purchase_order_id
            END
       LEFT JOIN po_totals
         ON po_totals.purchase_order_id = direct_po.id
       LEFT JOIN inventory_work_order_material_usages material
         ON material.id = binding.work_order_material_usage_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(array_agg(DISTINCT upstream.id), ARRAY[]::uuid[])
                  AS purchase_order_ids
           FROM purchase_orders upstream
          WHERE upstream.status = 'ISSUED'
            AND cost.id IS NOT NULL
            AND (
              (
                cost.service_request_id IS NOT NULL
                AND upstream.service_request_id = cost.service_request_id
              )
              OR (
                cost.work_order_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                    FROM work_order_procurement_bindings work_binding
                   WHERE work_binding.work_order_id = cost.work_order_id
                     AND (
                       upstream.purchase_request_id = work_binding.purchase_request_id
                       OR upstream.service_request_id = work_binding.service_request_id
                     )
                )
              )
            )
       ) cost_pos ON TRUE
       LEFT JOIN LATERAL (
         SELECT COALESCE(array_agg(DISTINCT upstream.id), ARRAY[]::uuid[])
                  AS purchase_order_ids
           FROM purchase_orders upstream
          WHERE upstream.status = 'ISSUED'
            AND invoice.id IS NOT NULL
            AND (
              upstream.id = invoice.purchase_order_id
              OR (
                invoice.work_order_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                    FROM work_order_procurement_bindings work_binding
                   WHERE work_binding.work_order_id = invoice.work_order_id
                     AND (
                       upstream.purchase_request_id = work_binding.purchase_request_id
                       OR upstream.service_request_id = work_binding.service_request_id
                     )
                )
              )
            )
       ) invoice_pos ON TRUE
      WHERE binding.budget_id = $1
        AND binding.status = 'ACTIVE'
      ORDER BY binding.budget_category_id, binding.created_at, binding.id`,
    [budgetId],
  );
  return result.rows;
}

export const operationalFinanceAggregationRepository = {
  listAggregationSources,
};
