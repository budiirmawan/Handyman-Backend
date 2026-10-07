import { AppError, ERROR_CODES } from '../../shared/errors';

export function assetTypeNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_TYPE_NOT_FOUND,
    message: 'Asset type not found.',
    statusCode: 404,
  });
}

export function assetTypeCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_TYPE_CODE_ALREADY_EXISTS,
    message: 'An asset type with this code already exists for this category.',
    statusCode: 409,
  });
}

export function assetTypeInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_TYPE_INACTIVE,
    message: 'Inactive asset types cannot be assigned to assets.',
    statusCode: 400,
  });
}

/** The assigned Type does not belong to the assigned Category. */
export function assetTypeCategoryMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_TYPE_CATEGORY_MISMATCH,
    message: 'The asset type does not belong to the selected asset category.',
    statusCode: 400,
  });
}

export function assetCategoryInactiveForTypeError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_CATEGORY_INACTIVE,
    message: 'Inactive asset categories cannot receive new asset types.',
    statusCode: 400,
  });
}
