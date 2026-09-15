import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createBuildingOperationalSettingHandler,
  createClientOperationalSettingHandler,
  getBuildingOperationalSettingHandler,
  getClientOperationalSettingHandler,
  getEffectiveBuildingOperationalSettingsHandler,
  getEffectiveClientOperationalSettingsHandler,
  listBuildingOperationalSettingsHandler,
  listClientOperationalSettingsHandler,
  updateBuildingOperationalSettingHandler,
  updateClientOperationalSettingHandler,
} from './operational-setting.controller';

/**
 * BE-27J is a typed facade over BE-27A/BE-27B. Their permissions and data
 * scope remain authoritative; no Operational Settings permission bypass exists.
 */
export function createOperationalSettingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const clientRead = requirePermission('client_configuration.read');
  const clientManage = requirePermission('client_configuration.manage');
  const buildingRead = requirePermission('building_configuration.read');
  const buildingManage = requirePermission('building_configuration.manage');

  router.post(
    '/clients/:clientId/operational-settings',
    auth,
    clientManage,
    createClientOperationalSettingHandler,
  );
  router.get(
    '/clients/:clientId/operational-settings/effective',
    auth,
    clientRead,
    getEffectiveClientOperationalSettingsHandler,
  );
  router.get(
    '/clients/:clientId/operational-settings',
    auth,
    clientRead,
    listClientOperationalSettingsHandler,
  );
  router.get(
    '/client-operational-settings/:id',
    auth,
    clientRead,
    getClientOperationalSettingHandler,
  );
  router.patch(
    '/client-operational-settings/:id',
    auth,
    clientManage,
    updateClientOperationalSettingHandler,
  );

  router.post(
    '/buildings/:buildingId/operational-settings',
    auth,
    buildingManage,
    createBuildingOperationalSettingHandler,
  );
  router.get(
    '/buildings/:buildingId/operational-settings/effective',
    auth,
    buildingRead,
    getEffectiveBuildingOperationalSettingsHandler,
  );
  router.get(
    '/buildings/:buildingId/operational-settings',
    auth,
    buildingRead,
    listBuildingOperationalSettingsHandler,
  );
  router.get(
    '/building-operational-settings/:id',
    auth,
    buildingRead,
    getBuildingOperationalSettingHandler,
  );
  router.patch(
    '/building-operational-settings/:id',
    auth,
    buildingManage,
    updateBuildingOperationalSettingHandler,
  );

  return router;
}
