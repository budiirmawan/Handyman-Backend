import { AppError, ERROR_CODES } from '../../shared/errors';

export function workOrderNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_NOT_FOUND,
    message: 'Work order not found.',
    statusCode: 404,
  });
}

export function workOrderNumberAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_NUMBER_ALREADY_EXISTS,
    message: 'A work order with this number already exists for this client.',
    statusCode: 409,
  });
}

/**
 * The Building named in the route does not resolve — through Property →
 * Client — to the Client named in the request. Reported as 400 rather than
 * 404 so the caller learns the combination is invalid without being told
 * anything about the other Client's estate.
 */
export function workOrderBuildingClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_BUILDING_CLIENT_MISMATCH,
    message: 'The building does not belong to the specified client.',
    statusCode: 400,
  });
}

/**
 * The source Work Request already produced a Work Order. The UNIQUE
 * (work_request_id) constraint is the final authority; this prevents
 * unintentional duplicate Work Orders from a single request.
 */
export function workOrderFromRequestAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_FROM_REQUEST_ALREADY_EXISTS,
    message: 'This work request has already been converted into a work order.',
    statusCode: 409,
  });
}

/** Only OPEN Work Orders are mutable in this PART. */
export function workOrderNotOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_NOT_OPEN,
    message: 'Only open work orders can be modified.',
    statusCode: 400,
  });
}

export function workOrderCompletionInvalidStateError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_COMPLETION_INVALID_STATE,
    message: 'This work order cannot be completed in its current state.',
    statusCode: 400,
  });
}

export function workOrderCompletionNoAssignmentError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_COMPLETION_NO_ASSIGNMENT,
    message: 'This work order has no active assignment.',
    statusCode: 400,
  });
}

export function workOrderCompletionUnauthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_COMPLETION_UNAUTHORIZED,
    message: 'The acting user is not authorized to complete this work order.',
    statusCode: 403,
  });
}

export function workOrderCompletionEvidenceIncompleteError(
  missingEvidenceTypes: string[],
): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_COMPLETION_EVIDENCE_INCOMPLETE,
    message: `Required evidence is incomplete: ${missingEvidenceTypes.join(', ')}.`,
    statusCode: 400,
  });
}

export function workOrderCompletionAlreadyCompletedError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_COMPLETION_ALREADY_COMPLETED,
    message: 'This work order is already completed.',
    statusCode: 409,
  });
}

export function workOrderBastRequirementLockedError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_BAST_REQUIREMENT_LOCKED,
    message:
      'BAST requirement can only change before work completion and before the first BAST submission attempt.',
    statusCode: 409,
  });
}

/** The requested status transition is not in the allowed lifecycle table. */
export function workOrderInvalidTransitionError(
  from: string,
  to: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_INVALID_TRANSITION,
    message: `Work order status cannot transition from ${from} to ${to}.`,
    statusCode: 400,
  });
}

/**
 * The Asset named in the binding does not belong to the Work Order's Building
 * (which also rejects every cross-Client binding, since a Building belongs to
 * exactly one Client through Property).
 */
export function workOrderAssetBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_ASSET_BUILDING_MISMATCH,
    message: 'The asset does not belong to the work order building.',
    statusCode: 400,
  });
}

/**
 * The Functional Location named in the binding does not belong to the Work
 * Order's Building.
 */
export function workOrderLocationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_LOCATION_BUILDING_MISMATCH,
    message: 'The functional location does not belong to the work order building.',
    statusCode: 400,
  });
}

/**
 * An INACTIVE Functional Location cannot receive a new Work Order binding,
 * following the BE-04 convention (only NEW bindings are refused; an EXISTING
 * binding survives deactivation untouched).
 */
export function workOrderLocationInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_LOCATION_INACTIVE,
    message:
      'Inactive functional locations cannot receive a new work order binding.',
    statusCode: 400,
  });
}

/**
 * When a Work Order is bound to both an Asset and a Functional Location, the
 * two must be consistent (resolve to the same Building). The authoritative
 * hierarchy is never trusted from the client.
 */
export function workOrderAssetLocationInconsistentError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_ASSET_LOCATION_INCONSISTENT,
    message:
      'The functional location is not consistent with the bound asset.',
    statusCode: 400,
  });
}
