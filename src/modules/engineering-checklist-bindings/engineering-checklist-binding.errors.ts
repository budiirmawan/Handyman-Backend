import { AppError, ERROR_CODES } from '../../shared/errors';

export function engineeringChecklistBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_CHECKLIST_BINDING_NOT_FOUND,
    message: 'Engineering checklist binding not found.',
    statusCode: 404,
  });
}

export function engineeringChecklistBindingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_CHECKLIST_BINDING_ALREADY_EXISTS,
    message:
      'An active engineering checklist binding already exists for this template and target.',
    statusCode: 409,
  });
}

export function engineeringChecklistBindingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_CHECKLIST_BINDING_INACTIVE,
    message: 'Inactive engineering checklist bindings cannot start executions.',
    statusCode: 400,
  });
}

/**
 * The Checklist Template belongs to a different Client than the Building.
 * Reported as 400 so the caller learns the combination is invalid without
 * being told anything about the other Client's templates.
 */
export function engineeringChecklistTemplateClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_CHECKLIST_TEMPLATE_CLIENT_MISMATCH,
    message: 'The checklist template does not belong to the building client.',
    statusCode: 400,
  });
}

/**
 * The Asset resolves to a different Building than the binding context.
 * BE-05 is the only authority for where an Asset sits.
 */
export function engineeringChecklistAssetBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_CHECKLIST_ASSET_BUILDING_MISMATCH,
    message: 'The asset does not belong to the building context.',
    statusCode: 400,
  });
}

export function engineeringChecklistLocationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_CHECKLIST_LOCATION_BUILDING_MISMATCH,
    message: 'The functional location does not belong to the building context.',
    statusCode: 400,
  });
}

export function engineeringChecklistUomInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_CHECKLIST_UOM_INACTIVE,
    message: 'A measurement item uses an inactive unit of measure.',
    statusCode: 400,
  });
}

export function engineeringChecklistUomClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_CHECKLIST_UOM_CLIENT_MISMATCH,
    message: 'A measurement item uses a unit of measure from another client.',
    statusCode: 400,
  });
}

export function engineeringChecklistExecutionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_CHECKLIST_EXECUTION_NOT_FOUND,
    message: 'Checklist execution is not linked to an engineering checklist binding.',
    statusCode: 404,
  });
}
