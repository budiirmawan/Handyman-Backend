import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { logger } from '../../shared/logger';
import { recordOperationalEvent } from '../operational-events';
import { operationalCommitmentRepository } from './operational-commitment.repository';
import {
  applyCommitmentActualization,
  reverseCommitmentActualization,
} from './operational-commitment.service';

/**
 * CR-BE-COMM-VAR-01 PART 04 — Vendor / operational cost integration.
 *
 * Governed mapping:
 *
 *   Vendor Work / SPK / completion report / BAST  -> no commitment (no amount)
 *   Service-backed ISSUED Purchase Order line     -> COMMITMENT (PART 03 path)
 *   FINALIZED + VERIFIED Vendor Invoice           -> ACTUAL
 *   Vendor Invoice leaving that state             -> governed reversal
 *
 * `vendor_service_costs` and `basic_expenses` are never actualized here. They
 * carry a governed currency snapshot since CUR-02 PART 01 and are bound to
 * Operational Finance through the data-driven source-binding/aggregation path
 * (exact-currency only; unknown currency remains fail-closed). This module
 * handles vendor-invoice actualization only and never invents a currency, a
 * default, or an FX rate.
 *
 * Commitment creation reuses the PART 03 PO-line authority unchanged — a
 * service-backed line is simply a line whose originating request is a Service
 * Request. No second commitment path exists.
 */

export type VendorInvoiceActualizationInput = {
  invoiceId: string;
  clientId: string;
  buildingId: string;
  vendorId: string;
  purchaseOrderId: string | null;
  workOrderId: string | null;
  invoiceAmount: string;
  /** Governing date (`invoice_date`), used for the budget-period rule. */
  invoiceDate: string;
  currency: string | null;
  status: string;
  verificationStatus: string;
  actorUserId: string;
};

export type VendorInvoiceActualizationOutcome =
  | { outcome: 'NOT_ELIGIBLE' }
  | { outcome: 'NO_COMMITMENT' }
  | { outcome: 'AMBIGUOUS'; candidateCount: number }
  | { outcome: 'CURRENCY_MISMATCH' }
  | { outcome: 'ACTUALIZED'; commitmentId: string; appliedAmount: string };

function minimumAmount(left: string, right: string): string {
  return Number(left) <= Number(right) ? left : right;
}

function isEligible(input: VendorInvoiceActualizationInput): boolean {
  return input.status === 'FINALIZED' && input.verificationStatus === 'VERIFIED';
}

/**
 * Recognises a verified Vendor Invoice as actual cost against its commitment.
 *
 * Lineage is deterministic: the invoice's own Purchase Order first, then the
 * existing BE-17H work-order procurement binding. Zero candidates leaves the
 * invoice as an uncommitted actual (it still consumes budget through the
 * availability term); more than one candidate fails closed with an explicit
 * event and no guess.
 */
export async function actualizeVendorInvoice(
  client: Pick<PoolClient, 'query'>,
  input: VendorInvoiceActualizationInput,
): Promise<VendorInvoiceActualizationOutcome> {
  if (!isEligible(input)) return { outcome: 'NOT_ELIGIBLE' };
  if (Number(input.invoiceAmount) <= 0) return { outcome: 'NOT_ELIGIBLE' };

  const candidates =
    await operationalCommitmentRepository.findVendorInvoiceCommitmentCandidates(
      client,
      {
        id: input.invoiceId,
        buildingId: input.buildingId,
        purchaseOrderId: input.purchaseOrderId,
        workOrderId: input.workOrderId,
        invoiceDate: input.invoiceDate,
      },
    );

  if (candidates.length === 0) return { outcome: 'NO_COMMITMENT' };

  if (candidates.length > 1) {
    await recordOperationalEvent(
      {
        clientId: input.clientId,
        buildingId: input.buildingId,
        eventType: 'OPERATIONAL_COMMITMENT_VENDOR_LINEAGE_AMBIGUOUS',
        entityType: 'VENDOR_INVOICE',
        entityId: input.invoiceId,
        actorUserId: input.actorUserId,
        summary:
          'Vendor invoice cost was not actualized: more than one open commitment matches its purchase order lineage.',
        metadata: {
          vendorId: input.vendorId,
          purchaseOrderId: input.purchaseOrderId,
          workOrderId: input.workOrderId,
          candidateCommitmentIds: candidates.map((candidate) => candidate.id),
          invoiceAmount: input.invoiceAmount,
        },
      },
      client,
    );
    return { outcome: 'AMBIGUOUS', candidateCount: candidates.length };
  }

  const candidate = candidates[0];
  if (input.currency === null || input.currency !== candidate.currency) {
    await recordOperationalEvent(
      {
        clientId: input.clientId,
        buildingId: input.buildingId,
        eventType: 'OPERATIONAL_COMMITMENT_VENDOR_CURRENCY_MISMATCH',
        entityType: 'VENDOR_INVOICE',
        entityId: input.invoiceId,
        actorUserId: input.actorUserId,
        summary:
          'Vendor invoice cost was not actualized: its currency does not match the commitment currency.',
        metadata: {
          commitmentId: candidate.id,
          invoiceCurrency: input.currency,
          commitmentCurrency: candidate.currency,
        },
      },
      client,
    );
    return { outcome: 'CURRENCY_MISMATCH' };
  }

  const applied = minimumAmount(input.invoiceAmount, candidate.openAmount);
  const binding = await operationalCommitmentRepository.ensureVendorInvoiceBinding(
    client,
    {
      budgetId: candidate.budgetId,
      budgetCategoryId: candidate.budgetCategoryId,
      clientId: candidate.clientId,
      buildingId: candidate.buildingId,
      vendorInvoiceId: input.invoiceId,
      createdByUserId: input.actorUserId,
    },
  );

  await applyCommitmentActualization(client, candidate.id, {
    amount: Number(applied),
    sourceBindingId: binding.id,
    reason: `Verified vendor invoice ${input.invoiceId}`,
    idempotencyKey: `VENDOR_INVOICE:${input.invoiceId}`,
    actorUserId: input.actorUserId,
  });

  return { outcome: 'ACTUALIZED', commitmentId: candidate.id, appliedAmount: applied };
}

