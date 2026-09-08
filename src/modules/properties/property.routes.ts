import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createPropertyHandler,
  getPropertyHandler,
  listClientPropertiesHandler,
  listPropertiesHandler,
  updatePropertyStatusHandler,
} from './property.controller';

/**
 * Property management endpoints, protected by RBAC.
 *
 * Reads (`property.read`): GET /properties, GET /properties/:id,
 *   GET /clients/:clientId/properties.
 * Management (`property.manage`): POST /properties, PATCH /properties/:id/status.
 */
export function createPropertyRouter(): Router {
  const router = Router();

  router.post(
    '/properties',
    authenticationMiddleware,
    requirePermission('property.manage'),
    createPropertyHandler,
  );
  router.get(
    '/properties',
    authenticationMiddleware,
    requirePermission('property.read'),
    listPropertiesHandler,
  );
  router.get(
    '/properties/:id',
    authenticationMiddleware,
    requirePermission('property.read'),
    getPropertyHandler,
  );
  router.patch(
    '/properties/:id/status',
    authenticationMiddleware,
    requirePermission('property.manage'),
    updatePropertyStatusHandler,
  );

  router.get(
    '/clients/:clientId/properties',
    authenticationMiddleware,
    requirePermission('property.read'),
    listClientPropertiesHandler,
  );

  return router;
}
