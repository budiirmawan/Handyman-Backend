import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignRoleHandler,
  createRoleHandler,
  getRoleHandler,
  listRolesHandler,
  listUserRolesHandler,
} from './role.controller';

/**
 * Role management endpoints, protected by RBAC.
 *
 * Reads (`role.read`): GET /roles, GET /roles/:id, GET /users/:userId/roles.
 * Management (`role.manage`): POST /roles, POST /users/:userId/roles.
 */
export function createRoleRouter(): Router {
  const router = Router();

  router.post(
    '/roles',
    authenticationMiddleware,
    requirePermission('role.manage'),
    createRoleHandler,
  );
  router.get(
    '/roles',
    authenticationMiddleware,
    requirePermission('role.read'),
    listRolesHandler,
  );
  router.get(
    '/roles/:id',
    authenticationMiddleware,
    requirePermission('role.read'),
    getRoleHandler,
  );

  router.post(
    '/users/:userId/roles',
    authenticationMiddleware,
    requirePermission('role.manage'),
    assignRoleHandler,
  );
  router.get(
    '/users/:userId/roles',
    authenticationMiddleware,
    requirePermission('role.read'),
    listUserRolesHandler,
  );

  return router;
}
