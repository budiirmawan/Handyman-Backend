import { getPool, withTransaction } from '../../database';
import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import {
  vendorInactiveError,
  vendorNotFoundError,
  vendorRepository,
} from '../vendors';
import { vendorBuildingRepository } from '../vendor-buildings';
import { workOrderRepository } from '../work-orders';
import { vendorWorkRepository } from '../vendor-work';
import { vendorCompletionReportRepository } from '../vendor-completion-reports/vendor-completion-report.repository';
import { vendorServiceReportRepository } from '../vendor-service-reports/vendor-service-report.repository';
import { bastDocumentRepository } from '../bast-documents/bast-document.repository';
import {
  purchaseOrderLineRepository,
  purchaseOrderRepository,
} from '../purchase-orders';
import { materialRequestRepository } from '../material-requests';
import { permissionService } from '../permissions';
import { purchaseRequestRepository } from '../purchase-requests';
import { receivingRepository } from '../receivings';
import { serviceRequestRepository } from '../service-requests';
import { workContractRepository } from '../work-contracts';
import { workOrderProcurementBindingRepository } from '../work-order-procurement-bindings';
import { vendorAssignmentRepository } from '../vendor-assignments/vendor-assignment.repository';
import {
  vendorInvoiceAlreadyVerifiedError,
  vendorInvoiceCancelNotAllowedError,
  vendorInvoiceContextInvalidError,
  vendorInvoicePurchaseOrderInvalidError,
  vendorInvoicePurchaseOrderNotIssuedError,
  vendorInvoiceProcurementScopeMismatchError,
  vendorInvoiceProcurementVendorMismatchError,
  vendorInvoiceWorkContractInvalidError,
  vendorInvoiceWorkContractNotEligibleError,
  vendorInvoiceWorkContractPoMismatchError,
  vendorInvoiceDiscrepancyError,
  vendorInvoiceFinalizedProtectedError,
  vendorInvoiceNotDraftError,
  vendorInvoiceNotFinalizedError,
  vendorInvoiceMatchingNotReadyError,
  vendorInvoiceNotVerifiedForPaymentError,
  vendorInvoiceOverpaymentError,
  vendorInvoicePaymentAmountInvalidError,
  vendorInvoicePaymentNotAllowedError,
  vendorInvoicePaymentNotReadyError,
  vendorInvoiceNotFoundError,
  vendorInvoiceNumberExistsError,
  vendorInvoiceVendorInvalidError,
} from './vendor-invoice.errors';
import { vendorInvoiceRepository } from './vendor-invoice.repository';
import type {
  BastHardGateResult,
  CreateVendorInvoiceInput,
  InvoiceMatchingCheck,
  InvoiceMatchingResult,
  NewVendorInvoice,
  PublicVendorInvoice,
  RecordVendorPaymentInput,
  R2PTraceDocument,
  R2PTraceDocumentType,
  R2PTraceRelationship,
  R2PTraceRelationshipType,
  UpdateVendorInvoiceInput,
  VendorConsistencyCheck,
  VendorConsistencyCode,
  VendorConsistencyResult,
  VendorInvoiceAvailableActions,
  VendorInvoiceDiscrepancyCode,
  VendorInvoiceFilters,
  VendorInvoiceMatchingStatus,
  VendorInvoiceRecord,
  VendorInvoiceTrace,
  VendorSettlementReadinessResult,
  VendorSettlementReason,
  VerifyVendorInvoiceInput,
} from './vendor-invoice.types';
import {
  isValidVendorPaymentAmount,
  isVendorInvoiceCurrency,
  isVendorInvoiceEligiblePurchaseOrderStatus,
  VENDOR_INVOICE_ACTIONS,
  isVendorInvoiceEligibleWorkContractStatus,
} from './vendor-invoice.types';
// CR-BE-COMM-VAR-01 PART 04 — operational cost-control seam. Direct module
// path keeps this import free of the operational-finance route graph.
import { operationalCommitmentVendorService } from '../operational-finance/operational-commitment-vendor.service';

function toPublic(record: VendorInvoiceRecord): PublicVendorInvoice {
  return {
    ...record,
    invoiceAmount: Number(record.invoiceAmount),
    paidAmount: Number(record.paidAmount),
    outstandingAmount: Number(record.outstandingAmount),
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
    finalizedAt: record.finalizedAt?.toISOString() ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

// ─── PART 01: Invoice lifecycle ─────────────────────────────────

/**
 * Validates that the Vendor exists, is ACTIVE, and holds an ACTIVE
 * relationship to the invoice's Building. Returns the Vendor's clientId.
 */
async function assertVendorContext(
  vendorId: string,
  buildingId: string,
): Promise<string> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) throw vendorNotFoundError();
  if (vendor.status !== 'ACTIVE') throw vendorInactiveError();

  const relationship =
    await vendorBuildingRepository.findActiveByVendorAndBuilding(
      vendorId,
      buildingId,
    );
  if (!relationship) throw vendorInvoiceVendorInvalidError();

  return vendor.clientId;
}

/**
 * Validates optional stable references against the invoice context.
 * Each referenced entity must belong to the same Client + Building
 * and be consistent with the Vendor and each other.
 */
async function assertContextReferences(
  input: {
    clientId: string;
    buildingId: string;
    vendorId: string;
    vendorWorkId: string | null;
    workOrderId: string | null;
    completionReportId: string | null;
    serviceReportId: string | null;
    bastDocumentId: string | null;
    purchaseOrderId: string | null;
    workContractId: string | null;
  },
): Promise<void> {
  const vendorWork = input.vendorWorkId
    ? await vendorWorkRepository.findById(input.vendorWorkId)
    : null;
  if (
    input.vendorWorkId &&
    (!vendorWork ||
      vendorWork.buildingId !== input.buildingId ||
      vendorWork.vendorId !== input.vendorId)
  ) {
    throw vendorInvoiceContextInvalidError();
  }

  const workOrder = input.workOrderId
    ? await workOrderRepository.findById(input.workOrderId)
    : null;
  if (
    input.workOrderId &&
    (!workOrder ||
      workOrder.clientId !== input.clientId ||
      workOrder.buildingId !== input.buildingId)
  ) {
    throw vendorInvoiceContextInvalidError();
  }
  if (vendorWork && workOrder && vendorWork.workOrderId !== workOrder.id) {
    throw vendorInvoiceContextInvalidError();
  }

  const completionReport = input.completionReportId
    ? await vendorCompletionReportRepository.findById(input.completionReportId)
    : null;
  if (input.completionReportId && !completionReport) {
    throw vendorInvoiceContextInvalidError();
  }
  if (completionReport) {
    const reportVendorWork =
      vendorWork?.id === completionReport.vendorWorkId
        ? vendorWork
        : await vendorWorkRepository.findById(completionReport.vendorWorkId);
    if (
      completionReport.clientId !== input.clientId ||
      completionReport.buildingId !== input.buildingId ||
      (input.vendorWorkId !== null &&
        completionReport.vendorWorkId !== input.vendorWorkId) ||
      (input.workOrderId !== null &&
        completionReport.workOrderId !== input.workOrderId) ||
      !reportVendorWork ||
      reportVendorWork.vendorId !== input.vendorId ||
      reportVendorWork.buildingId !== input.buildingId ||
      reportVendorWork.workOrderId !== completionReport.workOrderId
    ) {
      throw vendorInvoiceContextInvalidError();
    }
  }

  const serviceReport = input.serviceReportId
    ? await vendorServiceReportRepository.findById(input.serviceReportId)
    : null;
  if (input.serviceReportId && !serviceReport) {
    throw vendorInvoiceContextInvalidError();
  }
  if (serviceReport) {
    const reportVendorWork =
      vendorWork?.id === serviceReport.vendorWorkId
        ? vendorWork
        : await vendorWorkRepository.findById(serviceReport.vendorWorkId);
    if (
      serviceReport.clientId !== input.clientId ||
      serviceReport.buildingId !== input.buildingId ||
      (input.vendorWorkId !== null &&
        serviceReport.vendorWorkId !== input.vendorWorkId) ||
      (input.workOrderId !== null &&
        serviceReport.workOrderId !== input.workOrderId) ||
      !reportVendorWork ||
      reportVendorWork.vendorId !== input.vendorId ||
      reportVendorWork.buildingId !== input.buildingId ||
      reportVendorWork.workOrderId !== serviceReport.workOrderId
    ) {
      throw vendorInvoiceContextInvalidError();
    }
  }
  if (
    completionReport &&
    serviceReport &&
    (completionReport.vendorWorkId !== serviceReport.vendorWorkId ||
      completionReport.workOrderId !== serviceReport.workOrderId)
  ) {
    throw vendorInvoiceContextInvalidError();
  }

  if (input.bastDocumentId) {
    const bast = await bastDocumentRepository.findById(input.bastDocumentId);
    if (!bast) throw vendorInvoiceContextInvalidError();
    const bastVendorWork = bast.vendorWorkId
      ? await vendorWorkRepository.findById(bast.vendorWorkId)
      : null;
    if (
      bast.clientId !== input.clientId ||
      bast.buildingId !== input.buildingId ||
      (bast.vendorId !== null && bast.vendorId !== input.vendorId) ||
      (input.workOrderId !== null && bast.workOrderId !== input.workOrderId) ||
      (input.vendorWorkId !== null &&
        bast.vendorWorkId !== null &&
        bast.vendorWorkId !== input.vendorWorkId) ||
      (bast.completionReportId !== null &&
        input.completionReportId !== null &&
        bast.completionReportId !== input.completionReportId) ||
      (bast.serviceReportId !== null &&
        input.serviceReportId !== null &&
        bast.serviceReportId !== input.serviceReportId) ||
      (bastVendorWork !== null &&
        (bastVendorWork.vendorId !== input.vendorId ||
          bastVendorWork.buildingId !== input.buildingId ||
          bastVendorWork.workOrderId !== bast.workOrderId))
    ) {
      throw vendorInvoiceContextInvalidError();
    }
  }

  await assertProcurementChain(input);
}

