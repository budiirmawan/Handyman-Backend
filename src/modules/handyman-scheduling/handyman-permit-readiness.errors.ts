import { AppError } from '../../shared/errors';
import { ERROR_CODES } from '../../shared/errors';

/** Referenced permit-readiness row not found. */
export function handymanPermitReadinessNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PERMIT_READINESS_NOT_FOUND,
    message: 'Handyman permit readiness not found.',
    statusCode: 404,
  });
}

/** The request already carries an ACTIVE permit readiness (race-safe 409). */
export function handymanPermitReadinessAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PERMIT_READINESS_ALREADY_EXISTS,
    message: 'An ACTIVE permit readiness already exists for this request.',
    statusCode: 409,
  });
}

/** Supersede attempted on a non-ACTIVE readiness row. */
export function handymanPermitReadinessInvalidStatusError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PERMIT_READINESS_INVALID_STATUS,
    message: 'Only the ACTIVE permit readiness can be superseded.',
    statusCode: 400,
  });
}

/** Validity range missing, unparseable, reversed or zero-length. */
export function handymanPermitReadinessValidityInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PERMIT_READINESS_VALIDITY_INVALID,
    message:
      'validFrom/validUntil are required and validFrom must be strictly before validUntil.',
    statusCode: 400,
  });
}

/** Unsupported permit type (bounded Handyman vocabulary only). */
export function handymanPermitReadinessTypeUnsupportedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PERMIT_READINESS_TYPE_UNSUPPORTED,
    message:
      'permitType must be one of the bounded Handyman values: UNIT, BUILDING_COMMON_AREA.',
    statusCode: 400,
  });
}
