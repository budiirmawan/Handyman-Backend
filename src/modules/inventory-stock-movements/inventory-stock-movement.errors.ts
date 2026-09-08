import { AppError, ERROR_CODES } from '../../shared/errors';

export function stockMovementNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_STOCK_MOVEMENT_NOT_FOUND,
    message: 'Stock movement not found.',
    statusCode: 404,
  });
}

export function stockMovementInvalidQuantityError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_STOCK_MOVEMENT_INVALID_QUANTITY,
    message: 'Movement quantity must be positive.',
    statusCode: 400,
  });
}

export function stockMovementInsufficientStockError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_STOCK_MOVEMENT_INSUFFICIENT_STOCK,
    message: 'Insufficient available stock for STOCK_OUT.',
    statusCode: 409,
  });
}

export function stockMovementClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_STOCK_MOVEMENT_CLIENT_MISMATCH,
    message: 'Item and warehouse must belong to same client.',
    statusCode: 400,
  });
}

export function stockMovementImmutableError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_STOCK_MOVEMENT_IMMUTABLE,
    message: 'Posted stock movements cannot be edited or deleted.',
    statusCode: 405,
  });
}

export function stockMovementWorkOrderBypassError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_STOCK_MOVEMENT_WORK_ORDER_BYPASS,
    message: 'Work Order material consumption must use the Work Order material issue endpoint.',
    statusCode: 409,
  });
}
