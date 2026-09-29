import { AppError, ERROR_CODES } from '../../shared/errors';

export function handymanBastNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_NOT_FOUND,
    message: 'Handyman BAST not found.',
    statusCode: 404,
  });
}

export function handymanBastScopeNotEligibleError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_SCOPE_NOT_ELIGIBLE,
    message:
      'Handyman execution scope is not authorized for BAST issue.',
    statusCode: 409,
  });
}

export function handymanBastIllegalTransitionError(
  from: string,
  action: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_ILLEGAL_TRANSITION,
    message: 'Illegal Handyman BAST transition (frozen state machine).',
    statusCode: 409,
    details: [`from=${from}`, `action=${action}`],
  });
}

export function handymanBastSignOffReservedError(action: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_SIGN_OFF_RESERVED,
    message:
      'Customer ACCEPT/REJECT is reserved for CR-HM-11 PART 02.',
    statusCode: 409,
    details: [`action=${action}`],
  });
}

export function handymanBastActiveConflictError(
  executionScopeId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_ACTIVE_CONFLICT,
    message:
      'An active (non-VOID) Handyman BAST already exists for this execution scope.',
    statusCode: 409,
    details: [`executionScopeId=${executionScopeId}`],
  });
}

export function handymanBastValidationError(field: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_VALIDATION,
    message: 'Invalid Handyman BAST input.',
    statusCode: 400,
    details: [`field=${field}`],
  });
}
