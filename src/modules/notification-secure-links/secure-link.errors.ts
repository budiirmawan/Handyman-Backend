import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * BE-26J — Notification secure link errors.
 *
 * A secure link is only ever resolvable by its bound recipient; an unknown
 * token OR a token bound to a different user is reported identically as
 * NOT_FOUND (no existence/ownership leak).
 */
export function secureLinkNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURE_LINK_NOT_FOUND,
    message: 'Secure link not found.',
    statusCode: 404,
    resource: { type: 'SECURE_LINK', id: 'token' },
  });
}

export function secureLinkExpiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURE_LINK_EXPIRED,
    message: 'Secure link has expired.',
    statusCode: 403,
  });
}

export function secureLinkRevokedError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURE_LINK_REVOKED,
    message: 'Secure link has been revoked.',
    statusCode: 403,
  });
}

export function secureLinkAlreadyUsedError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURE_LINK_ALREADY_USED,
    message: 'Secure link has already been used.',
    statusCode: 403,
  });
}

/** A lifecycle transition (revoke) is not allowed because the link is not ACTIVE. */
export function secureLinkNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURE_LINK_NOT_ACTIVE,
    message: 'Secure link is not active.',
    statusCode: 409,
  });
}
