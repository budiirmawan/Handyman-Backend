import { AppError, ERROR_CODES } from '../../shared/errors';

export function stockBalanceNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_STOCK_BALANCE_NOT_FOUND,
    message: 'Stock balance not found.',
    statusCode: 404,
  });
}

export function stockBalanceAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_STOCK_BALANCE_ALREADY_EXISTS,
    message: 'Stock balance already exists for this item and warehouse.',
    statusCode: 409,
  });
}

export function stockBalanceClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_STOCK_BALANCE_CLIENT_MISMATCH,
    message: 'Item and warehouse must belong to the same client.',
    statusCode: 400,
  });
}

export function stockBalanceItemWarehouseMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_STOCK_BALANCE_ITEM_WAREHOUSE_MISMATCH,
    message: 'Item and warehouse client/building context mismatch.',
    statusCode: 400,
  });
}

export function stockBalanceNegativeQuantityError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_STOCK_BALANCE_NEGATIVE_QUANTITY,
    message: 'Quantity cannot be negative.',
    statusCode: 400,
  });
}

export function stockBalanceReservedExceedsError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_STOCK_BALANCE_RESERVED_EXCEEDS_ON_HAND,
    message: 'Reserved quantity cannot exceed quantity on hand.',
    statusCode: 400,
  });
}

export function stockBalanceInitActorRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_STOCK_BALANCE_INIT_ACTOR_REQUIRED,
    message:
      'Non-zero stock balance initialization must be attributed to an acting user so the ledger movement is auditable.',
    statusCode: 400,
  });
}
