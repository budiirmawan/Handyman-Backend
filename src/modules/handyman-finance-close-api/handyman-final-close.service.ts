import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { canAccessBuildingScopedResource } from '../context-access';
import {
  handymanCustomerTransactionNotAuthorizedError,
  handymanCustomerTransactionScopeNotFoundError,
} from '../handyman-customer-transactions';
import { readHandymanLedgerTransactionAt } from '../handyman-customer-ledger-read';
import { assertCurrentGuardedHandymanQcPass } from '../handyman-evidence-qc/handyman-qc-pass-gate';
import { handymanExecutionScopeRepository } from '../handyman-quotations';
import { hasVerifiedHandymanBastCustomerAcceptance } from '../handyman-bast';
import { recordOperationalEvent } from '../operational-events';

type Executor = Pick<PoolClient, 'query'>;

function ensureUuid(value: string, field: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(trimmed)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return trimmed;
}

function toCents(amount: string | number | null | undefined): bigint {
  if (amount === null || amount === undefined) return 0n;
  const text = typeof amount === 'number' ? amount.toFixed(2) : String(amount).trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return 0n;
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2]);
  const frac = BigInt((match[3] ?? '').padEnd(2, '0'));
  return sign * (whole * 100n + frac);
}

function fromCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${sign}${whole.toString()}.${frac}`;
}

export type HandymanDerivedPaymentStatus =
  | 'UNPAID'
  | 'DP_PENDING'
  | 'DP_PARTIAL'
  | 'DP_PAID'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'OVERPAID_UNRECONCILED';

export type HandymanInvoiceReconciliationSummary = {
  executionScopeId: string;
  handymanRequestId: string;
  scopeStatus: 'AUTHORIZED' | 'CLOSED';
  closedAt: string | null;
  closedByUserId: string | null;
  closeReason: string | null;
  currency: string;
  quotationDpTerms: {
    quotationVersionId: string;
    versionNumber: number;
    dpRequired: boolean;
    dpPercentage: number | null;
    dpAmount: string | null;
    dpTermsNotes: string | null;
  };
  ledgerSummary: {
    transactionId: string | null;
    chargedGross: string;
    adjusted: string;
    chargedNet: string;
    dpRequiredAmount: string;
    dpPendingAmount: string;
    dpVerifiedAmount: string;
    dpAllocatedAmount: string;
    dpRemainingRequiredAmount: string;
    terminVerifiedAmount: string;
    pelunasanVerifiedAmount: string;
    pendingPaymentAmount: string;
    totalConfirmedReceivedNet: string;
    totalConfirmedAllocatedNet: string;
    unallocatedConfirmedAmount: string;
    remainingBalanceAfterDpAndPayments: string;
    derivedPaymentStatus: HandymanDerivedPaymentStatus;
  };
  invoice: {
    invoiceId: string;
    invoiceNumber: string;
    status: string;
    grossTotal: string;
    dpDeductedAmount: string;
    otherConfirmedAppliedAmount: string;
    totalAppliedAmount: string;
    remainingBalance: string;
    paymentStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  } | null;
  variations: Array<{
    id: string;
    variationNumber: number;
    variationType: string;
    status: string;
    finalChargeEligible: boolean;
    invoiced: boolean;
    revisedQuotationVersionId: string | null;
    targetQuotationLineId: string | null;
    reducedQuantity: string | null;
  }>;
  history: {
    quotationVersions: Array<{
      id: string;
      versionNumber: number;
      status: string;
      dpRequired: boolean;
      dpPercentage: number | null;
      dpAmount: string | null;
      createdAt: string;
    }>;
    bastHistory: Array<{
      id: string;
      status: string;
      qcRunId: string | null;
      issuedAt: string | null;
      acceptedAt: string | null;
      rejectedAt: string | null;
      voidedAt: string | null;
      createdAt: string;
    }>;
    invoiceHistory: Array<{
      id: string;
      invoiceNumber: string;
      status: string;
      totalAmount: string;
      createdAt: string;
    }>;
  };
};

export type HandymanFinalCloseBlockerCode =
  | 'NO_ACTIVE_CREW_ASSIGNMENT'
  | 'WORK_SESSION_NOT_COMPLETED'
  | 'WORK_SESSION_STILL_ACTIVE'
  | 'MATERIAL_EXECUTION_NOT_SETTLED'
  | 'MATERIAL_PURCHASE_NOT_RECONCILED'
  | 'VARIATION_NOT_RECONCILED'
  | 'SUPERVISOR_QC_NOT_PASSED'
  | 'OPEN_DEFECT_UNVERIFIED'
  | 'BAST_NOT_ACCEPTED'
  | 'BAST_SIGN_OFF_MISSING'
  | 'LEDGER_TRANSACTION_NOT_OPEN'
  | 'NO_POSTED_CHARGE_LINES'
  | 'PENDING_PAYMENT_UNVERIFIED'
  | 'ONLY_DP_OR_PARTIAL_PAID'
  | 'OUTSTANDING_BALANCE_UNPAID'
  | 'UNRECONCILED_OVERPAYMENT_OR_UNALLOCATED_FUNDS'
  | 'FINAL_INVOICE_NOT_FINALIZED'
  | 'FINAL_INVOICE_LINES_INCOMPLETE'
  | 'FINAL_INVOICE_NOT_PAID'
  | 'OPEN_SETTLEMENT_EXCEPTION';

export type HandymanFinalCloseBlocker = {
  code: HandymanFinalCloseBlockerCode;
  message: string;
};

export type HandymanFinalCloseReadiness = {
  executionScopeId: string;
  handymanRequestId: string;
  scopeStatus: 'AUTHORIZED' | 'CLOSED';
  eligibleForFinalClose: boolean;
  gates: {
    activeCrewAssigned: boolean;
    workSessionsCompleted: boolean;
    materialsSettled: boolean;
    variationsReconciled: boolean;
    supervisorQcPassed: boolean;
    bastAccepted: boolean;
    noPendingPayments: boolean;
    ledgerFullySettled: boolean;
    finalInvoicePaid: boolean;
    noBlockingExceptions: boolean;
  };
  blockers: HandymanFinalCloseBlocker[];
  reconciliation: HandymanInvoiceReconciliationSummary;
};

export type HandymanExecutionScopeCloseEventRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  executionScopeId: string;
  handymanRequestId: string;
  bastId: string;
  qcRunId: string;
  transactionId: string;
  invoiceId: string;
  currency: string;
  chargedNetAmount: string;
  paidAppliedAmount: string;
  actorUserId: string;
  reason: string;
  idempotencyKey: string;
  occurredAt: string;
  createdAt: string;
};

async function buildReconciliationSummaryWithExecutor(
  executor: Executor,
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanInvoiceReconciliationSummary> {
  const scopeRowRes = await executor.query<{
    id: string;
    client_id: string;
    building_id: string;
    handyman_request_id: string;
    quotation_id: string;
    approved_quotation_version_id: string;
    status: 'AUTHORIZED' | 'CLOSED';
    closed_at: Date | null;
    closed_by_user_id: string | null;
    close_reason: string | null;
  }>(
    `SELECT id, client_id, building_id, handyman_request_id, quotation_id,
            approved_quotation_version_id, status, closed_at,
            closed_by_user_id, close_reason
       FROM handyman_execution_scopes
      WHERE id = $1`,
    [executionScopeId],
  );
  const scopeRow = scopeRowRes.rows[0];
  if (!scopeRow) throw handymanCustomerTransactionScopeNotFoundError();

  if (
    !(await canAccessBuildingScopedResource(actorUserId, {
      clientId: scopeRow.client_id,
      buildingId: scopeRow.building_id,
    }))
  ) {
    throw handymanCustomerTransactionNotAuthorizedError();
  }

  // Quotation versions + DP terms
  const versionsRes = await executor.query<{
    id: string;
    version_number: number;
    status: string;
    dp_required: boolean;
    dp_percentage: string | number | null;
    dp_amount: string | number | null;
    dp_terms_notes: string | null;
    created_at: Date;
  }>(
    `SELECT id, version_number, status, dp_required, dp_percentage,
            dp_amount, dp_terms_notes, created_at
       FROM handyman_quotation_versions
      WHERE quotation_id = $1
      ORDER BY version_number ASC`,
    [scopeRow.quotation_id],
  );
  const approvedVersion =
    versionsRes.rows.find(
      (v) => v.id === scopeRow.approved_quotation_version_id,
    ) ?? versionsRes.rows[versionsRes.rows.length - 1];

  const quoteCurrencyRes = await executor.query<{ currency: string }>(
    `SELECT currency
       FROM handyman_quotation_lines
      WHERE quotation_version_id = $1
      LIMIT 1`,
    [scopeRow.approved_quotation_version_id],
  );
  const defaultCurrency = quoteCurrencyRes.rows[0]?.currency ?? 'IDR';

  // Read authoritative ledger if opened
  const txExistsRes = await executor.query<{ id: string; currency: string }>(
    `SELECT id, currency
       FROM handyman_customer_transactions
      WHERE execution_scope_id = $1`,
    [executionScopeId],
  );
  const txRow = txExistsRes.rows[0] ?? null;
  const currency = txRow?.currency ?? defaultCurrency;

  const dpRequired = Boolean(approvedVersion?.dp_required);
  const dpPercentage =
    approvedVersion?.dp_percentage !== null &&
    approvedVersion?.dp_percentage !== undefined
      ? Number(approvedVersion.dp_percentage)
      : null;
  const dpAmountCents =
    dpRequired && approvedVersion?.dp_amount !== null && approvedVersion?.dp_amount !== undefined
      ? toCents(approvedVersion.dp_amount)
      : 0n;

  let chargedGrossCents = 0n;
  let adjustedCents = 0n;
  let chargedNetCents = 0n;
  let dpPendingCents = 0n;
  let dpVerifiedCents = 0n;
  let dpAllocatedCents = 0n;
  let terminVerifiedCents = 0n;
  let pelunasanVerifiedCents = 0n;
  let pendingPaymentCents = 0n;
  let totalConfirmedReceivedNetCents = 0n;
  let totalConfirmedAllocatedNetCents = 0n;

  if (txRow) {
    const ledger = await readHandymanLedgerTransactionAt(
      executionScopeId,
      actorUserId,
    );
    chargedGrossCents = toCents(ledger.totals.chargedGross);
    adjustedCents = toCents(ledger.totals.adjusted);
    chargedNetCents = toCents(ledger.totals.chargedNet);
    totalConfirmedAllocatedNetCents = toCents(ledger.totals.applied);
    totalConfirmedReceivedNetCents =
      toCents(ledger.totals.receivedNet) - toCents(ledger.totals.refunded);

    for (const p of ledger.payments) {
      const amtCents = toCents(p.amount);
      const revPayCents = toCents(p.reversedPayment);
      const refCents = toCents(p.refunded);
      const appCents = toCents(p.applied);
      const effectiveConfirmedCents =
        p.status === 'CONFIRMED' && revPayCents === 0n
          ? amtCents - refCents
          : 0n;

      if (p.status === 'PENDING') {
        pendingPaymentCents += amtCents;
        if (p.obligationStage === 'DP') {
          dpPendingCents += amtCents;
        }
      } else if (p.status === 'CONFIRMED' && revPayCents === 0n) {
        if (p.obligationStage === 'DP') {
          dpVerifiedCents += effectiveConfirmedCents;
          dpAllocatedCents += appCents;
        } else if (p.obligationStage === 'TERMIN') {
          terminVerifiedCents += effectiveConfirmedCents;
        } else {
          pelunasanVerifiedCents += effectiveConfirmedCents;
        }
      }
    }
  }

  const dpRemainingRequiredCents =
    dpAmountCents > dpVerifiedCents ? dpAmountCents - dpVerifiedCents : 0n;
  const unallocatedConfirmedCents =
    totalConfirmedReceivedNetCents > totalConfirmedAllocatedNetCents
      ? totalConfirmedReceivedNetCents - totalConfirmedAllocatedNetCents
      : 0n;
  const remainingBalanceCents =
    chargedNetCents > totalConfirmedAllocatedNetCents
      ? chargedNetCents - totalConfirmedAllocatedNetCents
      : 0n;

  let derivedPaymentStatus: HandymanDerivedPaymentStatus = 'UNPAID';
  if (
    totalConfirmedReceivedNetCents > chargedNetCents &&
    chargedNetCents > 0n
  ) {
    derivedPaymentStatus = 'OVERPAID_UNRECONCILED';
  } else if (
    chargedNetCents > 0n &&
    remainingBalanceCents === 0n &&
    unallocatedConfirmedCents === 0n
  ) {
    derivedPaymentStatus = 'PAID';
  } else if (totalConfirmedReceivedNetCents > 0n) {
    if (dpRequired && dpVerifiedCents > 0n && terminVerifiedCents === 0n && pelunasanVerifiedCents === 0n) {
      derivedPaymentStatus =
        dpVerifiedCents >= dpAmountCents ? 'DP_PAID' : 'DP_PARTIAL';
    } else {
      derivedPaymentStatus = 'PARTIALLY_PAID';
    }
  } else if (dpPendingCents > 0n) {
    derivedPaymentStatus = 'DP_PENDING';
  }

  // Invoices on the scope
  const invoicesRes = await executor.query<{
    id: string;
    invoice_number: string;
    status: string;
    total_amount: string;
    created_at: Date;
  }>(
    `SELECT id, invoice_number, status, total_amount::numeric(18, 2)::text AS total_amount,
            created_at
       FROM tenant_invoices
      WHERE handyman_execution_scope_id = $1
        AND client_id = $2
      ORDER BY created_at DESC, id DESC`,
    [executionScopeId, scopeRow.client_id],
  );
  const activeInvoice =
    invoicesRes.rows.find((inv) => inv.status === 'FINALIZED') ??
    invoicesRes.rows.find((inv) => inv.status === 'DRAFT') ??
    null;

  let invoiceProjection: HandymanInvoiceReconciliationSummary['invoice'] = null;
  if (activeInvoice) {
    const grossTotalCents = toCents(activeInvoice.total_amount);
    // DP is deducted ONCE via its authoritative allocation (`dpAllocatedCents`),
    // never double-counted alongside `totalConfirmedAllocatedNetCents`.
    const otherConfirmedAppliedCents =
      totalConfirmedAllocatedNetCents >= dpAllocatedCents
        ? totalConfirmedAllocatedNetCents - dpAllocatedCents
        : 0n;
    const invRemainingCents =
      grossTotalCents > totalConfirmedAllocatedNetCents
        ? grossTotalCents - totalConfirmedAllocatedNetCents
        : 0n;
    const invPaymentStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' =
      totalConfirmedAllocatedNetCents <= 0n
        ? 'UNPAID'
        : invRemainingCents === 0n && grossTotalCents > 0n
          ? 'PAID'
          : 'PARTIALLY_PAID';
    invoiceProjection = {
      invoiceId: activeInvoice.id,
      invoiceNumber: activeInvoice.invoice_number,
      status: activeInvoice.status,
      grossTotal: fromCents(grossTotalCents),
      dpDeductedAmount: fromCents(dpAllocatedCents),
      otherConfirmedAppliedAmount: fromCents(otherConfirmedAppliedCents),
      totalAppliedAmount: fromCents(totalConfirmedAllocatedNetCents),
      remainingBalance: fromCents(invRemainingCents),
      paymentStatus: invPaymentStatus,
    };
  }

  // Variations
  const variationsRes = await executor.query<{
    id: string;
    version: number;
    variation_type: string;
    status: string;
    final_charge_eligible: boolean;
    invoiced: boolean;
    revised_quotation_version_id: string | null;
    target_quotation_line_id: string | null;
    quantity: string | null;
  }>(
    `SELECT id, version, variation_type, status,
            final_charge_eligible, invoiced, revised_quotation_version_id,
            target_quotation_line_id,
            quantity::text AS quantity
       FROM handyman_scope_variations
      WHERE execution_scope_id = $1 AND client_id = $2
      ORDER BY created_at ASC, id ASC`,
    [executionScopeId, scopeRow.client_id],
  );

  // BAST history
  const bastRes = await executor.query<{
    id: string;
    status: string;
    qc_run_id: string | null;
    issued_at: Date | null;
    accepted_at: Date | null;
    rejected_at: Date | null;
    voided_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, status, qc_run_id, issued_at, accepted_at, rejected_at,
            voided_at, created_at
       FROM handyman_bast_documents
      WHERE execution_scope_id = $1 AND client_id = $2
      ORDER BY created_at ASC, id ASC`,
    [executionScopeId, scopeRow.client_id],
  );

  return {
    executionScopeId: scopeRow.id,
    handymanRequestId: scopeRow.handyman_request_id,
    scopeStatus: scopeRow.status,
    closedAt: scopeRow.closed_at ? scopeRow.closed_at.toISOString() : null,
    closedByUserId: scopeRow.closed_by_user_id ?? null,
    closeReason: scopeRow.close_reason ?? null,
    currency,
    quotationDpTerms: {
      quotationVersionId: approvedVersion.id,
      versionNumber: approvedVersion.version_number,
      dpRequired,
      dpPercentage,
      dpAmount: dpRequired ? fromCents(dpAmountCents) : null,
      dpTermsNotes: approvedVersion.dp_terms_notes ?? null,
    },
    ledgerSummary: {
      transactionId: txRow?.id ?? null,
      chargedGross: fromCents(chargedGrossCents),
      adjusted: fromCents(adjustedCents),
      chargedNet: fromCents(chargedNetCents),
      dpRequiredAmount: fromCents(dpAmountCents),
      dpPendingAmount: fromCents(dpPendingCents),
      dpVerifiedAmount: fromCents(dpVerifiedCents),
      dpAllocatedAmount: fromCents(dpAllocatedCents),
      dpRemainingRequiredAmount: fromCents(dpRemainingRequiredCents),
      terminVerifiedAmount: fromCents(terminVerifiedCents),
      pelunasanVerifiedAmount: fromCents(pelunasanVerifiedCents),
      pendingPaymentAmount: fromCents(pendingPaymentCents),
      totalConfirmedReceivedNet: fromCents(totalConfirmedReceivedNetCents),
      totalConfirmedAllocatedNet: fromCents(totalConfirmedAllocatedNetCents),
      unallocatedConfirmedAmount: fromCents(unallocatedConfirmedCents),
      remainingBalanceAfterDpAndPayments: fromCents(remainingBalanceCents),
      derivedPaymentStatus,
    },
    invoice: invoiceProjection,
    variations: variationsRes.rows.map((v, idx) => ({
      id: v.id,
      variationNumber: idx + 1,
      variationType: v.variation_type,
      status: v.status,
      finalChargeEligible: Boolean(v.final_charge_eligible),
      invoiced: Boolean(v.invoiced),
      revisedQuotationVersionId: v.revised_quotation_version_id,
      targetQuotationLineId: v.target_quotation_line_id,
      reducedQuantity: v.variation_type === 'REDUCE' ? v.quantity : null,
    })),
    history: {
      quotationVersions: versionsRes.rows.map((v) => ({
        id: v.id,
        versionNumber: v.version_number,
        status: v.status,
        dpRequired: Boolean(v.dp_required),
        dpPercentage:
          v.dp_percentage !== null && v.dp_percentage !== undefined
            ? Number(v.dp_percentage)
            : null,
        dpAmount:
          v.dp_amount !== null && v.dp_amount !== undefined
            ? fromCents(toCents(v.dp_amount))
            : null,
        createdAt: v.created_at.toISOString(),
      })),
      bastHistory: bastRes.rows.map((b) => ({
        id: b.id,
        status: b.status,
        qcRunId: b.qc_run_id,
        issuedAt: b.issued_at ? b.issued_at.toISOString() : null,
        acceptedAt: b.accepted_at ? b.accepted_at.toISOString() : null,
        rejectedAt: b.rejected_at ? b.rejected_at.toISOString() : null,
        voidedAt: b.voided_at ? b.voided_at.toISOString() : null,
        createdAt: b.created_at.toISOString(),
      })),
      invoiceHistory: invoicesRes.rows.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoice_number,
        status: inv.status,
        totalAmount: inv.total_amount,
        createdAt: inv.created_at.toISOString(),
      })),
    },
  };
}

