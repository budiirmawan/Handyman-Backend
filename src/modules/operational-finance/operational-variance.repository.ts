import type { PoolClient } from 'pg';
import { getPool } from '../../database';

/**
 * CR-BE-COMM-VAR-01 PART 05 — variance + traceability projection.
 *
 * This repository owns no table and writes nothing. Every figure is derived at
 * read time from the authoritative rows: the PART 02 commitment ledger, the
 * CR-BE-FIN-01 typed source bindings, and the operational cost transactions
 * themselves. All arithmetic happens in SQL `NUMERIC(18,2)`; amounts leave as
 * strings so no JavaScript float can enter a financial figure.
 */

type Executor = Pick<PoolClient, 'query'>;

/**
 * Eligible legacy (pre-ledger) commitment contributions.
 *
 * A CR-BE-FIN-01 `PO_LINE` / `PURCHASE_ORDER` source binding remains a valid
 * commitment while no ledger commitment represents the same Purchase Order or
 * line — that mutual exclusion is what stops one obligation being counted
 * twice. A PO header binding contributes only when the Purchase Order has
 * exactly one line, mirroring the existing PART 04 aggregation rule; anything
 * else is ambiguous and is excluded rather than guessed.
 */
export const LEGACY_COMMITMENT_SQL = `
  SELECT binding.id                AS binding_id,
         binding.budget_id         AS budget_id,
         binding.budget_category_id AS budget_category_id,
         binding.source_type       AS source_type,
         COALESCE(binding.purchase_order_line_id, binding.purchase_order_id)
                                   AS source_id,
         po.id                     AS purchase_order_id,
         line.id                   AS purchase_order_line_id,
         po.vendor_id              AS vendor_id,
         line.material_request_id  AS material_request_id,
         CASE
           WHEN binding.source_type = 'PO_LINE' THEN line.line_amount
           WHEN binding.source_type = 'PURCHASE_ORDER' AND totals.line_count = 1
             THEN totals.total_amount
           ELSE NULL
         END::numeric(18,2)        AS amount,
         po.currency               AS currency,
         po.status                 AS source_status,
         (ledger.id IS NOT NULL)   AS superseded_by_ledger,
         ledger.id                 AS ledger_commitment_id
    FROM operational_budget_source_bindings binding
    LEFT JOIN purchase_order_lines line
      ON line.id = binding.purchase_order_line_id
    LEFT JOIN purchase_orders po
      ON po.id = COALESCE(binding.purchase_order_id, line.purchase_order_id)
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS line_count,
             COALESCE(SUM(all_lines.line_amount), 0) AS total_amount
        FROM purchase_order_lines all_lines
       WHERE all_lines.purchase_order_id = po.id
    ) totals ON TRUE
    LEFT JOIN LATERAL (
      SELECT commitment.id
        FROM operational_commitments commitment
        LEFT JOIN purchase_order_lines commitment_line
          ON commitment_line.id = commitment.purchase_order_line_id
       WHERE commitment.status <> 'CANCELLED'
         AND (
           commitment.purchase_order_id = po.id
           OR commitment_line.purchase_order_id = po.id
         )
       LIMIT 1
    ) ledger ON TRUE
   WHERE binding.budget_id = $1
     AND binding.status = 'ACTIVE'
     AND binding.source_type IN ('PO_LINE', 'PURCHASE_ORDER')
`;

/** Costed Work Order material usages inside the budget's scope. */
export const MATERIAL_ACTUAL_SQL = `
  SELECT usage.id                    AS usage_id,
         usage.work_order_id         AS work_order_id,
         usage.material_request_id   AS material_request_id,
         usage.total_cost::numeric(18,2) AS total_cost,
         COALESCE(linked.actualized, 0)::numeric(18,2) AS actualized_amount,
         GREATEST(usage.total_cost - COALESCE(linked.actualized, 0), 0)::numeric(18,2)
                                     AS uncommitted_amount,
         usage.currency              AS currency,
         usage.used_at::date::text   AS source_date,
         linked.commitment_id        AS commitment_id,
         linked.binding_id           AS binding_id
    FROM inventory_work_order_material_usages usage
    JOIN operational_budgets budget ON budget.id = $1
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(-entry.signed_amount), 0) AS actualized,
             MIN(entry.commitment_id::text)::uuid   AS commitment_id,
             MIN(binding.id::text)::uuid            AS binding_id
        FROM operational_commitment_entries entry
        JOIN operational_budget_source_bindings binding
          ON binding.id = entry.source_binding_id
       WHERE entry.entry_type IN ('ACTUALIZE', 'ACTUALIZE_REVERSAL')
         AND binding.work_order_material_usage_id = usage.id
    ) linked ON TRUE
   WHERE usage.building_id = budget.building_id
     AND usage.unit_cost IS NOT NULL
     AND usage.currency = budget.currency
     AND usage.used_at::date BETWEEN budget.period_start AND budget.period_end
`;

