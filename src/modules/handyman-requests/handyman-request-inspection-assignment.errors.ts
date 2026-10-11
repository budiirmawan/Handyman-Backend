import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-INSPECTION-01 PART A — pre-quotation Field assignment errors.
 * The module-canonical request 404 lives in `handyman-request-triage.errors.ts`
 * and is reused directly; no duplicate definition exists here.
 */

/**
 * Assignment is bound to the INSPECTION_REQUIRED path only: the request must
 * carry the persisted `INSPECTION_REQUIRED` triage disposition, and the
 * current lifecycle state must still admit Field work.
 */
export function handymanInspectionAssignmentNotEligibleError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_ASSIGNMENT_NOT_ELIGIBLE,
    message:
      'A Field inspection assignment requires a request whose persisted triage disposition is INSPECTION_REQUIRED.',
    statusCode: 400,
  });
}

/**
 * The target must be an ACTIVE local user holding the dedicated Field
 * report-submission permission and active resource access to the request's
 * exact Building. No provider/crew/Lead/PIC identity is ever a target.
 */
export function handymanInspectionAssignmentTargetInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_ASSIGNMENT_TARGET_INVALID,
    message:
      'The assigned Field user must be an active user holding the Handyman ' +
      'field inspection report permission with access to the request building.',
    statusCode: 400,
  });
}

/** Reassignment demands an explicit reason (auditable supersession). */
export function handymanInspectionReassignmentReasonRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_REASSIGNMENT_REASON_REQUIRED,
    message:
      'Reassigning the Field inspector requires a reason (1-500 characters).',
    statusCode: 400,
  });
}

/**
 * Reassignment is refused once a report version is awaiting review or has
 * been accepted: the report chain is bound to the assignment that produced
 * it and acceptance is terminal.
 */
export function handymanInspectionReassignmentNotAllowedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_REASSIGNMENT_NOT_ALLOWED,
    message:
      'The Field inspector cannot be reassigned while a report version is ' +
      'pending review or after a report version has been accepted.',
    statusCode: 409,
  });
}

/** The request carries no active Field assignment yet. */
export function handymanInspectionAssignmentRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_ASSIGNMENT_REQUIRED,
    message:
      'This Handyman request has no active Field inspection assignment.',
    statusCode: 409,
  });
}

/**
 * Only the ACTIVE assigned Field user may record the in-scope physical
 * inspection (the legacy generic manage path is not an alternative writer).
 */
export function handymanInspectionFieldDeniedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_FIELD_DENIED,
    message:
      'Only the active assigned Field user may record this Handyman inspection.',
    statusCode: 403,
  });
}
