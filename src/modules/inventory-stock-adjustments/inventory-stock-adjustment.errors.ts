import { AppError, ERROR_CODES } from '../../shared/errors';

export function adjustmentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ADJUSTMENT_NOT_FOUND,
    message: 'Stock adjustment not found.',
    statusCode: 404,
  });
}

export function adjustmentInvalidTypeError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ADJUSTMENT_INVALID_TYPE,
    message: 'Invalid adjustment type.',
    statusCode: 400,
  });
}

export function adjustmentInvalidQuantityError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ADJUSTMENT_INVALID_QUANTITY,
    message: 'Adjustment quantity must be valid (>=0, >0 for INCREASE/DECREASE).',
    statusCode: 400,
  });
}

export function adjustmentReasonRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ADJUSTMENT_REASON_REQUIRED,
    message: 'Adjustment reason is required.',
    statusCode: 400,
  });
}

export function adjustmentNegativeResultError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ADJUSTMENT_NEGATIVE_RESULT,
    message: 'Adjustment would result in negative stock or reserved exceeds on-hand.',
    statusCode: 409,
  });
}

export function adjustmentClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ADJUSTMENT_CLIENT_MISMATCH,
    message: 'Item and warehouse must belong to same client.',
    statusCode: 400,
  });
}

export function adjustmentImmutableError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ADJUSTMENT_IMMUTABLE,
    message: 'Posted adjustments cannot be edited or deleted.',
    statusCode: 405,
  });
}
