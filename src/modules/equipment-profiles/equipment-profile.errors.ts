import { AppError, ERROR_CODES } from '../../shared/errors';

export function equipmentProfileNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.EQUIPMENT_PROFILE_NOT_FOUND,
    message: 'Equipment profile not found.',
    statusCode: 404,
  });
}

/** An Asset may carry at most one Equipment Profile. */
export function equipmentProfileAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.EQUIPMENT_PROFILE_ALREADY_EXISTS,
    message: 'This asset already has an equipment profile.',
    statusCode: 409,
  });
}

export function equipmentProfileCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.EQUIPMENT_PROFILE_CODE_ALREADY_EXISTS,
    message:
      'An equipment profile with this code already exists for this client.',
    statusCode: 409,
  });
}
