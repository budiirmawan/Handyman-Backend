import { AppError, ERROR_CODES } from '../../shared/errors';

export function unitPartyRoleNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.UNIT_PARTY_ROLE_NOT_FOUND,
    message: 'Unit party role assignment not found.',
    statusCode: 404,
  });
}

export function unitPartyRoleAlreadyActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.UNIT_PARTY_ROLE_ALREADY_ACTIVE,
    message:
      'This party already holds this role on the Unit; end the existing assignment instead.',
    statusCode: 409,
  });
}

/**
 * The party/Unit/Building combination cannot be expressed. The message is
 * intentionally generic: a wrong-Client party and an unavailable party are
 * indistinguishable to the caller.
 */
export function unitPartyRoleContextMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.UNIT_PARTY_ROLE_CONTEXT_MISMATCH,
    message:
      'The party cannot be assigned to this Unit in this Building and Client.',
    statusCode: 400,
  });
}

export function unitPartyRoleUnavailableError(): AppError {
  return new AppError({
    code: ERROR_CODES.UNIT_PARTY_ROLE_UNAVAILABLE,
    message: 'The Unit or the party is not ACTIVE.',
    statusCode: 400,
  });
}

export function apartmentUnitNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.APARTMENT_UNIT_NOT_FOUND,
    message: 'Unit not found.',
    statusCode: 404,
  });
}

export function apartmentUnitFloorMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.APARTMENT_UNIT_FLOOR_MISMATCH,
    message: 'The Floor does not belong to this Building.',
    statusCode: 400,
  });
}
