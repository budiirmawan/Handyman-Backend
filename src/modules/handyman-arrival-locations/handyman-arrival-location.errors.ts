import { AppError, ERROR_CODES } from '../../shared/errors';

/** Location chain breaks master linkage, completeness, or Client coherence. */
export function arrivalLocationIdentifierValidationError(
  details: { field: string; message: string }[],
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_VALIDATION,
    message: 'Request validation failed.',
    statusCode: 400,
    details,
  });
}

/** Registry row absent (bounded; deactivation/management paths only). */
export function arrivalLocationIdentifierNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_NOT_FOUND,
    message: 'Handyman arrival location identifier not found.',
    statusCode: 404,
  });
}
