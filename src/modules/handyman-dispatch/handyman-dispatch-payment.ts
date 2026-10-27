import type { PoolClient } from 'pg';

/**
 * Read the approved version's required DP against the existing customer ledger.
 * Planning an assignment does not call this gate. Finance's existing payment
 * facts are authoritative only when CONFIRMED and not reversed; as in the
 * Finance reconciliation projection, refunds reduce the DP received. There is
 * no payment creation, settlement, or inference from a Care statement here.
 *
 * The caller already holds the scope lock. Lock the ledger transaction before
 * reading its facts: payment and correction writers serialize on this same row.
 * This prevents a concurrent refund/reversal from racing release or start.
 */
export async function hasRequiredDispatchPayment(
  tx: PoolClient,
  scope: { id: string; clientId: string },
): Promise<boolean> {
  const terms = (await tx.query<{
    id: string; dp_required: boolean; dp_amount: string | null;
  }>(
    `SELECT v.id, v.dp_required, v.dp_amount::text AS dp_amount
       FROM handyman_execution_scopes s
       JOIN handyman_quotation_versions v
         ON v.id = s.approved_quotation_version_id AND v.quotation_id = s.quotation_id
      WHERE s.id = $1 AND s.client_id = $2 AND v.status = 'APPROVED'`,
    [scope.id, scope.clientId],
  )).rows[0];
  if (!terms) return false;
  if (!terms.dp_required) return true;
  // A required but unspecified amount has no trusted threshold; fail closed.
  if (terms.dp_amount === null) return false;

  const ledger = (await tx.query<{
    id: string; client_id: string; quotation_version_id: string; currency: string;
  }>(
    `SELECT id, client_id, quotation_version_id, currency
       FROM handyman_customer_transactions
      WHERE execution_scope_id = $1 FOR UPDATE`,
    [scope.id],
  )).rows[0];
  if (!ledger || ledger.client_id !== scope.clientId || ledger.quotation_version_id !== terms.id) return false;

  const result = await tx.query<{ satisfied: boolean }>(
    `SELECT $2::numeric > 0
            AND EXISTS (SELECT 1 FROM handyman_quotation_lines l WHERE l.quotation_version_id = $5)
            AND NOT EXISTS (SELECT 1 FROM handyman_quotation_lines l
                             WHERE l.quotation_version_id = $5 AND l.currency <> $4)
            AND COALESCE(SUM(
              p.amount - COALESCE((
                SELECT SUM(c.amount) FROM handyman_ledger_corrections c
                 WHERE c.transaction_id = p.transaction_id
                   AND c.source_payment_id = p.id AND c.correction_kind = 'REFUND'
              ), 0)
            ), 0) >= $2::numeric AS satisfied
       FROM handyman_customer_payments p
      WHERE p.transaction_id = $1 AND p.client_id = $3 AND p.currency = $4
        AND p.obligation_stage = 'DP' AND p.status = 'CONFIRMED'
        AND NOT EXISTS (
          SELECT 1 FROM handyman_ledger_corrections c
           WHERE c.transaction_id = p.transaction_id
             AND c.source_payment_id = p.id AND c.correction_kind = 'REVERSAL'
        )`,
    [ledger.id, terms.dp_amount, scope.clientId, ledger.currency, terms.id],
  );
  return result.rows[0]?.satisfied === true;
}
