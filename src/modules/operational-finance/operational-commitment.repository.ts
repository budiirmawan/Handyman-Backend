import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  OperationalCommitmentEntryRecord,
  OperationalCommitmentEntryType,
  OperationalCommitmentFilters,
  OperationalCommitmentRecord,
  OperationalCommitmentStatus,
} from './operational-commitment.types';

/**
 * CR-BE-COMM-VAR-01 PART 02 — Operational Commitment persistence.
 *
 * Every function accepts an executor so the service can run the whole
 * decision (budget lock → recheck → write → audit event) in ONE transaction.
 * All money arithmetic and every comparison happen in SQL `NUMERIC`; amounts
 * leave this layer as strings so no JavaScript float can ever enter a
 * financial decision.
 */

type Executor = Pick<PoolClient, 'query'>;

const COMMITMENT_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  budget_id AS "budgetId",
  budget_category_id AS "budgetCategoryId",
  origin,
  source_type AS "sourceType",
  purchase_order_id AS "purchaseOrderId",
  purchase_order_line_id AS "purchaseOrderLineId",
  work_order_id AS "workOrderId",
  vendor_id AS "vendorId",
  material_request_id AS "materialRequestId",
  currency,
  committed_amount::text AS "committedAmount",
  actualized_amount::text AS "actualizedAmount",
  released_amount::text AS "releasedAmount",
  open_amount::text AS "openAmount",
  status,
  title,
  reason,
  overspend_override_reason AS "overspendOverrideReason",
  overspend_override_by_user_id AS "overspendOverrideByUserId",
  overspend_override_at AS "overspendOverrideAt",
  idempotency_key AS "idempotencyKey",
  created_by_user_id AS "createdByUserId",
  closed_at AS "closedAt",
  closed_by_user_id AS "closedByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const ENTRY_SELECT = `
  id,
  commitment_id AS "commitmentId",
  entry_type AS "entryType",
  signed_amount::text AS "signedAmount",
  currency,
  source_binding_id AS "sourceBindingId",
  idempotency_key AS "idempotencyKey",
  reason,
  actor_user_id AS "actorUserId",
  request_id AS "requestId",
  occurred_at AS "occurredAt",
  created_at AS "createdAt"
`;

/**
 * CR-BE-COMM-VAR-01 PART 03 — costed Work Order material usages inside the
 * budget's Building, period and currency that are NOT (yet) represented by a
 * commitment actualization.
 *
 * These are real incurred cost with no preceding obligation, so they must
 * consume budget. The already-actualized portion of a usage is subtracted, so
 * a partially matched usage contributes only its uncommitted remainder and can
 * never be counted twice against its commitment.
 *
 * It is a BUDGET-scope term only: an unmatched usage carries no cost category,
 * and inventing one would violate the explicit-category rule.
 */
const UNCOMMITTED_MATERIAL_ACTUAL_SQL = `
  SELECT COALESCE(SUM(GREATEST(usage.total_cost - COALESCE(linked.actualized, 0), 0)), 0)
           AS amount
    FROM inventory_work_order_material_usages usage
    JOIN operational_budgets budget ON budget.id = $1
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(-entry.signed_amount), 0) AS actualized
        FROM operational_commitment_entries entry
        JOIN operational_budget_source_bindings binding
          ON binding.id = entry.source_binding_id
       WHERE entry.entry_type = 'ACTUALIZE'
         AND binding.work_order_material_usage_id = usage.id
    ) linked ON TRUE
   WHERE usage.building_id = budget.building_id
     AND usage.unit_cost IS NOT NULL
     AND usage.currency = budget.currency
     AND usage.used_at::date BETWEEN budget.period_start AND budget.period_end
`;

/**
 * CR-BE-COMM-VAR-01 PART 04 — verified vendor invoices inside the budget's
 * Building, period and currency that are not (yet) represented by a commitment
 * actualization. Only FINALIZED + VERIFIED invoices are authoritative actual;
 * DRAFT, DISCREPANCY and CANCELLED invoices never consume budget.
 *
 * As with the material term, the already-actualized portion is subtracted, and
 * it is a BUDGET-scope term only because an unmatched invoice carries no cost
 * category.
 */
const UNCOMMITTED_VENDOR_INVOICE_ACTUAL_SQL = `
  SELECT COALESCE(SUM(GREATEST(invoice.invoice_amount - COALESCE(linked.actualized, 0), 0)), 0)
           AS amount
    FROM vendor_invoices invoice
    JOIN operational_budgets budget ON budget.id = $1
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(-entry.signed_amount), 0) AS actualized
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

