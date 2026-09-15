import { AppError, ERROR_CODES } from '../../shared/errors';

export function logSheetBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.LOG_SHEET_BINDING_NOT_FOUND,
    message: 'Log sheet binding not found.',
    statusCode: 404,
  });
}

export function logSheetBindingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.LOG_SHEET_BINDING_ALREADY_EXISTS,
    message: 'An active log sheet binding already exists for this asset and template.',
    statusCode: 409,
  });
}

export function logSheetBindingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.LOG_SHEET_BINDING_INACTIVE,
    message: 'Inactive log sheet bindings cannot start executions.',
    statusCode: 400,
  });
}

/**
 * The Form Template belongs to a different Client than the Asset. Reported
 * as 400 so the caller learns the combination is invalid without being told
 * anything about the other Client's templates.
 */
export function logSheetTemplateClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.LOG_SHEET_TEMPLATE_CLIENT_MISMATCH,
    message: 'The log sheet template does not belong to the asset client.',
    statusCode: 400,
  });
}

/**
 * The selected Template Version belongs to a different template than the one
 * named in the binding.
 */
export function logSheetVersionTemplateMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.LOG_SHEET_VERSION_TEMPLATE_MISMATCH,
    message: 'The template version does not belong to the bound template.',
    statusCode: 400,
  });
}

export function logSheetUomInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.LOG_SHEET_UOM_INACTIVE,
    message: 'A measurement field uses an inactive unit of measure.',
    statusCode: 400,
  });
}

export function logSheetUomClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.LOG_SHEET_UOM_CLIENT_MISMATCH,
    message: 'A measurement field uses a unit of measure from another client.',
    statusCode: 400,
  });
}

export function logSheetLocationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.LOG_SHEET_LOCATION_BUILDING_MISMATCH,
    message: 'The functional location does not belong to the asset building.',
    statusCode: 400,
  });
}

export function logSheetExecutionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.LOG_SHEET_EXECUTION_NOT_FOUND,
    message: 'Form instance is not linked to an equipment log sheet.',
    statusCode: 404,
  });
}
