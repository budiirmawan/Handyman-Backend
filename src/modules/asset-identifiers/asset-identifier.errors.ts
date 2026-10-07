import { AppError, ERROR_CODES } from '../../shared/errors';

export function assetIdentifierNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_IDENTIFIER_NOT_FOUND,
    message: 'Asset identifier not found.',
    statusCode: 404,
  });
}

export function assetIdentifierValueAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_IDENTIFIER_VALUE_ALREADY_EXISTS,
    message: 'This identifier value is already in use.',
    statusCode: 409,
  });
}

/** At most one ACTIVE identifier per Asset per type. */
export function assetIdentifierActiveTypeExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_IDENTIFIER_ACTIVE_TYPE_EXISTS,
    message:
      'This asset already has an active identifier of this type.',
    statusCode: 409,
  });
}

/**
 * Resolution failure. Deliberately identical for an unknown value and an
 * INACTIVE (retired) label: a caller probing values must not be able to tell
 * which identifiers once existed.
 */
export function assetIdentifierNotResolvableError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_IDENTIFIER_NOT_RESOLVABLE,
    message: 'No active asset identifier matches this value.',
    statusCode: 404,
  });
}
