import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-10 PART 02 — persistence-boundary errors ONLY. No command,
 * lifecycle, QC-outcome, or commercial errors exist at this
 * boundary (no commands exist in this PART).
 */
export function handymanEvidenceRecordNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EVIDENCE_RECORD_NOT_FOUND,
    message: 'Handyman evidence record not found.',
    statusCode: 404,
  });
}

export function handymanQcRunNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QC_RUN_NOT_FOUND,
    message: 'Handyman QC run not found.',
    statusCode: 404,
  });
}

export function handymanDefectNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DEFECT_NOT_FOUND,
    message: 'Handyman defect record not found.',
    statusCode: 404,
  });
}

/* ---- CR-HM-10 PART 03 — evidence COMMAND errors --------------- */

/** Bounded request-surface validation (no authority from caller). */
export function handymanEvidenceValidationError(field: string): AppError {
  return new AppError({
    code: ERROR_CODES.VALIDATION_ERROR,
    message: `Invalid Handyman evidence request (${field}).`,
    statusCode: 400,
    details: [`field=${field}`],
  });
}

/** Actor is not the CURRENT authoritative Crew Lead of the scope. */
export function handymanEvidenceNotAuthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EVIDENCE_NOT_AUTHORIZED,
    message:
      'Only the CURRENT authoritative Crew Lead may write or read '
      + 'Handyman evidence for this scope.',
    statusCode: 403,
  });
}

/**
 * FINALIZE locks the file set (D6): once a FINALIZE event exists,
 * every further FILE_ADD/FINALIZE attempt is a bounded 409. Nothing
 * is ever deleted or rewritten afterwards.
 */
export function handymanEvidenceAlreadyFinalizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EVIDENCE_ALREADY_FINALIZED,
    message:
      'Handyman evidence record is already FINALIZED: the file set '
      + 'is locked.',
    statusCode: 409,
  });
}

/** Same idempotency key replayed with a different command shape. */
export function handymanEvidenceIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EVIDENCE_IDEMPOTENCY_CONFLICT,
    message:
      'Idempotency key was already used with a different request.',
    statusCode: 409,
  });
}

/** Storage key collides with an evidence file on another record. */
export function handymanEvidenceStorageKeyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EVIDENCE_STORAGE_KEY_CONFLICT,
    message:
      'Storage key is already bound to an evidence file.',
    statusCode: 409,
  });
}

/* ---- CR-HM-10 PART 04 — QC command errors --------------------- */

/** Actor lacks current Supervisor QC authority for this scope. */
export function handymanQcNotAuthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QC_NOT_AUTHORIZED,
    message:
      'QC decisions require an explicitly permitted current Supervisor '
      + 'of this scope; read access is separately Building-scoped.',
    statusCode: 403,
  });
}

/** ONE OPEN run per scope (D3): a second OPEN is a bounded 409. */
export function handymanQcRunAlreadyOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QC_RUN_ALREADY_OPEN,
    message:
      'This execution scope already has an OPEN QC run.',
    statusCode: 409,
  });
}

/** Command is not legal for the run's CURRENT status. */
export function handymanQcRunIllegalTransitionError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QC_RUN_ILLEGAL_TRANSITION,
    message:
      'Illegal Handyman QC run transition: the run is no longer '
      + 'OPEN (terminal runs accept no ITEM_SET/FINISH).',
    statusCode: 409,
  });
}

/** Same idempotency key replayed with a different command shape. */
export function handymanQcIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QC_IDEMPOTENCY_CONFLICT,
    message:
      'Idempotency key was already used with a different request.',
    statusCode: 409,
  });
}

/* ---- CR-HM-QC-AUTHORITY-01 — existing QC finish guards -------- */
export function handymanQcChecklistNotConfiguredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QC_CHECKLIST_NOT_CONFIGURED,
    message: 'A required-item checklist must be configured for this scope before opening QC.',
    statusCode: 409,
  });
}

export function handymanQcChecklistConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QC_CHECKLIST_CONFLICT,
    message: 'The checklist requirement for this scope is immutable; a different configuration is forbidden.',
    statusCode: 409,
  });
}

export function handymanQcVersionConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QC_VERSION_CONFLICT,
    message: 'QC run version changed. Reload the run before deciding.',
    statusCode: 409,
  });
}

export function handymanQcStaleRunError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QC_STALE_RUN,
    message: 'QC decision must use the latest run on this execution scope.',
    statusCode: 409,
  });
}

export function handymanQcPassBlockedError(reason: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QC_PASS_BLOCKED,
    message: `QC PASS is blocked: ${reason}.`,
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

export function handymanQcEvidenceInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QC_EVIDENCE_INVALID,
    message: 'QC evidence must be a byte-verified QC_EVIDENCE upload on this exact execution scope.',
    statusCode: 409,
  });
}

/* ---- CR-HM-10 PART 05 — defect/rectification errors ------------ */

/** Actor lacks the role for this defect command (PIC vs Supervisor). */
export function handymanDefectNotAuthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DEFECT_NOT_AUTHORIZED,
    message:
      'Defect inspection requires the permitted current Supervisor; '
      + 'rectification requires the currently assigned Crew Lead.',
    statusCode: 403,
  });
}

/**
 * Command is not legal for the defect's CURRENT status. The frozen
 * ladder is OPENED → RECTIFYING → RECTIFIED → VERIFIED (REINSPECTION
 * may loop RECTIFIED → RECTIFYING); VERIFIED is locked — every
 * mutation past it is a bounded 409.
 */
export function handymanDefectIllegalTransitionError(
  status: string,
  eventType: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DEFECT_ILLEGAL_TRANSITION,
    message:
      `Illegal Handyman defect transition ${eventType} from status `
      + `${status}.`,
    statusCode: 409,
    details: [`status=${status}`, `eventType=${eventType}`],
  });
}

/** Same idempotency key replayed with a different command shape. */
export function handymanDefectIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DEFECT_IDEMPOTENCY_CONFLICT,
    message:
      'Idempotency key was already used with a different request.',
    statusCode: 409,
  });
}
