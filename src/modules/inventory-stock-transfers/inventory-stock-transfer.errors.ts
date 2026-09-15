import { AppError, ERROR_CODES } from '../../shared/errors';

export function transferNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_TRANSFER_NOT_FOUND,
    message: 'Stock transfer not found.',
    statusCode: 404,
  });
}

export function transferSameWarehouseError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_TRANSFER_SAME_WAREHOUSE,
    message: 'Source and destination warehouse must be different.',
    statusCode: 400,
  });
}

export function transferInvalidQuantityError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_TRANSFER_INVALID_QUANTITY,
    message: 'Transfer quantity must be positive.',
    statusCode: 400,
  });
}

export function transferInsufficientStockError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_TRANSFER_INSUFFICIENT_STOCK,
    message: 'Insufficient available stock in source warehouse.',
    statusCode: 409,
  });
}

export function transferClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_TRANSFER_CLIENT_MISMATCH,
    message: 'Source, destination and item must belong to same client.',
    statusCode: 400,
  });
}
