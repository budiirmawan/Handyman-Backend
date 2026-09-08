import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  cancelWorkRequestHandler,
  createWorkRequestHandler,
  getWorkRequestHandler,
  listBuildingWorkRequestsHandler,
  updateWorkRequestHandler,
} from './work-request.controller';

/**
 * BE-08A — Work Request endpoints, protected by BE-01 RBAC and BE-02 Building
 * isolation.
 *
 * Reads (`work_request.read`):
 *   GET  /buildings/:buildingId/work-requests   (?status= & ?requestType=)
 *   GET  /work-requests/:id
 * Management (`work_request.manage`):
 *   POST   /buildings/:buildingId/work-requests
 *   PATCH  /work-requests/:id
 *   POST   /work-requests/:id/cancel
 *
 * Building-nested routes pass through `requireBuildingAccess('buildingId')`;
 * the `/work-requests/:id` routes enforce the same rule in the controller
 * after resolving the record's Building — so Work Request administration
 * inherits BE-02 isolation rather than opening a side channel around it.
 *
 * No Work Order endpoints are exposed here (BE-08B owns the Work Order domain).
 */
export function createWorkRequestRouter(): Router {
  const router = Router();

  router.post(
    '/buildings/:buildingId/work-requests',
    authenticationMiddleware,
    requirePermission('work_request.manage'),
    requireBuildingAccess('buildingId'),
    createWorkRequestHandler,
  );
  router.get(
    '/buildings/:buildingId/work-requests',
    authenticationMiddleware,
    requirePermission('work_request.read'),
    requireBuildingAccess('buildingId'),
    listBuildingWorkRequestsHandler,
  );
  router.get(
    '/work-requests/:id',
    authenticationMiddleware,
    requirePermission('work_request.read'),
    getWorkRequestHandler,
  );
  router.patch(
    '/work-requests/:id',
    authenticationMiddleware,
    requirePermission('work_request.manage'),
    updateWorkRequestHandler,
  );
  router.post(
    '/work-requests/:id/cancel',
    authenticationMiddleware,
    requirePermission('work_request.manage'),
    cancelWorkRequestHandler,
  );

  return router;
}