/** FINALIZED + VERIFIED vendor invoices inside the budget's scope. */
export const INVOICE_ACTUAL_SQL = `
  SELECT invoice.id                  AS invoice_id,
         invoice.vendor_id           AS vendor_id,
         invoice.purchase_order_id   AS purchase_order_id,
         invoice.work_order_id       AS work_order_id,
         invoice.invoice_number      AS invoice_number,
         invoice.invoice_amount::numeric(18,2) AS invoice_amount,
         COALESCE(linked.actualized, 0)::numeric(18,2) AS actualized_amount,
         GREATEST(invoice.invoice_amount - COALESCE(linked.actualized, 0), 0)::numeric(18,2)
                                     AS uncommitted_amount,
         invoice.currency            AS currency,
         invoice.invoice_date::text  AS source_date,
         linked.commitment_id        AS commitment_id,
         linked.binding_id           AS binding_id
    FROM vendor_invoices invoice
    JOIN operational_budgets budget ON budget.id = $1
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(-entry.signed_amount), 0) AS actualized,
             MIN(entry.commitment_id::text)::uuid   AS commitment_id,
             MIN(binding.id::text)::uuid            AS binding_id
        FROM operational_commitment_entries entry
        JOIN operational_budget_source_bindings binding
          ON binding.id = entry.source_binding_id
       WHERE entry.entry_type IN ('ACTUALIZE', 'ACTUALIZE_REVERSAL')
         AND binding.vendor_invoice_id = invoice.id
    ) linked ON TRUE
   WHERE invoice.building_id = budget.building_id
     AND invoice.status = 'FINALIZED'
     AND invoice.verification_status = 'VERIFIED'
     AND invoice.currency = budget.currency
     AND invoice.invoice_date BETWEEN budget.period_start AND budget.period_end
`;

export type LedgerCategoryRow = {
  budgetCategoryId: string;
  committedAmount: string;
  openAmount: string;
  actualizedAmount: string;
  releasedAmount: string;
  commitmentCount: number;
};

async function ledgerByCategory(
  budgetId: string,
  executor: Executor = getPool(),
): Promise<LedgerCategoryRow[]> {
  const result = await executor.query<LedgerCategoryRow>(
    `SELECT budget_category_id AS "budgetCategoryId",
            COALESCE(SUM(committed_amount), 0)::numeric(18,2)::text
              AS "committedAmount",
            COALESCE(SUM(open_amount), 0)::numeric(18,2)::text AS "openAmount",
            COALESCE(SUM(actualized_amount), 0)::numeric(18,2)::text
              AS "actualizedAmount",
            COALESCE(SUM(released_amount), 0)::numeric(18,2)::text
              AS "releasedAmount",
            COUNT(*)::int AS "commitmentCount"
       FROM operational_commitments
      WHERE budget_id = $1
        AND status <> 'CANCELLED'
      GROUP BY budget_category_id`,
    [budgetId],
  );
  return result.rows;
}

export type LegacyCommitmentRow = {
  bindingId: string;
  budgetCategoryId: string;
  sourceType: 'PO_LINE' | 'PURCHASE_ORDER';
  sourceId: string;
  purchaseOrderId: string | null;
  purchaseOrderLineId: string | null;
  vendorId: string | null;
  materialRequestId: string | null;
  amount: string | null;
  currency: string | null;
  sourceStatus: string | null;
  supersededByLedger: boolean;
  ledgerCommitmentId: string | null;
};

async function legacyCommitments(
  budgetId: string,
  executor: Executor = getPool(),
): Promise<LegacyCommitmentRow[]> {
  const result = await executor.query<LegacyCommitmentRow>(
    `SELECT binding_id AS "bindingId",
            budget_category_id AS "budgetCategoryId",
            source_type AS "sourceType",
            source_id AS "sourceId",
            purchase_order_id AS "purchaseOrderId",
            purchase_order_line_id AS "purchaseOrderLineId",
            vendor_id AS "vendorId",
            material_request_id AS "materialRequestId",
            amount::text AS "amount",
            currency,
            source_status AS "sourceStatus",
            superseded_by_ledger AS "supersededByLedger",
            ledger_commitment_id AS "ledgerCommitmentId"
       FROM (${LEGACY_COMMITMENT_SQL}) legacy
      ORDER BY budget_category_id, binding_id`,
    [budgetId],
  );
  return result.rows;
}

