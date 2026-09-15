import { AppError, ERROR_CODES } from '../../shared/errors';

export function esgMetricValueNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_VALUE_NOT_FOUND,
    message: 'ESG metric value not found.',
    statusCode: 404,
  });
}

export function esgMetricValuePeriodExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_VALUE_PERIOD_EXISTS,
    message: 'An ESG metric value for this building/metric/period already exists; no silent overwrite.',
    statusCode: 409,
  });
}

export function esgMetricValueBuildingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_VALUE_BUILDING_NOT_FOUND,
    message: 'The referenced Building was not found.',
    statusCode: 404,
  });
}

export function esgMetricValueBuildingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_VALUE_BUILDING_INACTIVE,
    message: 'The referenced Building is not ACTIVE.',
    statusCode: 400,
  });
}

export function esgMetricValueDefinitionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_VALUE_DEFINITION_NOT_FOUND,
    message: 'The referenced ESG metric definition was not found.',
    statusCode: 404,
  });
}

export function esgMetricValueDefinitionClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_VALUE_DEFINITION_CLIENT_MISMATCH,
    message: 'The referenced ESG metric definition belongs to a different Client.',
    statusCode: 400,
  });
}

export function esgMetricValueDefinitionInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_VALUE_DEFINITION_INACTIVE,
    message: 'The referenced ESG metric definition is not ACTIVE; new values are blocked.',
    statusCode: 400,
  });
}

export function esgMetricValueUomNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_VALUE_UOM_NOT_FOUND,
    message: 'The referenced UOM was not found.',
    statusCode: 404,
  });
}

export function esgMetricValueUomInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_VALUE_UOM_INACTIVE,
    message: 'The referenced UOM is not ACTIVE.',
    statusCode: 400,
  });
}

export function esgMetricValueUomClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_VALUE_UOM_CLIENT_MISMATCH,
    message: 'The referenced UOM belongs to a different Client.',
    statusCode: 400,
  });
}

export function esgMetricValuePeriodInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_VALUE_PERIOD_INVALID,
    message: 'period_end must be after period_start.',
    statusCode: 400,
  });
}

export function esgMetricValueMissingValueInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_METRIC_VALUE_MISSING_VALUE_INVALID,
    message: 'value must be absent or null when data_quality is MISSING, and present otherwise.',
    statusCode: 400,
  });
}
