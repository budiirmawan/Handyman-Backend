import { AppError, ERROR_CODES } from '../../shared/errors';

/** Policy input breaks physical bounds or building coherence. */
export function buildingGeospatialPolicyValidationError(
  details: { field: string; message: string }[],
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BUILDING_GEOSPATIAL_POLICY_VALIDATION,
    message: 'Request validation failed.',
    statusCode: 400,
    details,
  });
}

/** No ACTIVE policy row exists for the building (management paths). */
export function buildingGeospatialPolicyNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BUILDING_GEOSPATIAL_POLICY_NOT_FOUND,
    message:
      'No ACTIVE Handyman building geospatial policy exists for ' +
      'this building.',
    statusCode: 404,
  });
}

/** Device-signal input breaks bounded physical/temporal validation. */
export function geofenceSignalValidationError(
  details: { field: string; message: string }[],
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_GEOFENCE_SIGNAL_VALIDATION,
    message: 'Request validation failed.',
    statusCode: 400,
    details,
  });
}
