import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/** PART 02's only SQL writer: CR-HM-14 facts. CR-HM-13 is locked, never
 * mutated or read for financial values (those come from PART 06 reads).
 */
export type FactKind = 'PROVIDER' | 'BM_FEE';
export type FactInput = {
  clientId: string; transactionId: string; executionScopeId: string;
  currency: string; ledgerPostedAt: string; kind: FactKind;
  chargedNet: string; laborNet: string; materialNet: string;
  adjustedTransactionScope: string; amount: string;
  assignmentId?: string; providerContextId?: string; crewId?: string;
  leadWorkerId?: string; leadUserId?: string;
  agreementId?: string; agreementVersionId?: string;
  versionNumber?: number; effectiveFrom?: string; effectiveTo?: string | null;
  ruleId?: string; termId?: string; ratePercent?: string;
  beneficiaryId?: string; beneficiaryReferenceId?: string;
  idempotencyKey: string; actorUserId: string;
};

export type FactRow = {
  id: string; client_id: string; transaction_id: string;
  execution_scope_id: string; currency: string; ledger_posted_at: Date;
  ledger_contract_version: string; entitlement_kind: FactKind;
  charged_net: string; labor_net: string; material_net: string;
  adjusted_transaction_scope: string; amount: string;
  assignment_id: string | null; provider_context_id: string | null;
  crew_id: string | null; lead_worker_id: string | null; lead_user_id: string | null;
  agreement_id: string | null; agreement_version_id: string | null;
  agreement_version_number: number | null; agreement_effective_from: Date | null;
  agreement_effective_to: Date | null; bm_rule_id: string | null;
  bm_term_id: string | null; bm_term_rate_percent: string | null;
  bm_beneficiary_id: string | null; bm_beneficiary_reference_id: string | null;
  idempotency_key: string; derived_by_user_id: string; derived_at: Date;
};

export async function lockEntitlementTransaction(tx: PoolClient, scopeId: string) {
  // Assignment and ledger-open commands lock scope first. Hold it
  // through both INSERTs, then lock the transaction to serialize
  // against charge/correction writers (which lock the ledger row).
  await tx.query('SELECT id FROM handyman_execution_scopes WHERE id = $1 FOR UPDATE',
    [scopeId]);
  const r = await tx.query<{ id: string }>(
    `SELECT id FROM handyman_customer_transactions
      WHERE execution_scope_id = $1 FOR UPDATE`, [scopeId]);
  return r.rows[0]?.id ?? null;
}

export async function readAttribution(tx: PoolClient, scopeId: string) {
  const [assignments, sessions] = await Promise.all([
    tx.query<{ id: string; handyman_provider_context_id: string }>(
      `SELECT id, handyman_provider_context_id
         FROM handyman_execution_scope_assignments
        WHERE execution_scope_id = $1`, [scopeId]),
    tx.query<{ assignment_id: string; lead_worker_id: string }>(
      `SELECT assignment_id, lead_worker_id
         FROM handyman_work_sessions
        WHERE execution_scope_id = $1`, [scopeId]),
  ]);
  return { assignments: assignments.rows, sessions: sessions.rows };
}

export async function findFact(tx: PoolClient, transactionId: string, kind: FactKind) {
  const r = await tx.query<FactRow>(
    `SELECT * FROM handyman_entitlement_facts
      WHERE transaction_id = $1 AND entitlement_kind = $2`,
    [transactionId, kind]);
  return r.rows[0] ?? null;
}

export async function findByKey(tx: PoolClient, key: string) {
  const r = await tx.query<FactRow>(
    `SELECT * FROM handyman_entitlement_facts WHERE idempotency_key = $1`, [key]);
  return r.rows[0] ?? null;
}

export type CorrectionRow = {
  id: string; entitlement_id: string; ledger_correction_id: string;
  fact_kind: 'ADJUSTED_INCREASE' | 'ADJUSTED_DECREASE' | 'REVERSED';
  amount: string; idempotency_key: string; actor_user_id: string;
};
export async function listCorrections(tx: PoolClient, entitlementId: string) {
  const r = await tx.query<CorrectionRow>(
    `SELECT * FROM handyman_entitlement_corrections WHERE entitlement_id=$1
      ORDER BY occurred_at, id`, [entitlementId]);
  return r.rows;
}
export async function findCorrectionKey(tx: PoolClient, key: string) {
  const r = await tx.query<CorrectionRow>(
    `SELECT * FROM handyman_entitlement_corrections WHERE idempotency_key=$1`, [key]);
  return r.rows[0] ?? null;
}
export async function insertCorrection(tx: PoolClient, x: {
  entitlementId: string; ledgerCorrectionId: string;
  kind: CorrectionRow['fact_kind']; amount: string;
  key: string; actorUserId: string;
}): Promise<CorrectionRow> {
  const r = await tx.query<CorrectionRow>(`
    INSERT INTO handyman_entitlement_corrections
    (id, entitlement_id, ledger_correction_id, fact_kind, amount,
     idempotency_key, actor_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [randomUUID(), x.entitlementId, x.ledgerCorrectionId, x.kind,
      x.amount, x.key, x.actorUserId]);
  return r.rows[0];
}

export async function insertFact(tx: PoolClient, x: FactInput): Promise<FactRow> {
  const r = await tx.query<FactRow>(`
    INSERT INTO handyman_entitlement_facts (
      id, client_id, transaction_id, execution_scope_id, currency,
      ledger_posted_at, ledger_contract_version, entitlement_kind, fact_state,
      basis_kind, charged_net, labor_net, material_net, adjusted_transaction_scope,
      amount, assignment_id, provider_context_id, crew_id, lead_worker_id,
      lead_user_id, agreement_id, agreement_version_id, agreement_version_number,
      agreement_effective_from, agreement_effective_to, bm_rule_id, bm_term_id,
      bm_term_rate_percent, bm_beneficiary_id, bm_beneficiary_reference_id,
      idempotency_key, derived_by_user_id
    ) VALUES (
      $1,$2,$3,$4,$5,$6,'CR-HM-13-PART-06',$7,'EARNED',$8,$9,$10,$11,$12,
      $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30
    ) RETURNING *`, [
    randomUUID(), x.clientId, x.transactionId, x.executionScopeId, x.currency,
    x.ledgerPostedAt, x.kind,
    x.kind === 'PROVIDER' ? 'TRANSACTION_NET_CHARGED' : 'LABOR_ONLY',
    x.chargedNet, x.laborNet, x.materialNet, x.adjustedTransactionScope,
    x.amount, x.assignmentId ?? null, x.providerContextId ?? null,
    x.crewId ?? null, x.leadWorkerId ?? null, x.leadUserId ?? null,
    x.agreementId ?? null, x.agreementVersionId ?? null,
    x.versionNumber ?? null, x.effectiveFrom ?? null, x.effectiveTo ?? null,
    x.ruleId ?? null, x.termId ?? null, x.ratePercent ?? null,
    x.beneficiaryId ?? null, x.beneficiaryReferenceId ?? null,
    x.idempotencyKey, x.actorUserId,
  ]);
  return r.rows[0];
}
