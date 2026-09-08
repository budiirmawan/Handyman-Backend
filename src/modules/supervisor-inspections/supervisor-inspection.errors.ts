import { AppError, ERROR_CODES } from '../../shared/errors';

export function supervisorInspectionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SUPERVISOR_INSPECTION_NOT_FOUND,
    message: 'Supervisor inspection not found.',
    statusCode: 404,
  });
}

export function supervisorInspectionAlreadyOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.SUPERVISOR_INSPECTION_ALREADY_OPEN,
    message:
      'An open supervisor inspection is already pending for this target.',
    statusCode: 409,
  });
}

export function supervisorInspectionImmutableError(): AppError {
  return new AppError({
    code: ERROR_CODES.SUPERVISOR_INSPECTION_IMMUTABLE,
    message: 'Completed supervisor inspection decision cannot be overwritten.',
    statusCode: 400,
  });
}

export function supervisorInspectionTargetNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SUPERVISOR_INSPECTION_TARGET_NOT_FOUND,
    message: 'Inspected target does not exist.',
    statusCode: 404,
  });
}

export function supervisorInspectionTargetNotReviewableError(): AppError {
  return new AppError({
    code: ERROR_CODES.SUPERVISOR_INSPECTION_TARGET_NOT_REVIEWABLE,
    message: 'Target is not in a reviewable operational state.',
    statusCode: 400,
  });
}

export function supervisorInspectionClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SUPERVISOR_INSPECTION_CLIENT_MISMATCH,
    message: 'Target belongs to a different client.',
    statusCode: 400,
  });
}

export function supervisorInspectionBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SUPERVISOR_INSPECTION_BUILDING_MISMATCH,
    message: 'Target belongs to a different building.',
    statusCode: 400,
  });
}
