import { AppError } from '../../shared/errors';

export function assignmentResponseSupersededError(
  message = 'Cannot respond to an inactive or superseded assignment.',
): AppError {
  return new AppError({
    statusCode: 409,
    code: 'WORK_ORDER_ASSIGNMENT_SUPERSEDED',
    message,
  });
}

export function assignmentResponseConflictError(
  message = 'Assignment response has already been finalized and cannot be changed to a conflicting decision.',
): AppError {
  return new AppError({
    statusCode: 409,
    code: 'WORK_ORDER_ASSIGNMENT_RESPONSE_CONFLICT',
    message,
  });
}

export function assignmentAlreadyDeclinedError(
  message = 'Cannot execute work under an assignment that has been declined (TIDAK_BISA).',
): AppError {
  return new AppError({
    statusCode: 409,
    code: 'WORK_ORDER_ASSIGNMENT_DECLINED',
    message,
  });
}

export function assignmentResponseLateError(
  message = 'Assignment response is no longer allowed in the current lifecycle status.',
): AppError {
  return new AppError({
    statusCode: 409,
    code: 'WORK_ORDER_ASSIGNMENT_RESPONSE_LATE',
    message,
  });
}
