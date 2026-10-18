import type { NextFunction, Request, Response } from 'express';
import { getAppConfig } from '../../config';
import { passwordChangeRequiredError } from './auth.errors';

/**
 * CR-HM-IAM-BOOTSTRAP-01 HARDENING — mandatory password change enforcement.
 *
 * `user_credentials.must_change_password` is the authoritative server-side
 * state (set by an administrative reset). While it is true, the authenticated
 * session stays valid but may only reach the minimum surface required to
 * recover:
 *
 *   POST /auth/password          — set the new password (verifies the current)
 *   GET  /auth/password/status   — read the required state
 *   POST /auth/logout            — end the session
 *   GET  /auth/me               — read-only identity/effective context, so the
 *                                 client can render the account and guide the
 *                                 user into the change flow
 *
 * Everything else is refused with `403 PASSWORD_CHANGE_REQUIRED`. No second
 * session mechanism is introduced: the same opaque session token is used and
 * it is still revoked by the existing security paths.
 */
const ALLOWED_WHEN_PASSWORD_CHANGE_REQUIRED: ReadonlySet<string> = new Set([
  'POST /auth/password',
  'GET /auth/password/status',
  'POST /auth/logout',
  'GET /auth/me',
]);

function normalizePath(req: Request): string {
  const raw = (req.originalUrl ?? req.url ?? '').split('?')[0];
  const prefix = getAppConfig().apiPrefix;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

export function isPasswordChangeAllowed(
  method: string,
  path: string,
): boolean {
  return ALLOWED_WHEN_PASSWORD_CHANGE_REQUIRED.has(
    `${method.toUpperCase()} ${path}`,
  );
}

export function enforcePasswordChange(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    if (!req.auth) {
      // Authentication middleware always runs first; never fail open.
      next(passwordChangeRequiredError());
      return;
    }

    if (!req.auth.mustChangePassword) {
      next();
      return;
    }

    if (isPasswordChangeAllowed(req.method, normalizePath(req))) {
      next();
      return;
    }

    next(passwordChangeRequiredError());
  } catch (error) {
    next(error);
  }
}

export const PASSWORD_CHANGE_ALLOWED_OPERATIONS =
  ALLOWED_WHEN_PASSWORD_CHANGE_REQUIRED;
