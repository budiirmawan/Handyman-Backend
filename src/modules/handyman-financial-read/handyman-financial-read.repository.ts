import { getPool } from '../../database';

/** CR-HM-14 PART 04. Exactly ONE SELECT over CR-HM-14-owned facts,
 * executed through the shared pool. No ledger SQL, transaction handle,
 * writer import, mutation statement or second financial authority.
 * One PostgreSQL statement supplies a consistent snapshot of the entire
 * fact family. NUMERIC amounts are cast to TEXT before JSON encoding:
 * JavaScript numbers never represent monetary facts.
 */
export type RawFinancialFactSet = {
  transaction_id: string;
  entitlements: Record<string, unknown>[];
  corrections: Record<string, unknown>[];
  unit: Record<string, unknown> | null;
  events: Record<string, unknown>[];
  inclusions: Record<string, unknown>[];
  reconciliations: Record<string, unknown>[];
  exceptions: Record<string, unknown>[];
};

export async function readFinancialFactSets(
  transactionIds: readonly string[],
): Promise<RawFinancialFactSet[]> {
  if (transactionIds.length === 0) return [];
  const result = await getPool().query<RawFinancialFactSet>(`
    SELECT wanted.transaction_id,
      COALESCE((
        SELECT jsonb_agg(to_jsonb(f) ORDER BY f.derived_at, f.id)
          FROM (
            SELECT e.id, e.client_id, e.transaction_id, e.execution_scope_id,
                   e.currency, e.ledger_posted_at, e.ledger_contract_version,
                   e.entitlement_kind, e.fact_state, e.basis_kind,
                   e.charged_net::text AS charged_net,
                   e.labor_net::text AS labor_net,
                   e.material_net::text AS material_net,
                   e.adjusted_transaction_scope::text AS adjusted_transaction_scope,
                   e.amount::text AS amount,
                   e.assignment_id, e.provider_context_id, e.crew_id,
                   e.lead_worker_id, e.lead_user_id,
                   e.agreement_id, e.agreement_version_id,
                   e.agreement_version_number, e.agreement_effective_from,
                   e.agreement_effective_to, e.bm_rule_id, e.bm_term_id,
                   e.bm_term_rate_percent::text AS bm_term_rate_percent,
                   e.bm_beneficiary_id, e.bm_beneficiary_reference_id,
                   e.derived_by_user_id, e.derived_at
              FROM handyman_entitlement_facts e
             WHERE e.transaction_id = wanted.transaction_id
          ) f
      ), '[]'::jsonb) AS entitlements,
      COALESCE((
        SELECT jsonb_agg(to_jsonb(c) ORDER BY c.occurred_at, c.id)
          FROM (
            SELECT f.transaction_id, x.id, x.entitlement_id,
                   x.ledger_correction_id, x.fact_kind,
                   x.amount::text AS amount, x.actor_user_id, x.occurred_at
              FROM handyman_entitlement_corrections x
              JOIN handyman_entitlement_facts f ON f.id = x.entitlement_id
             WHERE f.transaction_id = wanted.transaction_id
          ) c
      ), '[]'::jsonb) AS corrections,
      CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id',u.id,'client_id',u.client_id,'transaction_id',u.transaction_id,
        'execution_scope_id',u.execution_scope_id,'currency',u.currency,
        'actor_user_id',u.actor_user_id,'created_at',u.created_at)
      END AS unit,
      COALESCE((
        SELECT jsonb_agg(to_jsonb(ev) ORDER BY ev.occurred_at, ev.id)
          FROM (
            SELECT x.id, x.unit_id, x.state, x.reconciliation_id,
                   x.actor_user_id, x.occurred_at
              FROM handyman_settlement_events x WHERE x.unit_id=u.id
          ) ev
      ), '[]'::jsonb) AS events,
      COALESCE((
        SELECT jsonb_agg(to_jsonb(inc) ORDER BY inc.entitlement_id)
          FROM (
            SELECT x.id, x.unit_id, x.entitlement_id,
                   x.amount::text AS amount, x.actor_user_id, x.occurred_at
              FROM handyman_settlement_inclusions x WHERE x.unit_id=u.id
          ) inc
      ), '[]'::jsonb) AS inclusions,
      COALESCE((
        SELECT jsonb_agg(to_jsonb(r) ORDER BY r.reconciliation_seq)
          FROM (
            SELECT x.id, x.unit_id,
                   x.reconciliation_seq::text AS reconciliation_seq,
                   x.ledger_contract_version, x.window_from, x.window_to,
                   x.currency, x.ledger_charged_net::text AS ledger_charged_net,
                   x.ledger_applied::text AS ledger_applied,
                   x.ledger_net_received::text AS ledger_net_received,
                   x.entitlement_total::text AS entitlement_total,
                   x.included_total::text AS included_total,
                   x.outcome, x.variance_cause,
                   x.variance_amount::text AS variance_amount,
                   x.actor_user_id, x.occurred_at
              FROM handyman_settlement_reconciliations x WHERE x.unit_id=u.id
          ) r
      ), '[]'::jsonb) AS reconciliations,
      COALESCE((
        SELECT jsonb_agg(to_jsonb(ex) ORDER BY ex.occurred_at, ex.id)
          FROM (
            SELECT x.id, x.unit_id, x.exception_kind,
                   x.ledger_correction_id, x.amount::text AS amount,
                   x.actor_user_id, x.occurred_at
              FROM handyman_settlement_exceptions x WHERE x.unit_id=u.id
          ) ex
      ), '[]'::jsonb) AS exceptions
    FROM unnest($1::uuid[]) AS wanted(transaction_id)
    LEFT JOIN handyman_settlement_units u ON u.transaction_id=wanted.transaction_id
    ORDER BY wanted.transaction_id
  `, [transactionIds]);
  return result.rows;
}
