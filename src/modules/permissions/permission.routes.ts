import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignPermissionHandler,
  createPermissionHandler,
  getPermissionHandler,
  listPermissionsHandler,
  listRolePermissionsHandler,
  revokePermissionHandler,
} from './permission.controller';

/**
 * Permission management endpoints, protected by RBAC.
 *
 * Reads (`permission.read`): GET /permissions, GET /permissions/:id,
 * GET /roles/:roleId/permissions.
 * Management (`permission.manage`): POST /permissions,
 * POST /roles/:roleId/permissions, DELETE /roles/:roleId/permissions/:permissionId.
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
  // CR-HM-BE-IAM-PERMISSION-REVOCATION-01 — grant revocation. Privileged
  // grants (system roles / authority-defining permissions) are owner-only;
  // the last ACTIVE grant of an authority-defining permission cannot be
  // revoked (409 LAST_ADMIN_PERMISSION_REQUIRED).
  router.delete(
    '/roles/:roleId/permissions/:permissionId',
    authenticationMiddleware,
    requirePermission('permission.manage'),
    revokePermissionHandler,
  );

  return router;
}
