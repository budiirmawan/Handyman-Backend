import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  closeBreakdownHandler,
  createBreakdownHandler,
  getBreakdownHandler,
  linkCorrectiveWorkOrderHandler,
  listAssetBreakdownsHandler,
  listBuildingBreakdownsHandler,
} from './breakdown-binding.controller';

/**
 * BE-10F — Breakdown / Corrective Binding endpoints.
 *
 *   POST /assets/:assetId/breakdowns
 *   GET  /assets/:assetId/breakdowns
 *   GET  /buildings/:buildingId/engineering/breakdowns
 *   GET  /engineering/breakdowns/:id
 *   POST /engineering/breakdowns/:id/work-order
 *   PATCH /engineering/breakdowns/:id
 *
 * The corrective Work Order is created / linked through BE-08's own flow;
 * its execution, assignment, evidence, verification, and closure endpoints
 * are NOT duplicated here.
 */
export function createBreakdownBindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('breakdown.manage');
  const read = requirePermission('breakdown.read');

  router.post('/assets/:assetId/breakdowns', auth, manage, createBreakdownHandler);
  router.get('/assets/:assetId/breakdowns', auth, read, listAssetBreakdownsHandler);
  router.get(
    '/buildings/:buildingId/engineering/breakdowns',
    auth,
    read,
    requireBuildingAccess('buildingId'),
    listBuildingBreakdownsHandler,
  );
  router.get('/engineering/breakdowns/:id', auth, read, getBreakdownHandler);
  router.post('/engineering/breakdowns/:id/work-order', auth, manage, linkCorrectiveWorkOrderHandler);
  router.patch('/engineering/breakdowns/:id', auth, manage, closeBreakdownHandler);

  return router;
}
