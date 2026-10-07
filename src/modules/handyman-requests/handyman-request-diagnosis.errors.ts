import { AppError, ERROR_CODES } from '../../shared/errors';

/** FROZEN F1: diagnosis may begin only while the request is in DIAGNOSIS. */
export function handymanServiceRequestNotInDiagnosisError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_NOT_IN_DIAGNOSIS,
    message:
      'A diagnosis can only be recorded while the request is in DIAGNOSIS state.',
    statusCode: 400,
  });
}

/** The request already carries its diagnosis decision (race-safe 409). */
export function handymanServiceRequestAlreadyDiagnosedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_ALREADY_DIAGNOSED,
    message: 'This Handyman request already has a diagnosis decision.',
    statusCode: 409,
  });
}

/**
 * A recommended catalogue anchor must be ACTIVE, same-Client, and
 * associated with the selected F9 discipline — free-text
 * `service_catalog.category` is never consulted as authority.
 */
export function handymanDiagnosisRecommendationInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DIAGNOSIS_RECOMMENDATION_INVALID,
    message:
      'Recommended service must be ACTIVE, belong to the request Client, ' +
      'and be associated with the selected Handyman discipline.',
    statusCode: 400,
  });
}
