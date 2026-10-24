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

export function handymanAssignmentResponseForbiddenError(
  message = 'User is not the authorized active assignee (Crew Lead or Inspector) for this assignment.',
): AppError {
  return new AppError({
    statusCode: 403,
    code: 'HANDYMAN_ASSIGNMENT_RESPONSE_FORBIDDEN',
    message,
  });
}

export function handymanAssignmentResponseSupersededError(
  message = 'Cannot respond to or execute a superseded or revoked assignment.',
): AppError {
  return new AppError({
    statusCode: 409,
    code: 'HANDYMAN_ASSIGNMENT_RESPONSE_SUPERSEDED',
    message,
  });
}

export function handymanAssignmentResponseConflictError(
  message = 'Assignment response has already been finalized and cannot be changed to a conflicting decision.',
): AppError {
  return new AppError({
    statusCode: 409,
    code: 'HANDYMAN_ASSIGNMENT_RESPONSE_CONFLICT',
    message,
  });
}

export function handymanAssignmentDeclinedError(
  message = 'Cannot execute work or visit under an assignment that has been declined (TIDAK_BISA).',
): AppError {
  return new AppError({
    statusCode: 409,
    code: 'HANDYMAN_ASSIGNMENT_DECLINED',
    message,
  });
}

export function handymanAssignmentResponseLateError(
  message = 'Assignment response is no longer allowed because execution or inspection has already started or completed.',
): AppError {
  return new AppError({
    statusCode: 409,
    code: 'HANDYMAN_ASSIGNMENT_RESPONSE_LATE',
    message,
  });
}

/**
 * CR-HM-FIELD-OPS-ACK-01 PART 01 — the authoritative appointment window for
 * this assignment has elapsed. A worker must never acknowledge or decline a
 * visit/execution slot that is already over; Operations must reschedule or
 * reassign instead. Replaying an already-finalized identical decision is
 * checked BEFORE this guard and therefore still succeeds.
 */
export function handymanAssignmentResponseExpiredError(
  message = 'Assignment response is no longer allowed because the assigned visit window has expired.',
): AppError {
  return new AppError({
    statusCode: 409,
    code: 'HANDYMAN_ASSIGNMENT_RESPONSE_EXPIRED',
    message,
  });
}

/**
 * CR-HM-FIELD-OPS-ACK-01 PART 01 — one actor + one caller key may finalize
 * ONE assignment only. A device replay carrying the same key against a new
 * (reassigned) assignment must fail closed instead of accepting on behalf of
 * the new assignee.
 */
export function handymanAssignmentResponseIdempotencyConflictError(
  message = 'This assignment-response key was already used for a different assignment.',
): AppError {
  return new AppError({
    statusCode: 409,
    code: 'HANDYMAN_ASSIGNMENT_RESPONSE_IDEMPOTENCY_CONFLICT',
    message,
  });
}

export function assignmentDeclineReasonRequiredError(
  message = 'declineReason is required (1-1000 characters) when responseStatus is TIDAK_BISA.',
): AppError {
  return AppError.validation(message, [
    {
      field: 'declineReason',
      message: 'declineReason is required (1-1000 characters) when responseStatus is TIDAK_BISA.',
    },
  ]);
}

export function assignmentDeclineReasonForbiddenOnAcceptError(
  message = 'declineReason must not be provided when responseStatus is TERIMA.',
): AppError {
  return AppError.validation(message, [
    {
      field: 'declineReason',
      message: 'declineReason must not be provided when responseStatus is TERIMA.',
    },
  ]);
}