export type VendorInvoiceReversalOutcome =
  | { outcome: 'NOTHING_TO_REVERSE' }
  | { outcome: 'NOT_REVERSIBLE' }
  | { outcome: 'REVERSED'; commitmentId: string };

/**
 * Governed reversal for an invoice that lost its authoritative state (today:
 * cancellation of a previously verified, actualized invoice).
 *
 * The original `ACTUALIZE` entry is never edited: an append-only
 * `ACTUALIZE_REVERSAL` restores the open amount, the lineage row is marked
 * REMOVED (history preserved), and a commitment closed by that actualization
 * is reopened. A commitment already RELEASED or CANCELLED is left untouched —
 * its remainder was formally given back and must not be resurrected.
 */
export async function reverseVendorInvoiceActualization(
  client: Pick<PoolClient, 'query'>,
  input: { invoiceId: string; actorUserId: string; reason: string },
): Promise<VendorInvoiceReversalOutcome> {
  const binding =
    await operationalCommitmentRepository.findActiveBindingForVendorInvoice(
      client,
      input.invoiceId,
    );
  if (!binding) return { outcome: 'NOTHING_TO_REVERSE' };

  const link = await operationalCommitmentRepository.findCommitmentForBinding(
    client,
    binding.id,
  );
  if (!link) {
    // The lineage row exists without a single unambiguous actualization: mark
    // it removed but never guess which commitment to unwind.
    await operationalCommitmentRepository.removeSourceBinding(
      client,
      binding.id,
      input.actorUserId,
    );
    return { outcome: 'NOTHING_TO_REVERSE' };
  }

  const reversed = await reverseCommitmentActualization(client, link.commitmentId, {
    sourceBindingId: binding.id,
    reason: input.reason,
    idempotencyKey: `VENDOR_INVOICE_REVERSAL:${input.invoiceId}`,
    actorUserId: input.actorUserId,
  });
  if (!reversed) return { outcome: 'NOTHING_TO_REVERSE' };

  await operationalCommitmentRepository.removeSourceBinding(
    client,
    binding.id,
    input.actorUserId,
  );

  return { outcome: 'REVERSED', commitmentId: link.commitmentId };
}

/**
 * Non-blocking wrappers used by the Vendor Invoice module.
 *
 * The invoice state change is already authoritative and committed when these
 * run, so the seam gets its own transaction and never rejects the invoice
 * command. A failure is conservative rather than lossy: the invoice keeps
 * consuming budget as an uncommitted actual and its commitment stays open, so
 * available budget is never overstated.
 */
export async function tryActualizeVendorInvoice(
  input: VendorInvoiceActualizationInput,
): Promise<VendorInvoiceActualizationOutcome | { outcome: 'FAILED' }> {
  try {
    return await withTransaction((client) => actualizeVendorInvoice(client, input));
  } catch (error) {
    logger.warn('Verified vendor invoice could not be actualized', {
      operation: 'operational_commitment.vendor_actualization_failed',
      resourceType: 'VENDOR_INVOICE',
      resourceId: input.invoiceId,
      buildingId: input.buildingId,
      errorMessage: error instanceof Error ? error.message : 'unknown error',
    });
    return { outcome: 'FAILED' };
  }
}

export async function tryReverseVendorInvoiceActualization(input: {
  invoiceId: string;
  buildingId: string;
  actorUserId: string;
  reason: string;
}): Promise<VendorInvoiceReversalOutcome | { outcome: 'FAILED' }> {
  try {
    return await withTransaction((client) =>
      reverseVendorInvoiceActualization(client, {
        invoiceId: input.invoiceId,
        actorUserId: input.actorUserId,
        reason: input.reason,
      }),
    );
  } catch (error) {
    logger.warn('Vendor invoice actualization could not be reversed', {
      operation: 'operational_commitment.vendor_reversal_failed',
      resourceType: 'VENDOR_INVOICE',
      resourceId: input.invoiceId,
      buildingId: input.buildingId,
      errorMessage: error instanceof Error ? error.message : 'unknown error',
    });
    return { outcome: 'FAILED' };
  }
}

export const operationalCommitmentVendorService = {
  actualizeVendorInvoice,
  reverseVendorInvoiceActualization,
  tryActualizeVendorInvoice,
  tryReverseVendorInvoiceActualization,
};
