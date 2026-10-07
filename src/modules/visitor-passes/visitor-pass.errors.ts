import { AppError, ERROR_CODES } from '../../shared/errors';

export function visitorPassNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PASS_NOT_FOUND,
    message: 'Visitor pass not found.',
    statusCode: 404,
  });
}

export function visitorPassVisitNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PASS_VISIT_NOT_FOUND,
    message: 'Visitor visit not found.',
    statusCode: 404,
  });
}

export function visitorPassBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PASS_BUILDING_MISMATCH,
    message: 'The visitor visit does not belong to the requested building.',
    statusCode: 400,
  });
}

export function visitorPassCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PASS_CODE_ALREADY_EXISTS,
    message: 'A visitor pass with this code already exists.',
    statusCode: 409,
  });
}

export function visitorPassVisitNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PASS_VISIT_NOT_ACTIVE,
    message: 'A visitor pass can only be issued for a CHECKED_IN visit.',
    statusCode: 409,
  });
}

export function visitorPassActiveAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PASS_ACTIVE_ALREADY_EXISTS,
    message: 'An active visitor pass already exists for this visit.',
    statusCode: 409,
  });
}

export function visitorPassNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PASS_NOT_ACTIVE,
    message: 'Only an ACTIVE visitor pass can be returned or cancelled.',
    statusCode: 409,
  });
}

export function visitorPassIssueTimeInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PASS_ISSUE_TIME_INVALID,
    message: 'issuedAt must not be in the future or before check-in.',
    statusCode: 400,
  });
}

export function visitorPassReturnTimeInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PASS_RETURN_TIME_INVALID,
    message: 'returnedAt must not be in the future or before issue.',
    statusCode: 400,
  });
}

export function visitorPassActiveAtVisitClosureError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PASS_ACTIVE_AT_VISIT_CLOSURE,
    message:
      'The active visitor pass must be returned or cancelled before the visit can be closed.',
    statusCode: 409,
  });
}
