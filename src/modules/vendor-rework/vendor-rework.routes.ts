import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getVendorReworkHandler,
  requestVendorReworkHandler,
  resubmitVendorWorkHandler,
  updateVendorReworkNotesHandler,
} from './vendor-rework.controller';

/**
 * BE-15J — Vendor Work Rework endpoints, protected by BE-01 RBAC and BE-02
 * Building isolation (enforced in the controller after resolving the Vendor
 * Work's Building). Reuses BE-09 rework / resubmission behavior.
 *
 * Reads (`vendor.read`):
 *   GET   /vendor-works/:id/rework     (current rework context + history)
 * Management (`vendor.manage`):
 *   POST  /vendor-works/:id/rework     (request rework — reason required)
 *   PATCH /vendor-works/:id/rework     (update rework notes while REQUESTED)
 *   POST  /vendor-works/:id/resubmit   (resubmit — notes required)
 *
 * No Vendor Work History endpoints are exposed here (BE-15K owns them).
 */
export function createVendorReworkRouter(): Router {
  const router = Router();

  router.post(
    '/vendor-works/:id/rework',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    requestVendorReworkHandler,
  );
  router.get(
    '/vendor-works/:id/rework',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getVendorReworkHandler,
  );
  router.patch(
    '/vendor-works/:id/rework',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    updateVendorReworkNotesHandler,
  );
  router.post(
    '/vendor-works/:id/resubmit',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    resubmitVendorWorkHandler,
  );

  return router;
}
