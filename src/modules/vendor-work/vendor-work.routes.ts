import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getVendorWorkHandler,
  listVendorWorksHandler,
  resolveVendorWorkHandler,
  updateVendorWorkStatusHandler,
} from './vendor-work.controller';

/**
 * BE-15B — Vendor Work endpoints, protected by BE-01 RBAC and BE-02 Building
 * isolation (enforced in the controller after resolving the assignment's /
 * work's Building).
 *
 * Management (`vendor.manage`):
 *   POST  /vendor-assignments/:assignmentId/work   (create/resolve work context)
 *   PATCH /vendor-works/:workId/status             (start / hold / complete)
 * Reads (`vendor.read`):
 *   GET   /vendor-works                            (?vendorId= & ?buildingId= & ?status=)
 *   GET   /vendor-works/:workId
 *
 * No Vendor Checklist endpoints are exposed here (later BE-15 PARTs).
 */
export function createVendorWorkRouter(): Router {
  const router = Router();

  router.post(
    '/vendor-assignments/:assignmentId/work',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    resolveVendorWorkHandler,
  );
  router.get(
    '/vendor-works',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listVendorWorksHandler,
  );
  router.get(
    '/vendor-works/:workId',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getVendorWorkHandler,
  );
  router.patch(
    '/vendor-works/:workId/status',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    updateVendorWorkStatusHandler,
  );

  return router;
}
