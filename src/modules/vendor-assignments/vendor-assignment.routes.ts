import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignVendorHandler,
  getVendorAssignmentHandler,
  listVendorAssignmentsHandler,
  updateVendorAssignmentHandler,
} from './vendor-assignment.controller';

/**
 * BE-15A — Vendor Assignment endpoints, protected by BE-01 RBAC and BE-02
 * Building isolation (enforced in the controller after resolving the
 * assignment's / work order's Building).
 *
 * Management (`vendor.manage`):
 *   POST  /vendor-assignments
 *   PATCH /vendor-assignments/:assignmentId   (deactivate or reassign)
 * Reads (`vendor.read`):
 *   GET   /vendor-assignments                 (?vendorId= & ?workOrderId= & ?buildingId=)
 *   GET   /vendor-assignments/:assignmentId
 *
 * No Vendor Work execution endpoints are exposed here (later BE-15 PARTs).
 */
export function createVendorAssignmentRouter(): Router {
  const router = Router();

  router.post(
    '/vendor-assignments',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    assignVendorHandler,
  );
  router.get(
    '/vendor-assignments',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listVendorAssignmentsHandler,
  );
  router.get(
    '/vendor-assignments/:assignmentId',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getVendorAssignmentHandler,
  );
  router.patch(
    '/vendor-assignments/:assignmentId',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    updateVendorAssignmentHandler,
  );

  return router;
}