/**
 * CR-BE-COMM-VAR-01 PART 05 — eligible pre-ledger commitment contributions.
 *
 * A CR-BE-FIN-01 `PO_LINE` / `PURCHASE_ORDER` binding still consumes budget
 * while no ledger commitment represents the same Purchase Order. Including it
 * here keeps the write-time gate and the read model on ONE consumption
 * definition, so what the variance report shows is exactly what the overspend
 * check enforced.
 */
const LEGACY_COMMITMENT_CONSUMPTION_SQL = `
  SELECT COALESCE(SUM(
           CASE
             WHEN binding.source_type = 'PO_LINE' THEN line.line_amount
             WHEN binding.source_type = 'PURCHASE_ORDER' AND totals.line_count = 1
               THEN totals.total_amount
             ELSE 0
           END
         ), 0) AS amount,
         binding.budget_category_id AS budget_category_id
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
   WHERE binding.status = 'ACTIVE'
     AND binding.source_type IN ('PO_LINE', 'PURCHASE_ORDER')
     AND po.status = 'ISSUED'
     AND po.currency = (SELECT currency FROM operational_budgets WHERE id = $1)
     AND NOT EXISTS (
       SELECT 1
         FROM operational_commitments commitment
         LEFT JOIN purchase_order_lines commitment_line
           ON commitment_line.id = commitment.purchase_order_line_id
        WHERE commitment.status <> 'CANCELLED'
          AND (
            commitment.purchase_order_id = po.id
            OR commitment_line.purchase_order_id = po.id
          )
     )
   GROUP BY binding.budget_category_id
`;

/** Locked budget state. The row lock is the serialization point for spend. */
export type LockedBudgetForCommitment = {
  id: string;
  clientId: string;
  buildingId: string;
  currency: string;
  status: string;
  overspendPolicy: 'STRICT' | 'ALLOW_WITH_OVERRIDE';
  plannedAmount: string;
};

async function lockBudgetForCommitment(
  executor: Executor,
  budgetId: string,
): Promise<LockedBudgetForCommitment | null> {
  const result = await executor.query<LockedBudgetForCommitment>(
    `SELECT id,
            client_id AS "clientId",
            building_id AS "buildingId",
            currency,
            status,
            overspend_policy AS "overspendPolicy",
            planned_amount::text AS "plannedAmount"
       FROM operational_budgets
      WHERE id = $1
      FOR UPDATE`,
    [budgetId],
  );
  return result.rows[0] ?? null;
}

export type ConsumptionProbe = {
  budgetPlannedAmount: string;
  budgetConsumedAmount: string;
  budgetAvailableAmount: string;
  categoryPlannedAmount: string;
  categoryConsumedAmount: string;
  categoryAvailableAmount: string;
  budgetAllowed: boolean;
  categoryAllowed: boolean;
};

/**
 * Reads budget and category consumption INSIDE the caller's transaction, after
 * the budget row lock has been taken.
 *
 * Consumed = SUM(committed_amount - released_amount) over every non-cancelled
 * commitment. Actualization deliberately does NOT reduce consumption: moving
 * value from open to actualized must never free budget, otherwise the same
 * obligation could be spent twice. This is the no-double-counting foundation
 * PART 03+ builds on.
 */
