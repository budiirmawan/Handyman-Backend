import { AppError, ERROR_CODES } from '../../shared/errors';

/** The Visitor / Security binding row could not be located. */
export function securityVisitorBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_VISITOR_BINDING_NOT_FOUND,
    message: 'Security visitor binding not found.',
    statusCode: 404,
  });
}

/** An ACTIVE binding already exists for the same (building, external visit reference). */
export function securityVisitorBindingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_VISITOR_BINDING_ALREADY_EXISTS,
    message:
      'An active security visitor binding already exists for this building and external visit reference.',
    statusCode: 409,
  });
}

/** The binding's building does not match the supplied building context. */
export function securityVisitorBindingBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_VISITOR_BINDING_BUILDING_MISMATCH,
    message: 'The visitor binding does not belong to the requested building.',
    statusCode: 400,
  });
}

/** The optional Security Post is in a different Building. */
export function securityVisitorBindingSecurityPostBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_VISITOR_BINDING_SECURITY_POST_BUILDING_MISMATCH,
    message:
      'The security post does not belong to the same building as the visitor binding.',
    statusCode: 400,
  });
}

/** The Security Post exists but is INACTIVE. */
export function securityVisitorBindingSecurityPostInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_VISITOR_BINDING_SECURITY_POST_INACTIVE,
    message: 'Inactive security posts cannot anchor a visitor binding.',
    statusCode: 400,
  });
}

/** The optional Security Workforce has no active Building assignment. */
export function securityVisitorBindingWorkforceBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_VISITOR_BINDING_WORKFORCE_BUILDING_MISMATCH,
    message:
      'The security workforce has no active building assignment for this building.',
    statusCode: 400,
  });
}

/** The Security Workforce exists but is INACTIVE. */
export function securityVisitorBindingWorkforceInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_VISITOR_BINDING_WORKFORCE_INACTIVE,
    message: 'Inactive security workforces cannot anchor a visitor binding.',
    statusCode: 400,
  });
}
