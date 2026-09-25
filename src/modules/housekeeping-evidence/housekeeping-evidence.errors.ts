import { AppError, ERROR_CODES } from '../../shared/errors';

export function housekeepingEvidenceSourceNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_EVIDENCE_SOURCE_NOT_FOUND,
    message: 'Housekeeping operational evidence source not found.',
    statusCode: 404,
  });
}

export function housekeepingEvidenceSourceTerminalError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_EVIDENCE_SOURCE_TERMINAL,
    message: 'Terminal operational source cannot receive new evidence.',
    statusCode: 400,
  });
}

export function housekeepingEvidenceTypeMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_EVIDENCE_TYPE_MISMATCH,
    message: 'Evidence type does not match requirement.',
    statusCode: 400,
  });
}

export function housekeepingEvidenceCountViolationError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_EVIDENCE_COUNT_VIOLATION,
    message: 'Maximum evidence count exceeded for this requirement.',
    statusCode: 400,
  });
}

export function housekeepingEvidenceClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_EVIDENCE_CLIENT_MISMATCH,
    message: 'Evidence requirement belongs to a different client.',
    statusCode: 400,
  });
}

export function housekeepingEvidenceBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_EVIDENCE_BUILDING_MISMATCH,
    message: 'Evidence source belongs to a different building.',
    statusCode: 400,
  });
}

/**
 * CR-BE-RN13-CLEANING-FIELD-01 PART 02 — the caller is not the assigned field
 * actor for the cleaning execution the evidence belongs to.
 *
 * Authority is delegated verbatim to `isBoundTaskExecutableByUser` (the same
 * MOB-C04 / MOB-C07 rule `mobile-checklist`, `mobile-form-instances` and the
 * BE-18 utility reading-due field gate use), so it is derived from
 * `task_assignments` data and never from a role name.
 */
export function housekeepingEvidenceFieldUnauthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_EVIDENCE_FIELD_UNAUTHORIZED,
    message:
      'The caller is not the assigned field actor for this cleaning execution, ' +
      'so evidence cannot be submitted against it.',
    statusCode: 403,
  });
}
