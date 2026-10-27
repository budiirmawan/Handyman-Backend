import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { adjustHandymanCustomerLedger } from '../handyman-customer-ledger-corrections';
import { financialId, financialPermission, financialScope } from '../handyman-customer-transactions/handyman-financial-integration-access';
import { assertPinnedVariationApproval } from './handyman-scope-variation-material-authority';
import { handymanScopeVariationRepository } from './handyman-scope-variation.repository';

/** Only references and an optimistic version are accepted from Finance.
 * Amount, target, customer, Building and approval are resolved server-side. */
export type PostReduceFinancialCorrectionInput = {
  executionScopeId: string;
  variationId: string;
  expectedVersion: number;
  idempotencyKey: string;
};

type BindingRow = {
  id: string; client_id: string; building_id: string; execution_scope_id: string;
  transaction_id: string; variation_id: string; variation_version: number;
  approved_variation_version: number; decision_event_id: string; authorization_event_id: string;
  original_quotation_version_id: string; revised_quotation_version_id: string; quotation_line_id: string;
  charge_line_id: string; correction_id: string | null; approved_quantity: string;
  approved_unit_amount: string; currency: string; signed_amount: string; created_by_user_id: string;
  idempotency_key: string; created_at: Date; original_amount: string; corrected_amount: string; transaction_net: string;
};

function conflict(message: string): AppError {
  return new AppError({ code: ERROR_CODES.HANDYMAN_REDUCE_CORRECTION_CONFLICT, statusCode: 409, message });
}

function key(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 128) {
    throw AppError.validation('idempotencyKey must be 1–128 trimmed characters.');
  }
  return value;
}

function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
    throw AppError.validation('expectedVersion must be a positive integer.');
  }
  return value;
}

async function bindingView(tx: PoolClient, id: string) {
  const result = await tx.query<BindingRow>(`SELECT b.*, b.approved_quantity::text AS approved_quantity,
      b.approved_unit_amount::text AS approved_unit_amount, b.signed_amount::text AS signed_amount,
      l.amount::text AS original_amount,
      (l.amount-COALESCE((SELECT sum(c.amount) FROM handyman_ledger_corrections c
        WHERE c.correction_kind='ADJUSTMENT' AND c.source_charge_line_id=l.id),0))::numeric(18,2)::text AS corrected_amount,
      (COALESCE((SELECT sum(cl.amount) FROM handyman_charge_lines cl WHERE cl.transaction_id=b.transaction_id),0)
       -COALESCE((SELECT sum(c.amount) FROM handyman_ledger_corrections c
         WHERE c.transaction_id=b.transaction_id AND c.correction_kind='ADJUSTMENT'),0))::numeric(18,2)::text AS transaction_net
    FROM handyman_reduce_financial_corrections b JOIN handyman_charge_lines l ON l.id=b.charge_line_id
    WHERE b.id=$1`, [id]);
  const b = result.rows[0];
  if (!b) throw conflict('REDUCE financial binding is unavailable.');
  return {
    id: b.id, clientId: b.client_id, buildingId: b.building_id, executionScopeId: b.execution_scope_id,
    transactionId: b.transaction_id, variationId: b.variation_id, variationVersion: b.variation_version,
    approvedVariationVersion: b.approved_variation_version, decisionEventId: b.decision_event_id,
    authorizationEventId: b.authorization_event_id, originalQuotationVersionId: b.original_quotation_version_id,
    revisedQuotationVersionId: b.revised_quotation_version_id, quotationLineId: b.quotation_line_id,
    chargeLineId: b.charge_line_id, correctionId: b.correction_id, approvedQuantity: b.approved_quantity,
    approvedUnitAmount: b.approved_unit_amount, currency: b.currency, signedAmount: b.signed_amount,
    createdByUserId: b.created_by_user_id, idempotencyKey: b.idempotency_key, createdAt: b.created_at.toISOString(),
    // Current projections of canonical charge and correction facts. The
    // signed binding itself is provenance and must never be summed again.
    originalChargeAmount: b.original_amount, correctedChargeAmount: b.corrected_amount,
    transactionChargedNet: b.transaction_net,
  };
}

/**
 * Finance independently posts an authorized REDUCE; Operations or field
 * evidence does not itself post money. The canonical correction service is
 * called in the SAME transaction as the immutable provenance binding.
 */