/**
 * CR-BE-R2P-01 PART 06 — validates the authoritative commercial chain behind
 * an invoice:
 *
 *   Request → Vendor → ISSUED PO → ACTIVE/COMPLETED SPK → WO → BAST → Invoice
 *
 * The PO and SPK are READ from their own authorities and never mutated: this
 * adds no invoice lifecycle, no PO quantity ledger and no second commercial
 * authority. The invoice's amount, status, verification, BAST gate and
 * settlement readiness are all untouched by the linkage.
 *
 * Vendor, Client and Building are VALIDATED against the chain rather than
 * derived through it, because the invoice already owns those fields (they
 * come from the Vendor + Building the invoice is raised under). A mismatch is
 * rejected here and, as a second line of defence, made unrepresentable by the
 * composite FKs `vendor_invoices_po_scope_fk` / `vendor_invoices_spk_scope_fk`.
 */
async function assertProcurementChain(input: {
  clientId: string;
  buildingId: string;
  vendorId: string;
  purchaseOrderId: string | null;
  workContractId: string | null;
}): Promise<void> {
  if (!input.purchaseOrderId && !input.workContractId) return;

  // An SPK is executed under a PO; it can never be linked on its own.
  if (input.workContractId && !input.purchaseOrderId) {
    throw vendorInvoiceWorkContractPoMismatchError();
  }

  const purchaseOrder = await purchaseOrderRepository.findById(
    input.purchaseOrderId as string,
  );
  if (!purchaseOrder) throw vendorInvoicePurchaseOrderInvalidError();

  // Only the existing committed state is eligible for invoice linkage.
  if (!isVendorInvoiceEligiblePurchaseOrderStatus(purchaseOrder.status)) {
    throw vendorInvoicePurchaseOrderNotIssuedError(purchaseOrder.status);
  }
  if (purchaseOrder.vendorId !== input.vendorId) {
    throw vendorInvoiceProcurementVendorMismatchError();
  }
  if (
    purchaseOrder.clientId !== input.clientId ||
    purchaseOrder.buildingId !== input.buildingId
  ) {
    throw vendorInvoiceProcurementScopeMismatchError();
  }

  if (!input.workContractId) return;

  const workContract = await workContractRepository.findById(
    input.workContractId,
  );
  if (!workContract) throw vendorInvoiceWorkContractInvalidError();

  // The SPK must be the one executed under this very Purchase Order.
  if (workContract.purchaseOrderId !== purchaseOrder.id) {
    throw vendorInvoiceWorkContractPoMismatchError();
  }
  if (workContract.vendorId !== input.vendorId) {
    throw vendorInvoiceProcurementVendorMismatchError();
  }
  if (
    workContract.clientId !== input.clientId ||
    workContract.buildingId !== input.buildingId
  ) {
    throw vendorInvoiceProcurementScopeMismatchError();
  }
  if (!isVendorInvoiceEligibleWorkContractStatus(workContract.status)) {
    throw vendorInvoiceWorkContractNotEligibleError(workContract.status);
  }
}

async function loadAccessible(
  id: string,
  actorUserId: string,
): Promise<VendorInvoiceRecord> {
  const record = await vendorInvoiceRepository.findById(id);
  if (!record) throw vendorInvoiceNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    record.buildingId,
  );
  return record;
}

/**
 * Creates a Vendor Invoice under a Vendor + Building.
 */
export async function createVendorInvoice(
  vendorId: string,
  input: CreateVendorInvoiceInput,
  actorUserId: string,
): Promise<PublicVendorInvoice> {
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    input.buildingId,
  );

  const clientId = await assertVendorContext(vendorId, input.buildingId);

  await assertContextReferences({
    clientId,
    buildingId: input.buildingId,
    vendorId,
    vendorWorkId: input.vendorWorkId ?? null,
    workOrderId: input.workOrderId ?? null,
    completionReportId: input.completionReportId ?? null,
    serviceReportId: input.serviceReportId ?? null,
    bastDocumentId: input.bastDocumentId ?? null,
    purchaseOrderId: input.purchaseOrderId ?? null,
    workContractId: input.workContractId ?? null,
  });

  const newInvoice: NewVendorInvoice = {
    clientId,
    buildingId: input.buildingId,
    vendorId,
    invoiceNumber: input.invoiceNumber,
    invoiceDate: input.invoiceDate,
    receivedDate: input.receivedDate,
    currency: input.currency,
    invoiceAmount: input.invoiceAmount,
    status: 'DRAFT',
    vendorReference: input.vendorReference?.trim() || null,
    vendorWorkId: input.vendorWorkId ?? null,
    workOrderId: input.workOrderId ?? null,
    completionReportId: input.completionReportId ?? null,
    serviceReportId: input.serviceReportId ?? null,
    bastDocumentId: input.bastDocumentId ?? null,
    purchaseOrderId: input.purchaseOrderId ?? null,
    workContractId: input.workContractId ?? null,
    notes: input.notes?.trim() || null,
    createdByUserId: actorUserId,
    verificationStatus: 'PENDING',
    discrepancyCodes: [],
    paymentStatus: 'UNPAID',
    paidAmount: 0,
  };

  try {
    const record = await vendorInvoiceRepository.create(newInvoice);
    await recordOperationalEvent({
      clientId,
      buildingId: record.buildingId,
      eventType: 'VENDOR_INVOICE_CREATED',
      entityType: 'VENDOR_INVOICE',
      entityId: record.id,
      actorUserId,
      summary: `Vendor Invoice ${record.invoiceNumber} created as draft.`,
      metadata: {
        vendorId: record.vendorId,
        invoiceAmount: record.invoiceAmount,
        currency: record.currency,
        purchaseOrderId: record.purchaseOrderId,
        workContractId: record.workContractId,
      },
    });
    return toPublic(record);
  } catch (error) {
    if (isUniqueViolation(error)) throw vendorInvoiceNumberExistsError();
    throw error;
  }
}

export async function getVendorInvoice(
  id: string,
  actorUserId: string,
): Promise<PublicVendorInvoice> {
  return toPublic(await loadAccessible(id, actorUserId));
}

export async function listVendorInvoices(
  filters: VendorInvoiceFilters,
  actorUserId: string,
): Promise<PublicVendorInvoice[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds =
    await contextAccessService.getAccessibleBuildingIds(actorUserId);
  const records = await vendorInvoiceRepository.list(filters, buildingIds);
  return records.map(toPublic);
}

export async function resolveVendorInvoiceAvailableActions(
  id: string,
  actorUserId: string,
): Promise<VendorInvoiceAvailableActions> {
  const invoice = await loadAccessible(id, actorUserId);
  const settlement = await evaluateSettlementReadiness(invoice);
  const permissions =
    await permissionService.resolvePermissionsForUser(actorUserId);
  const allowed = new Set<VendorInvoiceAvailableActions['availableActions'][number]>();

  if (permissions.includes('vendor_invoice.manage')) {
    if (invoice.status === 'DRAFT') {
      allowed.add('FINALIZE');
      allowed.add('CANCEL');
    } else if (invoice.status === 'FINALIZED') {
      allowed.add('CANCEL');
      if (
        settlement.matchingStatus !== 'NOT_READY' &&
        !(
          invoice.verificationStatus === 'VERIFIED' &&
          settlement.matchingStatus === 'MATCHED'
        )
      ) {
        allowed.add('VERIFY');
      }
      if (settlement.readiness === 'READY') {
        allowed.add('RECORD_PAYMENT');
      }
    }
  }
  const availableActions = VENDOR_INVOICE_ACTIONS.filter((action) =>
    allowed.has(action),
  );

  return {
    vendorInvoiceId: invoice.id,
    state: invoice.status,
    verificationStatus: invoice.verificationStatus,
    matchingStatus: settlement.matchingStatus,
    settlementReadiness: settlement.readiness,
    availableActions,
  };
}

export async function updateVendorInvoice(
  id: string,
  input: UpdateVendorInvoiceInput,
  actorUserId: string,
): Promise<PublicVendorInvoice> {
  const current = await loadAccessible(id, actorUserId);
  if (current.status === 'FINALIZED') {
    throw vendorInvoiceFinalizedProtectedError();
  }
  if (current.status !== 'DRAFT') throw vendorInvoiceNotDraftError();

  const updated = await vendorInvoiceRepository.update(id, input, actorUserId);
  if (!updated) throw vendorInvoiceNotDraftError();
  return toPublic(updated);
}

export async function finalizeVendorInvoice(
  id: string,
  actorUserId: string,
): Promise<PublicVendorInvoice> {
  const current = await loadAccessible(id, actorUserId);
  if (current.status === 'FINALIZED') {
    throw vendorInvoiceFinalizedProtectedError();
  }
  if (current.status !== 'DRAFT') throw vendorInvoiceNotDraftError();

  const finalized = await vendorInvoiceRepository.finalize(id, actorUserId);
  if (!finalized) throw vendorInvoiceFinalizedProtectedError();

  await recordOperationalEvent({
    clientId: finalized.clientId,
    buildingId: finalized.buildingId,
    eventType: 'VENDOR_INVOICE_FINALIZED',
    entityType: 'VENDOR_INVOICE',
    entityId: finalized.id,
    actorUserId,
    summary: `Vendor Invoice ${finalized.invoiceNumber} finalized.`,
    metadata: {
      invoiceAmount: finalized.invoiceAmount,
      currency: finalized.currency,
    },
  });

  return toPublic(finalized);
}

export async function cancelVendorInvoice(
  id: string,
  actorUserId: string,
): Promise<PublicVendorInvoice> {
  const current = await loadAccessible(id, actorUserId);
  if (current.status === 'CANCELLED') {
    throw vendorInvoiceCancelNotAllowedError();
  }

  const cancelled = await vendorInvoiceRepository.cancel(id, actorUserId);
  if (!cancelled) throw vendorInvoiceCancelNotAllowedError();

  await recordOperationalEvent({
    clientId: cancelled.clientId,
    buildingId: cancelled.buildingId,
    eventType: 'VENDOR_INVOICE_CANCELLED',
    entityType: 'VENDOR_INVOICE',
    entityId: cancelled.id,
    actorUserId,
    summary: `Vendor Invoice ${cancelled.invoiceNumber} cancelled.`,
  });

  // CR-BE-COMM-VAR-01 PART 04 — a cancelled invoice is no longer authoritative
  // actual cost. This is the only existing invoice state that justifies a
  // governed actualization reversal.
  await operationalCommitmentVendorService.tryReverseVendorInvoiceActualization({
    invoiceId: cancelled.id,
    buildingId: cancelled.buildingId,
    actorUserId,
    reason: 'Vendor invoice cancelled.',
  });

  return toPublic(cancelled);
}

