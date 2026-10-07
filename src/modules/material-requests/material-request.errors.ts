import { AppError, ERROR_CODES } from '../../shared/errors';

export function materialRequestNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.MATERIAL_REQUEST_NOT_FOUND,
    message: 'Material request not found.',
    statusCode: 404,
  });
}

export function materialRequestInvalidQuantityError(): AppError {
  return new AppError({
    code: ERROR_CODES.MATERIAL_REQUEST_INVALID_QUANTITY,
    message: 'Material request quantity must be a positive number.',
    statusCode: 400,
  });
}

/**
 * The supplied UOM does not match the referenced Item's UOM. The Item Master
 * (BE-16A) is the single authority for an item's UOM, so a Material Request
 * must use exactly that UOM (or none when the item has none).
 */
export function materialRequestItemUomMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.MATERIAL_REQUEST_ITEM_UOM_MISMATCH,
    message: 'The UOM must match the item\u2019s UOM.',
    statusCode: 400,
  });
}

/**
 * The referenced Item belongs to a different Client than the Purchase Request.
 */
export function materialRequestItemClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.MATERIAL_REQUEST_ITEM_CLIENT_MISMATCH,
    message: 'The item does not belong to the purchase request\u2019s client.',
    statusCode: 400,
  });
}

/** Material Requests can only be added to an OPEN Purchase Request. */
export function materialRequestPurchaseRequestNotOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.MATERIAL_REQUEST_PURCHASE_REQUEST_NOT_OPEN,
    message: 'Material requests can only be added to an open purchase request.',
    statusCode: 400,
  });
}

export function materialRequestWarehouseClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.MATERIAL_REQUEST_WAREHOUSE_CLIENT_MISMATCH,
    message: 'The warehouse does not belong to the purchase request\u2019s client.',
    statusCode: 400,
  });
}

export function materialRequestWarehouseBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.MATERIAL_REQUEST_WAREHOUSE_BUILDING_MISMATCH,
    message: 'The warehouse does not belong to the purchase request\u2019s building.',
    statusCode: 400,
  });
}

/**
 * Only OPEN Material Requests are mutable at intake. A request that is no
 * longer OPEN (already CANCELLED) cannot have its details changed, and an
 * already-cancelled request cannot be cancelled again.
 */
export function materialRequestNotOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.MATERIAL_REQUEST_NOT_OPEN,
    message: 'Only open material requests can be modified.',
    statusCode: 400,
  });
}

export function materialRequestActiveReservationError(): AppError {
  return new AppError({
    code: ERROR_CODES.MATERIAL_REQUEST_ACTIVE_RESERVATION,
    message: 'Material Request cannot be cancelled while an active reservation remains.',
    statusCode: 409,
  });
}
