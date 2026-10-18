import { AppError, ERROR_CODES } from '../../shared/errors';

export function userNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.USER_NOT_FOUND,
    message: 'User not found.',
    statusCode: 404,
  });
}

export function userEmailAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.USER_EMAIL_ALREADY_EXISTS,
    message: 'A user with this email already exists.',
    statusCode: 409,
  });
}

export function userWhatsAppPhoneAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.USER_WHATSAPP_PHONE_ALREADY_EXISTS,
    message: 'A user with this WhatsApp number already exists.',
    statusCode: 409,
  });
}

export function invalidAccountStateError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVALID_ACCOUNT_STATE,
    message: 'This account state transition is not allowed.',
    statusCode: 400,
  });
}

/**
 * CR-HM-IAM-BOOTSTRAP-01 — a credential reset on an account holding
 * PLATFORM_ADMIN is a potential account takeover. Only an actor that also
 * holds the Owner role may perform it; everyone else (including a
 * SYSTEM_ADMIN with `user.manage`) is denied. The denial is explicit so the
 * attempt is observable rather than silently ignored.
 */
export function privilegedAccountResetDeniedError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRIVILEGED_ACCOUNT_RESET_DENIED,
    message:
      'Only an owner may reset the password of an account holding PLATFORM_ADMIN.',
    statusCode: 403,
  });
}