// ─── PART 02: Verification / Matching ───────────────────────────

/**
 * Canonical Vendor Invoice matching result.
 *
 * This evaluator is read-only and reuses existing authorities:
 * Vendor Invoice → immutable PO/SPK references → PO Lines → MR/SR receiving
 * evidence, plus the already-linked Work Order/Vendor Work/completion/service/
 * BAST evidence. It persists no quantities and creates no parallel lifecycle.
 */
export async function evaluateMatching(
  invoice: VendorInvoiceRecord,
): Promise<InvoiceMatchingResult> {
  const vendorMatch = await evaluateVendorMatch(invoice);
  const purchaseOrderMatch = await evaluatePurchaseOrderMatch(invoice);
  const workContractMatch = await evaluateWorkContractMatch(invoice);
  const amountMatch = await evaluateAmountMatch(invoice);
  const receivingMatch = await evaluateReceivingMatch(invoice);
  const workOrderMatch = await evaluateWorkOrderMatch(invoice);
  const vendorWorkMatch = await evaluateVendorWorkMatch(invoice);
  const completionMatch = await evaluateCompletionMatch(invoice);
  const serviceMatch = await evaluateServiceMatch(invoice);
  const bastMatch = await evaluateBastMatch(invoice);

  const checks = [
    vendorMatch,
    purchaseOrderMatch,
    workContractMatch,
    amountMatch,
    receivingMatch,
    workOrderMatch,
    vendorWorkMatch,
    completionMatch,
    serviceMatch,
    bastMatch,
  ];
  const mismatchCodes = reasonCodes(checks, 'MISMATCH');
  const notReadyCodes = reasonCodes(checks, 'NOT_READY');
  const status: VendorInvoiceMatchingStatus =
    mismatchCodes.length > 0
      ? 'MISMATCH'
      : notReadyCodes.length > 0
        ? 'NOT_READY'
        : 'MATCHED';

  return {
    invoiceId: invoice.id,
    status,
    verificationEligible: status === 'MATCHED',
    vendorMatch,
    purchaseOrderMatch,
    workContractMatch,
    amountMatch,
    receivingMatch,
    workOrderMatch,
    vendorWorkMatch,
    completionMatch,
    serviceMatch,
    bastMatch,
    allMatched: status === 'MATCHED',
    mismatchCodes,
    notReadyCodes,
    discrepancyCodes: [...mismatchCodes, ...notReadyCodes],
    evaluatedAt: new Date().toISOString(),
  };
}

function reasonCodes(
  checks: InvoiceMatchingCheck[],
  status: Exclude<VendorInvoiceMatchingStatus, 'MATCHED'>,
): VendorInvoiceDiscrepancyCode[] {
  return [
    ...new Set(
      checks
        .filter((check) => check.status === status && check.discrepancy)
        .map((check) => check.discrepancy as VendorInvoiceDiscrepancyCode),
    ),
  ];
}

function matchedCheck(name: string, applicable = true): InvoiceMatchingCheck {
  return {
    check: name,
    applicable,
    status: 'MATCHED',
    matched: true,
    discrepancy: null,
  };
}

function failedCheck(
  name: string,
  status: 'MISMATCH' | 'NOT_READY',
  discrepancy: VendorInvoiceDiscrepancyCode,
): InvoiceMatchingCheck {
  return { check: name, applicable: true, status, matched: false, discrepancy };
}

async function evaluateVendorMatch(
  invoice: VendorInvoiceRecord,
): Promise<InvoiceMatchingCheck> {
  const vendor = await vendorRepository.findById(invoice.vendorId);
  if (
    !vendor ||
    vendor.status !== 'ACTIVE' ||
    vendor.clientId !== invoice.clientId
  ) {
    return failedCheck('vendorMatch', 'MISMATCH', 'VENDOR_MISMATCH');
  }
  const relationship =
    await vendorBuildingRepository.findActiveByVendorAndBuilding(
      invoice.vendorId,
      invoice.buildingId,
    );
  return relationship
    ? matchedCheck('vendorMatch')
    : failedCheck('vendorMatch', 'MISMATCH', 'VENDOR_MISMATCH');
}

async function evaluatePurchaseOrderMatch(
  invoice: VendorInvoiceRecord,
): Promise<InvoiceMatchingCheck> {
  if (!invoice.purchaseOrderId) {
    // Backward compatibility: legacy/unlinked invoices retain the existing
    // operational matching path. Procurement matching is simply not applicable.
    return matchedCheck('purchaseOrderMatch', false);
  }
  const purchaseOrder = await purchaseOrderRepository.findById(
    invoice.purchaseOrderId,
  );
  if (!purchaseOrder) {
    return failedCheck(
      'purchaseOrderMatch',
      'MISMATCH',
      'PURCHASE_ORDER_NOT_FOUND',
    );
  }
  if (!isVendorInvoiceEligiblePurchaseOrderStatus(purchaseOrder.status)) {
    return failedCheck(
      'purchaseOrderMatch',
      'MISMATCH',
      'PURCHASE_ORDER_NOT_ISSUED',
    );
  }
  if (
    purchaseOrder.clientId !== invoice.clientId ||
    purchaseOrder.buildingId !== invoice.buildingId
  ) {
    return failedCheck(
      'purchaseOrderMatch',
      'MISMATCH',
      'PURCHASE_ORDER_SCOPE_MISMATCH',
    );
  }
  if (purchaseOrder.vendorId !== invoice.vendorId) {
    return failedCheck(
      'purchaseOrderMatch',
      'MISMATCH',
      'PURCHASE_ORDER_VENDOR_MISMATCH',
    );
  }
  return matchedCheck('purchaseOrderMatch');
}

async function evaluateWorkContractMatch(
  invoice: VendorInvoiceRecord,
): Promise<InvoiceMatchingCheck> {
  if (!invoice.workContractId) {
    return matchedCheck('workContractMatch', false);
  }
  const workContract = await workContractRepository.findById(
    invoice.workContractId,
  );
  if (!workContract) {
    return failedCheck(
      'workContractMatch',
      'MISMATCH',
      'WORK_CONTRACT_NOT_FOUND',
    );
  }
  if (
    !invoice.purchaseOrderId ||
    workContract.purchaseOrderId !== invoice.purchaseOrderId
  ) {
    return failedCheck(
      'workContractMatch',
      'MISMATCH',
      'WORK_CONTRACT_PO_MISMATCH',
    );
  }
  if (
    workContract.clientId !== invoice.clientId ||
    workContract.buildingId !== invoice.buildingId
  ) {
    return failedCheck(
      'workContractMatch',
      'MISMATCH',
      'WORK_CONTRACT_SCOPE_MISMATCH',
    );
  }
  if (workContract.vendorId !== invoice.vendorId) {
    return failedCheck(
      'workContractMatch',
      'MISMATCH',
      'WORK_CONTRACT_VENDOR_MISMATCH',
    );
  }
  if (!isVendorInvoiceEligibleWorkContractStatus(workContract.status)) {
    return failedCheck(
      'workContractMatch',
      'MISMATCH',
      'WORK_CONTRACT_NOT_ELIGIBLE',
    );
  }
  return matchedCheck('workContractMatch');
}

async function evaluateAmountMatch(
  invoice: VendorInvoiceRecord,
): Promise<InvoiceMatchingCheck> {
  const invoiceAmount = Number(invoice.invoiceAmount);
  if (!Number.isFinite(invoiceAmount) || invoiceAmount <= 0) {
    return failedCheck('amountMatch', 'MISMATCH', 'AMOUNT_INVALID');
  }
  if (!invoice.purchaseOrderId) return matchedCheck('amountMatch');

  const purchaseOrder = await purchaseOrderRepository.findById(
    invoice.purchaseOrderId,
  );
  if (!purchaseOrder) {
    return failedCheck('amountMatch', 'MISMATCH', 'PURCHASE_ORDER_NOT_FOUND');
  }
  const lines = await purchaseOrderLineRepository.listByPurchaseOrder(
    purchaseOrder.id,
  );
  if (lines.length === 0) {
    return failedCheck(
      'amountMatch',
      'NOT_READY',
      'PURCHASE_ORDER_LINES_NOT_FOUND',
    );
  }
  if (purchaseOrder.currency !== invoice.currency) {
    return failedCheck('amountMatch', 'MISMATCH', 'CURRENCY_MISMATCH');
  }
  const committedAmount = Number(
    lines.reduce((total, line) => total + line.lineAmount, 0).toFixed(2),
  );
  return Math.abs(committedAmount - invoiceAmount) < 0.005
    ? matchedCheck('amountMatch')
    : failedCheck('amountMatch', 'MISMATCH', 'INVOICE_PO_AMOUNT_MISMATCH');
}

async function evaluateReceivingMatch(
  invoice: VendorInvoiceRecord,
): Promise<InvoiceMatchingCheck> {
  if (!invoice.purchaseOrderId) return matchedCheck('receivingMatch', false);
  const lines = await purchaseOrderLineRepository.listByPurchaseOrder(
    invoice.purchaseOrderId,
  );
  if (lines.length === 0) {
    return failedCheck(
      'receivingMatch',
      'NOT_READY',
      'PURCHASE_ORDER_LINES_NOT_FOUND',
    );
  }

  for (const line of lines) {
    if (line.materialRequestId) {
      const request = await materialRequestRepository.findById(
        line.materialRequestId,
      );
      if (!request) {
        return failedCheck(
          'receivingMatch',
          'MISMATCH',
          'MATERIAL_REQUEST_NOT_FOUND',
        );
      }
      const allowedQuantity = request.approvedQuantity ?? request.quantity;
      const receivedQuantity =
        await materialRequestRepository.sumReceivedQuantity(request.id);
      if (receivedQuantity > allowedQuantity + Number.EPSILON) {
        return failedCheck(
          'receivingMatch',
          'MISMATCH',
          'MATERIAL_RECEIVING_OVER_APPROVED',
        );
      }
      if (receivedQuantity < allowedQuantity - Number.EPSILON) {
        return failedCheck(
          'receivingMatch',
          'NOT_READY',
          'MATERIAL_RECEIVING_NOT_COMPLETE',
        );
      }
      continue;
    }

    if (line.serviceRequestId) {
      const receivings = await receivingRepository.listByRequest(
        null,
        line.serviceRequestId,
        invoice.buildingId,
        {},
      );
      const finalized = receivings.some(
        (receiving) =>
          receiving.vendorId === invoice.vendorId &&
          receiving.receivingType === 'SERVICE' &&
          receiving.status === 'FINALIZED',
      );
      if (!finalized) {
        return failedCheck(
          'receivingMatch',
          'NOT_READY',
          'SERVICE_RECEIVING_NOT_FINALIZED',
        );
      }
    }
  }
  return matchedCheck('receivingMatch');
}

