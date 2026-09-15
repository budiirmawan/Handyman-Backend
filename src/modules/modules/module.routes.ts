import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createModuleHandler,
  getModuleHandler,
  listModulesHandler,
  updateModuleStatusHandler,
} from './module.controller';

/**
 * Module catalogue management endpoints, protected by RBAC.
 *
 * Reads (`module.read`): GET /modules, GET /modules/:id.
 * Management (`module.manage`): POST /modules, PATCH /modules/:id/status.
 */
export function createModuleRouter(): Router {
  const router = Router();

  router.post(
    '/modules',
    authenticationMiddleware,
    requirePermission('module.manage'),
    createModuleHandler,
  );
  router.get(
    '/modules',
    authenticationMiddleware,
    requirePermission('module.read'),
    listModulesHandler,
  );
  router.get(
    '/modules/:id',
    authenticationMiddleware,
    requirePermission('module.read'),
    getModuleHandler,
  );
  router.patch(
    '/modules/:id/status',
    authenticationMiddleware,
    requirePermission('module.manage'),
    updateModuleStatusHandler,
  );

  return router;
}
