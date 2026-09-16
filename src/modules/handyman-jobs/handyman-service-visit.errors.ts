import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-BE-05 RUN 2 — Handyman service visit + schedule errors.
 *
 * Rules owned by other authorities keep THEIR errors: job/work-order gates
 * reuse the Run-1 HANDYMAN_JOB_* codes, provider/vendor/relationship/capability
 * failures reuse CR-HM-BE-02/BE-06/BE-15A errors, crew/worker failures reuse
 * CR-HM-BE-04/BE-06F/BE-03C errors, permit readiness failures are reported
 * through the BE-15D aggregate (never as an error), and access failures reuse
 * the BE-02G context-access error. These factories cover only the visit/
 * schedule-window rules this module owns.
 */

export function handymanServiceVisitNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_VISIT_NOT_FOUND,
    message: 'Handyman service visit not found.',
    statusCode: 404,
  });
}

export function handymanServiceVisitScheduleNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_VISIT_SCHEDULE_NOT_FOUND,
    message: 'Handyman service visit schedule not found.',
    statusCode: 404,
  });
}

export function handymanServiceVisitWindowInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_VISIT_WINDOW_INVALID,
    message:
      'The planned window is invalid: plannedEndAt must be after plannedStartAt.',
    statusCode: 400,
  });
}

export function handymanServiceVisitNotSchedulableError(
  message = 'The handyman service visit has no active schedule window.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_VISIT_NOT_SCHEDULABLE,
    message,
    statusCode: 409,
  });
}

export function handymanServiceVisitSequenceConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_VISIT_SEQUENCE_CONFLICT,
    message:
      'A concurrent visit creation claimed this sequence; retry the command.',
    statusCode: 409,
  });
}

export function handymanServiceVisitScheduleStateInvalidError(
  message = 'The handyman service visit schedule state changed during this operation.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_VISIT_SCHEDULE_STATE_INVALID,
    message,
    statusCode: 409,
  });
}

/**
 * Temporal CREW conflict (CR-HM-BE-04 P3 #3, discharged here): the assigned
 * crew already has an ACTIVE window overlapping the proposed half-open
 * window on ANOTHER job. Message carries IDs only — never worker or customer
 * PII.
 */
export function handymanServiceVisitCrewConflictError(input: {
  conflictingHandymanServiceVisitId: string;
  conflictingScheduleId: string;
  handymanWorkCrewId: string;
}): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_VISIT_CREW_CONFLICT,
    message: `The assigned crew ${input.handymanWorkCrewId} already has an active schedule window (${input.conflictingScheduleId}) overlapping this window on visit ${input.conflictingHandymanServiceVisitId}.`,
    statusCode: 409,
  });
}

/**
 * Temporal WORKER conflict: an individual ACTIVE crew member (identified by
 * the vendor workforce BINDING id — an ID, not a person) is double-booked
 * through another crew assigned to another job with an overlapping ACTIVE
 * window. Membership itself is never rejected — only the temporal overlap.
 */
export function handymanServiceVisitWorkerConflictError(input: {
  conflictingHandymanServiceVisitId: string;
  conflictingScheduleId: string;
  vendorWorkforceBindingId: string;
}): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_VISIT_WORKER_CONFLICT,
    message: `Crew member binding ${input.vendorWorkforceBindingId} is scheduled in an overlapping active window (${input.conflictingScheduleId}) on visit ${input.conflictingHandymanServiceVisitId} through another crew.`,
    statusCode: 409,
  });
}
