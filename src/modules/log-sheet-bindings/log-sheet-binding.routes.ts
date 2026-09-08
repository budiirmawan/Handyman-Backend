import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createLogSheetBindingHandler,
  getLogSheetBindingHandler,
  getLogSheetExecutionContextHandler,
  listAssetLogSheetBindingsHandler,
  listBuildingLogSheetBindingsHandler,
  listLogSheetExecutionsHandler,
  startLogSheetExecutionHandler,
  updateLogSheetBindingHandler,
} from './log-sheet-binding.controller';

/**
 * BE-10D — Equipment Log Sheet Binding endpoints.
 *
 *   POST /assets/:assetId/log-sheet-bindings
 *   GET  /assets/:assetId/log-sheet-bindings
 *   GET  /buildings/:buildingId/engineering/log-sheet-bindings
 *   GET  /engineering/log-sheet-bindings/:id
 *   PATCH /engineering/log-sheet-bindings/:id
 *   POST /engineering/log-sheet-bindings/:id/start
 *   GET  /engineering/log-sheet-bindings/:id/executions
 *   GET  /engineering/log-sheet-executions/:id
 *
 * Execution and response persistence stay BE-07's: the start endpoint only
 * creates the shared Form Instance, and log rows are submitted through
 * BE-07's own form instance / response endpoints. No duplicated Form
 * Instance / Response APIs are created.
 */
export function createLogSheetBindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('log_sheet_binding.manage');
  const read = requirePermission('log_sheet_binding.read');

  router.post('/assets/:assetId/log-sheet-bindings', auth, manage, createLogSheetBindingHandler);
  router.get('/assets/:assetId/log-sheet-bindings', auth, read, listAssetLogSheetBindingsHandler);
  router.get(
    '/buildings/:buildingId/engineering/log-sheet-bindings',
    auth,
    read,
    requireBuildingAccess('buildingId'),
    listBuildingLogSheetBindingsHandler,
  );
  router.get('/engineering/log-sheet-bindings/:id', auth, read, getLogSheetBindingHandler);
  router.patch('/engineering/log-sheet-bindings/:id', auth, manage, updateLogSheetBindingHandler);
  router.post('/engineering/log-sheet-bindings/:id/start', auth, manage, startLogSheetExecutionHandler);
  router.get('/engineering/log-sheet-bindings/:id/executions', auth, read, listLogSheetExecutionsHandler);
  router.get('/engineering/log-sheet-executions/:id', auth, read, getLogSheetExecutionContextHandler);

  return router;
}
