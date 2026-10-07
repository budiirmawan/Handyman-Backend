import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createDepartmentHandler,
  getDepartmentHandler,
  listDepartmentsHandler,
  updateDepartmentHandler,
} from './department.controller';

/**
 * Department management endpoints, protected by RBAC.
 *
 * Reads (`department.read`): GET /departments, GET /departments/:id.
 * Management (`department.manage`): POST /departments, PATCH /departments/:id.
 *
 * All list queries require an `organizationId` query parameter to scope results.
 */
export function createDepartmentRouter(): Router {
  const router = Router();

  router.post(
    '/departments',
    authenticationMiddleware,
    requirePermission('department.manage'),
    createDepartmentHandler,
  );

  router.get(
    '/departments',
    authenticationMiddleware,
    requirePermission('department.read'),
    listDepartmentsHandler,
  );

  router.get(
    '/departments/:id',
    authenticationMiddleware,
    requirePermission('department.read'),
    getDepartmentHandler,
  );

  router.patch(
    '/departments/:id',
    authenticationMiddleware,
    requirePermission('department.manage'),
    updateDepartmentHandler,
  );

  return router;
}
