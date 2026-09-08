import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createAssetFailureHandler,
  getAssetFailureHandler,
  listAssetFailuresHandler,
  updateAssetFailureHandler,
} from './asset-failure.controller';

/**
 * BE-21C — Asset Failure / Defect routes.
 *
 * These address the SHARED BE-21A Incident id: `/asset-failures/:id` takes the
 * Incident id, so there is one identity across the foundation and its
 * specialization. Cancellation stays on the BE-21A endpoint
 * (`POST /incidents/:id/cancel`) — the foundation owns the record lifecycle
 * and BE-21C must not offer a second way to end it.
 *
 * Listing by Asset is a filter on this collection (`?assetId=`) rather than a
 * nested `/assets/:id/failures` route: BE-05 owns the `/assets` namespace, and
 * an Incident specialization must not graft Incident endpoints onto it.
 *
 * RBAC is default-deny; the service additionally asserts Building access, so
 * holding the permission is never sufficient to reach another Building.
 */
export function createAssetFailureRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('asset_failure.read');
  const manage = requirePermission('asset_failure.manage');

  router.post('/asset-failures', auth, manage, createAssetFailureHandler);
  router.get('/asset-failures', auth, read, listAssetFailuresHandler);
  router.get('/asset-failures/:id', auth, read, getAssetFailureHandler);
  router.patch('/asset-failures/:id', auth, manage, updateAssetFailureHandler);

  return router;
}
