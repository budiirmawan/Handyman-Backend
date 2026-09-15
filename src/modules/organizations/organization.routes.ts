import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createOrganizationHandler,
  getOrganizationHandler,
  listOrganizationsHandler,
  updateOrganizationHandler,
} from './organization.controller';

/**
 * Organization management endpoints, protected by RBAC.
 *
 * Reads (`organization.read`): GET /organizations, GET /organizations/:id.
 * Management (`organization.manage`): POST /organizations, PATCH /organizations/:id.
 *
 * All list queries require a `clientId` query parameter to scope results.
 */
export function createOrganizationRouter(): Router {
  const router = Router();

  router.post(
    '/organizations',
    authenticationMiddleware,
    requirePermission('organization.manage'),
    createOrganizationHandler,
  );

  router.get(
    '/organizations',
    authenticationMiddleware,
    requirePermission('organization.read'),
    listOrganizationsHandler,
  );

  router.get(
    '/organizations/:id',
    authenticationMiddleware,
    requirePermission('organization.read'),
    getOrganizationHandler,
  );

  router.patch(
    '/organizations/:id',
    authenticationMiddleware,
    requirePermission('organization.manage'),
    updateOrganizationHandler,
  );

  return router;
}
