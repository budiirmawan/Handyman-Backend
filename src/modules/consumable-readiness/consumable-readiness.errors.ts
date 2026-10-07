import { AppError, ERROR_CODES } from '../../shared/errors';

export function consumableRequirementNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONSUMABLE_REQUIREMENT_NOT_FOUND,
    message: 'Consumable requirement not found.',
    statusCode: 404,
  });
}

export function consumableRequirementCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONSUMABLE_REQUIREMENT_CODE_ALREADY_EXISTS,
    message:
      'A consumable requirement with this code already exists for this building.',
    statusCode: 409,
  });
}

export function consumableRequirementInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONSUMABLE_REQUIREMENT_INACTIVE,
    message:
      'Inactive consumable requirement cannot receive new readiness checks.',
    statusCode: 400,
  });
}

export function consumableReadinessInvalidStatusError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONSUMABLE_READINESS_INVALID_STATUS,
    message: 'Readiness status must be one of READY, LOW, NOT_READY, UNKNOWN.',
    statusCode: 400,
  });
}

export function consumableReadinessInvalidQuantityError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONSUMABLE_READINESS_INVALID_QUANTITY,
    message: 'Quantity must be a non-negative number.',
    statusCode: 400,
  });
}

export function consumableReadinessClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONSUMABLE_READINESS_CLIENT_MISMATCH,
    message: 'Consumable requirement belongs to a different client.',
    statusCode: 400,
  });
}

export function consumableReadinessBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONSUMABLE_READINESS_BUILDING_MISMATCH,
    message: 'Consumable requirement belongs to a different building.',
    statusCode: 400,
  });
}
