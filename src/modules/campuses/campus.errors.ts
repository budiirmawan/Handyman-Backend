import { AppError, ERROR_CODES } from '../../shared/errors';

export function campusNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.CAMPUS_NOT_FOUND,
    message: 'Campus not found.',
    statusCode: 404,
  });
}

export function campusCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.CAMPUS_CODE_ALREADY_EXISTS,
    message: 'A campus with this code already exists for this property.',
    statusCode: 409,
  });
}

export function campusInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.CAMPUS_INACTIVE,
    message: 'Inactive campuses cannot receive new building associations.',
    statusCode: 400,
  });
}

export function campusPropertyMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.CAMPUS_PROPERTY_MISMATCH,
    message: 'Building and campus must belong to the same property.',
    statusCode: 400,
  });
}

export function campusPropertyInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PROPERTY_INACTIVE,
    message: 'Inactive properties cannot host new campuses.',
    statusCode: 400,
  });
}
