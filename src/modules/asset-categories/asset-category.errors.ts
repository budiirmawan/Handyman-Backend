import { AppError, ERROR_CODES } from '../../shared/errors';

export function assetCategoryNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_CATEGORY_NOT_FOUND,
    message: 'Asset category not found.',
    statusCode: 404,
  });
}

export function assetCategoryCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_CATEGORY_CODE_ALREADY_EXISTS,
    message: 'An asset category with this code already exists for this client.',
    statusCode: 409,
  });
}

export function assetCategoryInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_CATEGORY_INACTIVE,
    message: 'Inactive asset categories cannot be assigned to assets.',
    statusCode: 400,
  });
}

export function assetCategoryClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_CATEGORY_CLIENT_MISMATCH,
    message: 'Asset and asset category must belong to the same client.',
    statusCode: 400,
  });
}
