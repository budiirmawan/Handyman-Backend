import type { PoolClient } from 'pg';
import { getPool } from '../../database/connection';
import type {
  HandymanFinanceActionInboxBlockerCode,
  HandymanFinanceActionInboxCategory,
  HandymanFinanceActionInboxCounts,
  HandymanFinanceActionInboxItem,
  HandymanFinanceActionInboxQuery,
  HandymanFinanceActionInboxRecordStatus,
  HandymanFinanceActionInboxRecordType,
  HandymanFinanceActionInboxResponsibleAction,
  HandymanFinanceActionInboxResponsiblePermission,
} from './handyman-finance-action-inbox.types';

/**
 * CR-HM-FIN-DISCOVERY-02 P0-B — Authoritative Finance Action Inbox repository.
 *
 * Queries ONLY existing authoritative financial tables:
 *  1. `handyman_customer_payments` (`PENDING` awaiting Finance verification;
 *     `CONFIRMED` non-reversed payments with `unallocatedAmount > 0`).
 *  2. `handyman_ledger_corrections` (`REFUND | REVERSAL | ADJUSTMENT` awaiting
 *     downstream entitlement correction or settlement exception propagation).
 *  3. `handyman_settlement_units` (`PAYABLE`, `INCLUDED_IN_SETTLEMENT`, or
 *     units blocked by reconciliation `VARIANCE` / `OPEN_EXCEPTION`).
 *  4. `handyman_customer_transactions` (`LEDGER_ONLY` transactions with
 *     `NO_POSTED_CHARGE_FACTS`).
 *
 * Every branch enforces BE-02G exact Building scope inside the SQL statement
 * (`user_building_assignments` ACTIVE + `buildings` ACTIVE + `properties`
 * ACTIVE + `clients` ACTIVE + `users` ACTIVE) before filtering, counting, or
 * paginating.
 */

