import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-02 PART 01 — Handyman Service Variant errors.
 *
 * 409-class errors mark conflicts safe to retry with a corrected request
 * (variant code collision). Client isolation denials reuse the shared
 * `buildingAccessDeniedError` from the context-access module.
 */

export function handymanServiceVariantNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_VARIANT_NOT_FOUND,
    message: 'Handyman service variant not found.',
    statusCode: 404,
  });
}

export function handymanServiceVariantCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_VARIANT_CODE_ALREADY_EXISTS,
    message:
      'A Handyman service variant with this code already exists for this service.',
    statusCode: 409,
  });
}
