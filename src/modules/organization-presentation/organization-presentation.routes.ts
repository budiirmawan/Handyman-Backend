import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createBuildingOrganizationPresentationHandler,
  createClientOrganizationPresentationHandler,
  getBuildingOrganizationPresentationByIdHandler,
  getBuildingOrganizationPresentationForScopeHandler,
  getClientOrganizationPresentationByIdHandler,
  getClientOrganizationPresentationForScopeHandler,
  getEffectiveBuildingOrganizationPresentationHandler,
  getEffectiveClientOrganizationPresentationHandler,
  updateBuildingOrganizationPresentationHandler,
  updateClientOrganizationPresentationHandler,
} from './organization-presentation.controller';

/**
 * BE-27K presentation-only facade. BE-27A/BE-27B RBAC and Data Scope remain
 * authoritative; this router never changes BE-03 hierarchy or RBAC records.
 */
export function createOrganizationPresentationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const clientRead = requirePermission('client_configuration.read');
  const clientManage = requirePermission('client_configuration.manage');
  const buildingRead = requirePermission('building_configuration.read');
  const buildingManage = requirePermission('building_configuration.manage');

  router.post(
    '/clients/:clientId/organization-presentation',
    auth,
    clientManage,
    createClientOrganizationPresentationHandler,
  );
  router.get(
    '/clients/:clientId/organization-presentation/effective',
    auth,
    clientRead,
    getEffectiveClientOrganizationPresentationHandler,
  );
  router.get(
    '/clients/:clientId/organization-presentation',
    auth,
    clientRead,
    getClientOrganizationPresentationForScopeHandler,
  );
  router.get(
    '/client-organization-presentation/:id',
    auth,
    clientRead,
    getClientOrganizationPresentationByIdHandler,
  );
  router.patch(
    '/client-organization-presentation/:id',
    auth,
    clientManage,
    updateClientOrganizationPresentationHandler,
  );

  router.post(
    '/buildings/:buildingId/organization-presentation',
    auth,
    buildingManage,
    createBuildingOrganizationPresentationHandler,
  );
  router.get(
    '/buildings/:buildingId/organization-presentation/effective',
    auth,
    buildingRead,
    getEffectiveBuildingOrganizationPresentationHandler,
  );
  router.get(
    '/buildings/:buildingId/organization-presentation',
    auth,
    buildingRead,
    getBuildingOrganizationPresentationForScopeHandler,
  );
  router.get(
    '/building-organization-presentation/:id',
    auth,
    buildingRead,
    getBuildingOrganizationPresentationByIdHandler,
  );
  router.patch(
    '/building-organization-presentation/:id',
    auth,
    buildingManage,
    updateBuildingOrganizationPresentationHandler,
  );

  return router;
}