type RawFinanceInboxRow = {
  recordId: string;
  recordType: HandymanFinanceActionInboxRecordType;
  recordStatus: HandymanFinanceActionInboxRecordStatus;
  actionCategory: HandymanFinanceActionInboxCategory;
  blockerCode: HandymanFinanceActionInboxBlockerCode | null;
  executionScopeId: string;
  handymanRequestId: string;
  transactionId: string;
  clientId: string;
  buildingId: string;
  tenantCompanyId: string;
  currency: string;
  amount: string;
  allocatedAmount: string | null;
  unallocatedAmount: string | null;
  allocationState: 'UNALLOCATED' | 'PARTIALLY_ALLOCATED' | null;
  responsiblePermission: HandymanFinanceActionInboxResponsiblePermission;
  responsibleAction: HandymanFinanceActionInboxResponsibleAction;
  paymentId: string | null;
  paymentStatus: 'PENDING' | 'CONFIRMED' | null;
  paymentChannel: string | null;
  paymentReference: string | null;
  recordedByUserId: string | null;
  paymentProofEvidenceId: string | null;
  ledgerCorrectionId: string | null;
  correctionKind: 'REFUND' | 'REVERSAL' | 'ADJUSTMENT' | null;
  correctionSourceKind:
    | 'PAYMENT'
    | 'ALLOCATION'
    | 'CHARGE_LINE'
    | 'TRANSACTION'
    | null;
  entitlementCorrectionPending: boolean;
  settlementCorrectionPending: boolean;
  settlementUnitId: string | null;
  settlementState: 'PAYABLE' | 'INCLUDED_IN_SETTLEMENT' | 'SETTLED' | null;
  reconciliationId: string | null;
  reconciliationOutcome: 'MATCHED' | 'VARIANCE' | null;
  varianceCause:
    | 'NONE'
    | 'INCLUSION_MISMATCH'
    | 'LEDGER_BASIS_MISMATCH'
    | 'FUNDING_SHORTFALL'
    | 'OPEN_EXCEPTION'
    | null;
  varianceAmount: string | null;
  openExceptionCount: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function financeBuildingReadScope(alias: string, actorParam: number): string {
  const actor = `$${actorParam}::uuid`;
  return `EXISTS (
    SELECT 1 FROM user_building_assignments uba
      JOIN buildings b ON b.id = uba.building_id AND b.status = 'ACTIVE'
      JOIN properties p ON p.id = b.property_id AND p.status = 'ACTIVE'
      JOIN clients c ON c.id = p.client_id AND c.status = 'ACTIVE'
      JOIN users u ON u.id = uba.user_id AND u.status = 'ACTIVE'
    WHERE uba.user_id = ${actor} AND uba.status = 'ACTIVE'
      AND b.id = ${alias}.building_id AND c.id = ${alias}.client_id
  )`;
}

function buildDiscoveryCte(): string {
  const scopeGuard = financeBuildingReadScope('es', 2);
  return `
    WITH payment_alloc_roll AS (
      SELECT a.payment_id,
             COALESCE(SUM(a.amount), 0)::numeric(18, 2) AS allocated_gross,
             COALESCE(SUM(a.amount) FILTER (
               WHERE r.allocation_id IS NOT NULL
             ), 0)::numeric(18, 2) AS reversed_allocated
        FROM handyman_payment_allocations a
        LEFT JOIN (
          SELECT source_allocation_id AS allocation_id
            FROM handyman_ledger_corrections
           WHERE correction_kind = 'REVERSAL'
             AND source_kind = 'ALLOCATION'
             AND source_allocation_id IS NOT NULL
        ) r ON r.allocation_id = a.id
       WHERE a.client_id = $1::uuid
       GROUP BY a.payment_id
    ),
    tx_charge_counts AS (
      SELECT cl.transaction_id,
             COUNT(*)::int AS charge_line_count
        FROM handyman_charge_lines cl
       WHERE cl.client_id = $1::uuid
       GROUP BY cl.transaction_id
    ),
    action_items AS (
      /* Branch 1: Customer-reported payments awaiting Finance verification (PENDING)
         and confirmed, non-reversed payments with unallocated balance > 0 (CONFIRMED). */
      SELECT
        p.id AS record_id,
        'CUSTOMER_PAYMENT'::text AS record_type,
        p.status::text AS record_status,
        CASE
          WHEN p.status = 'PENDING' THEN 'PAYMENT_VERIFICATION'
          ELSE 'PAYMENT_ALLOCATION'
        END AS action_category,
        CASE
          WHEN p.status = 'PENDING' THEN 'PROVISIONAL_PAYMENTS_PENDING'
          WHEN COALESCE(tcc.charge_line_count, 0) = 0 THEN 'NO_POSTED_CHARGE_FACTS'
          ELSE NULL
        END AS blocker_code,
        es.id AS execution_scope_id,
        es.handyman_request_id AS handyman_request_id,
        t.id AS transaction_id,
        es.client_id AS client_id,
        es.building_id AS building_id,
        es.tenant_company_id AS tenant_company_id,
        p.currency::text AS currency,
        p.amount::numeric(18, 2)::text AS amount,
        CASE
          WHEN p.status = 'CONFIRMED' THEN
            (COALESCE(par.allocated_gross, 0) - COALESCE(par.reversed_allocated, 0))::numeric(18, 2)::text
          ELSE '0.00'
        END AS allocated_amount,
        CASE
          WHEN p.status = 'CONFIRMED' THEN
            (p.amount - (COALESCE(par.allocated_gross, 0) - COALESCE(par.reversed_allocated, 0)))::numeric(18, 2)::text
          ELSE '0.00'
        END AS unallocated_amount,
        CASE
          WHEN p.status = 'CONFIRMED' THEN
            CASE
              WHEN (COALESCE(par.allocated_gross, 0) - COALESCE(par.reversed_allocated, 0)) = 0
                THEN 'UNALLOCATED'
              ELSE 'PARTIALLY_ALLOCATED'
            END
          ELSE NULL
        END AS allocation_state,
        'handyman.finance.manage'::text AS responsible_permission,
        CASE
          WHEN p.status = 'PENDING' THEN 'VERIFY_CUSTOMER_PAYMENT'
          ELSE 'ALLOCATE_CUSTOMER_PAYMENT'
        END AS responsible_action,
        p.id AS payment_id,
        p.status::text AS payment_status,
        p.channel::text AS payment_channel,
        COALESCE(p.external_reference, p.provider_reference) AS payment_reference,
        p.recorded_by_user_id AS recorded_by_user_id,
        ev.id AS payment_proof_evidence_id,
        NULL::uuid AS ledger_correction_id,
        NULL::text AS correction_kind,
        NULL::text AS correction_source_kind,
        FALSE AS entitlement_correction_pending,
        FALSE AS settlement_correction_pending,
        NULL::uuid AS settlement_unit_id,
        NULL::text AS settlement_state,
        NULL::uuid AS reconciliation_id,
        NULL::text AS reconciliation_outcome,
        NULL::text AS variance_cause,
        NULL::text AS variance_amount,
        0::int AS open_exception_count,
        p.created_at AS created_at,
        COALESCE(p.decided_at, p.created_at) AS updated_at
      FROM handyman_customer_payments p
      JOIN handyman_customer_transactions t
        ON t.id = p.transaction_id
       AND t.client_id = p.client_id
      JOIN handyman_execution_scopes es
        ON es.id = t.execution_scope_id
       AND es.client_id = t.client_id
      LEFT JOIN payment_alloc_roll par
        ON par.payment_id = p.id
      LEFT JOIN tx_charge_counts tcc
        ON tcc.transaction_id = p.transaction_id
      LEFT JOIN evidence_submissions ev
        ON ev.execution_type = 'HANDYMAN_CUSTOMER_PAYMENT'
       AND ev.execution_id = p.id
      WHERE p.client_id = $1::uuid
        AND ${scopeGuard}
        AND (
          p.status = 'PENDING'
          OR (
            p.status = 'CONFIRMED'
            AND NOT EXISTS (
              SELECT 1
                FROM handyman_ledger_corrections lc_rev
               WHERE lc_rev.source_payment_id = p.id
                 AND lc_rev.correction_kind = 'REVERSAL'
                 AND lc_rev.source_kind = 'PAYMENT'
            )
            AND (p.amount - (COALESCE(par.allocated_gross, 0) - COALESCE(par.reversed_allocated, 0))) > 0
          )
        )

      UNION ALL

      /* Branch 2: Recorded ledger corrections (REFUND / REVERSAL / ADJUSTMENT)
         on transactions with a settlement unit that have not yet been recorded
         via POST /handyman/execution-scopes/:executionScopeId/settlement/correction. */
      SELECT
        lc.id AS record_id,
        'LEDGER_CORRECTION'::text AS record_type,
        lc.correction_kind::text AS record_status,
        'PENDING_CORRECTION'::text AS action_category,
        NULL::text AS blocker_code,
        es.id AS execution_scope_id,
        es.handyman_request_id AS handyman_request_id,
        t.id AS transaction_id,
        es.client_id AS client_id,
        es.building_id AS building_id,
        es.tenant_company_id AS tenant_company_id,
        lc.currency::text AS currency,
        lc.amount::numeric(18, 2)::text AS amount,
        NULL::text AS allocated_amount,
        NULL::text AS unallocated_amount,
        NULL::text AS allocation_state,
        'handyman.settlement.manage'::text AS responsible_permission,
        'RECORD_SETTLEMENT_CORRECTION'::text AS responsible_action,
        lc.source_payment_id AS payment_id,
        NULL::text AS payment_status,
        NULL::text AS payment_channel,
        NULL::text AS payment_reference,
        lc.corrected_by_user_id AS recorded_by_user_id,
        NULL::uuid AS payment_proof_evidence_id,
        lc.id AS ledger_correction_id,
        lc.correction_kind::text AS correction_kind,
        lc.source_kind::text AS correction_source_kind,
        corr_flags.entitlement_pending AS entitlement_correction_pending,
        TRUE AS settlement_correction_pending,
        su_corr.id AS settlement_unit_id,
        NULL::text AS settlement_state,
        NULL::uuid AS reconciliation_id,
        NULL::text AS reconciliation_outcome,
        NULL::text AS variance_cause,
        NULL::text AS variance_amount,
        0::int AS open_exception_count,
        lc.created_at AS created_at,
        lc.occurred_at AS updated_at
      FROM handyman_ledger_corrections lc
      JOIN handyman_customer_transactions t
        ON t.id = lc.transaction_id
       AND t.client_id = lc.client_id
      JOIN handyman_execution_scopes es
        ON es.id = t.execution_scope_id
       AND es.client_id = t.client_id
      JOIN handyman_settlement_units su_corr
        ON su_corr.transaction_id = lc.transaction_id
       AND su_corr.client_id = lc.client_id
      CROSS JOIN LATERAL (
        SELECT
          (
            lc.correction_kind = 'ADJUSTMENT'
            AND NOT EXISTS (
              SELECT 1
                FROM handyman_charge_lines cl_mat
               WHERE cl_mat.id = lc.source_charge_line_id
                 AND cl_mat.line_kind = 'MATERIAL'
            )
            AND EXISTS (
              SELECT 1
                FROM handyman_entitlement_facts ef
               WHERE ef.transaction_id = lc.transaction_id
            )
            AND NOT EXISTS (
              SELECT 1
                FROM handyman_entitlement_corrections ec
               WHERE ec.ledger_correction_id = lc.id
            )
          ) AS entitlement_pending
      ) corr_flags
      WHERE lc.client_id = $1::uuid
        AND ${scopeGuard}
        AND NOT EXISTS (
          SELECT 1
            FROM handyman_settlement_exceptions se_chk
           WHERE se_chk.unit_id = su_corr.id
             AND se_chk.ledger_correction_id = lc.id
        )

      UNION ALL

      /* Branch 3: Settlement units awaiting inclusion/reconciliation/settlement
         or blocked by reconciliation VARIANCE / OPEN_EXCEPTION. */
      SELECT
        su.id AS record_id,
        'SETTLEMENT_UNIT'::text AS record_type,
        COALESCE(latest_ev.state, 'PAYABLE')::text AS record_status,
        CASE
          WHEN latest_recon.outcome = 'VARIANCE' OR COALESCE(ex_roll.ex_count, 0) > 0
            THEN 'FINANCE_BLOCKER'
          ELSE 'PENDING_RECONCILIATION'
        END AS action_category,
        CASE
          WHEN latest_recon.outcome = 'VARIANCE' THEN latest_recon.variance_cause::text
          WHEN COALESCE(ex_roll.ex_count, 0) > 0 THEN 'OPEN_EXCEPTION'
          ELSE NULL
        END AS blocker_code,
        es.id AS execution_scope_id,
        es.handyman_request_id AS handyman_request_id,
        t.id AS transaction_id,
        es.client_id AS client_id,
        es.building_id AS building_id,
        es.tenant_company_id AS tenant_company_id,
        su.currency::text AS currency,
        (
          CASE
            WHEN COALESCE(inc_roll.included_amount, 0) > 0 THEN inc_roll.included_amount
            ELSE COALESCE(ent_roll.earned_amount, 0)
          END
        )::numeric(18, 2)::text AS amount,
        NULL::text AS allocated_amount,
        NULL::text AS unallocated_amount,
        NULL::text AS allocation_state,
        CASE
          WHEN latest_recon.outcome = 'VARIANCE' AND latest_recon.variance_cause = 'FUNDING_SHORTFALL'
            THEN 'handyman.finance.manage'
          ELSE 'handyman.settlement.manage'
        END AS responsible_permission,
        CASE
          WHEN latest_recon.outcome = 'VARIANCE' AND latest_recon.variance_cause = 'FUNDING_SHORTFALL'
            THEN 'RESOLVE_FUNDING_SHORTFALL'
          WHEN latest_recon.outcome = 'VARIANCE'
            THEN 'RESOLVE_SETTLEMENT_VARIANCE'
          WHEN COALESCE(ex_roll.ex_count, 0) > 0
            THEN 'RECONCILE_SETTLEMENT_UNIT'
          WHEN COALESCE(latest_ev.state, 'PAYABLE') = 'PAYABLE'
            THEN 'INCLUDE_IN_SETTLEMENT'
          WHEN latest_recon.id IS NULL OR latest_recon.occurred_at < latest_ev.occurred_at
            THEN 'RECONCILE_SETTLEMENT_UNIT'
          ELSE 'SETTLE_SETTLEMENT_UNIT'
        END AS responsible_action,
        NULL::uuid AS payment_id,
        NULL::text AS payment_status,
        NULL::text AS payment_channel,
        NULL::text AS payment_reference,
        NULL::uuid AS recorded_by_user_id,
        NULL::uuid AS payment_proof_evidence_id,
        NULL::uuid AS ledger_correction_id,
        NULL::text AS correction_kind,
        NULL::text AS correction_source_kind,
        FALSE AS entitlement_correction_pending,
        FALSE AS settlement_correction_pending,
        su.id AS settlement_unit_id,
        COALESCE(latest_ev.state, 'PAYABLE')::text AS settlement_state,
        latest_recon.id AS reconciliation_id,
        latest_recon.outcome::text AS reconciliation_outcome,
        latest_recon.variance_cause::text AS variance_cause,
        CASE
          WHEN latest_recon.variance_amount IS NOT NULL
            THEN latest_recon.variance_amount::numeric(18, 2)::text
          ELSE NULL
        END AS variance_amount,
        COALESCE(ex_roll.ex_count, 0)::int AS open_exception_count,
        su.created_at AS created_at,
        GREATEST(
          su.created_at,
          COALESCE(latest_ev.occurred_at, su.created_at),
          COALESCE(latest_recon.occurred_at, su.created_at),
          COALESCE(ex_roll.latest_ex_at, su.created_at)
        ) AS updated_at
      FROM handyman_settlement_units su
      JOIN handyman_customer_transactions t
        ON t.id = su.transaction_id
       AND t.client_id = su.client_id
      JOIN handyman_execution_scopes es
        ON es.id = su.execution_scope_id
       AND es.client_id = su.client_id
      LEFT JOIN LATERAL (
        SELECT se_ev.state, se_ev.occurred_at
          FROM handyman_settlement_events se_ev
         WHERE se_ev.unit_id = su.id
         ORDER BY se_ev.occurred_at DESC, se_ev.id DESC
         LIMIT 1
      ) latest_ev ON TRUE
      LEFT JOIN LATERAL (
        SELECT sr.id, sr.outcome, sr.variance_cause, sr.variance_amount, sr.occurred_at
          FROM handyman_settlement_reconciliations sr
         WHERE sr.unit_id = su.id
         ORDER BY sr.reconciliation_seq DESC
         LIMIT 1
      ) latest_recon ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS ex_count, MAX(se_ex.occurred_at) AS latest_ex_at
          FROM handyman_settlement_exceptions se_ex
         WHERE se_ex.unit_id = su.id
      ) ex_roll ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(si.amount), 0)::numeric(18, 2) AS included_amount
          FROM handyman_settlement_inclusions si
         WHERE si.unit_id = su.id
      ) inc_roll ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(ef.amount), 0)::numeric(18, 2) AS earned_amount
          FROM handyman_entitlement_facts ef
         WHERE ef.transaction_id = su.transaction_id
      ) ent_roll ON TRUE
      WHERE su.client_id = $1::uuid
        AND ${scopeGuard}
        AND NOT (
          COALESCE(latest_ev.state, 'PAYABLE') = 'SETTLED'
          AND COALESCE(latest_recon.outcome, 'MATCHED') = 'MATCHED'
          AND COALESCE(ex_roll.ex_count, 0) = 0
        )

      UNION ALL

      /* Branch 4: Opened customer transactions blocked by NO_POSTED_CHARGE_FACTS. */
      SELECT
        t.id AS record_id,
        'CUSTOMER_TRANSACTION'::text AS record_type,
        'LEDGER_ONLY'::text AS record_status,
        'FINANCE_BLOCKER'::text AS action_category,
        'NO_POSTED_CHARGE_FACTS'::text AS blocker_code,
        es.id AS execution_scope_id,
        es.handyman_request_id AS handyman_request_id,
        t.id AS transaction_id,
        es.client_id AS client_id,
        es.building_id AS building_id,
        es.tenant_company_id AS tenant_company_id,
        t.currency::text AS currency,
        '0.00'::text AS amount,
        NULL::text AS allocated_amount,
        NULL::text AS unallocated_amount,
        NULL::text AS allocation_state,
        'handyman.finance.manage'::text AS responsible_permission,
        'COMPOSE_CHARGE_LINES'::text AS responsible_action,
        NULL::uuid AS payment_id,
        NULL::text AS payment_status,
        NULL::text AS payment_channel,
        NULL::text AS payment_reference,
        NULL::uuid AS recorded_by_user_id,
        NULL::uuid AS payment_proof_evidence_id,
        NULL::uuid AS ledger_correction_id,
        NULL::text AS correction_kind,
        NULL::text AS correction_source_kind,
        FALSE AS entitlement_correction_pending,
        FALSE AS settlement_correction_pending,
        NULL::uuid AS settlement_unit_id,
        NULL::text AS settlement_state,
        NULL::uuid AS reconciliation_id,
        NULL::text AS reconciliation_outcome,
        NULL::text AS variance_cause,
        NULL::text AS variance_amount,
        0::int AS open_exception_count,
        t.created_at AS created_at,
        t.created_at AS updated_at
      FROM handyman_customer_transactions t
      JOIN handyman_execution_scopes es
        ON es.id = t.execution_scope_id
       AND es.client_id = t.client_id
      LEFT JOIN tx_charge_counts tcc
        ON tcc.transaction_id = t.id
      WHERE t.client_id = $1::uuid
        AND ${scopeGuard}
        AND COALESCE(tcc.charge_line_count, 0) = 0
    )
  `;
}

function buildFilterWhere(
  actorUserId: string,
  query: HandymanFinanceActionInboxQuery,
  includeCursor: boolean,
): { whereSql: string; values: unknown[] } {
  const values: unknown[] = [query.clientId, actorUserId];
  const conditions: string[] = [];

  if (query.buildingId) {
    values.push(query.buildingId);
    conditions.push(`building_id = $${values.length}::uuid`);
  }
  if (query.tenantCompanyId) {
    values.push(query.tenantCompanyId);
    conditions.push(`tenant_company_id = $${values.length}::uuid`);
  }
  if (query.executionScopeId) {
    values.push(query.executionScopeId);
    conditions.push(`execution_scope_id = $${values.length}::uuid`);
  }
  if (query.handymanRequestId) {
    values.push(query.handymanRequestId);
    conditions.push(`handyman_request_id = $${values.length}::uuid`);
  }
  if (query.transactionId) {
    values.push(query.transactionId);
    conditions.push(`transaction_id = $${values.length}::uuid`);
  }
  if (query.recordType) {
    values.push(query.recordType);
    conditions.push(`record_type = $${values.length}`);
  }
  if (query.actionCategory) {
    values.push(query.actionCategory);
    conditions.push(`action_category = $${values.length}`);
  }
  if (query.recordStatus) {
    values.push(query.recordStatus);
    conditions.push(`record_status = $${values.length}`);
  }
  if (query.blockerCode) {
    values.push(query.blockerCode);
    conditions.push(`blocker_code = $${values.length}`);
  }
  if (query.hasBlocker !== undefined) {
    conditions.push(
      query.hasBlocker ? 'blocker_code IS NOT NULL' : 'blocker_code IS NULL',
    );
  }
  if (query.responsiblePermission) {
    values.push(query.responsiblePermission);
    conditions.push(`responsible_permission = $${values.length}`);
  }
  if (query.createdFrom) {
    values.push(query.createdFrom.toISOString());
    conditions.push(`created_at >= $${values.length}::timestamptz`);
  }
  if (query.createdTo) {
    values.push(query.createdTo.toISOString());
    conditions.push(`created_at <= $${values.length}::timestamptz`);
  }
  if (includeCursor && query.cursor) {
    values.push(
      query.cursor.createdAt.toISOString(),
      query.cursor.recordType,
      query.cursor.recordId,
    );
    const cAt = `$${values.length - 2}::timestamptz`;
    const cType = `$${values.length - 1}`;
    const cId = `$${values.length}::uuid`;
    conditions.push(
      `(created_at < ${cAt} OR (created_at = ${cAt} AND (record_type < ${cType} OR (record_type = ${cType} AND record_id < ${cId}))))`,
    );
  }

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: RawFinanceInboxRow): HandymanFinanceActionInboxItem {
  return {
    recordId: row.recordId,
    recordType: row.recordType,
    recordStatus: row.recordStatus,
    actionCategory: row.actionCategory,
    blockerCode: row.blockerCode,
    executionScopeId: row.executionScopeId,
    handymanRequestId: row.handymanRequestId,
    transactionId: row.transactionId,
    clientId: row.clientId,
    buildingId: row.buildingId,
    tenantCompanyId: row.tenantCompanyId,
    currency: row.currency,
    amount: row.amount,
    allocatedAmount: row.allocatedAmount,
    unallocatedAmount: row.unallocatedAmount,
    allocationState: row.allocationState,
    responsible: {
      permission: row.responsiblePermission,
      action: row.responsibleAction,
    },
    provenance: {
      paymentId: row.paymentId,
      paymentStatus: row.paymentStatus,
      paymentChannel: row.paymentChannel,
      paymentReference: row.paymentReference,
      recordedByUserId: row.recordedByUserId,
      paymentProofEvidenceId: row.paymentProofEvidenceId,
      ledgerCorrectionId: row.ledgerCorrectionId,
      correctionKind: row.correctionKind,
      correctionSourceKind: row.correctionSourceKind,
      entitlementCorrectionPending: Boolean(row.entitlementCorrectionPending),
      settlementCorrectionPending: Boolean(row.settlementCorrectionPending),
      settlementUnitId: row.settlementUnitId,
      settlementState: row.settlementState,
      reconciliationId: row.reconciliationId,
      reconciliationOutcome: row.reconciliationOutcome,
      varianceCause: row.varianceCause,
      varianceAmount: row.varianceAmount,
      openExceptionCount: Number(row.openExceptionCount),
    },
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export const handymanFinanceActionInboxRepository = {
  async listItems(
    client: PoolClient | undefined,
    actorUserId: string,
    query: HandymanFinanceActionInboxQuery,
  ): Promise<HandymanFinanceActionInboxItem[]> {
    const executor = client ?? getPool();
    const { whereSql, values } = buildFilterWhere(actorUserId, query, true);
    values.push(query.limit + 1);
    const limitParam = `$${values.length}::int`;

    const result = await executor.query<RawFinanceInboxRow>(
      `${buildDiscoveryCte()}
       SELECT
         record_id AS "recordId",
         record_type AS "recordType",
         record_status AS "recordStatus",
         action_category AS "actionCategory",
         blocker_code AS "blockerCode",
         execution_scope_id AS "executionScopeId",
         handyman_request_id AS "handymanRequestId",
         transaction_id AS "transactionId",
         client_id AS "clientId",
         building_id AS "buildingId",
         tenant_company_id AS "tenantCompanyId",
         currency,
         amount,
         allocated_amount AS "allocatedAmount",
         unallocated_amount AS "unallocatedAmount",
         allocation_state AS "allocationState",
         responsible_permission AS "responsiblePermission",
         responsible_action AS "responsibleAction",
         payment_id AS "paymentId",
         payment_status AS "paymentStatus",
         payment_channel AS "paymentChannel",
         payment_reference AS "paymentReference",
         recorded_by_user_id AS "recordedByUserId",
         payment_proof_evidence_id AS "paymentProofEvidenceId",
         ledger_correction_id AS "ledgerCorrectionId",
         correction_kind AS "correctionKind",
         correction_source_kind AS "correctionSourceKind",
         entitlement_correction_pending AS "entitlementCorrectionPending",
         settlement_correction_pending AS "settlementCorrectionPending",
         settlement_unit_id AS "settlementUnitId",
         settlement_state AS "settlementState",
         reconciliation_id AS "reconciliationId",
         reconciliation_outcome AS "reconciliationOutcome",
         variance_cause AS "varianceCause",
         variance_amount AS "varianceAmount",
         open_exception_count AS "openExceptionCount",
         created_at AS "createdAt",
         updated_at AS "updatedAt"
       FROM action_items
       ${whereSql}
       ORDER BY created_at DESC, record_type DESC, record_id DESC
       LIMIT ${limitParam}`,
      values,
    );

    return result.rows.map(mapRow);
  },

  async countItems(
    client: PoolClient | undefined,
    actorUserId: string,
    query: HandymanFinanceActionInboxQuery,
  ): Promise<HandymanFinanceActionInboxCounts> {
    const executor = client ?? getPool();
    const { whereSql, values } = buildFilterWhere(actorUserId, query, false);

    const result = await executor.query<{
      actionCategory: HandymanFinanceActionInboxCategory;
      recordType: HandymanFinanceActionInboxRecordType;
      recordStatus: HandymanFinanceActionInboxRecordStatus;
      blockerCode: HandymanFinanceActionInboxBlockerCode | null;
      responsiblePermission: HandymanFinanceActionInboxResponsiblePermission;
      count: number;
    }>(
      `${buildDiscoveryCte()}
       SELECT
         action_category AS "actionCategory",
         record_type AS "recordType",
         record_status AS "recordStatus",
         blocker_code AS "blockerCode",
         responsible_permission AS "responsiblePermission",
         COUNT(*)::int AS count
       FROM action_items
       ${whereSql}
       GROUP BY
         action_category,
         record_type,
         record_status,
         blocker_code,
         responsible_permission`,
      values,
    );

    const counts: HandymanFinanceActionInboxCounts = {
      total: 0,
      byActionCategory: {
        PAYMENT_VERIFICATION: 0,
        PAYMENT_ALLOCATION: 0,
        PENDING_CORRECTION: 0,
        PENDING_RECONCILIATION: 0,
        FINANCE_BLOCKER: 0,
      },
      byRecordType: {
        CUSTOMER_PAYMENT: 0,
        LEDGER_CORRECTION: 0,
        SETTLEMENT_UNIT: 0,
        CUSTOMER_TRANSACTION: 0,
      },
      byRecordStatus: {},
      byBlockerCode: {},
      byResponsiblePermission: {
        'handyman.finance.manage': 0,
        'handyman.settlement.manage': 0,
      },
    };

    for (const row of result.rows) {
      counts.total += row.count;
      counts.byActionCategory[row.actionCategory] += row.count;
      counts.byRecordType[row.recordType] += row.count;
      counts.byRecordStatus[row.recordStatus] =
        (counts.byRecordStatus[row.recordStatus] ?? 0) + row.count;
      if (row.blockerCode) {
        counts.byBlockerCode[row.blockerCode] =
          (counts.byBlockerCode[row.blockerCode] ?? 0) + row.count;
      }
      counts.byResponsiblePermission[row.responsiblePermission] += row.count;
    }

    return counts;
  },
};
