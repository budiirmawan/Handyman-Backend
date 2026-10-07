import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: keyof typeof ERROR_CODES,
  message: string,
  statusCode: number,
): AppError =>
  new AppError({ code: ERROR_CODES[code], message, statusCode });

export const workContractNotFoundError = (): AppError =>
  error('WORK_CONTRACT_NOT_FOUND', 'Work Contract (SPK) not found.', 404);

export const workContractNumberExistsError = (): AppError =>
  error(
    'WORK_CONTRACT_NUMBER_ALREADY_EXISTS',
    'SPK number already exists for this Client.',
    409,
  );

/** The referenced Purchase Order does not exist or is not reachable. */
export const workContractPurchaseOrderInvalidError = (): AppError =>
  error(
    'WORK_CONTRACT_PURCHASE_ORDER_INVALID',
    'The referenced Purchase Order is invalid.',
    400,
  );

/**
 * Frozen decision: an SPK executes a COMMITTED order. A DRAFT Purchase Order
 * is not yet a mandate to execute, and a CANCELLED one never will be.
 */
export const workContractPurchaseOrderNotIssuedError = (
  currentStatus: string,
): AppError =>
  new AppError({
    code: ERROR_CODES.WORK_CONTRACT_PURCHASE_ORDER_NOT_ISSUED,
    message:
      'A Work Contract (SPK) can only be raised against an ISSUED Purchase Order.',
    statusCode: 409,
    details: [
      {
        field: 'purchaseOrderId',
        message: `Purchase Order status is ${currentStatus}`,
      },
    ],
  });

/** At most one live (DRAFT or ACTIVE) SPK may occupy a Purchase Order. */
export const workContractAlreadyExistsForPoError = (): AppError =>
  error(
    'WORK_CONTRACT_ALREADY_EXISTS_FOR_PO',
    'A live Work Contract (SPK) already exists for this Purchase Order.',
    409,
  );

export const workContractNotDraftError = (): AppError =>
  error(
    'WORK_CONTRACT_NOT_DRAFT',
    'Only a draft Work Contract (SPK) can be updated.',
    400,
  );

/** Deterministic lifecycle: DRAFT → ACTIVE → COMPLETED / CANCELLED. */
export const workContractTransitionInvalidError = (
  from: string,
  to: string,
): AppError =>
  new AppError({
    code: ERROR_CODES.WORK_CONTRACT_TRANSITION_INVALID,
    message: `A Work Contract (SPK) cannot move from ${from} to ${to}.`,
    statusCode: 409,
    details: [{ field: 'status', message: `current status is ${from}` }],
  });

/** The inherited Vendor is no longer usable for this mandate. */
export const workContractVendorInvalidError = (): AppError =>
  error(
    'WORK_CONTRACT_VENDOR_INVALID',
    'The Purchase Order Vendor is not valid for this Building.',
    400,
  );

/** The Purchase Order's own scope is internally inconsistent. */
export const workContractContextInvalidError = (): AppError =>
  error(
    'WORK_CONTRACT_CONTEXT_INVALID',
    'The Purchase Order context is inconsistent.',
    400,
  );