async function evaluateWorkOrderMatch(
  invoice: VendorInvoiceRecord,
): Promise<InvoiceMatchingCheck> {
  if (!invoice.workOrderId) return matchedCheck('workOrderMatch', false);
  const workOrder = await workOrderRepository.findById(invoice.workOrderId);
  if (!workOrder) {
    return failedCheck('workOrderMatch', 'MISMATCH', 'WORK_ORDER_NOT_FOUND');
  }
  if (
    workOrder.clientId !== invoice.clientId ||
    workOrder.buildingId !== invoice.buildingId
  ) {
    return failedCheck(
      'workOrderMatch',
      'MISMATCH',
      'WORK_ORDER_SCOPE_MISMATCH',
    );
  }
  return matchedCheck('workOrderMatch');
}

async function evaluateVendorWorkMatch(
  invoice: VendorInvoiceRecord,
): Promise<InvoiceMatchingCheck> {
  if (!invoice.vendorWorkId) return matchedCheck('vendorWorkMatch', false);
  const vendorWork = await vendorWorkRepository.findById(invoice.vendorWorkId);
  if (!vendorWork) {
    return failedCheck('vendorWorkMatch', 'MISMATCH', 'VENDOR_WORK_NOT_FOUND');
  }
  if (
    vendorWork.vendorId !== invoice.vendorId ||
    vendorWork.buildingId !== invoice.buildingId
  ) {
    return failedCheck(
      'vendorWorkMatch',
      'MISMATCH',
      'VENDOR_WORK_VENDOR_MISMATCH',
    );
  }
  if (
    invoice.workOrderId !== null &&
    vendorWork.workOrderId !== invoice.workOrderId
  ) {
    return failedCheck(
      'vendorWorkMatch',
      'MISMATCH',
      'WORK_ORDER_SCOPE_MISMATCH',
    );
  }
  return matchedCheck('vendorWorkMatch');
}

async function evaluateCompletionMatch(
  invoice: VendorInvoiceRecord,
): Promise<InvoiceMatchingCheck> {
  if (!invoice.vendorWorkId && !invoice.completionReportId) {
    return matchedCheck('completionMatch', false);
  }
  if (!invoice.completionReportId) {
    return failedCheck(
      'completionMatch',
      'NOT_READY',
      'COMPLETION_REPORT_NOT_FOUND',
    );
  }
  const report = await vendorCompletionReportRepository.findById(
    invoice.completionReportId,
  );
  const reportVendorWork = report
    ? await vendorWorkRepository.findById(report.vendorWorkId)
    : null;
  if (
    !report ||
    report.clientId !== invoice.clientId ||
    report.buildingId !== invoice.buildingId ||
    (invoice.vendorWorkId !== null &&
      report.vendorWorkId !== invoice.vendorWorkId) ||
    (invoice.workOrderId !== null && report.workOrderId !== invoice.workOrderId) ||
    !reportVendorWork ||
    reportVendorWork.vendorId !== invoice.vendorId ||
    reportVendorWork.buildingId !== invoice.buildingId ||
    reportVendorWork.workOrderId !== report.workOrderId
  ) {
    return failedCheck(
      'completionMatch',
      'MISMATCH',
      'COMPLETION_REPORT_NOT_FOUND',
    );
  }
  return report.completionStatus === 'SUBMITTED'
    ? matchedCheck('completionMatch')
    : failedCheck(
        'completionMatch',
        'NOT_READY',
        'COMPLETION_REPORT_NOT_SUBMITTED',
      );
}

async function evaluateServiceMatch(
  invoice: VendorInvoiceRecord,
): Promise<InvoiceMatchingCheck> {
  if (!invoice.serviceReportId) return matchedCheck('serviceMatch', false);
  const report = await vendorServiceReportRepository.findById(
    invoice.serviceReportId,
  );
  const reportVendorWork = report
    ? await vendorWorkRepository.findById(report.vendorWorkId)
    : null;
  if (
    !report ||
    report.clientId !== invoice.clientId ||
    report.buildingId !== invoice.buildingId ||
    (invoice.vendorWorkId !== null &&
      report.vendorWorkId !== invoice.vendorWorkId) ||
    (invoice.workOrderId !== null && report.workOrderId !== invoice.workOrderId) ||
    !reportVendorWork ||
    reportVendorWork.vendorId !== invoice.vendorId ||
    reportVendorWork.buildingId !== invoice.buildingId ||
    reportVendorWork.workOrderId !== report.workOrderId
  ) {
    return failedCheck('serviceMatch', 'MISMATCH', 'SERVICE_REPORT_NOT_FOUND');
  }
  return report.status === 'FINALIZED'
    ? matchedCheck('serviceMatch')
    : failedCheck(
        'serviceMatch',
        'NOT_READY',
        'SERVICE_REPORT_NOT_FINALIZED',
      );
}

async function evaluateBastMatch(
  invoice: VendorInvoiceRecord,
): Promise<InvoiceMatchingCheck> {
  let required = false;
  if (invoice.workOrderId) {
    const workOrder = await workOrderRepository.findById(invoice.workOrderId);
    required =
      workOrder !== null && workOrder.bastRequirement !== 'NONE';
  }
  if (!invoice.bastDocumentId) {
    return required
      ? failedCheck(
          'bastMatch',
          'NOT_READY',
          'BAST_REQUIRED_NOT_AVAILABLE',
        )
      : matchedCheck('bastMatch', false);
  }
  const bast = await bastDocumentRepository.findById(invoice.bastDocumentId);
  const bastVendorWork = bast?.vendorWorkId
    ? await vendorWorkRepository.findById(bast.vendorWorkId)
    : null;
  if (
    !bast ||
    bast.clientId !== invoice.clientId ||
    bast.buildingId !== invoice.buildingId ||
    (bast.vendorId !== null && bast.vendorId !== invoice.vendorId) ||
    (invoice.workOrderId !== null && bast.workOrderId !== invoice.workOrderId) ||
    (invoice.vendorWorkId !== null &&
      bast.vendorWorkId !== null &&
      bast.vendorWorkId !== invoice.vendorWorkId) ||
    (bast.completionReportId !== null &&
      invoice.completionReportId !== null &&
      bast.completionReportId !== invoice.completionReportId) ||
    (bast.serviceReportId !== null &&
      invoice.serviceReportId !== null &&
      bast.serviceReportId !== invoice.serviceReportId) ||
    (bastVendorWork !== null &&
      (bastVendorWork.vendorId !== invoice.vendorId ||
        bastVendorWork.buildingId !== invoice.buildingId ||
        bastVendorWork.workOrderId !== bast.workOrderId))
  ) {
    return failedCheck('bastMatch', 'MISMATCH', 'BAST_NOT_FOUND');
  }
  return bast.acceptanceStatus === 'ACCEPTED'
    ? matchedCheck('bastMatch')
    : failedCheck('bastMatch', 'NOT_READY', 'BAST_NOT_ACCEPTED');
}

/**
 * Verifies a FINALIZED Vendor Invoice by evaluating all matching checks
 * against existing authoritative records.
 *
 * - MATCHED   → VERIFIED
 * - MISMATCH  → DISCREPANCY with deterministic codes
 * - NOT_READY → 409 without mutating verification state
 *
 * Verification consumes the same result returned by GET /matching. A still-
 * MATCHED VERIFIED invoice remains idempotent; a DISCREPANCY invoice may be
 * re-verified after corrective action.
 *
 * This function does NOT mutate any Work Order, Vendor Work, BAST,
 * or Completion Report.
 */
