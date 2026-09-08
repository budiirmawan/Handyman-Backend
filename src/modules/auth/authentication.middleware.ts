import type { NextFunction, Request, Response } from 'express';
import { authenticationRequiredError } from './auth.errors';
import { sessionService } from './session.service';
import type { AuthContext } from './session.types';

declare global {
  namespace Express {
    interface Request {
      auth: AuthContext;
    }
  }
}

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

/**
 * Reads `Authorization: Bearer <token>`, resolves the session, and attaches
 * the authenticated context to `req.auth`. Role/permission resolution is
 * deferred to BE-01D–F.
 */
export async function authenticationMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = readBearerToken(req.header('authorization'));
    if (!token) {
      throw authenticationRequiredError();
    }

    req.auth = await sessionService.resolveSessionContext(token);
    next();
  } catch (error) {
    next(error);
  }
}

function readBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const match = BEARER_PATTERN.exec(header.trim());
  return match ? match[1] : null;
}
