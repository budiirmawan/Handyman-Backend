import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createMeterReadingBindingHandler,
  getMeterReadingBindingHandler,
  getMeterReadingContextHandler,
  listAssetMeterReadingBindingsHandler,
  listBuildingMeterReadingBindingsHandler,
  startMeterReadingExecutionHandler,
  submitMeterReadingHandler,
  updateMeterReadingBindingHandler,
} from './meter-reading-binding.controller';

/**
 * BE-10C — Meter Reading Binding endpoints.
 *
 *   POST /assets/:assetId/meter-reading-bindings
 *   GET  /assets/:assetId/meter-reading-bindings
 *   GET  /buildings/:buildingId/engineering/meter-reading-bindings
 *   GET  /engineering/meter-reading-bindings/:id
 *   PATCH /engineering/meter-reading-bindings/:id
 *   POST /engineering/meter-reading-bindings/:id/start
 *   PUT  /engineering/meter-reading-executions/:id/reading
 *   GET  /engineering/meter-reading-executions/:id
 *
 * Execution and measurement stay BE-07's: the start endpoint only creates
 * the shared Form Instance, and the reading endpoint writes into BE-07's own
 * `form_responses` store (the same table BE-07's response save uses). No
 * duplicated Form Instance / Response APIs are created.
 */
export function createMeterReadingBindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('meter_reading_binding.manage');
  const read = requirePermission('meter_reading_binding.read');

  router.post('/assets/:assetId/meter-reading-bindings', auth, manage, createMeterReadingBindingHandler);
  router.get('/assets/:assetId/meter-reading-bindings', auth, read, listAssetMeterReadingBindingsHandler);
  router.get(
    '/buildings/:buildingId/engineering/meter-reading-bindings',
    auth,
    read,
    requireBuildingAccess('buildingId'),
    listBuildingMeterReadingBindingsHandler,
  );
  router.get('/engineering/meter-reading-bindings/:id', auth, read, getMeterReadingBindingHandler);
  router.patch('/engineering/meter-reading-bindings/:id', auth, manage, updateMeterReadingBindingHandler);
  router.post('/engineering/meter-reading-bindings/:id/start', auth, manage, startMeterReadingExecutionHandler);
  router.put('/engineering/meter-reading-executions/:id/reading', auth, manage, submitMeterReadingHandler);
  router.get('/engineering/meter-reading-executions/:id', auth, read, getMeterReadingContextHandler);

  return router;
}
