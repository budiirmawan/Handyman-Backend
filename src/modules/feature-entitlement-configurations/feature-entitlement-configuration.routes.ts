import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createBuildingFeatureEntitlementHandler,
  createClientFeatureEntitlementHandler,
  effectiveBuildingFeatureEntitlementsHandler,
  effectiveClientFeatureEntitlementsHandler,
  getFeatureEntitlementHandler,
  listBuildingFeatureEntitlementsHandler,
  listClientFeatureEntitlementsHandler,
  updateFeatureEntitlementHandler,
} from './feature-entitlement-configuration.controller';

export function createFeatureEntitlementConfigurationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('feature_entitlement_configuration.read');
  const manage = requirePermission('feature_entitlement_configuration.manage');

  router.post('/clients/:clientId/feature-entitlements', auth, manage, createClientFeatureEntitlementHandler);
  router.get('/clients/:clientId/feature-entitlements/effective', auth, read, effectiveClientFeatureEntitlementsHandler);
  router.get('/clients/:clientId/feature-entitlements', auth, read, listClientFeatureEntitlementsHandler);
  router.post('/buildings/:buildingId/feature-entitlements', auth, manage, createBuildingFeatureEntitlementHandler);
  router.get('/buildings/:buildingId/feature-entitlements/effective', auth, read, effectiveBuildingFeatureEntitlementsHandler);
  router.get('/buildings/:buildingId/feature-entitlements', auth, read, listBuildingFeatureEntitlementsHandler);
  router.get('/feature-entitlements/:id', auth, read, getFeatureEntitlementHandler);
  router.patch('/feature-entitlements/:id', auth, manage, updateFeatureEntitlementHandler);
  return router;
}
