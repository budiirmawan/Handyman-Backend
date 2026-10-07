import type { NextFunction, Request, Response } from 'express';
import { permissionService } from '../permissions';
import { logger } from '../../shared/logger';
import { authenticationRequiredError, permissionDeniedError } from './auth.errors';

/**
 * Reusable RBAC enforcement middleware factory.
 *
 * Must be mounted AFTER the authentication middleware so `req.auth` is
 * populated. Resolves the caller's effective active permissions via the
 * BE-01E resolver (single source of truth) and requires the given permission
 * code. Default-deny: missing authentication → 401, missing permission → 403.
 */
export function requirePermission(code: string) {
  return async function rbacMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!req.auth) {
        throw authenticationRequiredError();
      }

      const permissions = await permissionService.resolvePermissionsForUser(
        req.auth.userId,
      );

      if (permissions.includes(code)) {
        next();
        return;
      }

      logger.warn('Permission denied', {
        requestId: req.requestId,
        userId: req.auth.userId,
        requiredPermission: code,
        path: req.path,
        method: req.method,
        result: 'denied',
      });

      next(permissionDeniedError());
    } catch (error) {
      next(error);
    }
  };
}
