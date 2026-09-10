import { AppError, ERROR_CODES } from '../../shared/errors';

/** BE-18C — Main / Sub Meter hierarchy error contract. */

export function utilityMeterHierarchyNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_HIERARCHY_NOT_FOUND,
    message: 'Meter hierarchy relationship not found.',
    statusCode: 404,
  });
}

/**
 * The Sub Meter already has an ACTIVE Main Meter. Moving a Sub Meter is an
 * explicit end-then-bind, so a second binding is a conflict rather than a
 * silent overwrite that would lose the previous relationship.
 */
export function utilityMeterHierarchyAlreadyExistsError(
  message = 'This sub meter is already bound to an active main meter. End that relationship first.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_HIERARCHY_ALREADY_EXISTS,
    message,
    statusCode: 409,
  });
}

/** A Meter cannot be its own Main Meter. */
export function utilityMeterHierarchySelfReferenceError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_HIERARCHY_SELF_REFERENCE,
    message: 'A meter cannot be its own main meter.',
    statusCode: 400,
  });
}

/**
 * The proposed Main Meter already sits below the Sub Meter in the ACTIVE
 * hierarchy, so the binding would close a loop (A → B → C → A). Unlike the
 * two-node-only check used elsewhere in the codebase, BE-18C walks the whole
 * ancestor chain — a meter tree can legitimately be several levels deep.
 */
export function utilityMeterHierarchyCircularError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_HIERARCHY_CIRCULAR,
    message:
      'Circular meter hierarchy: the selected main meter is already fed by this sub meter.',
    statusCode: 400,
  });
}

/** Main and Sub Meter must measure the same utility. */
export function utilityMeterHierarchyUtilityMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_HIERARCHY_UTILITY_MISMATCH,
    message: 'The main meter and the sub meter must have the same utility type.',
    statusCode: 400,
  });
}

/**
 * Cross-Client binding attempt. Reported as 400 rather than 404 so the caller
 * learns the combination is invalid without observing another Client's data.
 */
export function utilityMeterHierarchyClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_HIERARCHY_CLIENT_MISMATCH,
    message: 'The main meter and the sub meter must belong to the same client.',
    statusCode: 400,
  });
}

/** Cross-Building binding attempt within the same Client. */
export function utilityMeterHierarchyBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_HIERARCHY_BUILDING_MISMATCH,
    message: 'The main meter and the sub meter must belong to the same building.',
    statusCode: 400,
  });
}
