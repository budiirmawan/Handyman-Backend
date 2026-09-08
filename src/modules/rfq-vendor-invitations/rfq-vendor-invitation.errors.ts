import { AppError, ERROR_CODES } from '../../shared/errors';

export function rfqVendorInvitationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_INVITATION_NOT_FOUND,
    message: 'RFQ Vendor invitation not found.',
    statusCode: 404,
  });
}

export function rfqVendorInvitationRfqInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_INVITATION_RFQ_INVALID,
    message: 'The RFQ is not available for Vendor invitation management.',
    statusCode: 400,
  });
}

export function rfqVendorInvitationVendorInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_INVITATION_VENDOR_INVALID,
    message: 'The Vendor is not eligible for this RFQ invitation.',
    statusCode: 400,
  });
}

export function rfqVendorInvitationContextMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_INVITATION_CONTEXT_MISMATCH,
    message: 'The Vendor and RFQ do not share the same Client and Building scope.',
    statusCode: 400,
  });
}

export function rfqVendorInvitationAlreadyActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_INVITATION_ALREADY_ACTIVE,
    message: 'An active invitation already exists for this Vendor and RFQ.',
    statusCode: 409,
  });
}

export function rfqVendorInvitationNotOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_INVITATION_NOT_OPEN,
    message: 'The RFQ invitation is not open for this operation.',
    statusCode: 400,
  });
}

export function rfqVendorInvitationNotRevocableError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_INVITATION_NOT_REVOCABLE,
    message: 'The RFQ Vendor invitation is already terminal.',
    statusCode: 409,
  });
}

export function rfqVendorInvitationIdempotencyKeyRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_INVITATION_IDEMPOTENCY_KEY_REQUIRED,
    message: 'An idempotency key is required for this invitation command.',
    statusCode: 400,
  });
}

export function rfqVendorInvitationIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_INVITATION_IDEMPOTENCY_CONFLICT,
    message: 'The idempotency key was already used with a different invitation command.',
    statusCode: 409,
  });
}

/** Generic token failure: no token/invitation existence or ownership leak. */
export function rfqVendorInvitationTokenInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_INVITATION_TOKEN_INVALID,
    message: 'The RFQ Vendor invitation token is not valid.',
    statusCode: 404,
  });
}

export function rfqVendorInvitationTokenExpiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_INVITATION_TOKEN_EXPIRED,
    message: 'The RFQ Vendor invitation token has expired.',
    statusCode: 403,
  });
}

export function rfqVendorInvitationTokenReplayedError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_INVITATION_TOKEN_REPLAYED,
    message: 'The RFQ Vendor invitation token has already been used.',
    statusCode: 403,
  });
}

export function rfqVendorInvitationActionNotAllowedError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_INVITATION_ACTION_NOT_ALLOWED,
    message: 'This Vendor RFQ invitation action is not allowed in the current state.',
    statusCode: 409,
  });
}

export function rfqVendorSessionRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_SESSION_REQUIRED,
    message: 'A Vendor RFQ session is required.',
    statusCode: 401,
  });
}

export function rfqVendorSessionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_SESSION_NOT_FOUND,
    message: 'Vendor RFQ session not found.',
    statusCode: 401,
  });
}

export function rfqVendorSessionExpiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_SESSION_EXPIRED,
    message: 'Vendor RFQ session has expired.',
    statusCode: 401,
  });
}

export function rfqVendorSessionRevokedError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_SESSION_REVOKED,
    message: 'Vendor RFQ session has been revoked.',
    statusCode: 401,
  });
}

export function rfqVendorSessionRfqMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_SESSION_RFQ_MISMATCH,
    message: 'The Vendor RFQ session is not authorized for this RFQ.',
    statusCode: 404,
  });
}

export function rfqVendorSessionInvitationMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_VENDOR_SESSION_INVITATION_MISMATCH,
    message: 'The Vendor RFQ session is not authorized for this invitation.',
    statusCode: 404,
  });
}
