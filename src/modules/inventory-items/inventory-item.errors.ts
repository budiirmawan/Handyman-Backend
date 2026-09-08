import { AppError, ERROR_CODES } from '../../shared/errors';

export function inventoryItemNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ITEM_NOT_FOUND,
    message: 'Inventory item not found.',
    statusCode: 404,
  });
}

export function inventoryItemCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ITEM_CODE_ALREADY_EXISTS,
    message: 'An inventory item with this code already exists for this client.',
    statusCode: 409,
  });
}

export function inventoryItemInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ITEM_INACTIVE,
    message: 'Inactive inventory items cannot be used for stock operations.',
    statusCode: 400,
  });
}

export function inventoryItemClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ITEM_CLIENT_MISMATCH,
    message: 'Inventory item and client context mismatch.',
    statusCode: 400,
  });
}

export function inventoryItemUomNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ITEM_UOM_NOT_FOUND,
    message: 'UOM not found.',
    statusCode: 404,
  });
}

export function inventoryItemUomInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ITEM_UOM_INACTIVE,
    message: 'Inactive UOM cannot be assigned to inventory item.',
    statusCode: 400,
  });
}

export function inventoryItemUomClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ITEM_UOM_CLIENT_MISMATCH,
    message: 'Inventory item and UOM must belong to the same client.',
    statusCode: 400,
  });
}

export function inventoryItemTypeInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_ITEM_TYPE_INVALID,
    message: 'Invalid inventory item type.',
    statusCode: 400,
  });
}
