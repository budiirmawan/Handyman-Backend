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
