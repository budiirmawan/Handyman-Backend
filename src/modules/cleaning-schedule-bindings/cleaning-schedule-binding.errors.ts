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

/**
 * CR-BE-RN13-CLEANING-FIELD-01 PART 00 — one ACTIVE cleaning schedule binding
 * per schedule definition.
 *
 * BE-07 generates exactly one task per `(schedule_definition_id,
 * occurrence_at)`. A schedule definition that is ACTIVE against more than one
 * Cleaning Area would make that single generated cleaning task resolve to
 * several areas, so the canonical `cleaningAreaId` of a cleaning execution
 * would be undefined. The application-level twin of the partial unique index
 * `cleaning_schedule_bindings_schedule_active_unique` (migration 0352).
 */
export function cleaningScheduleBindingScheduleConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_SCHEDULE_BINDING_SCHEDULE_CONFLICT,
    message:
      'An active cleaning schedule binding already exists for this schedule definition. ' +
      'A schedule definition may be actively bound to only one cleaning area, ' +
      'so a generated cleaning task resolves to exactly one cleaning area.',
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
