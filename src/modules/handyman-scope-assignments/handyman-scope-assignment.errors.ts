import { AppError, ERROR_CODES } from '../../shared/errors';

/** Scope exists but is not in the assignable AUTHORIZED state. */
export function handymanAssignmentScopeNotAuthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_NOT_AUTHORIZED,
    message:
      'Execution scope must exist with status AUTHORIZED before crew assignment.',
    statusCode: 409,
  });
}

/** Provider context or crew is missing or not ACTIVE for assignment. */
export function handymanAssignmentContextInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CONTEXT_INACTIVE,
    message:
      'Provider context and crew must both exist and be ACTIVE for assignment.',
    statusCode: 400,
  });
}

/** Scope/provider/crew relationship chain crosses realms/clients. */
export function handymanAssignmentContextMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CONTEXT_MISMATCH,
    message:
      'Assignment requires scope, provider context, and crew within the ' +
      'same Client with a valid crew/provider relationship.',
    statusCode: 400,
  });
}

/** Current Lead fails the F4/§5 validity chain. */
export function handymanAssignmentLeadInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_LEAD_INVALID,
    message:
      'Assignment requires a current Lead that is an ACTIVE crew member ' +
      'with an ACTIVE worker context and a non-null workforce userId.',
    statusCode: 400,
  });
}

/** Scope already has an ACTIVE assignment; silent replacement forbidden. */
export function handymanAssignmentAlreadyActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CONFLICT,
    message:
      'An ACTIVE assignment already exists for this execution scope; ' +
      'use reassignment instead.',
    statusCode: 409,
  });
}

/** No ACTIVE assignment row exists for the execution scope. */
export function handymanAssignmentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_NOT_FOUND,
    message: 'No ACTIVE crew assignment exists for this execution scope.',
    statusCode: 404,
  });
}

/** P0-B: expectedVersion mismatch — caller must reload and retry. */
export function handymanAssignmentVersionConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_VERSION_CONFLICT,
    message:
      'Assignment version has changed; reload and retry with the current version.',
    statusCode: 409,
  });
}

/** P0-B: active (non-CHECKED_OUT) work session blocks reassignment. */
export function handymanAssignmentActiveSessionBlockError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_ACTIVE_SESSION_BLOCK,
    message:
      'Cannot reassign: an active work session exists on this execution scope. ' +
      'The PIC must check out before reassignment.',
    statusCode: 409,
  });
}

/** P0-B: duplicate idempotency key with conflicting parameters. */
export function handymanAssignmentIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_IDEMPOTENCY_CONFLICT,
    message:
      'An assignment history entry already exists for this idempotency key ' +
      'with different parameters.',
    statusCode: 409,
  });
}
