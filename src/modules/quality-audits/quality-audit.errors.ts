import { AppError, ERROR_CODES } from '../../shared/errors';

export function qualityAuditNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.QUALITY_AUDIT_NOT_FOUND,
    message: 'Quality audit not found.',
    statusCode: 404,
  });
}

export function qualityAuditImmutableError(): AppError {
  return new AppError({
    code: ERROR_CODES.QUALITY_AUDIT_IMMUTABLE,
    message: 'Completed quality audit cannot be modified.',
    statusCode: 400,
  });
}

export function qualityAuditSourceNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.QUALITY_AUDIT_SOURCE_NOT_FOUND,
    message: 'Audited Housekeeping source does not exist.',
    statusCode: 404,
  });
}

export function qualityAuditInvalidScoreError(): AppError {
  return new AppError({
    code: ERROR_CODES.QUALITY_AUDIT_INVALID_SCORE,
    message: 'Score must be a number between 0 and 100.',
    statusCode: 400,
  });
}

export function qualityAuditInvalidResultError(): AppError {
  return new AppError({
    code: ERROR_CODES.QUALITY_AUDIT_INVALID_RESULT,
    message: 'Result must be one of: PASS, FAIL, REWORK_REQUIRED.',
    statusCode: 400,
  });
}

export function qualityAuditClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.QUALITY_AUDIT_CLIENT_MISMATCH,
    message: 'Audited source belongs to a different client.',
    statusCode: 400,
  });
}

/**
 * CR-BE-RN15-CLEANING-QUALITY-MOBILE-01 — application-level guard matching the
 * `quality_audits_source_draft_unique` partial index (migration 0353).
 *
 * COMPLETED audits stay unlimited; only a SECOND open DRAFT for the same
 * `(sourceType, sourceId)` is refused, because a target-scoped read must be
 * able to name exactly one current draft.
 */
export function qualityAuditDraftAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.QUALITY_AUDIT_DRAFT_ALREADY_EXISTS,
    message:
      'A draft quality audit already exists for this source. Complete it before starting another.',
    statusCode: 409,
  });
}

export function qualityAuditBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.QUALITY_AUDIT_BUILDING_MISMATCH,
    message: 'Audited source belongs to a different building.',
    statusCode: 400,
  });
}
