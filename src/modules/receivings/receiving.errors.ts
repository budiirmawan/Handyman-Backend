import { AppError, ERROR_CODES } from '../../shared/errors';

function make(
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError {
  return new AppError({ code, message, statusCode });
}

export function receivingNotFoundError(): AppError {
  return make(ERROR_CODES.RECEIVING_NOT_FOUND, 'Receiving record not found.', 404);
}

export function receivingRequestInvalidError(): AppError {
  return make(
    ERROR_CODES.RECEIVING_REQUEST_INVALID,
    'The referenced Procurement request is invalid.',
    400,
  );
}

export function receivingVendorInvalidError(): AppError {
  return make(
    ERROR_CODES.RECEIVING_VENDOR_INVALID,
    'The referenced Vendor is invalid or belongs to another client.',
    400,
  );
}

export function receivingReadinessInvalidError(): AppError {
  return make(
    ERROR_CODES.RECEIVING_READINESS_INVALID,
    'The request and vendor must have a READY purchase order readiness to receive.',
    400,
  );
}

export function receivingAlreadyFinalizedError(): AppError {
  return make(
    ERROR_CODES.RECEIVING_ALREADY_FINALIZED,
    'A finalized receiving record cannot be modified.',
    409,
  );
}

export function receivingInvalidQuantityError(): AppError {
  return make(
    ERROR_CODES.RECEIVING_INVALID_QUANTITY,
    'Material receiving quantity must be a positive number.',
    400,
  );
}

export function receivingItemClientMismatchError(): AppError {
  return make(
    ERROR_CODES.RECEIVING_ITEM_CLIENT_MISMATCH,
    'The item does not belong to the receiving request\u2019s client.',
    400,
  );
}

export function receivingWarehouseClientMismatchError(): AppError {
  return make(
    ERROR_CODES.RECEIVING_WAREHOUSE_CLIENT_MISMATCH,
    'The warehouse does not belong to the receiving request\u2019s client.',
    400,
  );
}

export function receivingWarehouseBuildingMismatchError(): AppError {
  return make(
    ERROR_CODES.RECEIVING_WAREHOUSE_BUILDING_MISMATCH,
    'The warehouse does not belong to the receiving request\u2019s building.',
    400,
  );
}

export function receivingMaterialRequestInvalidError(): AppError {
  return make(
    ERROR_CODES.RECEIVING_MATERIAL_REQUEST_INVALID,
    'The referenced Material Request line is invalid for this receiving (not found, not OPEN, not a material receiving, or belongs to another Purchase Request).',
    400,
  );
}

export function receivingMaterialRequestItemMismatchError(): AppError {
  return make(
    ERROR_CODES.RECEIVING_MATERIAL_REQUEST_ITEM_MISMATCH,
    'The received item does not match the referenced Material Request line item.',
    400,
  );
}

export function receivingMaterialRequestScopeMismatchError(): AppError {
  return make(
    ERROR_CODES.RECEIVING_MATERIAL_REQUEST_SCOPE_MISMATCH,
    'The referenced Material Request line does not belong to the receiving request\u2019s Client/Building scope (or targets a different warehouse).',
    400,
  );
}

export function receivingOverReceiptError(): AppError {
  return make(
    ERROR_CODES.RECEIVING_OVER_RECEIPT,
    'Cumulative received quantity would exceed the Material Request line quantity.',
    409,
  );
}

export function receivingUomIncompatibleError(): AppError {
  return make(
    ERROR_CODES.RECEIVING_UOM_INCOMPATIBLE,
    'The receiving UOM is incompatible with the Material Request line / item UOM and no conversion authority exists.',
    400,
  );
}
