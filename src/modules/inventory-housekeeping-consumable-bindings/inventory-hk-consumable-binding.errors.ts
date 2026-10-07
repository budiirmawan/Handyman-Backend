import { AppError, ERROR_CODES } from '../../shared/errors';

export function hkBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_HK_CONSUMABLE_BINDING_NOT_FOUND,
    message: 'Housekeeping consumable binding not found.',
    statusCode: 404,
  });
}

export function hkBindingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_HK_CONSUMABLE_BINDING_ALREADY_EXISTS,
    message: 'Consumable binding already exists for this requirement, warehouse and item.',
    statusCode: 409,
  });
}

export function hkBindingItemNotConsumableError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_HK_CONSUMABLE_BINDING_ITEM_NOT_CONSUMABLE,
    message: 'Only items of type CONSUMABLE may be bound as housekeeping consumables.',
    statusCode: 400,
  });
}

export function hkBindingClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_HK_CONSUMABLE_BINDING_CLIENT_MISMATCH,
    message: 'Requirement, warehouse and item must belong to same client.',
    statusCode: 400,
  });
}

export function hkBindingBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_HK_CONSUMABLE_BINDING_BUILDING_MISMATCH,
    message: 'Requirement and warehouse must belong to same building.',
    statusCode: 400,
  });
}
