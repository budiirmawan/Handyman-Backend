import { AppError, ERROR_CODES } from '../../shared/errors';

export function vendorLicenseNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_LICENSE_CERTIFICATION_NOT_FOUND,
    message: 'Vendor license / certification not found.',
    statusCode: 404,
  });
}

/**
 * The Vendor already holds an ACTIVE record with this type and number.
 * Conflicting active records are rejected rather than silently stacked;
 * the caller updates or deactivates the existing row instead.
 */
export function vendorLicenseAlreadyActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_LICENSE_CERTIFICATION_ALREADY_ACTIVE,
    message:
      'An active license / certification with this type and number already exists for this vendor.',
    statusCode: 409,
  });
}

/**
 * Status and dates disagree: ACTIVE with an already-past expiry date, or
 * EXPIRED with no past expiry date. The status must reflect the dates.
 */
export function vendorLicenseStatusDateMismatchError(message: string): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_LICENSE_CERTIFICATION_STATUS_DATE_MISMATCH,
    message,
    statusCode: 400,
  });
}

/**
 * The referenced BE-06G compliance document belongs to a different Vendor.
 * A record may only reference its own Vendor's documents.
 */
export function vendorLicenseDocumentMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_LICENSE_CERTIFICATION_DOCUMENT_MISMATCH,
    message:
      'The compliance document must belong to the same vendor as the license / certification.',
    statusCode: 400,
  });
}
