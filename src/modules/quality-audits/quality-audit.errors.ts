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

export function qualityAuditBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.QUALITY_AUDIT_BUILDING_MISMATCH,
    message: 'Audited source belongs to a different building.',
    statusCode: 400,
  });
}