export async function getHandymanInvoiceReconciliationSummary(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanInvoiceReconciliationSummary> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  return buildReconciliationSummaryWithExecutor(getPool(), scopeUuid, actorUuid);
}

async function evaluateFinalCloseGates(
  executor: Executor,
  executionScopeId: string,
  actorUserId: string,
): Promise<{
  readiness: HandymanFinalCloseReadiness;
  bastId: string | null;
  qcRunId: string | null;
  transactionId: string | null;
  invoiceId: string | null;
}> {
  const reconciliation = await buildReconciliationSummaryWithExecutor(
    executor,
    executionScopeId,
    actorUserId,
  );
  const scope = await handymanExecutionScopeRepository.findScopeById(
    executor as PoolClient,
    executionScopeId,
  );
  if (!scope) throw handymanCustomerTransactionScopeNotFoundError();

  const blockers: HandymanFinalCloseBlocker[] = [];

  // 1. Active crew assignment
  const crewRes = await executor.query<{ id: string }>(
    `SELECT id
       FROM handyman_execution_scope_assignments
      WHERE execution_scope_id = $1 AND status = 'ACTIVE'
      LIMIT 1`,
    [executionScopeId],
  );
  const activeCrewAssigned = Boolean(crewRes.rows[0]);
  if (!activeCrewAssigned) {
    blockers.push({
      code: 'NO_ACTIVE_CREW_ASSIGNMENT',
      message: 'An active crew assignment is required before final close.',
    });
  }

  // 2. Work sessions completed & none active
  const sessionRes = await executor.query<{
    completed_count: number;
    active_count: number;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('COMPLETED', 'CHECKED_OUT'))::int AS completed_count,
       COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED', 'CHECKED_OUT', 'CANCELLED'))::int AS active_count
      FROM handyman_work_sessions
     WHERE execution_scope_id = $1`,
    [executionScopeId],
  );
  const completedSessions = sessionRes.rows[0]?.completed_count ?? 0;
  const activeSessions = sessionRes.rows[0]?.active_count ?? 0;
  if (completedSessions < 1) {
    blockers.push({
      code: 'WORK_SESSION_NOT_COMPLETED',
      message: 'At least one completed work session is required before final close.',
    });
  }
  if (activeSessions > 0) {
    blockers.push({
      code: 'WORK_SESSION_STILL_ACTIVE',
      message: 'All work sessions must be completed or checked out before final close.',
    });
  }
  const workSessionsCompleted = completedSessions >= 1 && activeSessions === 0;

  // 3. Material execution & purchasing settled
  const matExecRes = await executor.query<{ unsettled_count: number }>(
    `SELECT COUNT(*) FILTER (WHERE status NOT IN ('SETTLED', 'FINAL_CHARGE_READY'))::int AS unsettled_count
       FROM handyman_material_execution_lines
      WHERE execution_scope_id = $1`,
    [executionScopeId],
  );
  const unsettledMatLines = matExecRes.rows[0]?.unsettled_count ?? 0;
  if (unsettledMatLines > 0) {
    blockers.push({
      code: 'MATERIAL_EXECUTION_NOT_SETTLED',
      message: 'All material execution lines must be settled before final close.',
    });
  }

  const matPurchRes = await executor.query<{ unreconciled_count: number }>(
    `SELECT COUNT(*) FILTER (WHERE status NOT IN ('RECONCILED', 'REJECTED'))::int AS unreconciled_count
       FROM handyman_material_purchase_records
      WHERE execution_scope_id = $1`,
    [executionScopeId],
  );
  const unreconciledPurchases = matPurchRes.rows[0]?.unreconciled_count ?? 0;
  if (unreconciledPurchases > 0) {
    blockers.push({
      code: 'MATERIAL_PURCHASE_NOT_RECONCILED',
      message: 'All field/operations material purchases must be reconciled before final close.',
    });
  }
  const materialsSettled = unsettledMatLines === 0 && unreconciledPurchases === 0;

  // 4. Scope variations reconciled
  const unreconciledVariations = reconciliation.variations.filter(
    (v) =>
      v.status !== 'REJECTED' &&
      !(v.status === 'FINAL_CHARGE_ELIGIBILITY' && v.finalChargeEligible && v.invoiced),
  );
  const variationsReconciled = unreconciledVariations.length === 0;
  if (!variationsReconciled) {
    blockers.push({
      code: 'VARIATION_NOT_RECONCILED',
      message:
        'All non-rejected scope variations must reach final-charge eligibility and be reconciled on the final invoice.',
    });
  }

  // 5. Supervisor QC PASS & zero open defects
  let qcRunId: string | null = null;
  let supervisorQcPassed = false;
  try {
    const qcDecision = await assertCurrentGuardedHandymanQcPass(
      executor as PoolClient,
      {
        id: scope.id,
        clientId: scope.clientId,
        buildingId: scope.buildingId,
      },
    );
    qcRunId = qcDecision.runId;
    supervisorQcPassed = true;
  } catch {
    blockers.push({
      code: 'SUPERVISOR_QC_NOT_PASSED',
      message:
        'A current guarded Supervisor QC PASS with complete checklist and verified evidence is required before final close.',
    });
  }

  const defectRes = await executor.query<{ open_count: number }>(
    `SELECT COUNT(*) FILTER (WHERE status <> 'VERIFIED')::int AS open_count
       FROM handyman_defect_records
      WHERE execution_scope_id = $1`,
    [executionScopeId],
  );
  const openDefects = defectRes.rows[0]?.open_count ?? 0;
  if (openDefects > 0) {
    supervisorQcPassed = false;
    blockers.push({
      code: 'OPEN_DEFECT_UNVERIFIED',
      message: 'All QC defects must be rectified and verified before final close.',
    });
  }

  // 6. BAST ACCEPTED by authorized Tenant/PIC
  const bastDocRes = await executor.query<{
    id: string;
    status: string;
    qc_run_id: string | null;
    accepted_at: Date | null;
    has_accept_signoff: boolean;
  }>(
    `SELECT b.id, b.status, b.qc_run_id, b.accepted_at,
            EXISTS (
              SELECT 1
                FROM handyman_bast_sign_offs s
               WHERE s.bast_id = b.id
                 AND s.decision = 'ACCEPT'
                 AND length(btrim(COALESCE(s.signature_digest, ''))) > 0
            ) AS has_accept_signoff
       FROM handyman_bast_documents b
      WHERE b.execution_scope_id = $1
        AND b.status NOT IN ('VOID', 'REJECTED')
      ORDER BY b.created_at DESC
      LIMIT 1`,
    [executionScopeId],
  );
  const activeBast = bastDocRes.rows[0] ?? null;
  let bastAccepted = false;
  let bastId: string | null = null;
  if (
    !activeBast ||
    activeBast.status !== 'ACCEPTED' ||
    !activeBast.accepted_at ||
    (qcRunId !== null && activeBast.qc_run_id !== qcRunId)
  ) {
    blockers.push({
      code: 'BAST_NOT_ACCEPTED',
      message:
        'BAST must be ACCEPTED by an authorized Tenant/PIC and bound to the latest Supervisor QC PASS run.',
    });
  } else if (!activeBast.has_accept_signoff ||
      !(await hasVerifiedHandymanBastCustomerAcceptance(executor, activeBast.id))) {
    blockers.push({
      code: 'BAST_SIGN_OFF_MISSING',
      message: 'Accepted BAST must have a verified authenticated customer-PIC consent receipt; legacy staff/digest-only sign-offs do not qualify.',
    });
  } else {
    bastAccepted = true;
    bastId = activeBast.id;
  }

  // 7. No pending payments & ledger fully settled
  const transactionId = reconciliation.ledgerSummary.transactionId;
  const pendingCents = toCents(
    reconciliation.ledgerSummary.pendingPaymentAmount,
  );
  const chargedNetCents = toCents(reconciliation.ledgerSummary.chargedNet);
  const remainingBalanceCents = toCents(
    reconciliation.ledgerSummary.remainingBalanceAfterDpAndPayments,
  );
  const unallocatedConfirmedCents = toCents(
    reconciliation.ledgerSummary.unallocatedConfirmedAmount,
  );
  const dpVerifiedCents = toCents(
    reconciliation.ledgerSummary.dpVerifiedAmount,
  );
  const totalConfirmedReceivedCents = toCents(
    reconciliation.ledgerSummary.totalConfirmedReceivedNet,
  );

  const noPendingPayments = pendingCents === 0n;
  if (!noPendingPayments) {
    blockers.push({
      code: 'PENDING_PAYMENT_UNVERIFIED',
      message:
        'One or more customer payments (or uploaded payment proofs) are still PENDING Finance verification.',
    });
  }

  let ledgerFullySettled = true;
  if (!transactionId) {
    ledgerFullySettled = false;
    blockers.push({
      code: 'LEDGER_TRANSACTION_NOT_OPEN',
      message: 'Authoritative customer ledger transaction is not open.',
    });
  } else if (chargedNetCents <= 0n) {
    ledgerFullySettled = false;
    blockers.push({
      code: 'NO_POSTED_CHARGE_LINES',
      message: 'At least one positive net charge line must be posted on the ledger.',
    });
  } else {
    if (remainingBalanceCents > 0n) {
      ledgerFullySettled = false;
      if (dpVerifiedCents > 0n || totalConfirmedReceivedCents > 0n) {
        blockers.push({
          code: 'ONLY_DP_OR_PARTIAL_PAID',
          message:
            'Execution scope cannot be closed when only DP or partial payment is paid and remaining balance is unpaid.',
        });
      }
      blockers.push({
        code: 'OUTSTANDING_BALANCE_UNPAID',
        message: `Outstanding ledger balance of ${reconciliation.ledgerSummary.remainingBalanceAfterDpAndPayments} ${reconciliation.currency} remains unpaid/unallocated.`,
      });
    }
    if (unallocatedConfirmedCents > 0n) {
      ledgerFullySettled = false;
      blockers.push({
        code: 'UNRECONCILED_OVERPAYMENT_OR_UNALLOCATED_FUNDS',
        message: `Confirmed funds of ${reconciliation.ledgerSummary.unallocatedConfirmedAmount} ${reconciliation.currency} remain unallocated or overpaid without refund/reconciliation.`,
      });
    }
  }

  // 8. Final invoice finalized & PAID
  let finalInvoicePaid = false;
  let invoiceId: string | null = null;
  if (!reconciliation.invoice || reconciliation.invoice.status !== 'FINALIZED') {
    blockers.push({
      code: 'FINAL_INVOICE_NOT_FINALIZED',
      message: 'A FINALIZED tenant invoice is required before final close.',
    });
  } else {
    invoiceId = reconciliation.invoice.invoiceId;
    const unlinkedChargeLinesRes = await executor.query<{ unlinked_count: number }>(
      `SELECT COUNT(*)::int AS unlinked_count
         FROM handyman_charge_lines cl
         JOIN handyman_customer_transactions tx ON tx.id = cl.transaction_id
        WHERE tx.execution_scope_id = $1
          AND NOT EXISTS (
            SELECT 1
              FROM tenant_invoice_lines il
             WHERE il.invoice_id = $2
               AND il.source_type = 'HANDYMAN_CHARGE'
               AND il.handyman_charge_line_id = cl.id
          )`,
      [executionScopeId, invoiceId],
    );
    const unlinkedCount = unlinkedChargeLinesRes.rows[0]?.unlinked_count ?? 0;
    const invoiceGrossCents = toCents(reconciliation.invoice.grossTotal);
    if (unlinkedCount > 0 || invoiceGrossCents !== chargedNetCents) {
      blockers.push({
        code: 'FINAL_INVOICE_LINES_INCOMPLETE',
        message:
          'Finalized invoice lines do not cover all net ledger charge lines for the execution scope.',
      });
    } else if (
      reconciliation.invoice.paymentStatus !== 'PAID' ||
      toCents(reconciliation.invoice.remainingBalance) !== 0n
    ) {
      blockers.push({
        code: 'FINAL_INVOICE_NOT_PAID',
        message: 'Final invoice is not yet fully PAID from verified ledger allocations.',
      });
    } else {
      finalInvoicePaid = true;
    }
  }

  // 9. Zero blocking settlement exceptions (while keeping settlement & warranty lifecycles separate)
  const settlementExcRes = await executor.query<{ open_exc: number }>(
    `SELECT COUNT(*)::int AS open_exc
       FROM handyman_settlement_exceptions se
       JOIN handyman_settlement_units su ON su.id = se.unit_id
      WHERE su.execution_scope_id = $1
        AND se.exception_kind = 'DISPUTED'
        AND NOT EXISTS (
          SELECT 1 FROM handyman_settlement_dispute_resolutions r
           WHERE r.exception_id = se.id AND r.outcome = 'RELEASED'
        )`,
    [executionScopeId],
  );
  const openSettlementExceptions = settlementExcRes.rows[0]?.open_exc ?? 0;
  if (openSettlementExceptions > 0) {
    blockers.push({
      code: 'OPEN_SETTLEMENT_EXCEPTION',
      message: 'An open settlement exception exists on this execution scope.',
    });
  }
  const noBlockingExceptions = openDefects === 0 && openSettlementExceptions === 0;

  const eligibleForFinalClose =
    reconciliation.scopeStatus === 'AUTHORIZED' &&
    activeCrewAssigned &&
    workSessionsCompleted &&
    materialsSettled &&
    variationsReconciled &&
    supervisorQcPassed &&
    bastAccepted &&
    noPendingPayments &&
    ledgerFullySettled &&
    finalInvoicePaid &&
    noBlockingExceptions &&
    blockers.length === 0;

  return {
    readiness: {
      executionScopeId,
      handymanRequestId: reconciliation.handymanRequestId,
      scopeStatus: reconciliation.scopeStatus,
      eligibleForFinalClose,
      gates: {
        activeCrewAssigned,
        workSessionsCompleted,
        materialsSettled,
        variationsReconciled,
        supervisorQcPassed,
        bastAccepted,
        noPendingPayments,
        ledgerFullySettled,
        finalInvoicePaid,
        noBlockingExceptions,
      },
      blockers,
      reconciliation,
    },
    bastId,
    qcRunId,
    transactionId,
    invoiceId,
  };
}

export async function getHandymanFinalCloseReadiness(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanFinalCloseReadiness> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const { readiness } = await evaluateFinalCloseGates(
    getPool(),
    scopeUuid,
    actorUuid,
  );
  return readiness;
}

async function assertNotFieldExecutionActorOnScope(
  executor: Executor,
  executionScopeId: string,
  actorUserId: string,
): Promise<void> {
  const fieldActorRes = await executor.query<{ is_field_actor: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1
           FROM handyman_execution_scope_assignments a
           JOIN handyman_crew_memberships m ON m.handyman_crew_id = a.handyman_crew_id
           JOIN handyman_worker_contexts wc ON wc.id = m.handyman_worker_context_id
           JOIN workforce_profiles wp ON wp.id = wc.workforce_profile_id
          WHERE a.execution_scope_id = $1
            AND wp.user_id = $2
       )
       OR EXISTS (
         SELECT 1
           FROM handyman_execution_scopes s
           JOIN handyman_visit_appointments va ON va.handyman_request_id = s.handyman_request_id
          WHERE s.id = $1
            AND va.resource_type = 'INSPECTOR_USER'
            AND va.resource_id = $2
       )
     ) AS is_field_actor`,
    [executionScopeId, actorUserId],
  );
  if (fieldActorRes.rows[0]?.is_field_actor) {
    throw new AppError({
      code: ERROR_CODES.HANDYMAN_FINAL_CLOSE_NOT_AUTHORIZED,
      message:
        'Executing field crew members and assigned inspectors cannot perform Manager FINAL CLOSE.',
      statusCode: 403,
    });
  }
}

