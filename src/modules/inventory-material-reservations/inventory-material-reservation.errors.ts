import { AppError, ERROR_CODES } from '../../shared/errors';

export function materialReservationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MATERIAL_RESERVATION_NOT_FOUND,
    message: 'Material reservation not found.',
    statusCode: 404,
  });
}

export function materialReservationInvalidQuantityError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MATERIAL_RESERVATION_INVALID_QUANTITY,
    message: 'Reservation quantity must be a positive number.',
    statusCode: 400,
  });
}

export function materialReservationDemandNotApprovedError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MATERIAL_RESERVATION_DEMAND_NOT_APPROVED,
    message: 'Only approved Material Request demand can be reserved.',
    statusCode: 409,
  });
}

export function materialReservationDemandExceededError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MATERIAL_RESERVATION_DEMAND_EXCEEDED,
    message: 'Reservation quantity exceeds the remaining reservable demand.',
    statusCode: 409,
  });
}

export function materialReservationInsufficientStockError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MATERIAL_RESERVATION_INSUFFICIENT_STOCK,
    message: 'Insufficient available stock for material reservation.',
    statusCode: 409,
  });
}

export function materialReservationClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MATERIAL_RESERVATION_CLIENT_MISMATCH,
    message: 'Material Request, warehouse, and item must belong to the same client.',
    statusCode: 400,
  });
}

export function materialReservationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MATERIAL_RESERVATION_BUILDING_MISMATCH,
    message: 'The warehouse must belong to the Material Request building.',
    statusCode: 400,
  });
}

export function materialReservationItemMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MATERIAL_RESERVATION_ITEM_MISMATCH,
    message: 'The supplied item does not match the Material Request item.',
    statusCode: 400,
  });
}

export function materialReservationWarehouseMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MATERIAL_RESERVATION_WAREHOUSE_MISMATCH,
    message: 'The warehouse does not match the Material Request target warehouse.',
    statusCode: 400,
  });
}

export function materialReservationUomIncompatibleError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MATERIAL_RESERVATION_UOM_INCOMPATIBLE,
    message: 'The reservation UOM is incompatible with the Material Request item UOM.',
    statusCode: 400,
  });
}

export function materialReservationNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MATERIAL_RESERVATION_NOT_ACTIVE,
    message: 'Only active material reservations can be released, cancelled, or consumed.',
    statusCode: 409,
  });
}

export function materialReservationAllocationExceededError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MATERIAL_RESERVATION_ALLOCATION_EXCEEDED,
    message: 'Issue quantity exceeds the remaining reservation allocation.',
    statusCode: 409,
  });
}
