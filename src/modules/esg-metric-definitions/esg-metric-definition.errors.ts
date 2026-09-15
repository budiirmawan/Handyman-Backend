import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-BE-ESG-01 PART 01 — ESG Metric Definition errors.
 *
 * Structured, stable codes; 409 for conflicts safe to retry with corrected
 * request. Client/Building isolation denials reuse `buildingAccessDeniedError`
 * from context-access, not defined here.
 */

export function esgMetricDefinitionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_DEFINITION_NOT_FOUND,
    message: 'ESG metric definition not found.',
    statusCode: 404,
  });
}

export function esgMetricDefinitionCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_DEFINITION_CODE_ALREADY_EXISTS,
    message:
      'An ESG metric definition with this code already exists for this client.',
    statusCode: 409,
  });
}

export function esgMetricDefinitionClientInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_DEFINITION_CLIENT_INVALID,
    message: 'The referenced Client was not found or is not active.',
    statusCode: 404,
  });
}

export function esgMetricDefinitionCodeImmutableError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_DEFINITION_CODE_IMMUTABLE,
    message:
      'ESG metric definition code is immutable; create a new definition to change identity.',
    statusCode: 400,
  });
}

export function esgMetricDefinitionNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_DEFINITION_NOT_ACTIVE,
    message:
      'ESG metric definition is not ACTIVE; deactivation is terminal in v1.',
    statusCode: 409,
  });
}

export function esgMetricDefinitionUomNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_DEFINITION_UOM_NOT_FOUND,
    message: 'The referenced UOM was not found.',
    statusCode: 404,
  });
}

export function esgMetricDefinitionUomInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_DEFINITION_UOM_INACTIVE,
    message: 'The referenced UOM is not ACTIVE.',
    statusCode: 400,
  });
}

export function esgMetricDefinitionUomClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_DEFINITION_UOM_CLIENT_MISMATCH,
    message: 'The referenced UOM belongs to a different Client.',
    statusCode: 400,
  });
}