export type MaterialActualRow = {
  usageId: string;
  workOrderId: string;
  materialRequestId: string | null;
  totalCost: string;
  actualizedAmount: string;
  uncommittedAmount: string;
  currency: string;
  sourceDate: string;
  commitmentId: string | null;
  bindingId: string | null;
};

async function materialActuals(
  budgetId: string,
  executor: Executor = getPool(),
): Promise<MaterialActualRow[]> {
  const result = await executor.query<MaterialActualRow>(
    `SELECT usage_id AS "usageId",
            work_order_id AS "workOrderId",
            material_request_id AS "materialRequestId",
            total_cost::text AS "totalCost",
            actualized_amount::text AS "actualizedAmount",
            uncommitted_amount::text AS "uncommittedAmount",
            currency,
            source_date AS "sourceDate",
            commitment_id AS "commitmentId",
            binding_id AS "bindingId"
       FROM (${MATERIAL_ACTUAL_SQL}) material
      ORDER BY source_date, usage_id`,
    [budgetId],
  );
  return result.rows;
}

export type InvoiceActualRow = {
  invoiceId: string;
  vendorId: string;
  purchaseOrderId: string | null;
  workOrderId: string | null;
  invoiceNumber: string;
  invoiceAmount: string;
  actualizedAmount: string;
  uncommittedAmount: string;
  currency: string;
  sourceDate: string;
  commitmentId: string | null;
  bindingId: string | null;
};

async function invoiceActuals(
  budgetId: string,
  executor: Executor = getPool(),
): Promise<InvoiceActualRow[]> {
  const result = await executor.query<InvoiceActualRow>(
    `SELECT invoice_id AS "invoiceId",
            vendor_id AS "vendorId",
            purchase_order_id AS "purchaseOrderId",
            work_order_id AS "workOrderId",
            invoice_number AS "invoiceNumber",
            invoice_amount::text AS "invoiceAmount",
            actualized_amount::text AS "actualizedAmount",
            uncommitted_amount::text AS "uncommittedAmount",
            currency,
            source_date AS "sourceDate",
            commitment_id AS "commitmentId",
            binding_id AS "bindingId"
       FROM (${INVOICE_ACTUAL_SQL}) invoices
      ORDER BY source_date, invoice_id`,
    [budgetId],
  );
  return result.rows;
}

export type CommitmentTraceRow = {
  commitmentId: string;
  budgetCategoryId: string;
  origin: string;
  status: string;
  committedAmount: string;
  actualizedAmount: string;
  releasedAmount: string;
  openAmount: string;
  currency: string;
  title: string;
  purchaseOrderId: string | null;
  purchaseOrderLineId: string | null;
  workOrderId: string | null;
  vendorId: string | null;
  materialRequestId: string | null;
  createdAt: Date;
};

async function commitmentTrace(
  budgetId: string,
  executor: Executor = getPool(),
): Promise<CommitmentTraceRow[]> {
  const result = await executor.query<CommitmentTraceRow>(
    `SELECT commitment.id AS "commitmentId",
            commitment.budget_category_id AS "budgetCategoryId",
            commitment.origin,
            commitment.status,
            commitment.committed_amount::text AS "committedAmount",
            commitment.actualized_amount::text AS "actualizedAmount",
            commitment.released_amount::text AS "releasedAmount",
            commitment.open_amount::text AS "openAmount",
            commitment.currency,
            commitment.title,
            COALESCE(commitment.purchase_order_id, line.purchase_order_id)
              AS "purchaseOrderId",
            commitment.purchase_order_line_id AS "purchaseOrderLineId",
            commitment.work_order_id AS "workOrderId",
            commitment.vendor_id AS "vendorId",
            COALESCE(commitment.material_request_id, line.material_request_id)
              AS "materialRequestId",
            commitment.created_at AS "createdAt"
       FROM operational_commitments commitment
       LEFT JOIN purchase_order_lines line
         ON line.id = commitment.purchase_order_line_id
      WHERE commitment.budget_id = $1
      ORDER BY commitment.created_at, commitment.id`,
    [budgetId],
  );
  return result.rows;
}

export const operationalVarianceRepository = {
  commitmentTrace,
  invoiceActuals,
  ledgerByCategory,
  legacyCommitments,
  materialActuals,
};
