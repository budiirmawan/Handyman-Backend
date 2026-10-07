import { AppError, ERROR_CODES } from '../../shared/errors';

export function assetSparePartNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ASSET_SPARE_PART_NOT_FOUND,
    message: 'Asset spare part binding not found.',
    statusCode: 404,
  });
}

export function assetSparePartAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ASSET_SPARE_PART_ALREADY_EXISTS,
    message: 'Spare part already bound to this asset.',
    statusCode: 409,
  });
}

export function assetSparePartItemNotSparePartError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ASSET_SPARE_PART_ITEM_NOT_SPARE_PART,
    message: 'Only items of type SPARE_PART may be bound as asset spare parts.',
    statusCode: 400,
  });
}

export function assetSparePartClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ASSET_SPARE_PART_CLIENT_MISMATCH,
    message: 'Asset and spare part item must belong to same client.',
    statusCode: 400,
  });
}
