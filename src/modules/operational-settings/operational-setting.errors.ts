import { AppError, ERROR_CODES } from '../../shared/errors';

export function operationalSettingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.OPERATIONAL_SETTING_NOT_FOUND,
    message: 'Operational Setting not found.',
    statusCode: 404,
  });
}

export function operationalSettingKeyNotAllowedError(key?: string): AppError {
  return new AppError({
    code: ERROR_CODES.OPERATIONAL_SETTING_KEY_NOT_ALLOWED,
    message: key
      ? `Operational Setting key ${key} is not allowed.`
      : 'Operational Setting key is not allowed.',
    statusCode: 400,
  });
}

export function operationalSettingScopeNotAllowedError(): AppError {
  return new AppError({
    code: ERROR_CODES.OPERATIONAL_SETTING_SCOPE_NOT_ALLOWED,
    message: 'Operational Setting is not available for the selected scope.',
    statusCode: 400,
  });
}
