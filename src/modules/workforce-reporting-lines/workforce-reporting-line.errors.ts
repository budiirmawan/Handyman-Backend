import { AppError, ERROR_CODES } from '../../shared/errors';

/** No reporting line exists for the addressed Workforce Profile. */
export function workforceReportingLineNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_REPORTING_LINE_NOT_FOUND,
    message: 'Workforce reporting line not found.',
    statusCode: 404,
  });
}

/**
 * The Workforce Profile already has an ACTIVE reporting line. Changing who a
 * Workforce Profile reports to goes through PATCH, so the existing line is
 * superseded explicitly instead of two live supervisors coexisting.
 */
export function workforceReportingLineAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_REPORTING_LINE_ALREADY_EXISTS,
    message:
      'This workforce profile already has an active reporting line. Update or deactivate it first.',
    statusCode: 409,
  });
}

/** A Workforce Profile cannot supervise itself. */
export function workforceReportingLineSelfSupervisionError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_REPORTING_LINE_SELF_SUPERVISION,
    message: 'A workforce profile cannot be its own supervisor.',
    statusCode: 400,
  });
}

/**
 * Cross-Client reporting attempt: the Workforce Profile and the Supervisor
 * resolve to different Clients. Reported as 400 rather than 404 so the caller
 * learns the combination is invalid without observing another Client's data.
 */
export function workforceReportingLineClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_REPORTING_LINE_CLIENT_MISMATCH,
    message:
      'The workforce profile and the supervisor must belong to the same client.',
    statusCode: 400,
  });
}

/**
 * The simple circular case: the proposed Supervisor already reports to this
 * Workforce Profile, so A → B plus B → A would both be active. Only this
 * direct two-node cycle is checked — BE-03F deliberately does not build a
 * generic organization graph engine.
 */
export function workforceReportingLineCircularError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_REPORTING_LINE_CIRCULAR,
    message:
      'Circular reporting line: the selected supervisor already reports to this workforce profile.',
    statusCode: 400,
  });
}

/** The supervisor Workforce Profile id does not resolve to a profile. */
export function workforceSupervisorNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_SUPERVISOR_NOT_FOUND,
    message: 'Supervisor workforce profile not found.',
    statusCode: 404,
  });
}

/** An INACTIVE Workforce Profile cannot be given as a supervisor. */
export function workforceSupervisorInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_SUPERVISOR_INACTIVE,
    message: 'Supervisor workforce profile is inactive.',
    statusCode: 400,
  });
}
