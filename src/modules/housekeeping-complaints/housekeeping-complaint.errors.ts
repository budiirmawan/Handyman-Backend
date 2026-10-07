import { AppError, ERROR_CODES } from '../../shared/errors';

export function housekeepingComplaintBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_COMPLAINT_BINDING_NOT_FOUND,
    message: 'Housekeeping complaint binding not found.',
    statusCode: 404,
  });
}

export function housekeepingComplaintBindingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_COMPLAINT_BINDING_ALREADY_EXISTS,
    message:
      'An active complaint binding already exists for this complaint and operational target.',
    statusCode: 409,
  });
}

export function housekeepingComplaintBindingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_COMPLAINT_BINDING_INACTIVE,
    message: 'Inactive complaint binding cannot be used.',
    statusCode: 400,
  });
}

export function housekeepingComplaintSourceNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_COMPLAINT_SOURCE_NOT_FOUND,
    message: 'Referenced Housekeeping operational source not found.',
    statusCode: 404,
  });
}

export function housekeepingComplaintClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_COMPLAINT_CLIENT_MISMATCH,
    message: 'Complaint or operational source belongs to a different client.',
    statusCode: 400,
  });
}

export function housekeepingComplaintBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_COMPLAINT_BUILDING_MISMATCH,
    message: 'Complaint or operational source belongs to a different building.',
    statusCode: 400,
  });
}
