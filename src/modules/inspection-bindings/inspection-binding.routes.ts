import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createInspectionBindingHandler,
  getInspectionBindingHandler,
  getInspectionExecutionContextHandler,
  listAssetInspectionBindingsHandler,
  listBuildingInspectionBindingsHandler,
  startInspectionExecutionHandler,
  updateInspectionBindingHandler,
} from './inspection-binding.controller';

/**
 * BE-10B — Equipment Inspection Binding endpoints.
 *
 *   POST /assets/:assetId/inspection-bindings
 *   GET  /assets/:assetId/inspection-bindings
 *   GET  /buildings/:buildingId/engineering/inspection-bindings
 *   GET  /engineering/inspection-bindings/:id
 *   PATCH /engineering/inspection-bindings/:id
 *   POST /engineering/inspection-bindings/:id/start
 *   GET  /engineering/inspection-executions/:id
 *
 * Execution stays BE-07's: the start endpoint only creates the shared
 * checklist execution row for the binding — responses, completion, evidence,
 * and verification continue through BE-07's own endpoints (no duplicated
 * checklist execution endpoints here).
 */
export function createInspectionBindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('inspection_binding.manage');
  const read = requirePermission('inspection_binding.read');

  router.post('/assets/:assetId/inspection-bindings', auth, manage, createInspectionBindingHandler);
  router.get('/assets/:assetId/inspection-bindings', auth, read, listAssetInspectionBindingsHandler);
  router.get(
    '/buildings/:buildingId/engineering/inspection-bindings',
    auth,
    read,
    requireBuildingAccess('buildingId'),
    listBuildingInspectionBindingsHandler,
  );
  router.get('/engineering/inspection-bindings/:id', auth, read, getInspectionBindingHandler);
  router.patch('/engineering/inspection-bindings/:id', auth, manage, updateInspectionBindingHandler);
  router.post('/engineering/inspection-bindings/:id/start', auth, manage, startInspectionExecutionHandler);
  router.get('/engineering/inspection-executions/:id', auth, read, getInspectionExecutionContextHandler);

  return router;
}
