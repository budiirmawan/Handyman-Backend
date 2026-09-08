import { AppError, ERROR_CODES } from '../../shared/errors';

export function cleaningScheduleBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_SCHEDULE_BINDING_NOT_FOUND,
    message: 'Cleaning schedule binding not found.',
    statusCode: 404,
  });
}

export function cleaningScheduleBindingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_SCHEDULE_BINDING_ALREADY_EXISTS,
    message:
      'An active schedule binding already exists for this cleaning area and schedule.',
    statusCode: 409,
  });
}

export function cleaningScheduleBindingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_SCHEDULE_BINDING_INACTIVE,
    message:
      'Inactive cleaning schedule binding cannot be used for operational activity.',
    statusCode: 400,
  });
}

export function cleaningScheduleNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_SCHEDULE_NOT_FOUND,
    message: 'Schedule definition not found.',
    statusCode: 404,
  });
}

export function cleaningScheduleInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_SCHEDULE_INACTIVE,
    message: 'Inactive schedule cannot be bound to a cleaning area.',
    statusCode: 400,
  });
}

export function cleaningScheduleClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_SCHEDULE_CLIENT_MISMATCH,
    message: 'The schedule definition belongs to a different client.',
    statusCode: 400,
  });
}

export function cleaningScheduleBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_SCHEDULE_BUILDING_MISMATCH,
    message: 'The schedule definition belongs to a different building.',
    statusCode: 400,
  });
}
