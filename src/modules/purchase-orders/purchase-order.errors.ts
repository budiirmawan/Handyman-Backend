import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: keyof typeof ERROR_CODES,
  message: string,
  statusCode: number,
): AppError =>
  new AppError({ code: ERROR_CODES[code], message, statusCode });

export const purchaseOrderNotFoundError = (): AppError =>
  error('PURCHASE_ORDER_NOT_FOUND', 'Purchase Order not found.', 404);

export const purchaseOrderNumberExistsError = (): AppError =>
  error(
    'PURCHASE_ORDER_NUMBER_ALREADY_EXISTS',
    'PO number already exists for this Client.',
    409,
  );

/** The referenced BE-17F PO Readiness does not exist or is not reachable. */
export const purchaseOrderReadinessInvalidError = (): AppError =>
  error(
    'PURCHASE_ORDER_READINESS_INVALID',
    'The referenced Purchase Order Readiness is invalid.',
    400,
  );

/**
 * Frozen decision 1: PO Readiness is a PRECONDITION for issuance. A
 * readiness that is not READY may not be committed.
 */
export const purchaseOrderReadinessNotReadyError = (
  readiness: string,
): AppError =>
  new AppError({
    code: ERROR_CODES.PURCHASE_ORDER_READINESS_NOT_READY,
    message:
      'Purchase Order Readiness must be READY before a Purchase Order can be committed.',
    statusCode: 409,
    details: [{ field: 'poReadinessId', message: `readiness is ${readiness}` }],
  });

/** One live commitment per qualifying readiness. */
export const purchaseOrderReadinessAlreadyCommittedError = (): AppError =>
  error(
    'PURCHASE_ORDER_READINESS_ALREADY_COMMITTED',
    'A Purchase Order already exists for this Purchase Order Readiness.',
    409,
  );

export const purchaseOrderVendorInvalidError = (): AppError =>
  error(
    'PURCHASE_ORDER_VENDOR_INVALID',
    'Vendor must be ACTIVE and hold an ACTIVE relationship to the Building.',
    400,
  );

export const purchaseOrderNotDraftError = (): AppError =>
  error(
    'PURCHASE_ORDER_NOT_DRAFT',
    'Only a draft Purchase Order can be updated.',
    400,
  );

export const purchaseOrderCancelNotAllowedError = (): AppError =>
  error(
    'PURCHASE_ORDER_CANCEL_NOT_ALLOWED',
    'This Purchase Order cannot be cancelled.',
    400,
  );

/** Referenced request context does not match the readiness-derived scope. */
export const purchaseOrderContextInvalidError = (): AppError =>
  error(
    'PURCHASE_ORDER_CONTEXT_INVALID',
    'The referenced request does not match the Purchase Order Readiness context.',
    400,
  );

/** RFQ-derived DRAFT POs are immutable until explicit issuance. */
export const purchaseOrderRfqDerivedImmutableError = (): AppError =>
  error(
    'PURCHASE_ORDER_RFQ_DERIVED_IMMUTABLE',
    'RFQ-derived Purchase Orders and Lines cannot be edited or removed outside the RFQ award process.',
    409,
  );

// ─── PART 03: Issuance ──────────────────────────────────────────

/**
 * Only a DRAFT Purchase Order can be issued. Re-issuing an ISSUED order or
 * issuing a CANCELLED one is an invalid lifecycle transition.
 */
export const purchaseOrderNotIssuableStateError = (
  currentStatus: string,
): AppError =>
  new AppError({
    code: ERROR_CODES.PURCHASE_ORDER_NOT_ISSUABLE_STATE,
    message: `Cannot issue a Purchase Order from ${currentStatus}.`,
    statusCode: 409,
    details: [{ field: 'status', message: `current status is ${currentStatus}` }],
  });

/** An empty commitment is never issuable. */
export const purchaseOrderNoLinesError = (): AppError =>
  error(
    'PURCHASE_ORDER_NO_LINES',
    'A Purchase Order must have at least one line before it can be issued.',
    409,
  );

/**
 * Issuance readiness failed. `blockers` are deterministic codes resolved from
 * the existing authorities — BE-17F remains the sole readiness authority.
 */
export const purchaseOrderNotIssuableError = (
  blockers: readonly string[],
): AppError =>
  new AppError({
    code: ERROR_CODES.PURCHASE_ORDER_NOT_ISSUABLE,
    message:
      'Purchase Order issuance requirements are not satisfied. See details for blockers.',
    statusCode: 409,
    details: blockers.map((blocker) => ({
      field: 'issueReadiness',
      message: blocker,
    })),
  });
