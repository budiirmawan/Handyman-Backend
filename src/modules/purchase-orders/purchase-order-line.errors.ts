import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: keyof typeof ERROR_CODES,
  message: string,
  statusCode: number,
): AppError =>
  new AppError({ code: ERROR_CODES[code], message, statusCode });

export const purchaseOrderLineNotFoundError = (): AppError =>
  error('PURCHASE_ORDER_LINE_NOT_FOUND', 'Purchase Order Line not found.', 404);

/** The originating Material Request / Service Request line is unusable. */
export const purchaseOrderLineRequestInvalidError = (): AppError =>
  error(
    'PURCHASE_ORDER_LINE_REQUEST_INVALID',
    'The originating request line is invalid or not committable.',
    400,
  );

/**
 * The request line does not belong to the Purchase Order's own Purchase
 * Request, Client or Building — committing it would break the
 * PO ↔ request ↔ scope chain.
 */
export const purchaseOrderLineRequestMismatchError = (): AppError =>
  error(
    'PURCHASE_ORDER_LINE_REQUEST_MISMATCH',
    'The originating request line does not belong to this Purchase Order context.',
    400,
  );

/** Duplicate linkage: this request line is already committed on this PO. */
export const purchaseOrderLineDuplicateError = (): AppError =>
  error(
    'PURCHASE_ORDER_LINE_DUPLICATE',
    'This request line is already committed on this Purchase Order.',
    409,
  );

/** Lines may only be added/changed while the Purchase Order is DRAFT. */
export const purchaseOrderLineNotDraftError = (): AppError =>
  error(
    'PURCHASE_ORDER_LINE_NOT_DRAFT',
    'Purchase Order Lines can only be modified while the Purchase Order is DRAFT.',
    400,
  );

export const purchaseOrderLinePriceInvalidError = (): AppError =>
  error(
    'PURCHASE_ORDER_LINE_PRICE_INVALID',
    'unitPrice must be a finite non-negative number.',
    400,
  );

/**
 * The Material Request line and the Inventory Item disagree on UOM and no
 * conversion authority exists — mirrors RECEIVING_UOM_INCOMPATIBLE.
 */
export const purchaseOrderLineUomIncompatibleError = (): AppError =>
  error(
    'PURCHASE_ORDER_LINE_UOM_INCOMPATIBLE',
    'The request line UOM is incompatible with the item UOM and no conversion authority exists.',
    400,
  );

/** RFQ-derived PO Lines remain tied to the awarded quote and cannot drift. */
export const purchaseOrderLineRfqDerivedImmutableError = (): AppError =>
  error(
    'PURCHASE_ORDER_RFQ_DERIVED_IMMUTABLE',
    'RFQ-derived Purchase Order Lines cannot be added, edited, or removed outside the RFQ award process.',
    409,
  );
