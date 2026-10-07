import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createClientConfigurationHandler,
  getClientConfigurationHandler,
  getEffectiveClientConfigurationHandler,
  listClientConfigurationsHandler,
  updateClientConfigurationHandler,
} from './client-configuration.controller';

/**
 * BE-27A — Client-scoped configuration administration and effective read.
 *
 * Administration:
 *   POST  /clients/:clientId/configurations       client_configuration.manage
 *   GET   /clients/:clientId/configurations       client_configuration.read
 *   GET   /client-configurations/:id              client_configuration.read
 *   PATCH /client-configurations/:id              client_configuration.manage
 *
 * Runtime projection:
 *   GET   /clients/:clientId/configurations/effective
 *                                                   client_configuration.read
 *
 * All handlers additionally intersect the requested record with the caller's
 * BE-02G Client scope. Permission alone never grants cross-Client access.
 */
export function createClientConfigurationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('client_configuration.read');
  const manage = requirePermission('client_configuration.manage');

  router.post(
    '/clients/:clientId/configurations',
    auth,
    manage,
    createClientConfigurationHandler,
  );
  router.get(
    '/clients/:clientId/configurations/effective',
    auth,
    read,
    getEffectiveClientConfigurationHandler,
  );
  router.get(
    '/clients/:clientId/configurations',
    auth,
    read,
    listClientConfigurationsHandler,
  );
  router.get(
    '/client-configurations/:id',
    auth,
    read,
    getClientConfigurationHandler,
  );
  router.patch(
    '/client-configurations/:id',
    auth,
    manage,
    updateClientConfigurationHandler,
  );

  return router;
}
