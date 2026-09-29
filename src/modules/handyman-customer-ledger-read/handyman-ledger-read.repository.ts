import { getPool } from '../../database';

/**
 * CR-HM-13 PART 06 — read-only repository.
 *
 * STRUCTURALLY WRITE-INCAPABLE (§13 row 06, B12): every function here
 * issues EXACTLY ONE `SELECT` through the shared pool. There is no
 * `INSERT`, `UPDATE`, `DELETE`, DDL, transaction handle, or command
 * import in this file — the read contract can never become a second
 * write path, and no caller-supplied value can reach a mutation verb.
 *
 * Each read is a single statement: the composition is assembled by
 * PostgreSQL (one snapshot) and only DECORATED in the service layer
 * (exact integer-cent arithmetic), never re-derived from partial
 * snapshots.
 */

type Row = Record<string, unknown>;

export type RawLedgerTransactionRead = {
  transaction: Row | null;
  charge_lines: Row[];
  payments: Row[];
  allocations: Row[];
  corrections: Row[];
};

export type RawClientBasisRow = Row;

/** Allocations of the ledger, each flagged if a reversal negates it. */
const ALLOCATION_LATERAL = `
  SELECT a.id, a.payment_id, a.charge_line_id, a.line_kind, a.currency,
         a.amount, a.occurred_at,
         EXISTS (
           SELECT 1 FROM handyman_ledger_corrections c
            WHERE c.correction_kind = 'REVERSAL'
              AND c.source_allocation_id = a.id
         ) AS reversed
    FROM handyman_payment_allocations a
   WHERE a.transaction_id = (
     SELECT id FROM handyman_customer_transactions
      WHERE execution_scope_id = $1)`;

async function readTransactionByScope(
  executionScopeId: string,
): Promise<RawLedgerTransactionRead> {
  const result = await getPool().query(
    `SELECT
       (
         SELECT json_build_object(
           'transactionId', t.id,
           'clientId', t.client_id,
           'executionScopeId', t.execution_scope_id,
           'quotationVersionId', t.quotation_version_id,
           'currency', t.currency,
           'createdAt', t.created_at)
           FROM handyman_customer_transactions t
          WHERE t.execution_scope_id = $1
       ) AS transaction,
       COALESCE((
         SELECT json_agg(json_build_object(
           'chargeLineId', l.id,
           'quotationLineId', l.quotation_line_id,
           'lineKind', l.line_kind,
           'compositionKind', b.composition_kind,
           'basisFactKind', b.basis_fact_kind,
           'currency', l.currency,
           'amount', l.amount::numeric(18, 2)::text,
           'adjusted', COALESCE(adj.adjusted, 0)::numeric(18, 2)::text,
           'allocated', COALESCE(al.allocated, 0)::numeric(18, 2)::text,
           'reversedAllocations',
             COALESCE(al.reversed, 0)::numeric(18, 2)::text,
           'createdAt', l.created_at) ORDER BY l.created_at, l.id)
           FROM handyman_charge_lines l
           LEFT JOIN handyman_charge_line_bases b
             ON b.charge_line_id = l.id
           LEFT JOIN (
             SELECT a.charge_line_id,
                    SUM(a.amount) AS allocated,
                    COALESCE(SUM(a.amount) FILTER (
                      WHERE r.allocation_id IS NOT NULL), 0) AS reversed
               FROM handyman_payment_allocations a
               LEFT JOIN (
                 SELECT source_allocation_id AS allocation_id
                   FROM handyman_ledger_corrections
                  WHERE correction_kind = 'REVERSAL'
                    AND source_allocation_id IS NOT NULL
               ) r ON r.allocation_id = a.id
              GROUP BY a.charge_line_id
           ) al ON al.charge_line_id = l.id
           LEFT JOIN (
             SELECT source_charge_line_id AS charge_line_id,
                    SUM(amount) AS adjusted
               FROM handyman_ledger_corrections
              WHERE correction_kind = 'ADJUSTMENT'
                AND source_charge_line_id IS NOT NULL
              GROUP BY source_charge_line_id
           ) adj ON adj.charge_line_id = l.id
          WHERE l.transaction_id = (
            SELECT id FROM handyman_customer_transactions
             WHERE execution_scope_id = $1)
       ), '[]'::json) AS charge_lines,
       COALESCE((
         SELECT json_agg(json_build_object(
           'paymentId', p.id,
           'status', p.status,
           'channel', p.channel,
           'currency', p.currency,
           'amount', p.amount::numeric(18, 2)::text,
           'receivedAt', p.received_at,
           'allocated', COALESCE(al.allocated, 0)::numeric(18, 2)::text,
           'reversedAllocations',
             COALESCE(al.reversed, 0)::numeric(18, 2)::text,
           'refunded', COALESCE(rf.refunded, 0)::numeric(18, 2)::text,
           'reversedPayment',
             COALESCE(rv.reversed_payment, 0)::numeric(18, 2)::text)
           ORDER BY p.received_at, p.id)
           FROM handyman_customer_payments p
           LEFT JOIN (
             SELECT a.payment_id,
                    SUM(a.amount) AS allocated,
                    COALESCE(SUM(a.amount) FILTER (
                      WHERE r.allocation_id IS NOT NULL), 0) AS reversed
               FROM handyman_payment_allocations a
               LEFT JOIN (
                 SELECT source_allocation_id AS allocation_id
                   FROM handyman_ledger_corrections
                  WHERE correction_kind = 'REVERSAL'
                    AND source_allocation_id IS NOT NULL
               ) r ON r.allocation_id = a.id
              GROUP BY a.payment_id
           ) al ON al.payment_id = p.id
           LEFT JOIN (
             SELECT source_payment_id AS payment_id, SUM(amount) AS refunded
               FROM handyman_ledger_corrections
              WHERE correction_kind = 'REFUND'
                AND source_payment_id IS NOT NULL
              GROUP BY source_payment_id
           ) rf ON rf.payment_id = p.id
           LEFT JOIN (
             SELECT source_payment_id AS payment_id,
                    SUM(amount) AS reversed_payment
               FROM handyman_ledger_corrections
              WHERE correction_kind = 'REVERSAL'
                AND source_payment_id IS NOT NULL
              GROUP BY source_payment_id
           ) rv ON rv.payment_id = p.id
          WHERE p.transaction_id = (
            SELECT id FROM handyman_customer_transactions
             WHERE execution_scope_id = $1)
       ), '[]'::json) AS payments,
       COALESCE((
         SELECT json_agg(json_build_object(
           'allocationId', x.id,
           'paymentId', x.payment_id,
           'chargeLineId', x.charge_line_id,
           'lineKind', x.line_kind,
           'currency', x.currency,
           'amount', x.amount::numeric(18, 2)::text,
           'occurredAt', x.occurred_at,
           'reversed', x.reversed) ORDER BY x.occurred_at, x.id)
           FROM (${ALLOCATION_LATERAL}) x
       ), '[]'::json) AS allocations,
       COALESCE((
         SELECT json_agg(json_build_object(
           'correctionId', c.id,
           'correctionKind', c.correction_kind,
           'sourceKind', c.source_kind,
           'sourcePaymentId', c.source_payment_id,
           'sourceAllocationId', c.source_allocation_id,
           'sourceChargeLineId', c.source_charge_line_id,
           'currency', c.currency,
           'amount', c.amount::numeric(18, 2)::text,
           'reason', c.reason,
           'correctedByUserId', c.corrected_by_user_id,
           'occurredAt', c.occurred_at) ORDER BY c.occurred_at, c.id)
           FROM handyman_ledger_corrections c
          WHERE c.transaction_id = (
            SELECT id FROM handyman_customer_transactions
             WHERE execution_scope_id = $1)
       ), '[]'::json) AS corrections`,
    [executionScopeId],
  );
  const row = result.rows[0] as RawLedgerTransactionRead;
  return {
    transaction: row.transaction ?? null,
    charge_lines: row.charge_lines ?? [],
    payments: row.payments ?? [],
    allocations: row.allocations ?? [],
    corrections: row.corrections ?? [],
  };
}

