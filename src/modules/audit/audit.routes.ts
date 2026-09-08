import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { listAuditEventsHandler } from './audit.controller';

/**
 * Authentication audit read API. Append-only: there are intentionally no
 * update/delete endpoints.
 */
export function createAuditRouter(): Router {
  const router = Router();

  router.get(
    '/auth/audit-events',
    authenticationMiddleware,
    requirePermission('auth.audit.read'),
    listAuditEventsHandler,
  );

  return router;
}
