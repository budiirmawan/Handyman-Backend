import { AppError, ERROR_CODES } from '../../shared/errors';

export function inspectionBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.INSPECTION_BINDING_NOT_FOUND,
    message: 'Inspection binding not found.',
    statusCode: 404,
  });
}

export function inspectionBindingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.INSPECTION_BINDING_ALREADY_EXISTS,
    message: 'An active inspection binding already exists for this asset and template.',
    statusCode: 409,
  });
}

export function inspectionBindingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.INSPECTION_BINDING_INACTIVE,
    message: 'Inactive inspection bindings cannot start executions.',
    statusCode: 400,
  });
}

/**
 * The Checklist Template belongs to a different Client than the Asset.
 * Reported as 400 so the caller learns the combination is invalid without
 * being told anything about the other Client's templates.
 */
export function inspectionTemplateClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INSPECTION_TEMPLATE_CLIENT_MISMATCH,
    message: 'The checklist template does not belong to the asset client.',
    statusCode: 400,
  });
}

/**
 * The Functional Location resolves to a different Building than the Asset.
 * The BE-04 structure is the only authority for where a location sits.
 */
export function inspectionLocationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.INSPECTION_LOCATION_BUILDING_MISMATCH,
    message: 'The functional location does not belong to the asset building.',
    statusCode: 400,
  });
}

export function inspectionExecutionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.INSPECTION_EXECUTION_NOT_FOUND,
    message: 'Checklist execution is not linked to an equipment inspection.',
    statusCode: 404,
  });
}
