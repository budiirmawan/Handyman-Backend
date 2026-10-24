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

/**
 * CR-HM-FIELD-OPERATIONS-01 PART 04 — defensive bounded outcome for a
 * concurrent configuration race. The service serializes writers with a
 * per-Building row lock, so this is a backstop for the DB invariant
 * (one ACTIVE policy per Building) rather than an expected user outcome.
 */
export function buildingGeospatialPolicyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BUILDING_GEOSPATIAL_POLICY_CONFLICT,
    message:
      'The building geospatial policy was modified concurrently; ' +
      're-read the ACTIVE policy and retry.',
    statusCode: 409,
  });
}