export async function verifyVendorInvoice(
  id: string,
  input: VerifyVendorInvoiceInput,
  actorUserId: string,
): Promise<{
  invoice: PublicVendorInvoice;
  matching: InvoiceMatchingResult;
}> {
  const current = await loadAccessible(id, actorUserId);

  if (current.status !== 'FINALIZED') {
    throw vendorInvoiceNotFinalizedError();
  }

  // The command consumes the same canonical result exposed by GET /matching.
  const matching = await evaluateMatching(current);
  if (matching.status === 'NOT_READY') {
    throw vendorInvoiceMatchingNotReadyError(matching.notReadyCodes);
  }

  // A still-matched VERIFIED invoice is an idempotent no-op.
  if (
    current.verificationStatus === 'VERIFIED' &&
    matching.status === 'MATCHED'
  ) {
    return { invoice: toPublic(current), matching };
  }

  const verificationStatus =
    matching.status === 'MATCHED' ? 'VERIFIED' : 'DISCREPANCY';
  const verificationNotes = input.notes?.trim() || null;

  const updated = await vendorInvoiceRepository.applyVerification(
    id,
    verificationStatus,
    matching.discrepancyCodes,
    verificationNotes,
    actorUserId,
  );
  if (!updated) throw vendorInvoiceNotFoundError();

  const eventType =
    verificationStatus === 'VERIFIED'
      ? 'VENDOR_INVOICE_VERIFIED'
      : 'VENDOR_INVOICE_DISCREPANCY';

  await recordOperationalEvent({
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    eventType,
    entityType: 'VENDOR_INVOICE',
    entityId: updated.id,
    actorUserId,
    summary: `Vendor Invoice ${updated.invoiceNumber} ${verificationStatus.toLowerCase()}.`,
    metadata: {
      verificationStatus,
      matchingStatus: matching.status,
      discrepancyCodes: matching.discrepancyCodes,
      checks: {
        vendorMatch: matching.vendorMatch.status,
        purchaseOrderMatch: matching.purchaseOrderMatch.status,
        workContractMatch: matching.workContractMatch.status,
        receivingMatch: matching.receivingMatch.status,
        workOrderMatch: matching.workOrderMatch.status,
        vendorWorkMatch: matching.vendorWorkMatch.status,
        completionMatch: matching.completionMatch.status,
        serviceMatch: matching.serviceMatch.status,
        bastMatch: matching.bastMatch.status,
        amountMatch: matching.amountMatch.status,
      },
    },
  });

  // CR-BE-COMM-VAR-01 PART 04 — a newly VERIFIED invoice is authoritative
  // actual cost. The seam is best-effort and never fails verification: on a
  // failure the invoice still consumes budget as an uncommitted actual, so
  // availability is never overstated.
  if (verificationStatus === 'VERIFIED') {
    await operationalCommitmentVendorService.tryActualizeVendorInvoice({
      invoiceId: updated.id,
      clientId: updated.clientId,
      buildingId: updated.buildingId,
      vendorId: updated.vendorId,
      purchaseOrderId: updated.purchaseOrderId ?? null,
      workOrderId: updated.workOrderId ?? null,
      invoiceAmount: String(updated.invoiceAmount),
      invoiceDate: String(updated.invoiceDate).slice(0, 10),
      currency: updated.currency,
      status: updated.status,
      verificationStatus: updated.verificationStatus,
      actorUserId,
    });
  } else {
    // An invoice that fell back to DISCREPANCY is no longer authoritative
    // actual: any prior actualization is reversed through the governed path.
    await operationalCommitmentVendorService.tryReverseVendorInvoiceActualization({
      invoiceId: updated.id,
      buildingId: updated.buildingId,
      actorUserId,
      reason: 'Vendor invoice verification returned a discrepancy.',
    });
  }

  return { invoice: toPublic(updated), matching };
}

/**
 * Returns the matching evaluation for an invoice without persisting
 * a verification decision. Read-only diagnostic.
 */
export async function getVendorInvoiceMatching(
  id: string,
  actorUserId: string,
): Promise<InvoiceMatchingResult> {
  const current = await loadAccessible(id, actorUserId);
  return evaluateMatching(current);
}

// ─── PART 03: Payment Status ────────────────────────────────────

/**
 * Records a payment against a VERIFIED, FINALIZED Vendor Invoice.
 *
 * The target row is locked before access, lifecycle, and cumulative amount
 * decisions. Mutation, history, and the required operational event commit in
 * one transaction. PostgreSQL remains authoritative for cumulative
 * paid_amount and its generated outstanding_amount.
 *
 * This function does NOT mutate verification status, Work Order,
 * Vendor Work, Completion Report, Service Report, or BAST.
 */
