import { AppError, ERROR_CODES } from '../../shared/errors';

/** BE-18F — Reading Evidence error contract. */

/** The referenced Reading Evidence submission does not exist. */
export function utilityMeterReadingEvidenceNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_READING_EVIDENCE_NOT_FOUND,
    message: 'Meter reading evidence not found.',
    statusCode: 404,
  });
}

/**
 * The referenced BE-07 requirement does not belong to this reading, is not
 * ACTIVE, or does not match the submitted evidence type / MIME type.
 */
export function utilityMeterReadingEvidenceRequirementMismatchError(
  message = 'The evidence requirement does not match the submitted evidence.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_READING_EVIDENCE_REQUIREMENT_MISMATCH,
    message,
    statusCode: 400,
  });
}

/** The submission would exceed the requirement's maximum count. */
export function utilityMeterReadingEvidenceCountViolationError(
  message = 'Evidence count does not satisfy the requirement.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_READING_EVIDENCE_COUNT_VIOLATION,
    message,
    statusCode: 400,
  });
}

/**
 * The evidence context does not match the reading's Building / Client — e.g.
 * a requirement raised against another Client, or a Meter / Building filter
 * combination that contradicts the reading's own Building.
 */
export function utilityMeterReadingEvidenceBuildingMismatchError(
  message = 'The evidence building context does not match the meter reading.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_READING_EVIDENCE_BUILDING_MISMATCH,
    message,
    statusCode: 400,
  });
}
