import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-02 PART 02 — Handyman Common Material Profile errors.
 *
 * 409 conflict codes mark safe-to-retry duplicate/inactive-reference cases;
 * 400 scope mismatch covers cross-service/cross-Client relationship
 * violations (server-derived authority; the caller can never force a
 * relationship the masters do not support).
 */

export function handymanCommonMaterialProfileNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_COMMON_MATERIAL_PROFILE_NOT_FOUND,
    message: 'Handyman common material profile not found.',
    statusCode: 404,
  });
}

export function handymanCommonMaterialProfileAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_COMMON_MATERIAL_PROFILE_ALREADY_EXISTS,
    message:
      'This material already has a common material profile for the same service or variant.',
    statusCode: 409,
  });
}

export function handymanCommonMaterialProfileScopeMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_COMMON_MATERIAL_PROFILE_SCOPE_MISMATCH,
    message:
      'The variant must belong to the selected service and every reference must share the same client scope.',
    statusCode: 400,
  });
}

export function handymanCommonMaterialProfileReferenceInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_COMMON_MATERIAL_PROFILE_REFERENCE_INACTIVE,
    message:
      'An authoritative catalogue or material reference is not ACTIVE.',
    statusCode: 409,
  });
}
