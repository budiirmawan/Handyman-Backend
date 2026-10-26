import { randomUUID } from 'node:crypto';
import { getPool, withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { recordOperationalEvent } from '../operational-events';
import { adjustHandymanCustomerLedger } from '../handyman-customer-ledger-corrections';
import {
  financialConflict,
  financialConfig,
  financialDecimal,
  financialMoney,
  financialReference,
} from '../handyman-pricing-contract/handyman-indonesia-tax';
import {
  financialId,
  financialPermission,
  financialQuotation,
  financialRequest,
  financialScope,
} from './handyman-financial-integration-access';

type PaidTreatment = 'PAID_CREDITED' | 'PAID_SEPARATE';
type NoProceed = 'RETAIN_AGREED_FEE' | 'REFUND_AGREED_FEE';
export type InspectionFeeOfferInput = {
  handymanRequestId: string;
  treatment: PaidTreatment;
  noProceedTreatment: NoProceed;
  creditMode: 'SEPARATE_SERVICE_DISCOUNT';
};
/** A dedicated inspection-only quotation is an ordinary existing quotation,
 * approved by the existing customer decision/Commercial Bridge. This metadata
 * must be visible and frozen BEFORE that exact fee version is issued. It is
 * NOT a new consent engine, an automatic fee, or permission to bypass the
 * main INSPECTION_FIRST gate. The fee and the job keep separate ledgers. */
export async function prepareInspectionFeeOffer(
  versionId: string,
  input: InspectionFeeOfferInput,
  actor: string,
) {
  await financialPermission(actor);
  if (
    !['PAID_CREDITED', 'PAID_SEPARATE'].includes(input.treatment) ||
    !['RETAIN_AGREED_FEE', 'REFUND_AGREED_FEE'].includes(input.noProceedTreatment) ||
    input.creditMode !== 'SEPARATE_SERVICE_DISCOUNT'
  )
    financialConfig(
      'Explicit inspection treatment/no-proceed terms and separate-service discount arrangement are required. Job-advance reclassification is not inferred.',
    );
  return withTransaction(async (tx) => {
    const { version, request: feeRequest } = await financialQuotation(tx, versionId, actor);
    const request = await financialRequest(tx, input.handymanRequestId, actor, true);
    if (request.status !== 'INSPECTION_REQUIRED')
      financialConflict('No fee may be offered for a request that does not require inspection.');
    if (
      feeRequest.id === request.id ||
      ['client_id', 'tenant_company_id', 'building_id', 'space_id'].some(
        (k) => feeRequest[k] !== request[k],
      )
    )
      financialConflict(
        'Inspection and job must be distinct requests for the exact same customer and Building context.',
      );
    const prior = (
      await tx.query('SELECT * FROM handyman_inspection_fee_offers WHERE quotation_version_id=$1', [
        versionId,
      ])
    ).rows[0];
    if (prior) {
      if (
        prior.handyman_request_id !== request.id ||
        prior.treatment !== input.treatment ||
        prior.no_proceed_treatment !== input.noProceedTreatment
      )
        financialConflict('The inspection fee offer is immutable.');
      return prior;
    }
    if (version.status !== 'DRAFT')
      financialConflict(
        'Inspection commercial terms must be attached before issuing/approving the fee quotation.',
      );
    const row = (
      await tx.query(
        `INSERT INTO handyman_inspection_fee_offers
      (quotation_version_id,handyman_request_id,treatment,no_proceed_treatment,credit_mode,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [versionId, request.id, input.treatment, input.noProceedTreatment, input.creditMode, actor],
      )
    ).rows[0];
    await recordOperationalEvent(
      {
        clientId: request.client_id,
        buildingId: request.building_id,
        actorUserId: actor,
        eventType: 'HANDYMAN_INSPECTION_FEE_OFFER_PREPARED',
        entityType: 'HANDYMAN_QUOTATION_VERSION',
        entityId: versionId,
        summary: 'Inspection fee treatment bound before customer approval.',
        metadata: { requestId: request.id, treatment: input.treatment },
      },
      tx,
    );
    return row;
  });
}
export async function agreeInspectionFee(
  requestId: string,
  input: {
    treatment: 'FREE' | PaidTreatment;
    feeExecutionScopeId?: string;
    idempotencyKey: string;
  },
  actor: string,
) {
  await financialPermission(actor);
  const key = financialReference(input.idempotencyKey);
  return withTransaction(async (tx) => {
    const request = await financialRequest(tx, requestId, actor, true);
    const prior = (
      await tx.query('SELECT * FROM handyman_inspection_fee_terms WHERE handyman_request_id=$1', [
        request.id,
      ])
    ).rows[0];
    if (prior) {
      if (
        prior.idempotency_key !== key ||
        prior.treatment !== input.treatment ||
        prior.fee_execution_scope_id !== (input.feeExecutionScopeId ?? null)
      )
        financialConflict('A request has one immutable inspection agreement.');
      return { ...prior, replayed: true };
    }
    if (!['FREE', 'PAID_CREDITED', 'PAID_SEPARATE'].includes(input.treatment))
      throw AppError.validation('Invalid inspection commercial treatment.');
    const triage = (
      await tx.query(
        'SELECT triage_disposition FROM handyman_request_triage_decisions WHERE handyman_request_id=$1',
        [request.id],
      )
    ).rows[0];
    if (
      triage?.triage_disposition !== 'INSPECTION_REQUIRED' ||
      request.status !== 'INSPECTION_REQUIRED'
    )
      financialConflict('An inspection fee cannot be imposed on a direct/no-inspection request.');
    const visit = (
      await tx.query(
        `SELECT id FROM handyman_visit_appointments WHERE handyman_request_id=$1 AND state<>'CANCELLED'
      UNION ALL SELECT id FROM handyman_request_inspections WHERE handyman_request_id=$1 LIMIT 1`,
        [request.id],
      )
    ).rows[0];
    if (visit)
      financialConflict(
        'Agree and show inspection charges before proposing the visit or recording its result.',
      );
    let scopeId: string | null = null,
      amount = '0.00',
      currency = 'IDR',
      noProceed = 'NOT_APPLICABLE';
    if (input.treatment !== 'FREE') {
      const scope = await financialScope(tx, financialId(input.feeExecutionScopeId), actor);
      if (
        scope.handyman_request_id === request.id ||
        ['client_id', 'tenant_company_id', 'building_id', 'space_id'].some(
          (k) => scope[k] !== request[k],
        )
      )
        financialConflict('Fee scope and inspection request customer/Building context mismatch.');
      const offer = (
        await tx.query(
          `SELECT o.*,v.status FROM handyman_inspection_fee_offers o
        JOIN handyman_quotation_versions v ON v.id=o.quotation_version_id WHERE o.quotation_version_id=$1`,
          [scope.approved_quotation_version_id],
        )
      ).rows[0];
      if (
        !offer ||
        offer.handyman_request_id !== request.id ||
        offer.status !== 'APPROVED' ||
        offer.treatment !== input.treatment
      )
        financialConflict(
          'The existing customer-approved inspection-only quotation must bind this exact treatment and request.',
        );
      const lines = (
        await tx.query(
          'SELECT line_type,line_total,currency FROM handyman_quotation_lines WHERE quotation_version_id=$1',
          [scope.approved_quotation_version_id],
        )
      ).rows;
      if (
        lines.length !== 1 ||
        lines[0].line_type !== 'LABOR' ||
        financialMoney(String(lines[0].line_total)) <= 0n
      )
        financialConfig(
          'A dedicated single-LABOR inspection-only approved quotation is required; mixed job scope cannot become an inspection fee.',
        );
      scopeId = scope.id;
      amount = String(lines[0].line_total);
      currency = lines[0].currency;
      noProceed = offer.no_proceed_treatment;
    } else if (input.feeExecutionScopeId)
      financialConflict('FREE has no fee ledger, payment or credit.');
    const row = (
      await tx.query(
        `INSERT INTO handyman_inspection_fee_terms
      (id,handyman_request_id,treatment,fee_execution_scope_id,no_proceed_treatment,agreed_amount,currency,created_by_user_id,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          randomUUID(),
          request.id,
          input.treatment,
          scopeId,
          noProceed,
          amount,
          currency,
          actor,
          key,
        ],
      )
    ).rows[0];
    await recordOperationalEvent(
      {
        clientId: request.client_id,
        buildingId: request.building_id,
        actorUserId: actor,
        eventType: 'HANDYMAN_INSPECTION_FEE_AGREED',
        entityType: 'HANDYMAN_SERVICE_REQUEST',
        entityId: request.id,
        summary: 'Inspection commercial agreement recorded before visit.',
        metadata: {
          termsId: row.id,
          treatment: row.treatment,
          feeExecutionScopeId: scopeId,
          amount,
          currency,
        },
      },
      tx,
    );
    return { ...row, replayed: false };
  });
}
/** Once-only job DISCOUNT, never a copied payment or a second allocation.
 * The paid inspection stays independently charged/verified on its own scope.
 * A true job advance has different tax consequences and is NOT reclassified. */
export async function creditPaidInspection(
  jobScopeId: string,
  input: { chargeLineId: string; idempotencyKey: string },
  actor: string,
) {
  await financialPermission(actor);
  const key = financialReference(input.idempotencyKey);
  return withTransaction(async (tx) => {
    const job = await financialScope(tx, jobScopeId, actor, true);
    // Follow the existing refund writer's transaction -> terms lock order.
    // Terms are immutable; use their fee scope only to select both ledgers,
    // then re-read/lock the exact agreement before inspecting real net funds.
    await tx.query(
      `SELECT id FROM handyman_customer_transactions WHERE execution_scope_id=$1 OR execution_scope_id=(
        SELECT fee_execution_scope_id FROM handyman_inspection_fee_terms WHERE handyman_request_id=$2)
        ORDER BY id FOR UPDATE`,
      [job.id, job.handyman_request_id],
    );
    const terms = (
      await tx.query(
        'SELECT * FROM handyman_inspection_fee_terms WHERE handyman_request_id=$1 FOR UPDATE',
        [job.handyman_request_id],
      )
    ).rows[0];
    if (!terms || terms.treatment !== 'PAID_CREDITED' || !terms.fee_execution_scope_id)
      financialConflict('This inspection agreement grants no paid job credit.');
    const prior = (
      await tx.query(
        'SELECT cr.*,c.source_charge_line_id FROM handyman_inspection_fee_credits cr JOIN handyman_ledger_corrections c ON c.id=cr.correction_id WHERE cr.terms_id=$1',
        [terms.id],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.job_execution_scope_id !== job.id ||
        prior.idempotency_key !== key ||
        prior.source_charge_line_id !== input.chargeLineId ||
        prior.created_by_user_id !== actor
      )
        financialConflict('The inspection credit is already spent.');
      return { ...prior, replayed: true };
    }
    const fee = await financialScope(tx, terms.fee_execution_scope_id, actor);
    if (
      job.id === fee.id ||
      ['client_id', 'tenant_company_id', 'building_id', 'space_id'].some((k) => job[k] !== fee[k])
    )
      financialConflict('Fee/job customer context or currency mismatch.');
    const jobCurrency = (
      await tx.query(
        'SELECT DISTINCT currency FROM handyman_quotation_lines WHERE quotation_version_id=$1',
        [job.approved_quotation_version_id],
      )
    ).rows;
    if (jobCurrency.length !== 1 || jobCurrency[0].currency !== terms.currency)
      financialConflict('Inspection and job credit must use the exact same currency.');
    const paid = (
      await tx.query(
        `SELECT COALESCE(SUM(CASE WHEN EXISTS(SELECT 1 FROM handyman_ledger_corrections c
        WHERE c.source_payment_id=p.id AND c.correction_kind='REVERSAL') THEN 0 ELSE p.amount-COALESCE((
        SELECT SUM(c.amount) FROM handyman_ledger_corrections c WHERE c.source_payment_id=p.id AND c.correction_kind='REFUND'),0) END),0)::numeric(18,2)::text amount
      FROM handyman_customer_payments p JOIN handyman_customer_transactions t ON t.id=p.transaction_id
      WHERE t.execution_scope_id=$1 AND p.status='CONFIRMED' AND EXISTS(SELECT 1 FROM handyman_payment_reconciliations pr WHERE pr.payment_id=p.id)`,
        [fee.id],
      )
    ).rows[0].amount;
    if (financialMoney(paid) < financialMoney(String(terms.agreed_amount)))
      financialConflict(
        'The entire agreed inspection fee must be Finance-confirmed, bank-reconciled and unrefunded before credit.',
      );
    const result = await adjustHandymanCustomerLedger(
      {
        executionScopeId: job.id,
        chargeLineId: financialId(input.chargeLineId),
        amount: String(terms.agreed_amount),
        reason: `Agreed separate inspection service discount; terms ${terms.id}`,
        idempotencyKey: `inspection-credit:${terms.id}`,
      },
      actor,
      tx,
    );
    const row = (
      await tx.query(
        `INSERT INTO handyman_inspection_fee_credits(id,terms_id,job_execution_scope_id,correction_id,created_by_user_id,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [randomUUID(), terms.id, job.id, result.correction.id, actor, key],
      )
    ).rows[0];
    await recordOperationalEvent(
      {
        clientId: job.client_id,
        buildingId: job.building_id,
        actorUserId: actor,
        eventType: 'HANDYMAN_INSPECTION_FEE_CREDITED',
        entityType: 'HANDYMAN_EXECUTION_SCOPE',
        entityId: job.id,
        summary:
          'One agreed inspection discount posted through the existing forward-only ledger correction.',
        metadata: {
          termsId: terms.id,
          correctionId: row.correction_id,
          amount: terms.agreed_amount,
        },
      },
      tx,
    );
    return { ...row, replayed: false };
  });
}
export async function readInspectionFee(requestId: string, actor: string) {
  const db = getPool();
  await financialRequest(db, requestId, actor);
  const terms = (
    await db.query('SELECT * FROM handyman_inspection_fee_terms WHERE handyman_request_id=$1', [
      requestId,
    ])
  ).rows[0];
  if (!terms) return { configured: false, charge: '0.00', credit: '0.00' };
  const credits = (
    await db.query(
      `SELECT cr.*,c.amount FROM handyman_inspection_fee_credits cr JOIN handyman_ledger_corrections c ON c.id=cr.correction_id WHERE cr.terms_id=$1`,
      [terms.id],
    )
  ).rows;
  const payments = terms.fee_execution_scope_id
    ? (
        await db.query(
          `SELECT p.id,p.status,p.amount,p.decided_at FROM handyman_customer_payments p JOIN handyman_customer_transactions t ON t.id=p.transaction_id WHERE t.execution_scope_id=$1 ORDER BY p.created_at`,
          [terms.fee_execution_scope_id],
        )
      ).rows
    : [];
  return {
    configured: true,
    terms,
    charge: financialDecimal(financialMoney(String(terms.agreed_amount))),
    payments,
    credits,
    noProceed: terms.no_proceed_treatment,
    refundAutomatic: false,
  };
}