export async function postReduceFinancialCorrection(actorInput: string, input: PostReduceFinancialCorrectionInput) {
  const actor = financialId(actorInput).toLowerCase();
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(k => !['executionScopeId', 'variationId', 'expectedVersion', 'idempotencyKey'].includes(k))) {
    throw AppError.validation('Only REDUCE references, expectedVersion and idempotencyKey are accepted.');
  }
  const scopeId = financialId(input.executionScopeId).toLowerCase();
  const variationId = financialId(input.variationId).toLowerCase();
  const expectedVersion = version(input.expectedVersion);
  const idempotencyKey = key(input.idempotencyKey);
  await financialPermission(actor);
  try {
    return await withTransaction(async (tx) => {
      // Scope -> existing invoices -> variation -> ledger. This serializes
      // with variation authorization and existing invoice finalization.
      const scope = await financialScope(tx, scopeId, actor, true);
      const invoices = await tx.query<{ status: string }>(
        'SELECT status FROM tenant_invoices WHERE handyman_execution_scope_id=$1 AND client_id=$2 FOR UPDATE',
        [scopeId, scope.client_id],
      );
      const prior = (await tx.query<{ id: string; variation_id: string; variation_version: number;
        idempotency_key: string; created_by_user_id: string }>(`SELECT id,variation_id,variation_version,idempotency_key,created_by_user_id
        FROM handyman_reduce_financial_corrections
        WHERE execution_scope_id=$1 AND (variation_id=$2 OR idempotency_key=$3)`,
      [scopeId, variationId, idempotencyKey])).rows;
      if (prior.length) {
        const b = prior[0];
        if (prior.length !== 1 || b.variation_id !== variationId || b.idempotency_key !== idempotencyKey ||
            b.variation_version !== expectedVersion || b.created_by_user_id !== actor) {
          throw conflict('This variation or idempotency key is already bound to another financial correction.');
        }
        return { replayed: true, binding: await bindingView(tx, b.id) };
      }
      if (invoices.rows.some(i => i.status === 'FINALIZED')) {
        throw conflict('A finalized invoice already exists; an independent governed financial correction is required.');
      }
      const variation = await handymanScopeVariationRepository.findByIdForUpdate(tx, variationId, scopeId);
      if (!variation) throw new AppError({ statusCode: 404, code: ERROR_CODES.HANDYMAN_VARIATION_NOT_FOUND,
        message: 'Handyman scope variation not found.' });
      if (variation.version !== expectedVersion) throw conflict('The variation version is stale; reload the approved variation.');
      if (variation.clientId !== scope.client_id || variation.buildingId !== scope.building_id ||
          variation.handymanRequestId !== scope.handyman_request_id || variation.tenantCompanyId !== scope.tenant_company_id ||
          variation.variationType !== 'REDUCE' || variation.tenantDecisionOutcome !== 'APPROVED' || variation.invoiced ||
          !['AUTHORIZED_SCOPE', 'EXECUTION', 'QC', 'FINAL_CHARGE_ELIGIBILITY'].includes(variation.status) ||
          !variation.targetQuotationLineId || !variation.revisedQuotationVersionId || !variation.currency ||
          variation.quotedUnitAmount === null || variation.quotedTotalDelta === null) {
        throw conflict('An exact, tenant-approved and authorized REDUCE for this Client and Building is required.');
      }
      const events = await handymanScopeVariationRepository.listEventsByVariation(variation.id, tx);
      const decisions = events.filter(e => e.eventType === 'TENANT_DECISION');
      const authorizations = events.filter(e => e.eventType === 'AUTHORIZED_SCOPE');
      const snapshot = decisions[0]?.metadata.consentSnapshot as { version?: unknown } | undefined;
      const approvedVersion = snapshot?.version;
      if (decisions.length !== 1 || authorizations.length !== 1 || typeof approvedVersion !== 'number' ||
          !Number.isSafeInteger(approvedVersion) || approvedVersion < 1 || approvedVersion >= variation.version) {
        throw conflict('An exact version-pinned Tenant approval and Operations authorization are required.');
      }
      await assertPinnedVariationApproval(tx, variation, approvedVersion, events);

      // Lock the canonical ledger before inspecting corrections and allocations.
      // The unique transaction/quotation-line key admits exactly one source.
      const row = (await tx.query<{
        transaction_id: string; charge_line_id: string; magnitude: string;
        terms_match: boolean; line_headroom: boolean; transaction_headroom: boolean;
        ambiguous: boolean;
      }>(`SELECT t.id AS transaction_id,l.id AS charge_line_id,
          abs(v.quoted_total_delta)::numeric(18,2)::text AS magnitude,
          (v.quoted_total_delta<=0 AND round(v.quantity*v.quoted_unit_amount,2)=-v.quoted_total_delta
            AND v.currency=t.currency AND ql.currency=t.currency AND ql.line_type=v.line_type
            AND ql.uom_id=v.uom_id AND l.amount=ql.line_total
            AND revised.quotation_id=s.quotation_id AND revised.version_number>original.version_number
            AND revised.status IN ('ISSUED','APPROVED')) AS terms_match,
          (l.amount-COALESCE((SELECT sum(c.amount) FROM handyman_ledger_corrections c
            WHERE c.correction_kind='ADJUSTMENT' AND c.source_charge_line_id=l.id),0)
            >= abs(v.quoted_total_delta)) AS line_headroom,
          (COALESCE((SELECT sum(cl.amount) FROM handyman_charge_lines cl WHERE cl.transaction_id=t.id),0)
            -COALESCE((SELECT sum(c.amount) FROM handyman_ledger_corrections c
              WHERE c.transaction_id=t.id AND c.correction_kind='ADJUSTMENT'),0)
            >= abs(v.quoted_total_delta)) AS transaction_headroom,
          EXISTS (SELECT 1 FROM handyman_ledger_corrections c WHERE c.transaction_id=t.id
            AND c.correction_kind='ADJUSTMENT' AND (c.source_kind='TRANSACTION' OR c.source_charge_line_id=l.id)
            AND NOT EXISTS (SELECT 1 FROM handyman_reduce_financial_corrections b WHERE b.correction_id=c.id)
            AND NOT EXISTS (SELECT 1 FROM handyman_inspection_fee_credits x
              WHERE x.correction_id=c.id AND x.job_execution_scope_id=s.id)
            AND NOT EXISTS (SELECT 1 FROM handyman_fiscal_withholding_credits x
              JOIN handyman_fiscal_documents f ON f.id=x.document_id
              WHERE x.correction_id=c.id AND f.execution_scope_id=s.id)) AS ambiguous
        FROM handyman_execution_scopes s
        JOIN handyman_scope_variations v ON v.id=$2 AND v.execution_scope_id=s.id
        JOIN handyman_customer_transactions t ON t.execution_scope_id=s.id AND t.client_id=s.client_id
          AND t.quotation_version_id=s.approved_quotation_version_id
        JOIN handyman_quotation_versions original ON original.id=s.approved_quotation_version_id
        JOIN handyman_quotation_versions revised ON revised.id=v.revised_quotation_version_id
        JOIN handyman_quotation_lines ql ON ql.id=v.target_quotation_line_id AND ql.quotation_version_id=original.id
        JOIN handyman_charge_lines l ON l.transaction_id=t.id AND l.quotation_line_id=ql.id AND l.client_id=t.client_id
        WHERE s.id=$1 FOR UPDATE OF t`, [scopeId, variationId])).rows[0];
      if (!row) throw conflict('The exact original quotation line must first be posted as a charge in this ledger.');
      if (!row.terms_match) throw conflict('The approved REDUCE amount, quotation or currency does not match its source.');
      if (row.ambiguous) throw conflict('An unbound adjustment may already represent this REDUCE; financial review is required.');
      if (!row.line_headroom || !row.transaction_headroom) throw conflict('The REDUCE exceeds the unadjusted charge or transaction balance.');

      let correctionId: string | null = null;
      if (row.magnitude !== '0.00') {
        const correction = await adjustHandymanCustomerLedger({
          executionScopeId: scopeId, chargeLineId: row.charge_line_id, amount: row.magnitude,
          reason: `Approved REDUCE variation ${variation.id}`, idempotencyKey: `variation-reduce:${variation.id}`,
        }, actor, tx);
        if (correction.replayed) throw conflict('An existing unbound correction cannot be claimed as this REDUCE.');
        correctionId = correction.correction.id;
      }
      const id = randomUUID();
      await tx.query(`INSERT INTO handyman_reduce_financial_corrections
        (id,client_id,building_id,execution_scope_id,transaction_id,variation_id,variation_version,
         approved_variation_version,decision_event_id,authorization_event_id,original_quotation_version_id,
         revised_quotation_version_id,quotation_line_id,charge_line_id,correction_id,approved_quantity,
         approved_unit_amount,currency,signed_amount,created_by_user_id,idempotency_key)
        SELECT $1,s.client_id,s.building_id,s.id,$2,v.id,v.version,$3,$4,$5,s.approved_quotation_version_id,
          v.revised_quotation_version_id,v.target_quotation_line_id,$6,$7,v.quantity,v.quoted_unit_amount,
          v.currency,v.quoted_total_delta,$8,$9
        FROM handyman_execution_scopes s JOIN handyman_scope_variations v ON v.execution_scope_id=s.id
        WHERE s.id=$10 AND v.id=$11`,
      [id, row.transaction_id, approvedVersion, decisions[0].id, authorizations[0].id, row.charge_line_id,
        correctionId, actor, idempotencyKey, scopeId, variationId]);
      return { replayed: false, binding: await bindingView(tx, id) };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    const pg = error as { code?: string; message?: string };
    if (pg.code === '23505') throw conflict('The variation, correction or idempotency key is already bound.');
    if (pg.code === '23514' && /REDUCE|Unbound ledger|Ambiguous adjustment/.test(pg.message ?? '')) {
      throw conflict(pg.message ?? 'REDUCE financial authority is invalid.');
    }
    throw error;
  }
}
