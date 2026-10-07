import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createPositionHandler,
  getPositionHandler,
  listPositionsByDeptHandler,
  listPositionsByOrgHandler,
  updatePositionHandler,
} from './position.controller';

/**
 * Position management endpoints, protected by RBAC.
 *
 * Reads (`position.read`):
 *   GET /organizations/:organizationId/positions
 *   GET /departments/:departmentId/positions
 *   GET /positions/:id
 *
 * Management (`position.manage`):
 *   POST /organizations/:organizationId/positions
 *   PATCH /positions/:id
 *
 * Position is scoped to Organization; optionally linked to a Department.
 * Position creation must never alter BE-01 RBAC (Role/Permission).
 */
export function createPositionRouter(): Router {
  const router = Router();

  router.post(
    '/organizations/:organizationId/positions',
    authenticationMiddleware,
    requirePermission('position.manage'),
    createPositionHandler,
  );

  router.get(
    '/organizations/:organizationId/positions',
    authenticationMiddleware,
    requirePermission('position.read'),
    listPositionsByOrgHandler,
  );

  router.get(
    '/departments/:departmentId/positions',
    authenticationMiddleware,
    requirePermission('position.read'),
    listPositionsByDeptHandler,
  );

  router.get(
    '/positions/:id',
    authenticationMiddleware,
    requirePermission('position.read'),
    getPositionHandler,
  );

  router.patch(
    '/positions/:id',
    authenticationMiddleware,
    requirePermission('position.manage'),
    updatePositionHandler,
  );

  return router;
}
