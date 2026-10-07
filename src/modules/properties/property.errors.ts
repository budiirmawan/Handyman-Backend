import { AppError, ERROR_CODES } from '../../shared/errors';

export function propertyNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PROPERTY_NOT_FOUND,
    message: 'Property not found.',
    statusCode: 404,
  });
}

export function propertyCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.PROPERTY_CODE_ALREADY_EXISTS,
    message: 'A property with this code already exists for this client.',
    statusCode: 409,
  });
}

export function propertyInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PROPERTY_INACTIVE,
    message: 'Inactive properties cannot host new buildings.',
    statusCode: 400,
  });
}
