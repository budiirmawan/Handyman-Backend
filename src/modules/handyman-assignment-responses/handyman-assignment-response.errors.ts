import { AppError, ERROR_CODES } from '../../shared/errors';

export function handymanAssignmentResponseNotFoundError(
  message = 'Assignment response target not found.',
): AppError {
  return new AppError({
    statusCode: 404,
    code: ERROR_CODES.HANDYMAN_ASSIGNMENT_RESPONSE_NOT_FOUND,
    message,
  });
}

export function handymanAssignmentResponseForbiddenError(
  message = 'User is not the authorized assigned worker or Crew Lead for this assignment.',
): AppError {
  return new AppError({
    statusCode: 403,
    code: ERROR_CODES.HANDYMAN_ASSIGNMENT_RESPONSE_FORBIDDEN,
    message,
  });
}

export function handymanAssignmentResponseDuplicateError(
  message = 'A response has already been recorded for this assignment.',
): AppError {
  return new AppError({
    statusCode: 409,
    code: ERROR_CODES.HANDYMAN_ASSIGNMENT_RESPONSE_DUPLICATE,
    message,
  });
}

export function handymanAssignmentResponseExpiredError(
  deadlineIso: string,
): AppError {
  return new AppError({
    statusCode: 409,
    code: ERROR_CODES.HANDYMAN_ASSIGNMENT_RESPONSE_EXPIRED,
    message: `Assignment response deadline expired at ${deadlineIso}; Operations action is required.`,
  });
}

export function handymanAssignmentSupersededError(
  message = 'This assignment has been superseded or replaced and can no longer accept a response.',
): AppError {
  return new AppError({
    statusCode: 409,
    code: ERROR_CODES.HANDYMAN_ASSIGNMENT_SUPERSEDED,
    message,
  });
}

export function handymanAssignmentDeclineReasonRequiredError(
  message = 'A non-empty decline reason (1..1000 characters) is required for TIDAK_BISA.',
): AppError {
  return new AppError({
    statusCode: 400,
    code: ERROR_CODES.HANDYMAN_ASSIGNMENT_DECLINE_REASON_REQUIRED,
    message,
    details: [{ field: 'reason', message }],
  });
}

export function handymanAssignmentResponseDeadlineInvalidError(
  message: string,
): AppError {
  return new AppError({
    statusCode: 400,
    code: ERROR_CODES.HANDYMAN_ASSIGNMENT_RESPONSE_DEADLINE_INVALID,
    message,
  });
}
