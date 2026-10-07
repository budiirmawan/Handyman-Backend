import { AppError, ERROR_CODES } from '../../shared/errors';

export function assetWarrantyNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_WARRANTY_NOT_FOUND,
    message: 'Asset warranty not found.',
    statusCode: 404,
  });
}

/** At most one ACTIVE coverage per Asset. */
export function assetWarrantyActiveExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_WARRANTY_ACTIVE_EXISTS,
    message: 'This asset already has an active warranty.',
    statusCode: 409,
  });
}

export function assetWarrantyNumberAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_WARRANTY_NUMBER_ALREADY_EXISTS,
    message: 'A warranty with this number already exists for this asset.',
    statusCode: 409,
  });
}

/** Overlapping coverage windows for the same Asset. */
export function assetWarrantyOverlapError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_WARRANTY_OVERLAP,
    message:
      'This warranty period overlaps an existing warranty for this asset.',
    statusCode: 409,
  });
}

/** The requested status contradicts the coverage dates. */
export function assetWarrantyStatusDateMismatchError(
  message: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_WARRANTY_STATUS_DATE_MISMATCH,
    message,
    statusCode: 400,
  });
}
