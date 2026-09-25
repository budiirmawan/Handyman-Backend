import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelMobileMaterialRequestHandler,
  createMobileWorkOrderMaterialRequestHandler,
  getMobileMaterialRequestHandler,
  listMobileWorkOrderMaterialItemsHandler,
  listMobileWorkOrderMaterialRequestsHandler,
  recordMobileWorkOrderMaterialUsageHandler,
} from './mobile-material-request.controller';

/**
 * CR-BE-RN11-MATERIAL-FIELD-01 PART 01 — mobile field material requests.
 *
 *   GET  /mobile/work-orders/:workOrderId/material-requests   material_request.field.read
 *   POST /mobile/work-orders/:workOrderId/material-requests   material_request.field.request
 *   GET  /mobile/material-requests/:materialRequestId          material_request.field.read
 *   POST /mobile/material-requests/:materialRequestId/cancel   material_request.field.request
 *   GET  /mobile/work-orders/:workOrderId/material-items      material_request.field.read  (PART 02)
 *   POST /mobile/work-orders/:workOrderId/material-usages     material_usage.field.record  (PART 03)
 *
 * Building isolation is not `requireBuildingAccess` because the Building is
 * not in the path: it is derived from the Work Order (or the request's Work
 * Order) and asserted in the service, followed for CREATE/CANCEL by the
 * BE-08F Work Order field-actor gate. Management routes are NOT re-exposed.
 */
export function createMobileMaterialRequestRouter(): Router {
  const router = Router();
  router.get(
    '/mobile/work-orders/:workOrderId/material-requests',
    authenticationMiddleware,
    requirePermission('material_request.field.read'),
    listMobileWorkOrderMaterialRequestsHandler,
  );
  router.post(
    '/mobile/work-orders/:workOrderId/material-requests',
    authenticationMiddleware,
    requirePermission('material_request.field.request'),
    createMobileWorkOrderMaterialRequestHandler,
  );
  router.get(
    '/mobile/material-requests/:materialRequestId',
    authenticationMiddleware,
    requirePermission('material_request.field.read'),
    getMobileMaterialRequestHandler,
  );
  router.get(
    '/mobile/work-orders/:workOrderId/material-items',
    authenticationMiddleware,
    requirePermission('material_request.field.read'),
    listMobileWorkOrderMaterialItemsHandler,
  );
  router.post(
    '/mobile/material-requests/:materialRequestId/cancel',
    authenticationMiddleware,
    requirePermission('material_request.field.request'),
    cancelMobileMaterialRequestHandler,
  );
  router.post(
    '/mobile/work-orders/:workOrderId/material-usages',
    authenticationMiddleware,
    requirePermission('material_usage.field.record'),
    recordMobileWorkOrderMaterialUsageHandler,
  );
  return router;
}
