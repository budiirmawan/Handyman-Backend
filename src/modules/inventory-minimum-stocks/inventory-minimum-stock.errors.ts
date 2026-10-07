import { AppError, ERROR_CODES } from '../../shared/errors';

export function minimumStockNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MINIMUM_STOCK_NOT_FOUND,
    message: 'Minimum stock threshold not found.',
    statusCode: 404,
  });
}

export function minimumStockAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MINIMUM_STOCK_ALREADY_EXISTS,
    message: 'Minimum stock threshold already exists for this item and warehouse.',
    statusCode: 409,
  });
}

export function minimumStockInvalidQuantityError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MINIMUM_STOCK_INVALID_QUANTITY,
    message: 'Minimum quantity must be positive.',
    statusCode: 400,
  });
}

export function minimumStockClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_MINIMUM_STOCK_CLIENT_MISMATCH,
    message: 'Item and warehouse must belong to same client.',
    statusCode: 400,
  });
}
