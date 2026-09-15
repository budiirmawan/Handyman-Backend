import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createBuildingModuleConfigurationHandler,
  createClientModuleConfigurationHandler,
  getEffectiveBuildingModuleConfigurationHandler,
  getEffectiveClientModuleConfigurationHandler,
  getModuleConfigurationHandler,
  listBuildingModuleConfigurationsHandler,
  listClientModuleConfigurationsHandler,
  updateModuleConfigurationHandler,
} from './module-configuration.controller';

/**
 * BE-27C — Client/Building Module configuration. The existing Module and
 * Entitlement services remain authoritative; these routes only narrow them.
 */
export function createModuleConfigurationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('module_configuration.read');
  const manage = requirePermission('module_configuration.manage');

  router.post(
    '/clients/:clientId/module-configurations',
    auth,
    manage,
    createClientModuleConfigurationHandler,
  );
  router.get(
    '/clients/:clientId/module-configurations/effective',
    auth,
    read,
    getEffectiveClientModuleConfigurationHandler,
  );
  router.get(
    '/clients/:clientId/module-configurations',
    auth,
    read,
    listClientModuleConfigurationsHandler,
  );
  router.post(
    '/buildings/:buildingId/module-configurations',
    auth,
    manage,
    createBuildingModuleConfigurationHandler,
  );
  router.get(
    '/buildings/:buildingId/module-configurations/effective',
    auth,
    read,
    getEffectiveBuildingModuleConfigurationHandler,
  );
  router.get(
    '/buildings/:buildingId/module-configurations',
    auth,
    read,
    listBuildingModuleConfigurationsHandler,
  );
  router.get(
    '/module-configurations/:id',
    auth,
    read,
    getModuleConfigurationHandler,
  );
  router.patch(
    '/module-configurations/:id',
    auth,
    manage,
    updateModuleConfigurationHandler,
  );

  return router;
}
