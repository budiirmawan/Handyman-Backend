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
