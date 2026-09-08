import { AppError, ERROR_CODES } from '../../shared/errors';

export function inventoryWarehouseNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WAREHOUSE_NOT_FOUND,
    message: 'Warehouse/store not found.',
    statusCode: 404,
  });
}

export function inventoryWarehouseCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WAREHOUSE_CODE_ALREADY_EXISTS,
    message: 'A warehouse/store with this code already exists for this building.',
    statusCode: 409,
  });
}

export function inventoryWarehouseInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WAREHOUSE_INACTIVE,
    message: 'Inactive warehouse/store cannot be used.',
    statusCode: 400,
  });
}

export function inventoryWarehouseLocationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WAREHOUSE_LOCATION_BUILDING_MISMATCH,
    message: 'Warehouse and functional location must belong to the same building.',
    statusCode: 400,
  });
}

export function inventoryWarehouseLocationInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WAREHOUSE_LOCATION_INACTIVE,
    message: 'Inactive functional locations cannot be assigned to active warehouse/store.',
    statusCode: 400,
  });
}

export function inventoryWarehouseClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WAREHOUSE_CLIENT_MISMATCH,
    message: 'Warehouse/store and client context mismatch.',
    statusCode: 400,
  });
}
