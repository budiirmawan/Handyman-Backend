import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: keyof typeof ERROR_CODES,
  message: string,
  statusCode: number,
) => new AppError({ code: ERROR_CODES[code], message, statusCode });

export const vendorInvoiceNotFoundError = (): AppError =>
  error('VENDOR_INVOICE_NOT_FOUND', 'Vendor Invoice not found.', 404);

export const vendorInvoiceNumberExistsError = (): AppError =>
  error(
    'VENDOR_INVOICE_NUMBER_ALREADY_EXISTS',
    'Invoice number already exists for this Client.',
    409,
  );

export const vendorInvoiceVendorInvalidError = (): AppError =>
  error(
    'VENDOR_INVOICE_VENDOR_INVALID',
    'Vendor must be ACTIVE and belong to the same Client.',
    400,
  );

export const vendorInvoiceNotDraftError = (): AppError =>
  error(
    'VENDOR_INVOICE_NOT_DRAFT',
    'Only a draft Vendor Invoice can be updated or finalized.',
    400,
  );

export const vendorInvoiceFinalizedProtectedError = (): AppError =>
  error(
    'VENDOR_INVOICE_FINALIZED_PROTECTED',
    'A finalized Vendor Invoice cannot be overwritten.',
    400,
  );

export const vendorInvoiceCancelNotAllowedError = (): AppError =>
  error(
    'VENDOR_INVOICE_CANCEL_NOT_ALLOWED',
    'This Vendor Invoice cannot be cancelled.',
    400,
  );

export const vendorInvoiceContextInvalidError = (): AppError =>
  error(
    'VENDOR_INVOICE_CONTEXT_INVALID',
    'Referenced Work Order, Vendor Work, Completion Report, Service Report, or BAST does not match the invoice context.',
    400,
  );

// ─── PART 02: Verification errors ───────────────────────────────

export const vendorInvoiceNotFinalizedError = (): AppError =>
  error(
    'VENDOR_INVOICE_NOT_FINALIZED',
    'Only a finalized Vendor Invoice can be verified.',
    400,
  );

export const vendorInvoiceAlreadyVerifiedError = (): AppError =>
  error(
    'VENDOR_INVOICE_ALREADY_VERIFIED',
    'This Vendor Invoice is already verified and cannot be re-verified.',
    400,
  );

export const vendorInvoiceDiscrepancyError = (): AppError =>
  error(
    'VENDOR_INVOICE_DISCREPANCY',
    'Verification failed: one or more matching checks did not pass.',
    422,
  );

export const vendorInvoiceMatchingNotReadyError = (
  reasons: readonly string[],
): AppError =>
  new AppError({
    code: ERROR_CODES.VENDOR_INVOICE_MATCHING_NOT_READY,
    message:
      'Vendor Invoice matching is not ready for verification. Complete the required procurement or completion evidence first.',
    statusCode: 409,
    details: reasons.map((reason) => ({
      field: 'matching',
      message: reason,
    })),
  });

// ─── PART 03: Payment errors ────────────────────────────────────

export const vendorInvoiceNotVerifiedForPaymentError = (): AppError =>
  error(
    'VENDOR_INVOICE_NOT_VERIFIED_FOR_PAYMENT',
    'Only a verified Vendor Invoice can receive payments.',
    400,
  );

export const vendorInvoicePaymentAmountInvalidError = (): AppError =>
  error(
    'VENDOR_INVOICE_PAYMENT_AMOUNT_INVALID',
    'Payment amount must be positive, have at most two decimal places, and fit NUMERIC(18,2).',
    400,
  );

export const vendorInvoiceOverpaymentError = (): AppError =>
  error(
    'VENDOR_INVOICE_OVERPAYMENT',
    'Payment would exceed the outstanding amount on this invoice.',
    422,
  );

export const vendorInvoicePaymentNotAllowedError = (): AppError =>
  error(
    'VENDOR_INVOICE_PAYMENT_NOT_ALLOWED',
    'Payments cannot be recorded against this invoice.',
    400,
  );

