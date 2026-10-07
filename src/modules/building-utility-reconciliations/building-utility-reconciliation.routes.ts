import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createBuildingUtilityReconciliationHandler,
  getBuildingUtilityReconciliationHandler,
  listBuildingUtilityReconciliationsHandler,
} from './building-utility-reconciliation.controller';

/** PART 12 Building analytics only — no Tenant approval or billing routes. */
export function createBuildingUtilityReconciliationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  router.post('/buildings/:buildingId/utility-reconciliations', auth,
    requirePermission('utility_meter.manage'), requireBuildingAccess('buildingId'),
    createBuildingUtilityReconciliationHandler);
  router.get('/buildings/:buildingId/utility-reconciliations', auth,
    requirePermission('utility_meter.read'), requireBuildingAccess('buildingId'),
    listBuildingUtilityReconciliationsHandler);
  router.get('/utility/reconciliations/:id', auth,
    requirePermission('utility_meter.read'), getBuildingUtilityReconciliationHandler);
  return router;
}
