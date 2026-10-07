import { AppError, ERROR_CODES } from '../../shared/errors';

function make(
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError {
  return new AppError({ code, message, statusCode });
}

export function woProcurementNotFoundError(): AppError {
  return make(
    ERROR_CODES.WO_PROCUREMENT_NOT_FOUND,
    'Work order procurement binding not found.',
    404,
  );
}

export function woProcurementAlreadyBoundError(): AppError {
  return make(
    ERROR_CODES.WO_PROCUREMENT_ALREADY_BOUND,
    'This work order is already bound to a procurement request.',
    409,
  );
}

export function woProcurementRequestInvalidError(): AppError {
  return make(
    ERROR_CODES.WO_PROCUREMENT_REQUEST_INVALID,
    'The referenced Work Order or procurement request is invalid.',
    400,
  );
}

export function woProcurementBuildingMismatchError(): AppError {
  return make(
    ERROR_CODES.WO_PROCUREMENT_BUILDING_MISMATCH,
    'The procurement context must belong to the same client and building as the work order.',
    400,
  );
}

export function woProcurementReceivingInvalidError(): AppError {
  return make(
    ERROR_CODES.WO_PROCUREMENT_RECEIVING_INVALID,
    'The referenced receiving record is invalid.',
    400,
  );
}

export function woProcurementReceivingMismatchError(): AppError {
  return make(
    ERROR_CODES.WO_PROCUREMENT_RECEIVING_MISMATCH,
    'The receiving record does not belong to this binding\u2019s request and building.',
    400,
  );
}

// ─── CR-BE-R2P-01 PART 05: SPK → PO / Vendor / WO chain ─────────

/** The referenced Work Contract (SPK) does not exist or is not reachable. */
export function woProcurementWorkContractInvalidError(): AppError {
  return make(
    ERROR_CODES.WO_PROCUREMENT_WORK_CONTRACT_INVALID,
    'The referenced Work Contract (SPK) is invalid.',
    400,
  );
}

/**
 * Only an ACTIVE SPK authorizes work. A DRAFT mandate is not yet in force,
 * and a COMPLETED or CANCELLED one no longer is.
 */
export function woProcurementWorkContractNotActiveError(
  currentStatus: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.WO_PROCUREMENT_WORK_CONTRACT_NOT_ACTIVE,
    message:
      'A Work Order can only be bound to an ACTIVE Work Contract (SPK).',
    statusCode: 409,
    details: [
      {
        field: 'workContractId',
        message: `Work Contract status is ${currentStatus}`,
      },
    ],
  });
}

/** The SPK's Purchase Order must still be ISSUED for the chain to hold. */
export function woProcurementPurchaseOrderNotIssuedError(
  currentStatus: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.WO_PROCUREMENT_PURCHASE_ORDER_NOT_ISSUED,
    message:
      'The Work Contract\u2019s Purchase Order must be ISSUED to bind a Work Order.',
    statusCode: 409,
    details: [
      {
        field: 'purchaseOrderId',
        message: `Purchase Order status is ${currentStatus}`,
      },
    ],
  });
}

/** The Work Order's assigned Vendor disagrees with the SPK's Vendor. */
export function woProcurementVendorMismatchError(): AppError {
  return make(
    ERROR_CODES.WO_PROCUREMENT_VENDOR_MISMATCH,
    'The Work Order\u2019s assigned Vendor does not match the Work Contract Vendor.',
    400,
  );
}

/** The binding already carries an SPK; re-binding is not a silent overwrite. */
export function woProcurementWorkContractAlreadyBoundError(): AppError {
  return make(
    ERROR_CODES.WO_PROCUREMENT_WORK_CONTRACT_ALREADY_BOUND,
    'This binding is already bound to a Work Contract (SPK).',
    409,
  );
}
