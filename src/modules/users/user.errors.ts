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

/**
 * CR-HM-IAM-BOOTSTRAP-01 HARDENING — a protected (PLATFORM_ADMIN) account may
 * only be transitioned, or have its credential/notification channel changed,
 * by an actor that also holds PLATFORM_ADMIN. A `user.manage` grant alone must
 * never let a normal administrator disable, hijack or lock out an owner.
 */
export function privilegedAccountProtectedError(): AppError {
  return new AppError({
    code: ERROR_CODES.PRIVILEGED_ACCOUNT_PROTECTED,
    message:
      'Only an owner may modify an account holding PLATFORM_ADMIN.',
    statusCode: 403,
  });
}

/**
 * CR-HM-IAM-BOOTSTRAP-01 HARDENING — the last ACTIVE PLATFORM_ADMIN account
 * cannot be deactivated or suspended (that would leave the installation with
 * no authority at all). Assign a second owner first.
 */
export function lastOwnerAccountProtectedError(): AppError {
  return new AppError({
    code: ERROR_CODES.LAST_OWNER_ACCOUNT_PROTECTED,
    message:
      'The last active owner account cannot be deactivated or suspended. Assign PLATFORM_ADMIN to another account first.',
    statusCode: 409,
  });
}

/**
 * CR-HM-IAM-BOOTSTRAP-01 HARDENING — an administrator cannot apply a
 * lifecycle transition to their own account. Self-suspension would otherwise
 * revoke the very session used to perform it and leave no recovery path.
 */
export function selfAccountActionDeniedError(): AppError {
  return new AppError({
    code: ERROR_CODES.SELF_ACCOUNT_ACTION_DENIED,
    message:
      'An administrator cannot deactivate or suspend their own account.',
    statusCode: 403,
  });
}
