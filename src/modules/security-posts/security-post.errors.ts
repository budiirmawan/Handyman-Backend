import { AppError, ERROR_CODES } from '../../shared/errors';

export function securityPostNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_POST_NOT_FOUND,
    message: 'Security post not found.',
    statusCode: 404,
  });
}

export function securityPostCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_POST_CODE_ALREADY_EXISTS,
    message: 'A security post with this code already exists for this building.',
    statusCode: 409,
  });
}

export function securityPostInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_POST_INACTIVE,
    message: 'Inactive security post cannot be used for operational activity.',
    statusCode: 400,
  });
}

export function securityPostLocationMismatchError(
  message = 'The referenced location does not belong to this building.',
): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_POST_LOCATION_MISMATCH,
    message,
    statusCode: 400,
  });
}

export function securityPostBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_POST_BUILDING_MISMATCH,
    message: 'The security post belongs to a different building.',
    statusCode: 400,
  });
}

export function securityPostTypeNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_POST_TYPE_NOT_FOUND,
    message: 'Security post type not found.',
    statusCode: 400,
  });
}

export function securityPostBuildingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.BUILDING_NOT_AVAILABLE,
    message: 'Inactive buildings cannot host new security posts.',
    statusCode: 400,
  });
}
