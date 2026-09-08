import { AppError, ERROR_CODES } from '../../shared/errors';

export function breakdownNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.BREAKDOWN_NOT_FOUND,
    message: 'Breakdown record not found.',
    statusCode: 404,
  });
}

export function breakdownWorkOrderAlreadyLinkedError(): AppError {
  return new AppError({
    code: ERROR_CODES.BREAKDOWN_WORK_ORDER_ALREADY_LINKED,
    message: 'A corrective work order is already linked to this breakdown.',
    statusCode: 409,
  });
}

export function breakdownWorkOrderBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.BREAKDOWN_WORK_ORDER_BUILDING_MISMATCH,
    message: 'The work order does not belong to the breakdown building.',
    statusCode: 400,
  });
}

export function breakdownLocationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.BREAKDOWN_LOCATION_BUILDING_MISMATCH,
    message: 'The functional location does not belong to the asset building.',
    statusCode: 400,
  });
}

export function breakdownClosedError(): AppError {
  return new AppError({
    code: ERROR_CODES.BREAKDOWN_CLOSED,
    message: 'Closed breakdowns cannot be modified.',
    statusCode: 400,
  });
}

export function breakdownInvalidTransitionError(): AppError {
  return new AppError({
    code: ERROR_CODES.BREAKDOWN_INVALID_TRANSITION,
    message: 'Invalid breakdown status transition.',
    statusCode: 400,
  });
}
