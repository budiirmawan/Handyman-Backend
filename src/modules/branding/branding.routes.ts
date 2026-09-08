import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createBuildingBrandingHandler,
  createClientBrandingHandler,
  getBuildingBrandingByIdHandler,
  getBuildingBrandingForScopeHandler,
  getClientBrandingByIdHandler,
  getClientBrandingForScopeHandler,
  getEffectiveBuildingBrandingHandler,
  getEffectiveClientBrandingHandler,
  updateBuildingBrandingHandler,
  updateClientBrandingHandler,
} from './branding.controller';

/** BE-27M constrained branding configuration over BE-27A/BE-27B. */
export function createBrandingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const clientRead = requirePermission('client_configuration.read');
  const clientManage = requirePermission('client_configuration.manage');
  const buildingRead = requirePermission('building_configuration.read');
  const buildingManage = requirePermission('building_configuration.manage');

  router.post('/clients/:clientId/branding', auth, clientManage, createClientBrandingHandler);
  router.get(
    '/clients/:clientId/branding/effective',
    auth,
    clientRead,
    getEffectiveClientBrandingHandler,
  );
  router.get('/clients/:clientId/branding', auth, clientRead, getClientBrandingForScopeHandler);
  router.get('/client-branding/:id', auth, clientRead, getClientBrandingByIdHandler);
  router.patch('/client-branding/:id', auth, clientManage, updateClientBrandingHandler);

  router.post(
    '/buildings/:buildingId/branding',
    auth,
    buildingManage,
    createBuildingBrandingHandler,
  );
  router.get(
    '/buildings/:buildingId/branding/effective',
    auth,
    buildingRead,
    getEffectiveBuildingBrandingHandler,
  );
  router.get(
    '/buildings/:buildingId/branding',
    auth,
    buildingRead,
    getBuildingBrandingForScopeHandler,
  );
  router.get('/building-branding/:id', auth, buildingRead, getBuildingBrandingByIdHandler);
  router.patch('/building-branding/:id', auth, buildingManage, updateBuildingBrandingHandler);
  return router;
}