export const vendorInvoicePaymentNotReadyError = (
  reasons: readonly string[],
): AppError =>
  new AppError({
    code: ERROR_CODES.VENDOR_INVOICE_PAYMENT_NOT_READY,
    message:
      'Vendor Invoice is not ready for payment. Resolve the settlement-readiness reasons first.',
    statusCode: 409,
    details: reasons.map((reason) => ({
      field: 'settlementReadiness',
      message: reason,
    })),
  });

// ─── PART 05: Consistency / BAST hard-gate errors ──────────────

export const vendorInvoiceVendorConsistencyError = (): AppError =>
  error(
    'VENDOR_INVOICE_VENDOR_CONSISTENCY_FAILED',
    'Vendor consistency cross-check failed: vendor chain is inconsistent.',
    422,
  );

export const vendorInvoiceBastHardGateError = (): AppError =>
  error(
    'VENDOR_INVOICE_BAST_HARD_GATE_FAILED',
    'BAST hard gate failed: required canonical BAST is not ACCEPTED.',
    422,
  );

// ─── CR-BE-R2P-01 PART 06: PO / SPK commercial linkage ─────────

/** The referenced Purchase Order does not exist or is not reachable. */
export const vendorInvoicePurchaseOrderInvalidError = (): AppError =>
  error(
    'VENDOR_INVOICE_PURCHASE_ORDER_INVALID',
    'The referenced Purchase Order is invalid.',
    400,
  );

/** Only a committed (ISSUED) Purchase Order can be invoiced against. */
export const vendorInvoicePurchaseOrderNotIssuedError = (
  currentStatus: string,
): AppError =>
  new AppError({
    code: ERROR_CODES.VENDOR_INVOICE_PURCHASE_ORDER_NOT_ISSUED,
    message:
      'A Vendor Invoice can only be linked to an ISSUED Purchase Order.',
    statusCode: 409,
    details: [
      {
        field: 'purchaseOrderId',
        message: `Purchase Order status is ${currentStatus}`,
      },
    ],
  });

/** The referenced Work Contract (SPK) does not exist or is not reachable. */
export const vendorInvoiceWorkContractInvalidError = (): AppError =>
  error(
    'VENDOR_INVOICE_WORK_CONTRACT_INVALID',
    'The referenced Work Contract (SPK) is invalid.',
    400,
  );

/** Only an authorized or completed SPK is eligible for invoice linkage. */
export const vendorInvoiceWorkContractNotEligibleError = (
  currentStatus: string,
): AppError =>
  new AppError({
    code: ERROR_CODES.VENDOR_INVOICE_WORK_CONTRACT_NOT_ELIGIBLE,
    message:
      'A Vendor Invoice can only be linked to an ACTIVE or COMPLETED Work Contract (SPK).',
    statusCode: 409,
    details: [
      {
        field: 'workContractId',
        message: `Work Contract status is ${currentStatus}`,
      },
    ],
  });

/** The SPK must be executed under the invoice's own Purchase Order. */
export const vendorInvoiceWorkContractPoMismatchError = (): AppError =>
  error(
    'VENDOR_INVOICE_WORK_CONTRACT_PO_MISMATCH',
    'The Work Contract (SPK) does not belong to the linked Purchase Order.',
    400,
  );

/** The invoice Vendor must be the Vendor committed by the PO/SPK chain. */
export const vendorInvoiceProcurementVendorMismatchError = (): AppError =>
  error(
    'VENDOR_INVOICE_PROCUREMENT_VENDOR_MISMATCH',
    'The invoice Vendor does not match the Purchase Order / Work Contract Vendor.',
    400,
  );

/** Client/Building scope must agree across the whole commercial chain. */
export const vendorInvoiceProcurementScopeMismatchError = (): AppError =>
  error(
    'VENDOR_INVOICE_PROCUREMENT_SCOPE_MISMATCH',
    'The Purchase Order / Work Contract does not belong to the invoice Client and Building.',
    400,
  );
