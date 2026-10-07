import { AppError, ERROR_CODES } from '../../shared/errors';

export function assetNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_NOT_FOUND,
    message: 'Asset not found.',
    statusCode: 404,
  });
}

export function assetCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_CODE_ALREADY_EXISTS,
    message: 'An asset with this code already exists for this client.',
    statusCode: 409,
  });
}

export function assetSerialNumberAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_SERIAL_NUMBER_ALREADY_EXISTS,
    message: 'An asset with this serial number already exists for this client.',
    statusCode: 409,
  });
}

/** The Functional Location does not belong to the Asset's own Building. */
export function assetLocationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_LOCATION_BUILDING_MISMATCH,
    message:
      'Asset and functional location must belong to the same building.',
    statusCode: 400,
  });
}

export function assetLocationInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_LOCATION_INACTIVE,
    message:
      'Inactive functional locations cannot receive a new active asset binding.',
    statusCode: 400,
  });
}

/** A RETIRED Asset is terminal: no automatic reactivation. */
export function assetRetiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_RETIRED,
    message:
      'This asset is retired and cannot receive further lifecycle transitions.',
    statusCode: 409,
  });
}

export function assetStatusTransitionNotAllowedError(
  from: string,
  to: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_STATUS_TRANSITION_NOT_ALLOWED,
    message: `Asset status cannot change from ${from} to ${to}.`,
    statusCode: 409,
  });
}

export function assetBuildingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.BUILDING_NOT_AVAILABLE,
    message: 'Inactive buildings cannot register new assets.',
    statusCode: 400,
  });
}
