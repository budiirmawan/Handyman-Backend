import { AppError, ERROR_CODES } from '../../shared/errors';

export function configurationPreviewNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONFIGURATION_PREVIEW_NOT_FOUND,
    message: 'Configuration Preview Context not found.',
    statusCode: 404,
  });
}

export function configurationPreviewExpiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONFIGURATION_PREVIEW_EXPIRED,
    message: 'Configuration Preview Context has expired.',
    statusCode: 410,
  });
}

export function configurationPreviewRevokedError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONFIGURATION_PREVIEW_REVOKED,
    message: 'Configuration Preview Context has been revoked.',
    statusCode: 410,
  });
}

export function configurationPreviewVersionNotValidatedError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONFIGURATION_PREVIEW_VERSION_NOT_VALIDATED,
    message: 'Only a VALIDATED or PUBLISHED non-active version can be previewed.',
    statusCode: 409,
  });
}
