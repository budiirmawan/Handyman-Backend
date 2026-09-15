import { AppError, ERROR_CODES } from '../../shared/errors';

export function organizationPresentationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ORGANIZATION_PRESENTATION_NOT_FOUND,
    message: 'Organization Presentation Configuration not found.',
    statusCode: 404,
  });
}

export function organizationPresentationReferenceInvalidError(
  field = 'items',
  message = 'Referenced organization structure entity is invalid for the selected Client.',
): AppError {
  return new AppError({
    code: ERROR_CODES.ORGANIZATION_PRESENTATION_REFERENCE_INVALID,
    message: 'Organization Presentation reference is invalid.',
    statusCode: 400,
    details: [{ field, message }],
  });
}
