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