/**
 * Client-level net basis, one row per ledger transaction in the
 * (optional) [from, to) window — aggregated in SQL with exact NUMERIC
 * arithmetic and mapped to cents in the service.
 */
async function readClientBasisRows(
  clientId: string,
  from: string | null,
  to: string | null,
  limit: number,
): Promise<RawClientBasisRow[]> {
  const result = await getPool().query(
    `WITH tx AS (
       SELECT t.id, t.execution_scope_id, t.currency, t.created_at
         FROM handyman_customer_transactions t
        WHERE t.client_id = $1
          AND ($2::timestamptz IS NULL OR t.created_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR t.created_at < $3::timestamptz)
        ORDER BY t.created_at ASC, t.id ASC
        LIMIT $4::int
     ),
     line_roll AS (
       SELECT l.transaction_id,
              SUM(l.amount) AS charged_gross,
              COALESCE(SUM(l.amount) FILTER (
                WHERE l.line_kind = 'LABOR'), 0) AS labor_gross,
              COALESCE(SUM(l.amount) FILTER (
                WHERE l.line_kind = 'MATERIAL'), 0) AS material_gross
         FROM handyman_charge_lines l
        WHERE l.transaction_id IN (SELECT id FROM tx)
        GROUP BY l.transaction_id
     ),
     adjust_roll AS (
       SELECT c.transaction_id,
              SUM(c.amount) AS adjusted,
              COUNT(*) AS adjustment_count
         FROM handyman_ledger_corrections c
        WHERE c.correction_kind = 'ADJUSTMENT'
          AND c.transaction_id IN (SELECT id FROM tx)
        GROUP BY c.transaction_id
     ),
     line_adjust_roll AS (
       SELECT c.transaction_id, l.line_kind, SUM(c.amount) AS adjusted
         FROM handyman_ledger_corrections c
         JOIN handyman_charge_lines l ON l.id = c.source_charge_line_id
        WHERE c.correction_kind = 'ADJUSTMENT'
          AND c.transaction_id IN (SELECT id FROM tx)
        GROUP BY c.transaction_id, l.line_kind
     ),
     alloc_roll AS (
       SELECT a.transaction_id,
              SUM(a.amount) AS allocated,
              COALESCE(SUM(a.amount) FILTER (
                WHERE r.allocation_id IS NOT NULL), 0) AS reversed
         FROM handyman_payment_allocations a
         LEFT JOIN (
           SELECT source_allocation_id AS allocation_id
             FROM handyman_ledger_corrections
            WHERE correction_kind = 'REVERSAL'
              AND source_allocation_id IS NOT NULL
         ) r ON r.allocation_id = a.id
        WHERE a.transaction_id IN (SELECT id FROM tx)
        GROUP BY a.transaction_id
     ),
     pay_roll AS (
       SELECT p.transaction_id,
              COALESCE(SUM(p.amount) FILTER (
                WHERE p.status = 'CONFIRMED'), 0) AS received_gross,
              COUNT(*) FILTER (WHERE p.status = 'PENDING') AS pending_count
         FROM handyman_customer_payments p
        WHERE p.transaction_id IN (SELECT id FROM tx)
        GROUP BY p.transaction_id
     ),
     corr_roll AS (
       SELECT c.transaction_id,
              COALESCE(SUM(c.amount) FILTER (
                WHERE c.correction_kind = 'REFUND'), 0) AS refunded,
              COUNT(*) FILTER (
                WHERE c.correction_kind = 'REFUND') AS refund_count,
              COALESCE(SUM(c.amount) FILTER (
                WHERE c.correction_kind = 'REVERSAL'
                  AND c.source_payment_id IS NOT NULL), 0)
                AS reversed_payments,
              COUNT(*) FILTER (
                WHERE c.correction_kind = 'REVERSAL'
                  AND c.source_payment_id IS NOT NULL) AS payment_reversals,
              COUNT(*) FILTER (
                WHERE c.correction_kind = 'REVERSAL'
                  AND c.source_allocation_id IS NOT NULL)
                AS allocation_reversals,
              COALESCE(SUM(c.amount) FILTER (
                WHERE c.correction_kind = 'REVERSAL'), 0)
                AS reversed_total
         FROM handyman_ledger_corrections c
        WHERE c.transaction_id IN (SELECT id FROM tx)
        GROUP BY c.transaction_id
     )
     SELECT t.id AS transaction_id,
            t.execution_scope_id,
            t.currency,
            t.created_at,
            COALESCE(lr.charged_gross, 0)::numeric(18, 2)::text
              AS charged_gross,
            COALESCE(lr.labor_gross, 0)::numeric(18, 2)::text
              AS labor_gross,
            COALESCE(lr.material_gross, 0)::numeric(18, 2)::text
              AS material_gross,
            COALESCE(ladj.adjusted, 0)::numeric(18, 2)::text
              AS labor_adjusted,
            COALESCE(madj.adjusted, 0)::numeric(18, 2)::text
              AS material_adjusted,
            COALESCE(ar.adjusted, 0)::numeric(18, 2)::text AS adjusted,
            COALESCE(ar.adjustment_count, 0)::int AS adjustment_count,
            COALESCE(al.allocated, 0)::numeric(18, 2)::text AS allocated,
            COALESCE(al.reversed, 0)::numeric(18, 2)::text
              AS reversed_allocations,
            COALESCE(pr.received_gross, 0)::numeric(18, 2)::text
              AS received_gross,
            COALESCE(pr.pending_count, 0)::int AS pending_payments,
            COALESCE(cr.refunded, 0)::numeric(18, 2)::text AS refunded,
            COALESCE(cr.refund_count, 0)::int AS refund_count,
            COALESCE(cr.reversed_payments, 0)::numeric(18, 2)::text
              AS reversed_payments,
            COALESCE(cr.payment_reversals, 0)::int AS payment_reversals,
            COALESCE(cr.allocation_reversals, 0)::int
              AS allocation_reversals
       FROM tx t
       LEFT JOIN line_roll lr ON lr.transaction_id = t.id
       LEFT JOIN adjust_roll ar ON ar.transaction_id = t.id
       LEFT JOIN line_adjust_roll ladj
         ON ladj.transaction_id = t.id AND ladj.line_kind = 'LABOR'
       LEFT JOIN line_adjust_roll madj
         ON madj.transaction_id = t.id AND madj.line_kind = 'MATERIAL'
       LEFT JOIN alloc_roll al ON al.transaction_id = t.id
       LEFT JOIN pay_roll pr ON pr.transaction_id = t.id
       LEFT JOIN corr_roll cr ON cr.transaction_id = t.id
      ORDER BY t.created_at ASC, t.id ASC`,
    [clientId, from, to, limit],
  );
  return result.rows as RawClientBasisRow[];
}

async function clientExists(clientId: string): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM clients WHERE id = $1`,
    [clientId],
  );
  return result.rows.length > 0;
}

export const handymanLedgerReadRepository = {
  readTransactionByScope,
  readClientBasisRows,
  clientExists,
};
