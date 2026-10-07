import { AppError, ERROR_CODES } from '../../shared/errors';

/** A COMPLETED Vendor Work (or terminal state) cannot receive evidence. */
export function vendorWorkEvidenceInvalidStateError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_WORK_EVIDENCE_INVALID_STATE,
    message: 'This vendor work cannot receive evidence in its current state.',
    statusCode: 400,
  });
}

/** The referenced requirement does not match the submitted evidence. */
export function vendorWorkEvidenceRequirementMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_WORK_EVIDENCE_REQUIREMENT_MISMATCH,
    message: 'The evidence requirement does not match the submitted evidence.',
    statusCode: 400,
  });
}

/** The evidence submission violates the requirement's min/max count. */
export function vendorWorkEvidenceCountViolationError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_WORK_EVIDENCE_COUNT_VIOLATION,
    message: 'Evidence count does not satisfy the requirement.',
    statusCode: 400,
  });
}

/**
 * A Vendor / Building filter combination is invalid (the Vendor holds no
 * ACTIVE relationship to that Building), or the evidence's Building context
 * does not match its Vendor Work.
 */
export function vendorWorkEvidenceBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_WORK_EVIDENCE_BUILDING_MISMATCH,
    message: 'The evidence building context does not match the vendor work.',
    statusCode: 400,
  });
}

/** The referenced Vendor Work evidence submission does not exist. */
export function vendorWorkEvidenceNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_WORK_EVIDENCE_NOT_FOUND,
    message: 'Vendor work evidence not found.',
    statusCode: 404,
  });
}
