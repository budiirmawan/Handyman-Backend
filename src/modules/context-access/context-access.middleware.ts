import type { NextFunction, Request, Response } from 'express';
import { isValidUuid } from '../clients';
import { authenticationRequiredError } from '../auth';
import {
  buildingAccessDeniedError,
  buildingContextRequiredError,
} from './context-access.errors';
import { contextAccessService } from './context-access.service';
import { logger } from '../../shared/logger';

/**
 * BE-02G — Building-scoped access enforcement middleware.
 *
 * Must be mounted AFTER `authenticationMiddleware` (so `req.auth` exists) and,
 * where a capability is required, AFTER `requirePermission(...)`.
 *
 * Flow:
 *   authenticate
 *     → requirePermission(...)
 *       → requireBuildingAccess(paramName)
 *         → controller
 *
 * The requested Building id is read from `req.params[paramName]` (default
 * `id`). A malformed (non-UUID) id is deferred to the controller so it yields
 * the standard 400 VALIDATION_ERROR. A valid but inaccessible id yields 403
 * BUILDING_ACCESS_DENIED (whether or not the Building actually exists).
 */
export function requireBuildingAccess(paramName = 'id') {
  return async function buildingAccessMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const raw = req.params[paramName];
      if (typeof raw !== 'string' || raw.trim() === '') {
        throw buildingContextRequiredError();
      }

      if (!isValidUuid(raw.trim())) {
        return next();
      }

      if (!req.auth) {
        throw authenticationRequiredError();
      }

      const buildingId = raw.trim().toLowerCase();

      const allowed = await contextAccessService.canAccessBuilding(
        req.auth.userId,
        buildingId,
      );

      if (!allowed) {
        logger.warn('Building access denied', {
          requestId: req.requestId,
          userId: req.auth.userId,
          buildingId,
          result: 'DENIED',
        });
        return next(buildingAccessDeniedError());
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
