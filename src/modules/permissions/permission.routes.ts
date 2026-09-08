import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignPermissionHandler,
  createPermissionHandler,
  getPermissionHandler,
  listPermissionsHandler,
  listRolePermissionsHandler,
} from './permission.controller';

/**
 * Permission management endpoints, protected by RBAC.
 *
 * Reads (`permission.read`): GET /permissions, GET /permissions/:id,
 * GET /roles/:roleId/permissions.
 * Management (`permission.manage`): POST /permissions,
 * POST /roles/:roleId/permissions.
 */
export function createPermissionRouter(): Router {
  const router = Router();

  router.post(
    '/permissions',
    authenticationMiddleware,
    requirePermission('permission.manage'),
    createPermissionHandler,
  );
  router.get(
    '/permissions',
    authenticationMiddleware,
    requirePermission('permission.read'),
    listPermissionsHandler,
  );
  router.get(
    '/permissions/:id',
    authenticationMiddleware,
    requirePermission('permission.read'),
    getPermissionHandler,
  );

  router.post(
    '/roles/:roleId/permissions',
    authenticationMiddleware,
    requirePermission('permission.manage'),
    assignPermissionHandler,
  );
  router.get(
    '/roles/:roleId/permissions',
    authenticationMiddleware,
    requirePermission('permission.read'),
    listRolePermissionsHandler,
  );

  return router;
}