async function probeConsumption(
  executor: Executor,
  budgetId: string,
  budgetCategoryId: string,
  requestedAmount: string,
  excludeCommitmentId: string | null,
): Promise<ConsumptionProbe> {
  const result = await executor.query<ConsumptionProbe>(
    `WITH budget AS (
       SELECT planned_amount FROM operational_budgets WHERE id = $1
     ),
     category AS (
       SELECT planned_amount FROM operational_budget_categories WHERE id = $2
     ),
     budget_consumed AS (
       SELECT COALESCE(SUM(committed_amount - released_amount), 0) AS amount
         FROM operational_commitments
        WHERE budget_id = $1
          AND status <> 'CANCELLED'
          AND ($4::uuid IS NULL OR id <> $4::uuid)
     ),
     category_consumed AS (
       SELECT COALESCE(SUM(committed_amount - released_amount), 0) AS amount
         FROM operational_commitments
        WHERE budget_category_id = $2
          AND status <> 'CANCELLED'
          AND ($4::uuid IS NULL OR id <> $4::uuid)
     ),
     uncommitted_material AS (${UNCOMMITTED_MATERIAL_ACTUAL_SQL}),
     uncommitted_invoice AS (${UNCOMMITTED_VENDOR_INVOICE_ACTUAL_SQL}),
     legacy_by_category AS (${LEGACY_COMMITMENT_CONSUMPTION_SQL}),
     legacy_budget AS (
       SELECT COALESCE(SUM(amount), 0) AS amount
         FROM legacy_by_category
        WHERE budget_category_id IN (
          SELECT id FROM operational_budget_categories WHERE budget_id = $1
        )
     ),
     legacy_category AS (
       SELECT COALESCE(SUM(amount), 0) AS amount
         FROM legacy_by_category
        WHERE budget_category_id = $2
     )
     SELECT budget.planned_amount::numeric(18,2)::text AS "budgetPlannedAmount",
            (budget_consumed.amount + uncommitted_material.amount
              + uncommitted_invoice.amount + legacy_budget.amount)::numeric(18,2)::text
              AS "budgetConsumedAmount",
            (budget.planned_amount - budget_consumed.amount
              - uncommitted_material.amount
              - uncommitted_invoice.amount
              - legacy_budget.amount)::numeric(18,2)::text
              AS "budgetAvailableAmount",
            category.planned_amount::numeric(18,2)::text AS "categoryPlannedAmount",
            (category_consumed.amount + legacy_category.amount)::numeric(18,2)::text
              AS "categoryConsumedAmount",
            (category.planned_amount - category_consumed.amount
              - legacy_category.amount)::numeric(18,2)::text
              AS "categoryAvailableAmount",
            (budget.planned_amount - budget_consumed.amount
              - uncommitted_material.amount
              - uncommitted_invoice.amount
              - legacy_budget.amount >= $3::numeric)
              AS "budgetAllowed",
            (category.planned_amount - category_consumed.amount
              - legacy_category.amount >= $3::numeric)
              AS "categoryAllowed"
       FROM budget, category, budget_consumed, category_consumed,
            uncommitted_material, uncommitted_invoice,
            legacy_budget, legacy_category`,
    [budgetId, budgetCategoryId, requestedAmount, excludeCommitmentId],
  );
  return result.rows[0];
}

async function findCategory(
  executor: Executor,
  categoryId: string,
): Promise<{ id: string; budgetId: string } | null> {
  const result = await executor.query<{ id: string; budgetId: string }>(
    `SELECT id, budget_id AS "budgetId"
       FROM operational_budget_categories
      WHERE id = $1`,
    [categoryId],
  );
  return result.rows[0] ?? null;
}