function mapCloseEventRow(
  row: Record<string, unknown>,
): HandymanExecutionScopeCloseEventRecord {
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    buildingId: String(row.building_id),
    executionScopeId: String(row.execution_scope_id),
    handymanRequestId: String(row.handyman_request_id),
    bastId: String(row.bast_id),
    qcRunId: String(row.qc_run_id),
    transactionId: String(row.transaction_id),
    invoiceId: String(row.invoice_id),
    currency: String(row.currency),
    chargedNetAmount: fromCents(toCents(row.charged_net_amount as string)),
    paidAppliedAmount: fromCents(toCents(row.paid_applied_amount as string)),
    actorUserId: String(row.actor_user_id),
    reason: String(row.reason),
    idempotencyKey: String(row.idempotency_key),
    occurredAt: (row.occurred_at instanceof Date
      ? row.occurred_at
      : new Date(String(row.occurred_at))
    ).toISOString(),
    createdAt: (row.created_at instanceof Date
      ? row.created_at
      : new Date(String(row.created_at))
    ).toISOString(),
  };
}

export async function executeHandymanManagerFinalClose(
  input: {
    executionScopeId: string;
    reason: string;
    idempotencyKey: string;
  },
  actorUserId: string,
): Promise<{
  closeEvent: HandymanExecutionScopeCloseEventRecord;
  readiness: HandymanFinalCloseReadiness;
  replayed: boolean;
}> {
  const scopeUuid = ensureUuid(input.executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 1 || reason.length > 500) {
    throw AppError.validation('Request validation failed.', [
      { field: 'reason', message: 'reason is required (1..500 characters).' },
    ]);
  }
  const idempotencyKey =
    typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  if (idempotencyKey.length < 1 || idempotencyKey.length > 200) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'idempotencyKey',
        message: 'idempotencyKey is required (1..200 characters).',
      },
    ]);
  }

  return withTransaction(async (tx) => {
    const scopeRes = await tx.query<{
      id: string;
      client_id: string;
      building_id: string;
      handyman_request_id: string;
      status: 'AUTHORIZED' | 'CLOSED';
    }>(
      `SELECT id, client_id, building_id, handyman_request_id, status
         FROM handyman_execution_scopes
        WHERE id = $1
        FOR UPDATE`,
      [scopeUuid],
    );
    const scope = scopeRes.rows[0];
    if (!scope) throw handymanCustomerTransactionScopeNotFoundError();

    if (
      !(await canAccessBuildingScopedResource(actorUuid, {
        clientId: scope.client_id,
        buildingId: scope.building_id,
      }))
    ) {
      throw handymanCustomerTransactionNotAuthorizedError();
    }

    await assertNotFieldExecutionActorOnScope(tx, scopeUuid, actorUuid);

    // Lock ledger transaction row if present to serialize concurrent payment/allocation mutations
    await tx.query(
      `SELECT id
         FROM handyman_customer_transactions
        WHERE execution_scope_id = $1
        FOR UPDATE`,
      [scopeUuid],
    );

    if (scope.status === 'CLOSED') {
      const existingEventRes = await tx.query<Record<string, unknown>>(
        `SELECT *
           FROM handyman_execution_scope_close_events
          WHERE execution_scope_id = $1`,
        [scopeUuid],
      );
      const existingEvent = existingEventRes.rows[0];
      if (
        existingEvent &&
        existingEvent.idempotency_key === idempotencyKey &&
        existingEvent.actor_user_id === actorUuid &&
        existingEvent.reason === reason
      ) {
        const { readiness } = await evaluateFinalCloseGates(
          tx,
          scopeUuid,
          actorUuid,
        );
        return {
          closeEvent: mapCloseEventRow(existingEvent),
          readiness,
          replayed: true,
        };
      }
      throw new AppError({
        code: ERROR_CODES.HANDYMAN_FINAL_CLOSE_ALREADY_CLOSED,
        message: 'Handyman execution scope is already CLOSED.',
        statusCode: 409,
      });
    }

    const { readiness, bastId, qcRunId, transactionId, invoiceId } =
      await evaluateFinalCloseGates(tx, scopeUuid, actorUuid);

    if (
      !readiness.eligibleForFinalClose ||
      !bastId ||
      !qcRunId ||
      !transactionId ||
      !invoiceId
    ) {
      throw new AppError({
        code: ERROR_CODES.HANDYMAN_FINAL_CLOSE_GATE_FAILED,
        message: `Handyman execution scope cannot be closed: ${readiness.blockers
          .map((b) => b.code)
          .join(', ')}`,
        statusCode: 409,
        details: readiness.blockers,
      });
    }

    const closeEventId = randomUUID();
    const insertedEventRes = await tx.query<Record<string, unknown>>(
      `INSERT INTO handyman_execution_scope_close_events (
         id, client_id, building_id, execution_scope_id, handyman_request_id,
         bast_id, qc_run_id, transaction_id, invoice_id, currency,
         charged_net_amount, paid_applied_amount, actor_user_id, reason,
         idempotency_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        closeEventId,
        scope.client_id,
        scope.building_id,
        scopeUuid,
        scope.handyman_request_id,
        bastId,
        qcRunId,
        transactionId,
        invoiceId,
        readiness.reconciliation.currency,
        readiness.reconciliation.ledgerSummary.chargedNet,
        readiness.reconciliation.ledgerSummary.totalConfirmedAllocatedNet,
        actorUuid,
        reason,
        idempotencyKey,
      ],
    );

    await tx.query(
      `UPDATE handyman_execution_scopes
          SET status = 'CLOSED',
              closed_at = NOW(),
              closed_by_user_id = $2,
              close_reason = $3,
              updated_at = NOW()
        WHERE id = $1 AND status = 'AUTHORIZED'`,
      [scopeUuid, actorUuid, reason],
    );

    await recordOperationalEvent(
      {
        clientId: scope.client_id,
        buildingId: scope.building_id,
        eventType: 'HANDYMAN_EXECUTION_SCOPE_FINAL_CLOSED',
        entityType: 'HANDYMAN_EXECUTION_SCOPE',
        entityId: scopeUuid,
        actorUserId: actorUuid,
        summary: 'Handyman execution scope final-closed by Manager.',
        metadata: {
          closeEventId,
          executionScopeId: scopeUuid,
          handymanRequestId: scope.handyman_request_id,
          bastId,
          qcRunId,
          transactionId,
          invoiceId,
          currency: readiness.reconciliation.currency,
          chargedNetAmount: readiness.reconciliation.ledgerSummary.chargedNet,
          paidAppliedAmount:
            readiness.reconciliation.ledgerSummary.totalConfirmedAllocatedNet,
          reason,
          idempotencyKey,
        },
      },
      tx,
    );

    const updatedReadiness = await evaluateFinalCloseGates(
      tx,
      scopeUuid,
      actorUuid,
    );

    return {
      closeEvent: mapCloseEventRow(insertedEventRes.rows[0]),
      readiness: updatedReadiness.readiness,
      replayed: false,
    };
  });
}
