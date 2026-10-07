import { AppError, ERROR_CODES } from '../../shared/errors';

export function serviceReportNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_REPORT_NOT_FOUND,
    message: 'Vendor service report not found.',
    statusCode: 404,
  });
}

/** The same Vendor Work already has a service report. */
export function serviceReportAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_REPORT_ALREADY_EXISTS,
    message: 'A service report already exists for this vendor work.',
    statusCode: 409,
  });
}

/** The service report number is already taken within the Client. */
export function serviceReportNumberAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_REPORT_NUMBER_ALREADY_EXISTS,
    message: 'A service report with this number already exists for the client.',
    statusCode: 409,
  });
}

/** A FINALIZED report is final and cannot be updated or re-finalized. */
export function serviceReportAlreadyFinalizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_REPORT_ALREADY_FINALIZED,
    message: 'This service report is already finalized.',
    statusCode: 409,
  });
}

/**
 * The Work Order's Building does not match the Vendor Work's Building, or a
 * Vendor / Building filter combination is invalid.
 */
export function serviceReportBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_REPORT_BUILDING_MISMATCH,
    message: 'The work order building does not match the vendor work building.',
    statusCode: 400,
  });
}

/** The linked Completion Report does not belong to the same Vendor Work. */
export function serviceReportCompletionMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_REPORT_COMPLETION_MISMATCH,
    message: 'The completion report does not belong to this vendor work.',
    statusCode: 400,
  });
}
