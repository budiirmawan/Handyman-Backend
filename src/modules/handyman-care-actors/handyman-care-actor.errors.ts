import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-01 AMENDMENT 01 PART 07 — Customer Care actor persistence errors.
 *
 * These are operational provisioning/lifecycle failures (registry
 * administration), NOT the untrusted-handoff failure surface: the handoff
 * runtime's non-enumerating 401 semantics (PART 03/08) are untouched.
 */

export function handymanCareActorNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CARE_ACTOR_NOT_FOUND,
    message: 'Handyman Customer Care actor not found.',
    statusCode: 404,
  });
}

export function handymanCareActorIntegrationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CARE_ACTOR_INTEGRATION_NOT_FOUND,
    message: 'Handoff integration not found.',
    statusCode: 404,
  });
}

export function handymanCareActorIntegrationInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CARE_ACTOR_INTEGRATION_INVALID,
    message:
      'An ACTIVE handoff integration with the Customer Care actor capability is required.',
    statusCode: 400,
  });
}

export function handymanCareActorReferenceConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CARE_ACTOR_REFERENCE_CONFLICT,
    message:
      'This actor reference is already registered for this handoff integration.',
    statusCode: 409,
  });
}
