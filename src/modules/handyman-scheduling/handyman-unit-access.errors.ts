import { AppError } from '../../shared/errors';
import { ERROR_CODES } from '../../shared/errors';

/** Referenced unit-access-readiness row not found. */
export function handymanUnitAccessReadinessNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNIT_ACCESS_READINESS_NOT_FOUND,
    message: 'Handyman unit access readiness not found.',
    statusCode: 404,
  });
}

/** The request already carries an ACTIVE access readiness (race-safe 409). */
export function handymanUnitAccessReadinessAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNIT_ACCESS_READINESS_ALREADY_EXISTS,
    message:
      'An ACTIVE unit access readiness already exists for this request.',
    statusCode: 409,
  });
}

/** Supersede attempted on a non-ACTIVE readiness row. */
export function handymanUnitAccessReadinessInvalidStatusError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNIT_ACCESS_READINESS_INVALID_STATUS,
    message: 'Only the ACTIVE unit access readiness can be superseded.',
    statusCode: 400,
  });
}

/** Access window missing, unparseable, reversed or zero-length. */
export function handymanUnitAccessReadinessWindowInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNIT_ACCESS_READINESS_WINDOW_INVALID,
    message:
      'accessWindowStart/accessWindowEnd are required and start must be strictly before end.',
    statusCode: 400,
  });
}

/** The request cannot identify an authoritative unit/space. */
export function handymanUnitAccessReadinessUnitSpaceUnavailableError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNIT_ACCESS_READINESS_UNIT_SPACE_UNAVAILABLE,
    message:
      'The authoritative request context carries no unit/space; unit access readiness cannot be derived.',
    statusCode: 400,
  });
}

/** Derived location chain disagrees with the request authority. */
export function handymanUnitAccessReadinessLocationInconsistentError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNIT_ACCESS_READINESS_LOCATION_INCONSISTENT,
    message:
      'The derived unit/space location chain does not match the request building context.',
    statusCode: 400,
  });
}
