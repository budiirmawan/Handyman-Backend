import { AppError, ERROR_CODES } from '../../shared/errors';

export function maintenanceBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.MAINTENANCE_BINDING_NOT_FOUND,
    message: 'Maintenance binding not found.',
    statusCode: 404,
  });
}

export function maintenanceBindingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.MAINTENANCE_BINDING_INACTIVE,
    message: 'Inactive maintenance bindings cannot link shared records.',
    statusCode: 400,
  });
}

export function maintenanceScheduleAlreadyLinkedError(): AppError {
  return new AppError({
    code: ERROR_CODES.MAINTENANCE_SCHEDULE_ALREADY_LINKED,
    message: 'A schedule is already linked to this maintenance binding.',
    statusCode: 409,
  });
}

export function maintenanceScheduleBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.MAINTENANCE_SCHEDULE_BUILDING_MISMATCH,
    message: 'The schedule does not belong to the maintenance building context.',
    statusCode: 400,
  });
}

export function maintenanceWorkOrderAlreadyLinkedError(): AppError {
  return new AppError({
    code: ERROR_CODES.MAINTENANCE_WORK_ORDER_ALREADY_LINKED,
    message: 'A work order is already linked to this maintenance binding.',
    statusCode: 409,
  });
}

export function maintenanceWorkOrderBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.MAINTENANCE_WORK_ORDER_BUILDING_MISMATCH,
    message: 'The work order does not belong to the maintenance building context.',
    statusCode: 400,
  });
}

export function maintenanceTaskBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.MAINTENANCE_TASK_BUILDING_MISMATCH,
    message: 'The generated task does not belong to the maintenance building context.',
    statusCode: 400,
  });
}

export function maintenanceTaskAlreadyLinkedError(): AppError {
  return new AppError({
    code: ERROR_CODES.MAINTENANCE_TASK_ALREADY_LINKED,
    message: 'The generated task is already linked to a maintenance binding.',
    statusCode: 409,
  });
}

export function maintenanceLocationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.MAINTENANCE_LOCATION_BUILDING_MISMATCH,
    message: 'The functional location does not belong to the asset building.',
    statusCode: 400,
  });
}
