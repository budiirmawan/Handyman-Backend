import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createBuildingConfigurationHandler,
  getBuildingConfigurationHandler,
  getEffectiveBuildingConfigurationHandler,
  listBuildingConfigurationsHandler,
  updateBuildingConfigurationHandler,
} from './building-configuration.controller';

/**
 * BE-27B — Building-scoped administration and effective Client→Building read.
 * Permission checks are followed by BE-02G Building scope enforcement.
 */
export function createBuildingConfigurationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('building_configuration.read');
  const manage = requirePermission('building_configuration.manage');

  router.post(
    '/buildings/:buildingId/configurations',
    auth,
    manage,
    createBuildingConfigurationHandler,
  );
  router.get(
    '/buildings/:buildingId/configurations/effective',
    auth,
    read,
    getEffectiveBuildingConfigurationHandler,
  );
  router.get(
    '/buildings/:buildingId/configurations',
    auth,
    read,
    listBuildingConfigurationsHandler,
  );
  router.get(
    '/building-configurations/:id',
    auth,
    read,
    getBuildingConfigurationHandler,
  );
  router.patch(
    '/building-configurations/:id',
    auth,
    manage,
    updateBuildingConfigurationHandler,
  );

  return router;
}
