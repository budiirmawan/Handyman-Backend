import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createPublicAreaInspectionBindingHandler,
  getPublicAreaInspectionBindingHandler,
  getPublicAreaInspectionExecutionHandler,
  listPublicAreaInspectionBindingsHandler,
  startPublicAreaInspectionExecutionHandler,
  updatePublicAreaInspectionBindingHandler,
} from './public-area-inspection.controller';

/**
 * BE-11F — Public Area Inspection Binding endpoints.
 *
 *   POST  /housekeeping/public-area-inspection-bindings
 *   GET   /housekeeping/public-area-inspection-bindings
 *   GET   /housekeeping/public-area-inspection-bindings/:id
 *   PATCH /housekeeping/public-area-inspection-bindings/:id
 *   POST  /housekeeping/public-area-inspection-bindings/:id/start
 *   GET   /housekeeping/public-area-inspection-executions/:id
 */
export function createPublicAreaInspectionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('public_area_inspection.manage');
  const read = requirePermission('public_area_inspection.read');

  router.post(
    '/housekeeping/public-area-inspection-bindings',
    auth,
    manage,
    createPublicAreaInspectionBindingHandler,
  );
  router.get(
    '/housekeeping/public-area-inspection-bindings',
    auth,
    read,
    listPublicAreaInspectionBindingsHandler,
  );
  router.get(
    '/housekeeping/public-area-inspection-bindings/:id',
    auth,
    read,
    getPublicAreaInspectionBindingHandler,
  );
  router.patch(
    '/housekeeping/public-area-inspection-bindings/:id',
    auth,
    manage,
    updatePublicAreaInspectionBindingHandler,
  );
  router.post(
    '/housekeeping/public-area-inspection-bindings/:id/start',
    auth,
    manage,
    startPublicAreaInspectionExecutionHandler,
  );
  router.get(
    '/housekeeping/public-area-inspection-executions/:id',
    auth,
    read,
    getPublicAreaInspectionExecutionHandler,
  );

  return router;
}
