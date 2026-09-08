import { AppError, ERROR_CODES } from '../../shared/errors';

export function vendorComplianceDocumentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_COMPLIANCE_DOCUMENT_NOT_FOUND,
    message: 'Vendor compliance document not found.',
    statusCode: 404,
  });
}

/**
 * The Vendor already holds an ACTIVE document with this type and number.
 * Conflicting active documents are rejected rather than silently stacked;
 * the caller updates or deactivates the existing row instead.
 */
export function vendorComplianceDocumentAlreadyActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_COMPLIANCE_DOCUMENT_ALREADY_ACTIVE,
    message:
      'An active compliance document with this type and number already exists for this vendor.',
    statusCode: 409,
  });
}

/**
 * Status and dates disagree: ACTIVE with an already-past expiry date, or
 * EXPIRED with no past expiry date. The status must reflect the dates.
 */
export function vendorComplianceDocumentStatusDateMismatchError(
  message: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_COMPLIANCE_DOCUMENT_STATUS_DATE_MISMATCH,
    message,
    statusCode: 400,
  });
}
