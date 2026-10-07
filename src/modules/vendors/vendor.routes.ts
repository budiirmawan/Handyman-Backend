import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createVendorHandler,
  getVendorHandler,
  listClientVendorsHandler,
  updateVendorHandler,
} from './vendor.controller';

/**
 * BE-06A — Vendor Registry endpoints, protected by BE-01 RBAC.
 *
 * Reads (`vendor.read`):       GET   /clients/:clientId/vendors
 *                              GET   /vendors/:id
 * Management (`vendor.manage`): POST  /clients/:clientId/vendors
 *                               PATCH /vendors/:id
 *
 * Vendors are Client-scoped master data, so routes follow the BE-04E Room
 * Type convention: writes and Client-scoped reads are nested under the
 * Client, so the owning Client is always taken from the URL (BE-02
 * isolation).
 *
 * Status lifecycle (ACTIVE/INACTIVE) travels through the general
 * `PATCH /vendors/:id` (which accepts `status`); `updateVendorStatus` also
 * exists at the service level for later PARTs.
 */
export function createVendorRouter(): Router {
  const router = Router();

  router.post(
    '/clients/:clientId/vendors',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    createVendorHandler,
  );
  router.get(
    '/clients/:clientId/vendors',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listClientVendorsHandler,
  );
  router.get(
    '/vendors/:id',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getVendorHandler,
  );
  router.patch(
    '/vendors/:id',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    updateVendorHandler,
  );

  return router;
}
