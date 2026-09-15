import { AppError, ERROR_CODES } from '../../shared/errors';

export function assetCertificationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_CERTIFICATION_NOT_FOUND,
    message: 'Asset certification not found.',
    statusCode: 404,
  });
}

/** At most one ACTIVE certification per Asset per certification type. */
export function assetCertificationActiveExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_CERTIFICATION_ACTIVE_EXISTS,
    message:
      'This asset already has an active certification of this type.',
    statusCode: 409,
  });
}

export function assetCertificationNumberAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_CERTIFICATION_NUMBER_ALREADY_EXISTS,
    message:
      'A certification with this certificate number already exists for this asset.',
    statusCode: 409,
  });
}

/** Overlapping validity windows within the same certification type. */
export function assetCertificationOverlapError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_CERTIFICATION_OVERLAP,
    message:
      'This certification period overlaps an existing certification of the same type for this asset.',
    statusCode: 409,
  });
}

/** The requested status contradicts the certification dates. */
export function assetCertificationStatusDateMismatchError(
  message: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_CERTIFICATION_STATUS_DATE_MISMATCH,
    message,
    statusCode: 400,
  });
}
