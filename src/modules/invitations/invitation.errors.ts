import { AppError, ERROR_CODES } from '../../shared/errors';

export function invitationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVITATION_NOT_FOUND,
    message: 'Invitation not found.',
    statusCode: 404,
  });
}

export function invitationAlreadyPendingError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVITATION_ALREADY_PENDING,
    message: 'An invitation for this email is already pending.',
    statusCode: 409,
  });
}

export function invitationExpiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVITATION_EXPIRED,
    message: 'This invitation has expired.',
    statusCode: 400,
  });
}

export function invitationRevokedError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVITATION_REVOKED,
    message: 'This invitation has been revoked.',
    statusCode: 400,
  });
}

export function invitationAlreadyAcceptedError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVITATION_ALREADY_ACCEPTED,
    message: 'This invitation has already been accepted.',
    statusCode: 409,
  });
}

/**
 * Generic public-token error. Deliberately reveals nothing about whether the
 * token, its hash, or an associated email exists.
 */
export function invalidInvitationTokenError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVALID_INVITATION_TOKEN,
    message: 'This invitation token is not valid.',
    statusCode: 404,
  });
}
