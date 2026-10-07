import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createVendorCapabilityHandler,
  getVendorCapabilityHandler,
  listVendorCapabilitiesHandler,
  updateVendorCapabilityHandler,
} from './vendor-capability.controller';

/**
 * BE-06E — Vendor Service Scope & Capability endpoints, protected by
 * BE-01 RBAC.
 *
 * Reads (`vendor.read`):        GET   /vendors/:vendorId/capabilities
 *                               GET   /vendor-capabilities/:id
 * Management (`vendor.manage`): POST  /vendors/:vendorId/capabilities
 *                               PATCH /vendor-capabilities/:id
 *
 * Capabilities are catalog data of the Vendor domain, so they reuse the
 * BE-06A `vendor.*` permissions. Writes and Vendor-scoped reads are nested
 * under the Vendor, so the owning Vendor is always taken from the URL —
 * Client isolation is inherited through the Vendor (Capability → Vendor →
 * Client), and Building scope is inherited through the referenced BE-06D
 * relationship rather than duplicated.
 *
 * Deactivation travels through the general `PATCH /vendor-capabilities/:id`
 * (which accepts `status`); no capability row is ever deleted.
 */
export function createVendorCapabilityRouter(): Router {
  const router = Router();

  router.post(
    '/vendors/:vendorId/capabilities',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    createVendorCapabilityHandler,
  );
  router.get(
    '/vendors/:vendorId/capabilities',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listVendorCapabilitiesHandler,
  );
  router.get(
    '/vendor-capabilities/:id',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getVendorCapabilityHandler,
  );
  router.patch(
    '/vendor-capabilities/:id',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    updateVendorCapabilityHandler,
  );

  return router;
}
