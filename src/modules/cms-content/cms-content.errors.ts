import { AppError, ERROR_CODES } from '../../shared/errors';

export function cmsContentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.CMS_CONTENT_NOT_FOUND,
    message: 'CMS Content not found.',
    statusCode: 404,
  });
}

export function cmsContentAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.CMS_CONTENT_ALREADY_EXISTS,
    message: 'CMS Content type and slug already exist for the selected scope.',
    statusCode: 409,
  });
}
