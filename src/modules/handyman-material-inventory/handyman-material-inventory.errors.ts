import { AppError, ERROR_CODES } from '../../shared/errors';

/** CR-HM-BE-07 RUN 2 — errors for the thin Handyman-to-inventory bridge. */
export function handymanMaterialInventoryIdempotencyKeyRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_IDEMPOTENCY_KEY_REQUIRED,
    message: 'Idempotency key is required for Handyman material inventory commands.',
    statusCode: 400,
  });
}

export function handymanMaterialInventoryIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_IDEMPOTENCY_CONFLICT,
    message: 'The idempotency key was already used with different Handyman material inventory facts.',
    statusCode: 409,
  });
}

export function handymanMaterialInventoryDemandNotExecutableError(
  message = 'The Handyman material demand is not an active executable demand for this inventory command.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_DEMAND_NOT_EXECUTABLE,
    message,
    statusCode: 409,
  });
}

export function handymanMaterialInventoryDemandExceededError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_DEMAND_EXCEEDED,
    message: 'The quantity exceeds the remaining approved Handyman material demand.',
    statusCode: 409,
  });
}

export function handymanMaterialInventoryReservationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_RESERVATION_NOT_FOUND,
    message: 'Handyman material reservation not found.',
    statusCode: 404,
  });
}

export function handymanMaterialInventoryReservationMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_RESERVATION_MISMATCH,
    message: 'The reservation does not match the Handyman demand and inventory issue context.',
    statusCode: 409,
  });
}

export function handymanMaterialInventoryReservationNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_RESERVATION_NOT_ACTIVE,
    message: 'Only an active Handyman material reservation can be released, cancelled, or issued.',
    statusCode: 409,
  });
}

export function handymanMaterialInventoryReservationAllocationExceededError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_RESERVATION_ALLOCATION_EXCEEDED,
    message: 'The issue quantity exceeds the remaining Handyman reservation allocation.',
    statusCode: 409,
  });
}

export function handymanMaterialInventoryIssueNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_ISSUE_NOT_FOUND,
    message: 'Handyman controlled material issue not found.',
    statusCode: 404,
  });
}

export function handymanMaterialInventoryIssueContextInvalidError(
  message = 'The controlled issue does not match the Handyman material context.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_ISSUE_CONTEXT_INVALID,
    message,
    statusCode: 409,
  });
}

export function handymanMaterialInventoryIssueExceededError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_ISSUE_EXCEEDED,
    message: 'The issue quantity exceeds the allowed Handyman material demand capacity.',
    statusCode: 409,
  });
}

export function handymanMaterialInventoryActualUseExceededError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_ACTUAL_USE_EXCEEDED,
    message: 'Cumulative actual use and returned quantity cannot exceed the originating authorized quantity.',
    statusCode: 409,
  });
}

export function handymanMaterialInventoryReturnExceededError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_RETURN_EXCEEDED,
    message: 'Cumulative actual use and returned quantity cannot exceed the originating controlled issue.',
    statusCode: 409,
  });
}

export function handymanMaterialInventoryWorkOrderStateInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_WORK_ORDER_STATE_INVALID,
    message: 'Material issue is not allowed for a completed, cancelled, or closed Work Order.',
    statusCode: 409,
  });
}

export function handymanMaterialInventoryExecutionContextInvalidError(
  message = 'The supplied Handyman execution context does not belong to this job.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_EXECUTION_CONTEXT_INVALID,
    message,
    statusCode: 409,
  });
}

export function handymanMaterialInventoryUomIncompatibleError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_INVENTORY_UOM_INCOMPATIBLE,
    message: 'The supplied UOM is incompatible with the approved Handyman material demand.',
    statusCode: 400,
  });
}
