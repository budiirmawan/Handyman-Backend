import { AppError, ERROR_CODES } from '../../shared/errors';

/** Terminal Work Orders (and non-active states) cannot receive evidence. */
export function workOrderEvidenceInvalidStateError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_EVIDENCE_INVALID_STATE,
    message: 'This work order cannot receive evidence in its current state.',
    statusCode: 400,
  });
}

/** No active assignment exists to authorize evidence submission. */
export function workOrderEvidenceNoAssignmentError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_EVIDENCE_NO_ASSIGNMENT,
    message: 'This work order has no active assignment.',
    statusCode: 400,
  });
}

/** The acting user is not authorized for the active assignment. */
export function workOrderEvidenceUnauthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_EVIDENCE_UNAUTHORIZED,
    message: 'The acting user is not authorized to submit evidence.',
    statusCode: 403,
  });
}

/** The referenced requirement does not match the submitted evidence. */
export function workOrderEvidenceRequirementMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_EVIDENCE_REQUIREMENT_MISMATCH,
    message: 'The evidence requirement does not match the submitted evidence.',
    statusCode: 400,
  });
}

/** The evidence submission violates the requirement's min/max count. */
export function workOrderEvidenceCountViolationError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_EVIDENCE_COUNT_VIOLATION,
    message: 'Evidence count does not satisfy the requirement.',
    statusCode: 400,
  });
}

/** The referenced Work Order evidence submission does not exist. */
export function workOrderEvidenceNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_EVIDENCE_NOT_FOUND,
    message: 'Work order evidence not found.',
    statusCode: 404,
  });
}
