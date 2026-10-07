import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createBuildingCmsContentHandler,
  createClientCmsContentHandler,
  getBuildingCmsContentHandler,
  getClientCmsContentHandler,
  getEffectiveBuildingCmsContentHandler,
  getEffectiveClientCmsContentHandler,
  listBuildingCmsContentHandler,
  listClientCmsContentHandler,
  updateBuildingCmsContentHandler,
  updateClientCmsContentHandler,
} from './cms-content.controller';

/** BE-27L CMS text/Markdown content; BE-27A/BE-27B scope and RBAC are reused. */
export function createCmsContentRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const clientRead = requirePermission('client_configuration.read');
  const clientManage = requirePermission('client_configuration.manage');
  const buildingRead = requirePermission('building_configuration.read');
  const buildingManage = requirePermission('building_configuration.manage');

  router.post('/clients/:clientId/cms-content', auth, clientManage, createClientCmsContentHandler);
  router.get(
    '/clients/:clientId/cms-content/effective',
    auth,
    clientRead,
    getEffectiveClientCmsContentHandler,
  );
  router.get('/clients/:clientId/cms-content', auth, clientRead, listClientCmsContentHandler);
  router.get('/client-cms-content/:id', auth, clientRead, getClientCmsContentHandler);
  router.patch('/client-cms-content/:id', auth, clientManage, updateClientCmsContentHandler);

  router.post(
    '/buildings/:buildingId/cms-content',
    auth,
    buildingManage,
    createBuildingCmsContentHandler,
  );
  router.get(
    '/buildings/:buildingId/cms-content/effective',
    auth,
    buildingRead,
    getEffectiveBuildingCmsContentHandler,
  );
  router.get(
    '/buildings/:buildingId/cms-content',
    auth,
    buildingRead,
    listBuildingCmsContentHandler,
  );
  router.get('/building-cms-content/:id', auth, buildingRead, getBuildingCmsContentHandler);
  router.patch(
    '/building-cms-content/:id',
    auth,
    buildingManage,
    updateBuildingCmsContentHandler,
  );
  return router;
}
