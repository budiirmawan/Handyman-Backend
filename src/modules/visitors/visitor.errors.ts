import { AppError, ERROR_CODES } from '../../shared/errors';

/** The visitor identity row could not be located. */
export function visitorNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_NOT_FOUND,
    message: 'Visitor not found.',
    statusCode: 404,
  });
}

/**
 * A visitor with the same identity document (identity type + identity
 * number) already exists for this Client — reuse the existing visitor
 * identity instead of registering a duplicate.
 */
export function visitorIdentityAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_IDENTITY_ALREADY_EXISTS,
    message:
      'A visitor with this identity document already exists for this client. Reuse the existing visitor identity.',
    statusCode: 409,
  });
}

/** An identity number was supplied without a concrete identity type. */
export function visitorIdentityNumberRequiresTypeError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_IDENTITY_NUMBER_REQUIRES_TYPE,
    message:
      'An identity number requires a concrete identity type (not NONE).',
    statusCode: 400,
  });
}
