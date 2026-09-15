import { AppError, ERROR_CODES } from '../../shared/errors';

export function permitReadinessNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PERMIT_READINESS_NOT_FOUND,
    message: 'Work permit readiness not found.',
    statusCode: 404,
  });
}

/** The same Vendor Work already has a readiness record for this requirement type. */
export function permitReadinessAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.PERMIT_READINESS_ALREADY_EXISTS,
    message:
      'Work permit readiness already exists for this vendor work and requirement type.',
    statusCode: 409,
  });
}

/**
 * A Vendor / Building filter combination is invalid (the Vendor holds no
 * ACTIVE relationship to that Building), or the Building context does not
 * match the Vendor Work.
 */
export function permitReadinessBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.PERMIT_READINESS_BUILDING_MISMATCH,
    message: 'The vendor is not related to the permit readiness building.',
    statusCode: 400,
  });
}

/** The validity window is malformed (valid_until before valid_from). */
export function permitReadinessInvalidValidityError(): AppError {
  return new AppError({
    code: ERROR_CODES.PERMIT_READINESS_INVALID_VALIDITY,
    message: 'The permit validity window is invalid.',
    statusCode: 400,
  });
}