export async function recordVendorPayment(
  id: string,
  input: RecordVendorPaymentInput,
  actorUserId: string,
): Promise<PublicVendorInvoice> {
  if (!isValidVendorPaymentAmount(input.amount)) {
    throw vendorInvoicePaymentAmountInvalidError();
  }

  return withTransaction(async (client) => {
    const current = await vendorInvoiceRepository.findByIdForUpdate(client, id);
    if (!current) throw vendorInvoiceNotFoundError();

    await contextAccessService.assertBuildingAccess(
      actorUserId,
      current.buildingId,
    );

    // The payment command consumes the exact same authority as the readiness
    // endpoint. Existing error contracts remain for lifecycle/verification and
    // duplicate full payment; all other eligibility failures use one 409.
    const readiness = await evaluateSettlementReadiness(current);
    if (readiness.readiness === 'SETTLED') {
      throw vendorInvoiceOverpaymentError();
    }
    if (readiness.readiness === 'NOT_READY') {
      if (readiness.reasons.includes('INVOICE_NOT_VERIFIED')) {
        throw vendorInvoiceNotVerifiedForPaymentError();
      }
      if (
        readiness.reasons.includes('INVOICE_CANCELLED') ||
        readiness.reasons.includes('INVOICE_NOT_FINALIZED')
      ) {
        throw vendorInvoicePaymentNotAllowedError();
      }
      throw vendorInvoicePaymentNotReadyError(readiness.reasons);
    }

    // Preserve defense-in-depth lifecycle guards after the shared authority.
    if (current.status === 'CANCELLED') {
      throw vendorInvoicePaymentNotAllowedError();
    }
    if (current.verificationStatus !== 'VERIFIED') {
      throw vendorInvoiceNotVerifiedForPaymentError();
    }
    if (current.status !== 'FINALIZED') {
      throw vendorInvoicePaymentNotAllowedError();
    }

    const invoiceAmount = Number(current.invoiceAmount);
    const previousPaidAmount = Number(current.paidAmount);
    if (
      current.paymentStatus === 'PAID' ||
      previousPaidAmount >= invoiceAmount
    ) {
      throw vendorInvoiceOverpaymentError();
    }

    const updated = await vendorInvoiceRepository.applyPayment(
      client,
      id,
      input.amount,
      input.paymentDate ?? null,
      actorUserId,
    );
    // The guarded SQL update is the final NUMERIC(18,2) overpayment authority.
    if (!updated) throw vendorInvoiceOverpaymentError();

    const newPaidAmount = Number(updated.paidAmount);
    await recordOperationalEvent(
      {
        clientId: updated.clientId,
        buildingId: updated.buildingId,
        eventType: 'VENDOR_INVOICE_PAYMENT_RECORDED',
        entityType: 'VENDOR_INVOICE',
        entityId: updated.id,
        actorUserId,
        summary: `Payment of ${input.amount} ${updated.currency} recorded against invoice ${updated.invoiceNumber}.`,
        metadata: {
          previousPaymentStatus: current.paymentStatus,
          newPaymentStatus: updated.paymentStatus,
          paymentAmount: input.amount,
          previousPaidAmount,
          newPaidAmount,
          outstandingAmount: Number(updated.outstandingAmount),
          invoiceAmount,
          ...(input.paymentDate ? { paymentDate: input.paymentDate } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      },
      client,
    );

    return toPublic(updated);
  });
}

// ─── PART 04: Settlement Readiness ──────────────────────────────

/**
 * Canonical, read-only Vendor Invoice payment eligibility.
 *
 * Reuses the canonical matching result, existing consistency checks, and the
 * persisted invoice/payment fields. No settlement/payment state is persisted
 * here and no duplicate balance or ledger is introduced.
 */
export async function evaluateSettlementReadiness(
  invoice: VendorInvoiceRecord,
): Promise<VendorSettlementReadinessResult> {
  const invoiceAmount = Number(invoice.invoiceAmount);
  const paidAmount = Number(invoice.paidAmount);
  const outstandingAmount = Number(invoice.outstandingAmount);
  const matching = await evaluateMatching(invoice);
  const consistency = await evaluateVendorConsistency(invoice);
  const reasons: VendorSettlementReason[] = [];

  const paymentStateSettled =
    invoice.paymentStatus === 'PAID' &&
    Math.abs(paidAmount - invoiceAmount) < 0.005 &&
    Math.abs(outstandingAmount) < 0.005;

  // SETTLED is derived solely from the existing payment authority. It remains
  // true even if later operational evidence changes; no second paid state exists.
  if (paymentStateSettled) {
    return settlementResult(
      invoice,
      matching,
      consistency,
      'SETTLED',
      [],
    );
  }

  if (invoice.status === 'CANCELLED') {
    reasons.push('INVOICE_CANCELLED');
  } else if (invoice.status !== 'FINALIZED') {
    reasons.push('INVOICE_NOT_FINALIZED');
  }
  if (invoice.verificationStatus !== 'VERIFIED') {
    reasons.push('INVOICE_NOT_VERIFIED');
  }
  if (matching.status === 'NOT_READY') reasons.push('MATCHING_NOT_READY');
  if (matching.status === 'MISMATCH') reasons.push('MATCHING_MISMATCH');
  if (!consistency.allConsistent) reasons.push('SCOPE_MISMATCH');
  if (!Number.isFinite(invoiceAmount) || invoiceAmount <= 0) {
    reasons.push('INVALID_INVOICE_AMOUNT');
  }
  if (!isVendorInvoiceCurrency(invoice.currency)) {
    reasons.push('INVALID_CURRENCY');
  }
  if (
    !isUnsettledPaymentStateValid(
      invoice.paymentStatus,
      invoiceAmount,
      paidAmount,
      outstandingAmount,
    )
  ) {
    reasons.push('INVALID_PAYMENT_STATE');
  }

  const uniqueReasons = [...new Set(reasons)];
  return settlementResult(
    invoice,
    matching,
    consistency,
    uniqueReasons.length === 0 ? 'READY' : 'NOT_READY',
    uniqueReasons,
  );
}

function isUnsettledPaymentStateValid(
  status: VendorInvoiceRecord['paymentStatus'],
  invoiceAmount: number,
  paidAmount: number,
  outstandingAmount: number,
): boolean {
  if (
    !Number.isFinite(paidAmount) ||
    !Number.isFinite(outstandingAmount) ||
    paidAmount < 0 ||
    Math.abs(outstandingAmount - (invoiceAmount - paidAmount)) >= 0.005
  ) {
    return false;
  }
  if (status === 'UNPAID') return paidAmount === 0 && outstandingAmount > 0;
  if (status === 'PARTIALLY_PAID') {
    return paidAmount > 0 && paidAmount < invoiceAmount && outstandingAmount > 0;
  }
  // PAID was handled by the SETTLED branch; any other PAID shape is invalid.
  return false;
}

function settlementResult(
  invoice: VendorInvoiceRecord,
  matching: InvoiceMatchingResult,
  consistency: VendorConsistencyResult,
  readiness: VendorSettlementReadinessResult['readiness'],
  reasons: VendorSettlementReason[],
): VendorSettlementReadinessResult {
  return {
    invoiceId: invoice.id,
    readiness,
    invoiceStatus: invoice.status,
    verificationStatus: invoice.verificationStatus,
    matchingStatus: matching.status,
    paymentStatus: invoice.paymentStatus,
    currency: invoice.currency,
    invoiceAmount: Number(invoice.invoiceAmount),
    paidAmount: Number(invoice.paidAmount),
    outstandingAmount: Number(invoice.outstandingAmount),
    reasons,
    blockers: reasons,
    matchingReasons: matching.discrepancyCodes,
    consistencyReasons: consistency.inconsistencyCodes,
    availableActions: readiness === 'READY' ? ['RECORD_PAYMENT'] : [],
    evaluatedAt: new Date().toISOString(),
  };
}

export async function getSettlementReadiness(
  id: string,
  actorUserId: string,
): Promise<VendorSettlementReadinessResult> {
  const invoice = await loadAccessible(id, actorUserId);
  return evaluateSettlementReadiness(invoice);
}

// ─── PART 05: Vendor Consistency Cross-Check ────────────────────

function consistencyCheck(
  name: string,
  consistent: boolean,
  reason: VendorConsistencyCode,
): VendorConsistencyCheck {
  return { check: name, consistent, reason: consistent ? null : reason };
}

/**
 * Evaluates vendor consistency across the commercial-to-operational chain.
 *
 * Checks:
 *  1. Invoice Vendor == Vendor Work Vendor (if Vendor Work referenced)
 *  2. Vendor Work Vendor == Work Order assigned Vendor (via vendor_assignments)
 *  3. Procurement Vendor mismatch (where authoritative assignment exists)
 *  4. Cross-Client reference
 *  5. Cross-Building reference
 *
 * This is a PURE read-only evaluator — it does NOT mutate any records.
 * It uses existing references only; does not create duplicate authority.
 */
export async function evaluateVendorConsistency(
  invoice: VendorInvoiceRecord,
): Promise<VendorConsistencyResult> {
  // 1. Invoice Vendor vs Vendor Work Vendor
  let vendorWorkVendorMatch: VendorConsistencyCheck = consistencyCheck(
    'vendorWorkVendorMatch',
    true,
    'INVOICE_VENDOR_WORK_MISMATCH',
  );
  if (invoice.vendorWorkId) {
    const vw = await vendorWorkRepository.findById(invoice.vendorWorkId);
    if (vw && vw.vendorId !== invoice.vendorId) {
      vendorWorkVendorMatch = consistencyCheck(
        'vendorWorkVendorMatch',
        false,
        'INVOICE_VENDOR_WORK_MISMATCH',
      );
    }
  }

  // 2. Vendor Work Vendor vs Work Order assigned Vendor
  let workOrderAssignedVendorMatch: VendorConsistencyCheck = consistencyCheck(
    'workOrderAssignedVendorMatch',
    true,
    'VENDOR_WORK_WORK_ORDER_MISMATCH',
  );
  if (invoice.vendorWorkId && invoice.workOrderId) {
    const vw = await vendorWorkRepository.findById(invoice.vendorWorkId);
    if (vw) {
      // Look up the active assignment for this work order
      const assignments = await vendorAssignmentRepository.list({
        workOrderId: invoice.workOrderId,
        buildingIds: [invoice.buildingId],
      });
      const activeAssignment = assignments.find((a) => a.status === 'ACTIVE');
      if (activeAssignment && activeAssignment.vendorId !== vw.vendorId) {
        workOrderAssignedVendorMatch = consistencyCheck(
          'workOrderAssignedVendorMatch',
          false,
          'VENDOR_WORK_WORK_ORDER_MISMATCH',
        );
      }
    }
  }

  // 3. Procurement Vendor mismatch (where authoritative data exists)
  let procurementVendorMatch: VendorConsistencyCheck = consistencyCheck(
    'procurementVendorMatch',
    true,
    'PROCUREMENT_VENDOR_MISMATCH',
  );
  if (invoice.workOrderId) {
    const assignments = await vendorAssignmentRepository.list({
      workOrderId: invoice.workOrderId,
      buildingIds: [invoice.buildingId],
    });
    const activeAssignment = assignments.find((a) => a.status === 'ACTIVE');
    // Only flag if there IS an authoritative assignment that differs
    if (activeAssignment && activeAssignment.vendorId !== invoice.vendorId) {
      procurementVendorMatch = consistencyCheck(
        'procurementVendorMatch',
        false,
        'PROCUREMENT_VENDOR_MISMATCH',
      );
    }
  }

  // 4. Cross-Client reference
  let clientIsolationMatch: VendorConsistencyCheck = consistencyCheck(
    'clientIsolationMatch',
    true,
    'CROSS_CLIENT_REFERENCE',
  );
  if (invoice.workOrderId) {
    const wo = await workOrderRepository.findById(invoice.workOrderId);
    if (wo && wo.clientId !== invoice.clientId) {
      clientIsolationMatch = consistencyCheck(
        'clientIsolationMatch',
        false,
        'CROSS_CLIENT_REFERENCE',
      );
    }
  }
  if (invoice.completionReportId) {
    const cr = await vendorCompletionReportRepository.findById(
      invoice.completionReportId,
    );
    if (cr && cr.clientId !== invoice.clientId) {
      clientIsolationMatch = consistencyCheck(
        'clientIsolationMatch',
        false,
        'CROSS_CLIENT_REFERENCE',
      );
    }
  }
  if (invoice.serviceReportId) {
    const sr = await vendorServiceReportRepository.findById(
      invoice.serviceReportId,
    );
    if (sr && sr.clientId !== invoice.clientId) {
      clientIsolationMatch = consistencyCheck(
        'clientIsolationMatch',
        false,
        'CROSS_CLIENT_REFERENCE',
      );
    }
  }

  // 5. Cross-Building reference
  let buildingIsolationMatch: VendorConsistencyCheck = consistencyCheck(
    'buildingIsolationMatch',
    true,
    'CROSS_BUILDING_REFERENCE',
  );
  if (invoice.vendorWorkId) {
    const vw = await vendorWorkRepository.findById(invoice.vendorWorkId);
    if (vw && vw.buildingId !== invoice.buildingId) {
      buildingIsolationMatch = consistencyCheck(
        'buildingIsolationMatch',
        false,
        'CROSS_BUILDING_REFERENCE',
      );
    }
  }
  if (invoice.workOrderId) {
    const wo = await workOrderRepository.findById(invoice.workOrderId);
    if (wo && wo.buildingId !== invoice.buildingId) {
      buildingIsolationMatch = consistencyCheck(
        'buildingIsolationMatch',
        false,
        'CROSS_BUILDING_REFERENCE',
      );
    }
  }

  const checks = [
    vendorWorkVendorMatch,
    workOrderAssignedVendorMatch,
    procurementVendorMatch,
    clientIsolationMatch,
    buildingIsolationMatch,
  ];
  const allConsistent = checks.every((c) => c.consistent);
  const inconsistencyCodes = checks
    .filter((c) => !c.consistent && c.reason)
    .map((c) => c.reason as VendorConsistencyCode);

  return {
    vendorWorkVendorMatch,
    workOrderAssignedVendorMatch,
    procurementVendorMatch,
    clientIsolationMatch,
    buildingIsolationMatch,
    allConsistent,
    inconsistencyCodes,
  };
}

// ─── PART 05: BAST Hard Gate ────────────────────────────────────

/**
 * Evaluates the BAST hard gate for settlement readiness.
 *
 * Uses BE-22 canonical BAST authority ONLY.
 * Does NOT duplicate BAST lifecycle/status into Vendor Invoice.
 *
 * Rules:
 *  - If the Work Order's bastRequirement is NONE, BAST is not required.
 *  - If the Work Order requires BAST (WORK_ORDER or EACH_VENDOR_WORK),
 *    the referenced canonical BAST must be ACCEPTED.
 *  - Missing/DRAFT/SUBMITTED/REJECTED BAST does not satisfy the gate.
 *  - Legacy vendor_bast_bindings alone cannot satisfy the gate.
 *  - If no Work Order is referenced, BAST is not required (no invention).
 */
export async function evaluateBastHardGate(
  invoice: VendorInvoiceRecord,
): Promise<BastHardGateResult> {
  // No Work Order → no BAST requirement to enforce
  if (!invoice.workOrderId) {
    return {
      required: false,
      gatePassed: true,
      bastStatus: null,
      isLegacyProjection: false,
      bastDocumentId: null,
      workOrderBastRequirement: null,
    };
  }

  const wo = await workOrderRepository.findById(invoice.workOrderId);
  if (!wo) {
    return {
      required: false,
      gatePassed: true,
      bastStatus: null,
      isLegacyProjection: false,
      bastDocumentId: null,
      workOrderBastRequirement: null,
    };
  }

  // bastRequirement NONE → no BAST required
  if (wo.bastRequirement === 'NONE') {
    return {
      required: false,
      gatePassed: true,
      bastStatus: null,
      isLegacyProjection: false,
      bastDocumentId: invoice.bastDocumentId,
      workOrderBastRequirement: wo.bastRequirement,
    };
  }

  // BAST IS required — check canonical BAST
  if (!invoice.bastDocumentId) {
    // No BAST referenced at all → gate fails
    // Check if there's a legacy vendor_bast_bindings projection
    const isLegacyProjection = await hasLegacyBastBinding(invoice);
    return {
      required: true,
      gatePassed: false,
      bastStatus: null,
      isLegacyProjection,
      bastDocumentId: null,
      workOrderBastRequirement: wo.bastRequirement,
    };
  }

  const bast = await bastDocumentRepository.findById(invoice.bastDocumentId);
  if (!bast) {
    return {
      required: true,
      gatePassed: false,
      bastStatus: null,
      isLegacyProjection: false,
      bastDocumentId: invoice.bastDocumentId,
      workOrderBastRequirement: wo.bastRequirement,
    };
  }

  // Gate passes ONLY when canonical BAST is ACCEPTED
  const gatePassed = bast.acceptanceStatus === 'ACCEPTED';
  return {
    required: true,
    gatePassed,
    bastStatus: bast.acceptanceStatus,
    isLegacyProjection: false,
    bastDocumentId: bast.id,
    workOrderBastRequirement: wo.bastRequirement,
  };
}

/**
 * Checks whether a legacy vendor_bast_bindings record exists for the
 * invoice's vendor work + work order context. This is NOT sufficient
 * to satisfy the BAST hard gate — only the canonical BE-22 BAST counts.
 */
async function hasLegacyBastBinding(
  invoice: VendorInvoiceRecord,
): Promise<boolean> {
  if (!invoice.vendorWorkId) return false;
  try {
    const result = await getPool().query(
      `SELECT id FROM vendor_bast_bindings
       WHERE vendor_work_id = $1 AND work_order_id = $2
       LIMIT 1`,
      [invoice.vendorWorkId, invoice.workOrderId],
    );
    return result.rows.length > 0;
  } catch {
    // Table may not exist or query may fail — treat as no legacy binding
    return false;
  }
}

// ─── PART 05: End-to-End Trace ─────────────────────────────────

/**
 * Returns stable traceability references along the vendor commercial chain.
 * Read-only — no mutation. Only exposes identifiers/links.
 *
 * Chain: Vendor → Vendor Work → Work Order → Completion/Service Report
 *        → Canonical BAST → Vendor Invoice → Verification → Payment
 *        → Settlement Readiness
 */
export async function getVendorInvoiceTrace(
  id: string,
  actorUserId: string,
): Promise<VendorInvoiceTrace> {
  const invoice = await loadAccessible(id, actorUserId);
  const documents: R2PTraceDocument[] = [];
  const relationships: R2PTraceRelationship[] = [];
  const documentKeys = new Set<string>();
  const relationshipKeys = new Set<string>();

  const addDocument = (
    documentType: R2PTraceDocumentType,
    documentId: string,
    documentNumber: string | null,
    status: string | null,
  ): void => {
    const key = `${documentType}:${documentId}`;
    if (documentKeys.has(key)) return;
    documentKeys.add(key);
    documents.push({ documentType, documentId, documentNumber, status });
  };
  const addRelationship = (
    relationship: R2PTraceRelationshipType,
    sourceDocumentType: R2PTraceDocumentType,
    sourceDocumentId: string,
    targetDocumentType: R2PTraceDocumentType,
    targetDocumentId: string,
  ): void => {
    if (
      !documentKeys.has(`${sourceDocumentType}:${sourceDocumentId}`) ||
      !documentKeys.has(`${targetDocumentType}:${targetDocumentId}`)
    ) {
      return;
    }
    const key = [
      relationship,
      sourceDocumentType,
      sourceDocumentId,
      targetDocumentType,
      targetDocumentId,
    ].join(':');
    if (relationshipKeys.has(key)) return;
    relationshipKeys.add(key);
    relationships.push({
      relationship,
      sourceDocumentType,
      sourceDocumentId,
      targetDocumentType,
      targetDocumentId,
    });
  };

  addDocument(
    'VENDOR_INVOICE',
    invoice.id,
    invoice.invoiceNumber,
    invoice.status,
  );

  const matching = await evaluateMatching(invoice);
  const settlementReadiness = await evaluateSettlementReadiness(invoice);
  for (const [type, status] of [
    ['INVOICE_MATCHING', matching.status],
    ['INVOICE_VERIFICATION', invoice.verificationStatus],
    ['PAYMENT_STATE', invoice.paymentStatus],
    ['SETTLEMENT_READINESS', settlementReadiness.readiness],
  ] as const) {
    addDocument(type, invoice.id, null, status);
    addRelationship(
      'PROJECTS',
      'VENDOR_INVOICE',
      invoice.id,
      type,
      invoice.id,
    );
  }

  let purchaseOrderStatus: string | null = null;
  let purchaseOrderNumber: string | null = null;
  let purchaseOrder = null as Awaited<
    ReturnType<typeof purchaseOrderRepository.findById>
  >;
  const materialRequestIds: string[] = [];
  const serviceRequestIds: string[] = [];
  let purchaseRequestId: string | null = null;

  if (invoice.purchaseOrderId) {
    purchaseOrder = await purchaseOrderRepository.findById(invoice.purchaseOrderId);
    if (
      purchaseOrder &&
      purchaseOrder.clientId === invoice.clientId &&
      purchaseOrder.buildingId === invoice.buildingId &&
      purchaseOrder.vendorId === invoice.vendorId
    ) {
      purchaseOrderStatus = purchaseOrder.status;
      purchaseOrderNumber = purchaseOrder.poNumber;
      addDocument(
        'PURCHASE_ORDER',
        purchaseOrder.id,
        purchaseOrder.poNumber,
        purchaseOrder.status,
      );
      addRelationship(
        'INVOICED_BY',
        'PURCHASE_ORDER',
        purchaseOrder.id,
        'VENDOR_INVOICE',
        invoice.id,
      );

      purchaseRequestId = purchaseOrder.purchaseRequestId;
      if (purchaseOrder.serviceRequestId) {
        serviceRequestIds.push(purchaseOrder.serviceRequestId);
      }

      const lines = await purchaseOrderLineRepository.listByPurchaseOrder(
        purchaseOrder.id,
      );
      for (const line of lines) {
        addDocument('PURCHASE_ORDER_LINE', line.id, null, null);
        addRelationship(
          'BELONGS_TO',
          'PURCHASE_ORDER_LINE',
          line.id,
          'PURCHASE_ORDER',
          purchaseOrder.id,
        );
        if (line.materialRequestId) {
          materialRequestIds.push(line.materialRequestId);
          const materialRequest = await materialRequestRepository.findById(
            line.materialRequestId,
          );
          if (
            materialRequest &&
            materialRequest.clientId === invoice.clientId &&
            materialRequest.buildingId === invoice.buildingId
          ) {
            purchaseRequestId ??= materialRequest.purchaseRequestId;
            addDocument(
              'MATERIAL_REQUEST',
              materialRequest.id,
              null,
              materialRequest.status,
            );
            addRelationship(
              'COMMITTED_BY_LINE',
              'MATERIAL_REQUEST',
              materialRequest.id,
              'PURCHASE_ORDER_LINE',
              line.id,
            );
          }
        }
        if (line.serviceRequestId) {
          serviceRequestIds.push(line.serviceRequestId);
          const serviceRequest = await serviceRequestRepository.findById(
            line.serviceRequestId,
          );
          if (
            serviceRequest &&
            serviceRequest.clientId === invoice.clientId &&
            serviceRequest.buildingId === invoice.buildingId
          ) {
            purchaseRequestId ??= serviceRequest.purchaseRequestId;
            addDocument(
              'SERVICE_REQUEST',
              serviceRequest.id,
              null,
              serviceRequest.status,
            );
            addRelationship(
              'COMMITTED_BY_LINE',
              'SERVICE_REQUEST',
              serviceRequest.id,
              'PURCHASE_ORDER_LINE',
              line.id,
            );
          }
        }
      }
    }
  }

  if (purchaseOrder?.serviceRequestId) {
    const serviceRequest = await serviceRequestRepository.findById(
      purchaseOrder.serviceRequestId,
    );
    if (
      serviceRequest &&
      serviceRequest.clientId === invoice.clientId &&
      serviceRequest.buildingId === invoice.buildingId
    ) {
      purchaseRequestId ??= serviceRequest.purchaseRequestId;
      addDocument(
        'SERVICE_REQUEST',
        serviceRequest.id,
        null,
        serviceRequest.status,
      );
      addRelationship(
        'SOURCE_OF',
        'SERVICE_REQUEST',
        serviceRequest.id,
        'PURCHASE_ORDER',
        purchaseOrder.id,
      );
    }
  }

  if (purchaseRequestId && purchaseOrder) {
    const purchaseRequest = await purchaseRequestRepository.findById(
      purchaseRequestId,
    );
    if (
      purchaseRequest &&
      purchaseRequest.clientId === invoice.clientId &&
      purchaseRequest.buildingId === invoice.buildingId
    ) {
      addDocument(
        'PURCHASE_REQUEST',
        purchaseRequest.id,
        purchaseRequest.requestNumber,
        purchaseRequest.status,
      );
      addRelationship(
        'SOURCE_OF',
        'PURCHASE_REQUEST',
        purchaseRequest.id,
        'PURCHASE_ORDER',
        purchaseOrder.id,
      );
      for (const materialRequestId of new Set(materialRequestIds)) {
        addRelationship(
          'SOURCE_OF',
          'PURCHASE_REQUEST',
          purchaseRequest.id,
          'MATERIAL_REQUEST',
          materialRequestId,
        );
      }
      for (const serviceRequestId of new Set(serviceRequestIds)) {
        addRelationship(
          'SOURCE_OF',
          'PURCHASE_REQUEST',
          purchaseRequest.id,
          'SERVICE_REQUEST',
          serviceRequestId,
        );
      }
    }
  }

  if (purchaseOrder) {
    const approvals = await listTraceApprovals(
      invoice.buildingId,
      purchaseRequestId,
      materialRequestIds,
      serviceRequestIds,
    );
    for (const approval of approvals) {
      addDocument('PROCUREMENT_APPROVAL', approval.id, null, approval.status);
      const source = approval.purchaseRequestId
        ? (['PURCHASE_REQUEST', approval.purchaseRequestId] as const)
        : approval.materialRequestId
          ? (['MATERIAL_REQUEST', approval.materialRequestId] as const)
          : approval.serviceRequestId
            ? (['SERVICE_REQUEST', approval.serviceRequestId] as const)
            : null;
      if (source) {
        addRelationship(
          'APPROVED_BY',
          source[0],
          source[1],
          'PROCUREMENT_APPROVAL',
          approval.id,
        );
      }
    }

    const receivings = await receivingRepository.listByRequest(
      purchaseOrder.purchaseRequestId,
      purchaseOrder.serviceRequestId,
      invoice.buildingId,
      {},
    );
    for (const serviceRequestId of new Set(serviceRequestIds)) {
      receivings.push(
        ...(await receivingRepository.listByRequest(
          null,
          serviceRequestId,
          invoice.buildingId,
          {},
        )),
      );
    }
    const receivingIds = new Set<string>();
    for (const receiving of receivings.filter(
      (candidate) => candidate.vendorId === invoice.vendorId,
    )) {
      if (receivingIds.has(receiving.id)) continue;
      receivingIds.add(receiving.id);
      addDocument('RECEIVING', receiving.id, null, receiving.status);
      const source = receiving.materialRequestId
        ? (['MATERIAL_REQUEST', receiving.materialRequestId] as const)
        : receiving.serviceRequestId
          ? (['SERVICE_REQUEST', receiving.serviceRequestId] as const)
          : receiving.purchaseRequestId
            ? (['PURCHASE_REQUEST', receiving.purchaseRequestId] as const)
            : null;
      if (source) {
        addRelationship(
          'RECEIVED_AS',
          source[0],
          source[1],
          'RECEIVING',
          receiving.id,
        );
      }
      addRelationship(
        'INVOICED_BY',
        'RECEIVING',
        receiving.id,
        'VENDOR_INVOICE',
        invoice.id,
      );
    }
  }

  let workContractStatus: string | null = null;
  let workContractSpkNumber: string | null = null;
  if (invoice.workContractId) {
    const workContract = await workContractRepository.findById(
      invoice.workContractId,
    );
    if (
      workContract &&
      workContract.clientId === invoice.clientId &&
      workContract.buildingId === invoice.buildingId &&
      workContract.vendorId === invoice.vendorId &&
      workContract.purchaseOrderId === invoice.purchaseOrderId
    ) {
      workContractStatus = workContract.status;
      workContractSpkNumber = workContract.spkNumber;
      addDocument(
        'WORK_CONTRACT',
        workContract.id,
        workContract.spkNumber,
        workContract.status,
      );
      if (purchaseOrder) {
        addRelationship(
          'MANDATES',
          'PURCHASE_ORDER',
          purchaseOrder.id,
          'WORK_CONTRACT',
          workContract.id,
        );
      }
      addRelationship(
        'INVOICED_BY',
        'WORK_CONTRACT',
        workContract.id,
        'VENDOR_INVOICE',
        invoice.id,
      );
    }
  }

  let workOrderAssignedVendorId: string | null = null;
  let workOrderBastRequirement: string | null = null;
  if (invoice.workOrderId) {
    const workOrder = await workOrderRepository.findById(invoice.workOrderId);
    if (
      workOrder &&
      workOrder.clientId === invoice.clientId &&
      workOrder.buildingId === invoice.buildingId
    ) {
      workOrderBastRequirement = workOrder.bastRequirement;
      addDocument(
        'WORK_ORDER',
        workOrder.id,
        workOrder.workOrderNumber,
        workOrder.status,
      );
      addRelationship(
        'INVOICED_BY',
        'WORK_ORDER',
        workOrder.id,
        'VENDOR_INVOICE',
        invoice.id,
      );
      const binding =
        await workOrderProcurementBindingRepository.findByWorkOrderId(
          workOrder.id,
        );
      if (binding?.workContractId === invoice.workContractId && invoice.workContractId) {
        addRelationship(
          'BOUND_TO',
          'WORK_CONTRACT',
          invoice.workContractId,
          'WORK_ORDER',
          workOrder.id,
        );
      } else if (binding?.purchaseOrderId === invoice.purchaseOrderId && invoice.purchaseOrderId) {
        addRelationship(
          'BOUND_TO',
          'PURCHASE_ORDER',
          invoice.purchaseOrderId,
          'WORK_ORDER',
          workOrder.id,
        );
      }
      const assignments = await vendorAssignmentRepository.list({
        workOrderId: workOrder.id,
        buildingIds: [invoice.buildingId],
      });
      workOrderAssignedVendorId =
        assignments.find((assignment) => assignment.status === 'ACTIVE')
          ?.vendorId ?? null;
    }
  }

  if (invoice.vendorWorkId) {
    const vendorWork = await vendorWorkRepository.findById(invoice.vendorWorkId);
    if (
      vendorWork &&
      vendorWork.buildingId === invoice.buildingId &&
      vendorWork.vendorId === invoice.vendorId
    ) {
      addDocument('VENDOR_WORK', vendorWork.id, null, vendorWork.status);
      if (
        invoice.workOrderId &&
        vendorWork.workOrderId === invoice.workOrderId
      ) {
        addRelationship(
          'EXECUTED_AS',
          'WORK_ORDER',
          invoice.workOrderId,
          'VENDOR_WORK',
          vendorWork.id,
        );
      }
      addRelationship(
        'INVOICED_BY',
        'VENDOR_WORK',
        vendorWork.id,
        'VENDOR_INVOICE',
        invoice.id,
      );
    }
  }

  if (invoice.completionReportId) {
    const report = await vendorCompletionReportRepository.findById(
      invoice.completionReportId,
    );
    if (
      report?.clientId === invoice.clientId &&
      report.buildingId === invoice.buildingId
    ) {
      addDocument(
        'COMPLETION_REPORT',
        report.id,
        null,
        report.completionStatus,
      );
      addRelationship(
        'REPORTED_BY',
        'VENDOR_WORK',
        report.vendorWorkId,
        'COMPLETION_REPORT',
        report.id,
      );
      addRelationship(
        'INVOICED_BY',
        'COMPLETION_REPORT',
        report.id,
        'VENDOR_INVOICE',
        invoice.id,
      );
    }
  }

  if (invoice.serviceReportId) {
    const report = await vendorServiceReportRepository.findById(
      invoice.serviceReportId,
    );
    if (
      report?.clientId === invoice.clientId &&
      report.buildingId === invoice.buildingId
    ) {
      addDocument(
        'SERVICE_REPORT',
        report.id,
        report.serviceReportNumber,
        report.status,
      );
      addRelationship(
        'REPORTED_BY',
        'VENDOR_WORK',
        report.vendorWorkId,
        'SERVICE_REPORT',
        report.id,
      );
      addRelationship(
        'INVOICED_BY',
        'SERVICE_REPORT',
        report.id,
        'VENDOR_INVOICE',
        invoice.id,
      );
    }
  }

  let bastAcceptanceStatus: string | null = null;
  let bastIsLegacyProjection = false;
  if (invoice.bastDocumentId) {
    const bast = await bastDocumentRepository.findById(invoice.bastDocumentId);
    if (
      bast?.clientId === invoice.clientId &&
      bast.buildingId === invoice.buildingId &&
      (bast.vendorId === null || bast.vendorId === invoice.vendorId)
    ) {
      bastAcceptanceStatus = bast.acceptanceStatus;
      addDocument('BAST', bast.id, bast.bastNumber, bast.acceptanceStatus);
      const sourceType: R2PTraceDocumentType = bast.vendorWorkId
        ? 'VENDOR_WORK'
        : 'WORK_ORDER';
      const sourceId = bast.vendorWorkId ?? bast.workOrderId;
      addRelationship(
        'ACCEPTED_BY',
        sourceType,
        sourceId,
        'BAST',
        bast.id,
      );
      addRelationship(
        'INVOICED_BY',
        'BAST',
        bast.id,
        'VENDOR_INVOICE',
        invoice.id,
      );
    }
  } else if (invoice.vendorWorkId && invoice.workOrderId) {
    bastIsLegacyProjection = await hasLegacyBastBinding(invoice);
  }

  return {
    invoiceId: invoice.id,
    vendorId: invoice.vendorId,
    clientId: invoice.clientId,
    buildingId: invoice.buildingId,
    vendorWorkId: invoice.vendorWorkId,
    workOrderId: invoice.workOrderId,
    completionReportId: invoice.completionReportId,
    serviceReportId: invoice.serviceReportId,
    bastDocumentId: invoice.bastDocumentId,
    purchaseOrderId: invoice.purchaseOrderId,
    workContractId: invoice.workContractId,
    purchaseOrderStatus,
    purchaseOrderNumber,
    workContractStatus,
    workContractSpkNumber,
    workOrderAssignedVendorId,
    workOrderBastRequirement,
    bastAcceptanceStatus,
    bastIsLegacyProjection,
    verificationStatus: invoice.verificationStatus,
    paymentStatus: invoice.paymentStatus,
    invoiceStatus: invoice.status,
    documents,
    relationships,
    matching,
    settlementReadiness,
    generatedAt: new Date().toISOString(),
  };
}

type TraceApproval = {
  id: string;
  status: string;
  purchaseRequestId: string | null;
  materialRequestId: string | null;
  serviceRequestId: string | null;
};

async function listTraceApprovals(
  buildingId: string,
  purchaseRequestId: string | null,
  materialRequestIds: string[],
  serviceRequestIds: string[],
): Promise<TraceApproval[]> {
  const result = await getPool().query<TraceApproval>(
    `SELECT id, status,
            purchase_request_id AS "purchaseRequestId",
            material_request_id AS "materialRequestId",
            service_request_id AS "serviceRequestId"
     FROM procurement_approval_bindings
     WHERE building_id = $1
       AND (
         ($2::uuid IS NOT NULL AND purchase_request_id = $2::uuid)
         OR material_request_id = ANY($3::uuid[])
         OR service_request_id = ANY($4::uuid[])
       )
     ORDER BY created_at`,
    [
      buildingId,
      purchaseRequestId,
      [...new Set(materialRequestIds)],
      [...new Set(serviceRequestIds)],
    ],
  );
  return result.rows;
}

/**
 * Returns the vendor consistency evaluation for an invoice.
 * Read-only diagnostic — does not mutate any records.
 */
export async function getVendorInvoiceConsistency(
  id: string,
  actorUserId: string,
): Promise<VendorConsistencyResult> {
  const invoice = await loadAccessible(id, actorUserId);
  return evaluateVendorConsistency(invoice);
}

export const vendorInvoiceService = {
  cancelVendorInvoice,
  createVendorInvoice,
  evaluateBastHardGate,
  evaluateMatching,
  evaluateSettlementReadiness,
  evaluateVendorConsistency,
  finalizeVendorInvoice,
  getVendorInvoice,
  getVendorInvoiceConsistency,
  getVendorInvoiceMatching,
  getVendorInvoiceTrace,
  getSettlementReadiness,
  listVendorInvoices,
  recordVendorPayment,
  resolveVendorInvoiceAvailableActions,
  updateVendorInvoice,
  verifyVendorInvoice,
};
