import { AppError, ERROR_CODES } from '../../shared/errors';

export function completionReportNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.COMPLETION_REPORT_NOT_FOUND,
    message: 'Vendor completion report not found.',
    statusCode: 404,
  });
}

/** The same Vendor Work already has a completion report. */
export function completionReportAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.COMPLETION_REPORT_ALREADY_EXISTS,
    message: 'A completion report already exists for this vendor work.',
    statusCode: 409,
  });
}

/** A SUBMITTED report is final and cannot be updated or resubmitted. */
export function completionReportAlreadySubmittedError(): AppError {
  return new AppError({
    code: ERROR_CODES.COMPLETION_REPORT_ALREADY_SUBMITTED,
    message: 'This completion report is already submitted.',
    statusCode: 409,
  });
}

/** Required BE-07 evidence is not yet satisfied for this Vendor Work. */
export function completionReportEvidenceIncompleteError(
  missingEvidenceTypes: string[],
): AppError {
  return new AppError({
    code: ERROR_CODES.COMPLETION_REPORT_EVIDENCE_INCOMPLETE,
    message: 'Required evidence is incomplete.',
    statusCode: 400,
    details: missingEvidenceTypes.map((evidenceType) => ({
      field: 'evidence',
      message: `Missing required evidence: ${evidenceType}.`,
    })),
  });
}

/**
 * The Work Order's Building does not match the Vendor Work's Building, or a
 * Vendor / Building filter combination is invalid.
 */
export function completionReportBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.COMPLETION_REPORT_BUILDING_MISMATCH,
    message: 'The work order building does not match the vendor work building.',
    statusCode: 400,
  });
}