async function findById(
  id: string,
  executor: Executor = getPool(),
): Promise<OperationalCommitmentRecord | null> {
  const result = await executor.query<OperationalCommitmentRecord>(
    `SELECT ${COMMITMENT_SELECT} FROM operational_commitments WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Locks the commitment row itself; the budget row must already be locked. */
async function lockCommitment(
  executor: Executor,
  id: string,
): Promise<OperationalCommitmentRecord | null> {
  const result = await executor.query<OperationalCommitmentRecord>(
    `SELECT ${COMMITMENT_SELECT} FROM operational_commitments
      WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByIdempotencyKey(
  executor: Executor,
  budgetId: string,
  idempotencyKey: string,
): Promise<OperationalCommitmentRecord | null> {
  const result = await executor.query<OperationalCommitmentRecord>(
    `SELECT ${COMMITMENT_SELECT} FROM operational_commitments
      WHERE budget_id = $1 AND idempotency_key = $2`,
    [budgetId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function findEntryByIdempotencyKey(
  executor: Executor,
  commitmentId: string,
  idempotencyKey: string,
): Promise<OperationalCommitmentEntryRecord | null> {
  const result = await executor.query<OperationalCommitmentEntryRecord>(
    `SELECT ${ENTRY_SELECT} FROM operational_commitment_entries
      WHERE commitment_id = $1 AND idempotency_key = $2`,
    [commitmentId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function listCommitments(
  budgetId: string,
  filters: OperationalCommitmentFilters,
  executor: Executor = getPool(),
): Promise<OperationalCommitmentRecord[]> {
  const values: unknown[] = [budgetId];
  const clauses = ['budget_id = $1'];

  if (filters.budgetCategoryId !== undefined) {
    values.push(filters.budgetCategoryId);
    clauses.push(`budget_category_id = $${values.length}`);
  }
  if (filters.status !== undefined) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }
  if (filters.origin !== undefined) {
    values.push(filters.origin);
    clauses.push(`origin = $${values.length}`);
  }
  if (filters.workOrderId !== undefined) {
    values.push(filters.workOrderId);
    clauses.push(`work_order_id = $${values.length}`);
  }
  if (filters.vendorId !== undefined) {
    values.push(filters.vendorId);
    clauses.push(`vendor_id = $${values.length}`);
  }

  const result = await executor.query<OperationalCommitmentRecord>(
    `SELECT ${COMMITMENT_SELECT} FROM operational_commitments
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id`,
    values,
  );
  return result.rows;
}

async function listEntries(
  commitmentId: string,
  executor: Executor = getPool(),
): Promise<OperationalCommitmentEntryRecord[]> {
  const result = await executor.query<OperationalCommitmentEntryRecord>(
    `SELECT ${ENTRY_SELECT} FROM operational_commitment_entries
      WHERE commitment_id = $1
      ORDER BY occurred_at, created_at, id`,
    [commitmentId],
  );
  return result.rows;
}

export type NewCommitmentRow = {
  clientId: string;
  buildingId: string;
  budgetId: string;
  budgetCategoryId: string;
  currency: string;
  /** Exchanged as a fixed 2-decimal string so no float reaches the ledger. */
  amount: string;
  title: string;
  reason: string | null;
  idempotencyKey: string;
  workOrderId: string | null;
  vendorId: string | null;
  materialRequestId: string | null;
  overspendOverrideReason: string | null;
  actorUserId: string;
  /**
   * CR-BE-COMM-VAR-01 PART 03 — typed source origin. `MANUAL` carries no
   * source reference; `PO_LINE` carries the priced, ISSUED Purchase Order
   * line that is the only automatic commitment authority in the repository.
   */
  origin: 'MANUAL' | 'PO_LINE';
  purchaseOrderLineId: string | null;
};

async function insertCommitment(
  executor: Executor,
  input: NewCommitmentRow,
): Promise<OperationalCommitmentRecord> {
  const result = await executor.query<OperationalCommitmentRecord>(
    `INSERT INTO operational_commitments
       (id, client_id, building_id, budget_id, budget_category_id, origin,
        currency, committed_amount, status, title, reason,
        overspend_override_reason, overspend_override_by_user_id,
        overspend_override_at, idempotency_key, created_by_user_id,
        work_order_id, vendor_id, material_request_id,
        source_type, purchase_order_line_id)
     VALUES ($1,$2,$3,$4,$5,$16,$6,$7::numeric,'COMMITTED',$8,$9,
             $10, CASE WHEN $10::text IS NULL THEN NULL ELSE $11::uuid END,
             CASE WHEN $10::text IS NULL THEN NULL ELSE NOW() END,
             $12,$11,$13,$14,$15,
             CASE WHEN $16 = 'PO_LINE' THEN 'PO_LINE' ELSE NULL END,
             $17)
     RETURNING ${COMMITMENT_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.budgetId,
      input.budgetCategoryId,
      input.currency,
      input.amount,
      input.title,
      input.reason,
      input.overspendOverrideReason,
      input.actorUserId,
      input.idempotencyKey,
      input.workOrderId,
      input.vendorId,
      input.materialRequestId,
      input.origin,
      input.purchaseOrderLineId,
    ],
  );
  return result.rows[0];
}

export type NewEntryRow = {
  commitmentId: string;
  entryType: OperationalCommitmentEntryType;
  signedAmount: string;
  currency: string;
  sourceBindingId: string | null;
  idempotencyKey: string;
  reason: string | null;
  actorUserId: string;
  requestId: string | null;
};

async function insertEntry(
  executor: Executor,
  input: NewEntryRow,
): Promise<OperationalCommitmentEntryRecord> {
  const result = await executor.query<OperationalCommitmentEntryRecord>(
    `INSERT INTO operational_commitment_entries
       (id, commitment_id, entry_type, signed_amount, currency,
        source_binding_id, idempotency_key, reason, actor_user_id, request_id)
     VALUES ($1,$2,$3,$4::numeric,$5,$6,$7,$8,$9,$10)
     RETURNING ${ENTRY_SELECT}`,
    [
      randomUUID(),
      input.commitmentId,
      input.entryType,
      input.signedAmount,
      input.currency,
      input.sourceBindingId,
      input.idempotencyKey,
      input.reason,
      input.actorUserId,
      input.requestId,
    ],
  );
  return result.rows[0];
}

/**
 * Applies a signed amount delta to the header. `status` is always recomputed
 * from the resulting amounts so it can never drift from the ledger, and the
 * database CHECK constraints reject any inconsistent combination.
 */
async function applyAmounts(
  executor: Executor,
  commitmentId: string,
  delta: {
    committedDelta?: string;
    actualizedDelta?: string;
    releasedDelta?: string;
  },
  closure: { closedByUserId: string | null; reopen?: boolean },
): Promise<OperationalCommitmentRecord> {
  const result = await executor.query<OperationalCommitmentRecord>(
    `UPDATE operational_commitments AS c
        SET committed_amount = c.committed_amount + $2::numeric,
            actualized_amount = c.actualized_amount + $3::numeric,
            released_amount = c.released_amount + $4::numeric,
            status = CASE
              WHEN c.released_amount + $4::numeric > 0 THEN 'RELEASED'
              WHEN c.actualized_amount + $3::numeric = 0
                   AND c.committed_amount + $2::numeric = 0 THEN 'CANCELLED'
              WHEN c.actualized_amount + $3::numeric = 0 THEN 'COMMITTED'
              WHEN c.actualized_amount + $3::numeric
                   = c.committed_amount + $2::numeric THEN 'ACTUALIZED'
              ELSE 'PARTIALLY_ACTUALIZED'
            END,
            closed_at = CASE
              WHEN $6::boolean THEN NULL
              WHEN $5::uuid IS NULL THEN c.closed_at
              ELSE NOW()
            END,
            closed_by_user_id = CASE
              WHEN $6::boolean THEN NULL
              ELSE COALESCE($5::uuid, c.closed_by_user_id)
            END,
            updated_at = NOW()
      WHERE c.id = $1
      RETURNING ${COMMITMENT_SELECT}`,
    [
      commitmentId,
      delta.committedDelta ?? '0',
      delta.actualizedDelta ?? '0',
      delta.releasedDelta ?? '0',
      closure.closedByUserId,
      closure.reopen ?? false,
    ],
  );
  return result.rows[0];
}

/**
 * Cancellation withdraws the whole obligation. `committed_amount > 0` is a
 * table invariant, so cancellation keeps the amount and flips the status
 * rather than zeroing the row — the ledger keeps the full history.
 */
async function markCancelled(
  executor: Executor,
  commitmentId: string,
  actorUserId: string,
): Promise<OperationalCommitmentRecord> {
  const result = await executor.query<OperationalCommitmentRecord>(
    `UPDATE operational_commitments
        SET status = 'CANCELLED',
            closed_at = NOW(),
            closed_by_user_id = $2,
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${COMMITMENT_SELECT}`,
    [commitmentId, actorUserId],
  );
  return result.rows[0];
}

async function statusOf(
  executor: Executor,
  commitmentId: string,
): Promise<OperationalCommitmentStatus | null> {
  const result = await executor.query<{ status: OperationalCommitmentStatus }>(
    'SELECT status FROM operational_commitments WHERE id = $1',
    [commitmentId],
  );
  return result.rows[0]?.status ?? null;
}

export type MaterialCommitmentCandidate = {
  id: string;
  budgetId: string;
  budgetCategoryId: string;
  clientId: string;
  buildingId: string;
  currency: string;
  openAmount: string;
  status: string;
};

/**
 * CR-BE-COMM-VAR-01 PART 03 — the governed material mapping:
 *
 *   usage.material_request_id -> purchase_order_lines.material_request_id
 *                             -> the live commitment raised on that PO line
 *
 * Only open commitments in the same Building are candidates. Rows are locked
 * so a concurrent actualization of the same commitment serializes behind this
 * one. More than one row is an ambiguity the caller must fail closed on — this
 * function never guesses.
 */
async function findMaterialCommitmentCandidates(
  executor: Executor,
  materialRequestId: string,
  buildingId: string,
  sourceDate: string,
): Promise<MaterialCommitmentCandidate[]> {
  const result = await executor.query<MaterialCommitmentCandidate>(
    `SELECT commitment.id,
            commitment.budget_id AS "budgetId",
            commitment.budget_category_id AS "budgetCategoryId",
            commitment.client_id AS "clientId",
            commitment.building_id AS "buildingId",
            commitment.currency,
            commitment.open_amount::text AS "openAmount",
            commitment.status
       FROM operational_commitments commitment
       JOIN purchase_order_lines line
         ON line.id = commitment.purchase_order_line_id
       JOIN operational_budgets budget
         ON budget.id = commitment.budget_id
      WHERE line.material_request_id = $1
        AND commitment.building_id = $2
        AND commitment.status IN ('COMMITTED', 'PARTIALLY_ACTUALIZED')
        -- BR-A1: a transaction may only actualize a budget whose period
        -- contains its governing date.
        AND $3::date BETWEEN budget.period_start AND budget.period_end
      ORDER BY commitment.created_at, commitment.id
      FOR UPDATE OF commitment`,
    [materialRequestId, buildingId, sourceDate],
  );
  return result.rows;
}

export type IssuedPurchaseOrderLine = {
  id: string;
  purchaseOrderId: string;
  clientId: string;
  buildingId: string;
  vendorId: string;
  materialRequestId: string | null;
  serviceRequestId: string | null;
  currency: string;
  lineAmount: string;
  description: string;
  purchaseOrderStatus: string;
};

async function findIssuedPurchaseOrderLine(
  executor: Executor,
  purchaseOrderLineId: string,
): Promise<IssuedPurchaseOrderLine | null> {
  const result = await executor.query<IssuedPurchaseOrderLine>(
    `SELECT line.id,
            line.purchase_order_id AS "purchaseOrderId",
            line.client_id AS "clientId",
            line.building_id AS "buildingId",
            po.vendor_id AS "vendorId",
            line.material_request_id AS "materialRequestId",
            line.service_request_id AS "serviceRequestId",
            po.currency,
            line.line_amount::text AS "lineAmount",
            line.description,
            po.status AS "purchaseOrderStatus"
       FROM purchase_order_lines line
       JOIN purchase_orders po ON po.id = line.purchase_order_id
      WHERE line.id = $1`,
    [purchaseOrderLineId],
  );
  return result.rows[0] ?? null;
}

/**
 * A Purchase Order (or one of its lines) that is already represented by a
 * legacy CR-BE-FIN-01 source binding must not also enter the ledger: the read
 * model would then count the same obligation twice.
 */
async function hasLegacyPurchaseOrderBinding(
  executor: Executor,
  purchaseOrderId: string,
  purchaseOrderLineId: string,
): Promise<boolean> {
  const result = await executor.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM operational_budget_source_bindings
        WHERE status = 'ACTIVE'
          AND (
            (source_type = 'PO_LINE' AND purchase_order_line_id = $2)
            OR (source_type = 'PURCHASE_ORDER' AND purchase_order_id = $1)
          )
     ) AS exists`,
    [purchaseOrderId, purchaseOrderLineId],
  );
  return result.rows[0]?.exists ?? false;
}

/**
 * Returns the ACTIVE lineage row for a Work Order material usage, creating it
 * when absent. The existing CR-BE-FIN-01 partial unique index guarantees one
 * active binding per usage, so traceability is preserved without duplicating
 * an authoritative source.
 */
async function ensureMaterialUsageBinding(
  executor: Executor,
  input: {
    budgetId: string;
    budgetCategoryId: string;
    clientId: string;
    buildingId: string;
    workOrderMaterialUsageId: string;
    createdByUserId: string;
  },
): Promise<{ id: string; budgetCategoryId: string }> {
  const existing = await executor.query<{ id: string; budgetCategoryId: string }>(
    `SELECT id, budget_category_id AS "budgetCategoryId"
       FROM operational_budget_source_bindings
      WHERE source_type = 'WORK_ORDER_MATERIAL'
        AND work_order_material_usage_id = $1
        AND status = 'ACTIVE'`,
    [input.workOrderMaterialUsageId],
  );
  if (existing.rows[0]) return existing.rows[0];

  const created = await executor.query<{ id: string; budgetCategoryId: string }>(
    `INSERT INTO operational_budget_source_bindings
       (id, budget_id, budget_category_id, client_id, building_id, source_type,
        work_order_material_usage_id, currency_status, status, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,'WORK_ORDER_MATERIAL',$6,'MATCHED','ACTIVE',$7)
     RETURNING id, budget_category_id AS "budgetCategoryId"`,
    [
      randomUUID(),
      input.budgetId,
      input.budgetCategoryId,
      input.clientId,
      input.buildingId,
      input.workOrderMaterialUsageId,
      input.createdByUserId,
    ],
  );
  return created.rows[0];
}

export type VendorCommitmentCandidate = MaterialCommitmentCandidate;

/**
 * CR-BE-COMM-VAR-01 PART 04 — deterministic invoice -> commitment mapping.
 *
 * Primary lineage is the invoice's own Purchase Order (`0274`). When it is
 * absent the existing BE-17H `work_order_procurement_bindings` lineage is used
 * to reach the ISSUED Purchase Orders raised for the same request. Only open
 * commitments raised on those Purchase Orders' lines are candidates, and they
 * are locked so a concurrent actualization serializes behind this one.
 *
 * More than one candidate is an ambiguity the caller must fail closed on.
 */
async function findVendorInvoiceCommitmentCandidates(
  executor: Executor,
  invoice: {
    id: string;
    buildingId: string;
    purchaseOrderId: string | null;
    workOrderId: string | null;
    invoiceDate: string;
  },
): Promise<VendorCommitmentCandidate[]> {
  const result = await executor.query<VendorCommitmentCandidate>(
    `WITH lineage_purchase_orders AS (
       SELECT po.id
         FROM purchase_orders po
        WHERE po.status = 'ISSUED'
          AND (
            po.id = $2::uuid
            OR (
              $2::uuid IS NULL
              AND $3::uuid IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM work_order_procurement_bindings binding
                 WHERE binding.work_order_id = $3::uuid
                   AND (
                     po.purchase_request_id = binding.purchase_request_id
                     OR po.service_request_id = binding.service_request_id
                   )
              )
            )
          )
     )
     SELECT commitment.id,
            commitment.budget_id AS "budgetId",
            commitment.budget_category_id AS "budgetCategoryId",
            commitment.client_id AS "clientId",
            commitment.building_id AS "buildingId",
            commitment.currency,
            commitment.open_amount::text AS "openAmount",
            commitment.status
       FROM operational_commitments commitment
       LEFT JOIN purchase_order_lines line
         ON line.id = commitment.purchase_order_line_id
       JOIN operational_budgets budget
         ON budget.id = commitment.budget_id
      WHERE commitment.building_id = $1
        AND commitment.status IN ('COMMITTED', 'PARTIALLY_ACTUALIZED')
        -- BR-A1: the invoice date must fall inside the budget period.
        AND $4::date BETWEEN budget.period_start AND budget.period_end
        AND (
          line.purchase_order_id IN (SELECT id FROM lineage_purchase_orders)
          OR commitment.purchase_order_id IN (SELECT id FROM lineage_purchase_orders)
        )
      ORDER BY commitment.created_at, commitment.id
      FOR UPDATE OF commitment`,
    [
      invoice.buildingId,
      invoice.purchaseOrderId,
      invoice.workOrderId,
      invoice.invoiceDate,
    ],
  );
  return result.rows;
}

async function ensureVendorInvoiceBinding(
  executor: Executor,
  input: {
    budgetId: string;
    budgetCategoryId: string;
    clientId: string;
    buildingId: string;
    vendorInvoiceId: string;
    createdByUserId: string;
  },
): Promise<{ id: string; budgetCategoryId: string }> {
  const existing = await executor.query<{ id: string; budgetCategoryId: string }>(
    `SELECT id, budget_category_id AS "budgetCategoryId"
       FROM operational_budget_source_bindings
      WHERE source_type = 'VENDOR_INVOICE'
        AND vendor_invoice_id = $1
        AND status = 'ACTIVE'`,
    [input.vendorInvoiceId],
  );
  if (existing.rows[0]) return existing.rows[0];

  const created = await executor.query<{ id: string; budgetCategoryId: string }>(
    `INSERT INTO operational_budget_source_bindings
       (id, budget_id, budget_category_id, client_id, building_id, source_type,
        vendor_invoice_id, currency_status, status, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,'VENDOR_INVOICE',$6,'MATCHED','ACTIVE',$7)
     RETURNING id, budget_category_id AS "budgetCategoryId"`,
    [
      randomUUID(),
      input.budgetId,
      input.budgetCategoryId,
      input.clientId,
      input.buildingId,
      input.vendorInvoiceId,
      input.createdByUserId,
    ],
  );
  return created.rows[0];
}

/** Marks a lineage row removed; the history stays queryable. */
async function removeSourceBinding(
  executor: Executor,
  bindingId: string,
  actorUserId: string,
): Promise<void> {
  await executor.query(
    `UPDATE operational_budget_source_bindings
        SET status = 'REMOVED',
            removed_by_user_id = $2,
            removed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'`,
    [bindingId, actorUserId],
  );
}

/**
 * The still-effective actualized amount contributed by one lineage row:
 * ACTUALIZE entries minus any ACTUALIZE_REVERSAL already applied to it.
 */
async function actualizedAmountForBinding(
  executor: Executor,
  commitmentId: string,
  sourceBindingId: string,
): Promise<string> {
  const result = await executor.query<{ amount: string }>(
    `SELECT COALESCE(SUM(-signed_amount), 0)::numeric(18,2)::text AS amount
       FROM operational_commitment_entries
      WHERE commitment_id = $1
        AND source_binding_id = $2
        AND entry_type IN ('ACTUALIZE', 'ACTUALIZE_REVERSAL')`,
    [commitmentId, sourceBindingId],
  );
  return result.rows[0]?.amount ?? '0.00';
}

async function findActiveBindingForVendorInvoice(
  executor: Executor,
  vendorInvoiceId: string,
): Promise<{ id: string; budgetId: string } | null> {
  const result = await executor.query<{ id: string; budgetId: string }>(
    `SELECT id, budget_id AS "budgetId"
       FROM operational_budget_source_bindings
      WHERE source_type = 'VENDOR_INVOICE'
        AND vendor_invoice_id = $1
        AND status = 'ACTIVE'`,
    [vendorInvoiceId],
  );
  return result.rows[0] ?? null;
}

async function findCommitmentForBinding(
  executor: Executor,
  sourceBindingId: string,
): Promise<{ commitmentId: string } | null> {
  const result = await executor.query<{ commitmentId: string }>(
    `SELECT DISTINCT commitment_id AS "commitmentId"
       FROM operational_commitment_entries
      WHERE source_binding_id = $1 AND entry_type = 'ACTUALIZE'`,
    [sourceBindingId],
  );
  return result.rows.length === 1 ? result.rows[0] : null;
}

export const operationalCommitmentRepository = {
  actualizedAmountForBinding,
  ensureMaterialUsageBinding,
  ensureVendorInvoiceBinding,
  findActiveBindingForVendorInvoice,
  findCommitmentForBinding,
  findVendorInvoiceCommitmentCandidates,
  removeSourceBinding,
  findIssuedPurchaseOrderLine,
  findMaterialCommitmentCandidates,
  hasLegacyPurchaseOrderBinding,
  applyAmounts,
  findById,
  findByIdempotencyKey,
  findCategory,
  findEntryByIdempotencyKey,
  insertCommitment,
  insertEntry,
  listCommitments,
  listEntries,
  lockBudgetForCommitment,
  lockCommitment,
  markCancelled,
  probeConsumption,
  statusOf,
};
