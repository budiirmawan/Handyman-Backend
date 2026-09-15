import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createMaintenanceBindingHandler,
  getMaintenanceBindingHandler,
  linkMaintenanceScheduleHandler,
  linkMaintenanceTaskHandler,
  linkMaintenanceWorkOrderHandler,
  listAssetMaintenanceBindingsHandler,
  listBuildingMaintenanceBindingsHandler,
  updateMaintenanceBindingHandler,
} from './maintenance-binding.controller';

/**
 * BE-10G — Maintenance Operational Binding endpoints.
 *
 *   POST /assets/:assetId/maintenance-bindings
 *   GET  /assets/:assetId/maintenance-bindings
 *   GET  /buildings/:buildingId/engineering/maintenance-bindings
 *   GET  /engineering/maintenance-bindings/:id
 *   PATCH /engineering/maintenance-bindings/:id
 *   POST /engineering/maintenance-bindings/:id/schedule
 *   POST /engineering/maintenance-bindings/:id/task
 *   POST /engineering/maintenance-bindings/:id/work-order
 *
 * Schedules, tasks, and Work Orders stay BE-07's / BE-08's: the link
 * endpoints only create/link the shared records; their execution,
 * assignment, evidence, and verification endpoints are NOT duplicated here.
 */
export function createMaintenanceBindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('maintenance_binding.manage');
  const read = requirePermission('maintenance_binding.read');

  router.post('/assets/:assetId/maintenance-bindings', auth, manage, createMaintenanceBindingHandler);
  router.get('/assets/:assetId/maintenance-bindings', auth, read, listAssetMaintenanceBindingsHandler);
  router.get(
    '/buildings/:buildingId/engineering/maintenance-bindings',
    auth,
    read,
    requireBuildingAccess('buildingId'),
    listBuildingMaintenanceBindingsHandler,
  );
  router.get('/engineering/maintenance-bindings/:id', auth, read, getMaintenanceBindingHandler);
  router.patch('/engineering/maintenance-bindings/:id', auth, manage, updateMaintenanceBindingHandler);
  router.post('/engineering/maintenance-bindings/:id/schedule', auth, manage, linkMaintenanceScheduleHandler);
  router.post('/engineering/maintenance-bindings/:id/task', auth, manage, linkMaintenanceTaskHandler);
  router.post('/engineering/maintenance-bindings/:id/work-order', auth, manage, linkMaintenanceWorkOrderHandler);

  return router;
}
