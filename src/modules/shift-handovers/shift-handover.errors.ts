import { AppError, ERROR_CODES } from '../../shared/errors';

export function shiftHandoverNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SHIFT_HANDOVER_NOT_FOUND,
    message: 'Shift handover not found.',
    statusCode: 404,
  });
}

/** A Shift named in the handover belongs to a different Building. */
export function shiftHandoverShiftBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SHIFT_HANDOVER_SHIFT_BUILDING_MISMATCH,
    message: 'The shift does not belong to the handover building.',
    statusCode: 400,
  });
}

export function shiftHandoverSameShiftError(): AppError {
  return new AppError({
    code: ERROR_CODES.SHIFT_HANDOVER_SAME_SHIFT,
    message: 'Outgoing and incoming shifts must be different.',
    statusCode: 400,
  });
}

export function shiftHandoverInvalidTransitionError(): AppError {
  return new AppError({
    code: ERROR_CODES.SHIFT_HANDOVER_INVALID_TRANSITION,
    message: 'Invalid shift handover status transition.',
    statusCode: 400,
  });
}

/** Only DRAFT handovers can be edited; READY/ACKNOWLEDGED are immutable. */
export function shiftHandoverImmutableError(): AppError {
  return new AppError({
    code: ERROR_CODES.SHIFT_HANDOVER_IMMUTABLE,
    message: 'Ready or acknowledged handovers cannot be modified.',
    statusCode: 400,
  });
}
