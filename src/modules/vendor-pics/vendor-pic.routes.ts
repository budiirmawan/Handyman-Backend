import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createVendorPicHandler,
  getVendorPicHandler,
  listVendorPicsHandler,
  updateVendorPicHandler,
} from './vendor-pic.controller';

/**
 * BE-06C — Vendor PIC endpoints, protected by BE-01 RBAC.
 *
 * Reads (`vendor.read`):        GET   /vendors/:vendorId/pics
 *                               GET   /vendor-pics/:id
 * Management (`vendor.manage`): POST  /vendors/:vendorId/pics
 *                               PATCH /vendor-pics/:id
 *
 * Vendor PICs are contact data of the Vendor domain, so they reuse the
 * BE-06A `vendor.*` permissions. Writes and Vendor-scoped reads are nested
 * under the Vendor, so the owning Vendor is always taken from the URL —
 * Client isolation is inherited through the Vendor (PIC → Vendor → Client).
 *
 * Primary PIC changes and the status lifecycle travel through the general
 * `PATCH /vendor-pics/:id` (which accepts `isPrimary` and `status`).
 */
export function createVendorPicRouter(): Router {
  const router = Router();

  router.post(
    '/vendors/:vendorId/pics',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    createVendorPicHandler,
  );
  router.get(
    '/vendors/:vendorId/pics',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listVendorPicsHandler,
  );
  router.get(
    '/vendor-pics/:id',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getVendorPicHandler,
  );
  router.patch(
    '/vendor-pics/:id',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    updateVendorPicHandler,
  );

  return router;
}
