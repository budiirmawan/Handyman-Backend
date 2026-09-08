import { AppError, ERROR_CODES } from '../../shared/errors';

export function woMaterialUsageNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WO_MATERIAL_USAGE_NOT_FOUND,
    message: 'Work order material usage not found.',
    statusCode: 404,
  });
}

export function woMaterialUsageInvalidQuantityError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WO_MATERIAL_USAGE_INVALID_QUANTITY,
    message: 'Material usage quantity must be positive.',
    statusCode: 400,
  });
}

export function woMaterialUsageInsufficientStockError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WO_MATERIAL_USAGE_INSUFFICIENT_STOCK,
    message: 'Insufficient available stock for material usage.',
    statusCode: 409,
  });
}

export function woMaterialUsageClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WO_MATERIAL_USAGE_CLIENT_MISMATCH,
    message: 'Work order, warehouse and item must belong to same client.',
    statusCode: 400,
  });
}

export function woMaterialUsageBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WO_MATERIAL_USAGE_BUILDING_MISMATCH,
    message: 'Warehouse building must match work order building.',
    statusCode: 400,
  });
}

export function woMaterialUsageInvalidUnitCostError(): AppError {
  return new AppError({
    code: ERROR_CODES.WO_MATERIAL_USAGE_INVALID_UNIT_COST,
    message: 'Operational unit cost must be a non-negative number.',
    statusCode: 400,
  });
}

export function woMaterialUsageWorkOrderStateInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.WO_MATERIAL_USAGE_WORK_ORDER_STATE_INVALID,
    message:
      'Material cannot be issued to a work order in a COMPLETED, CANCELLED, or CLOSED state.',
    statusCode: 409,
  });
}

export function woMaterialUsageUomIncompatibleError(): AppError {
  return new AppError({
    code: ERROR_CODES.WO_MATERIAL_USAGE_UOM_INCOMPATIBLE,
    message:
      'The supplied UOM is incompatible with the item UOM and no conversion authority exists.',
    statusCode: 400,
  });
}

export function woMaterialUsageDuplicateReferenceError(): AppError {
  return new AppError({
    code: ERROR_CODES.WO_MATERIAL_USAGE_DUPLICATE_REFERENCE,
    message:
      'A material usage with this reference already exists for the work order (duplicate issue protection).',
    statusCode: 409,
  });
}

export function woMaterialUsageMaterialRequestRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WO_MATERIAL_USAGE_MATERIAL_REQUEST_REQUIRED,
    message: 'The Work Order must have an existing Material Request demand binding.',
    statusCode: 409,
  });
}

export function woMaterialUsageMaterialRequestInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WO_MATERIAL_USAGE_MATERIAL_REQUEST_INVALID,
    message: 'The Material Request is not valid for this Work Order issue.',
    statusCode: 400,
  });
}

export function woMaterialUsageMaterialRequestNotApprovedError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WO_MATERIAL_USAGE_MATERIAL_REQUEST_NOT_APPROVED,
    message: 'Only approved Material Request demand can be issued.',
    statusCode: 409,
  });
}

export function woMaterialUsageDemandExceededError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WO_MATERIAL_USAGE_DEMAND_EXCEEDED,
    message: 'Issue quantity exceeds the remaining authorized Material Request demand.',
    statusCode: 409,
  });
}

export function woMaterialUsageReservationMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVENTORY_WO_MATERIAL_USAGE_RESERVATION_MISMATCH,
    message: 'The reservation is not valid for this Material Request issue.',
    statusCode: 400,
  });
}

export function woMaterialUsageCurrencyRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.WO_MATERIAL_USAGE_CURRENCY_REQUIRED,
    message:
      'A governed currency is required whenever a costed Work Order material usage supplies a unit cost.',
    statusCode: 400,
  });
}
