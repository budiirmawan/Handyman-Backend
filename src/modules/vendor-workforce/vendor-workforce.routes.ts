import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createVendorWorkforceBindingHandler,
  listVendorWorkforceHandler,
  listWorkforceVendorBindingsHandler,
  updateVendorWorkforceBindingHandler,
} from './vendor-workforce.controller';

/**
 * BE-06F — Vendor Workforce Binding endpoints, protected by BE-01 RBAC.
 *
 * Vendor-nested routes reuse the BE-06A vendor permissions; the
 * workforce-nested read reuses the BE-03C workforce permission, matching
 * whose data each route primarily exposes:
 *   `vendor.manage`  → POST  /vendors/:vendorId/workforce
 *                      PATCH /vendors/:vendorId/workforce/:workforceId
 *   `vendor.read`    → GET   /vendors/:vendorId/workforce
 *   `workforce.read` → GET   /workforce/:workforceId/vendor-bindings
 *
 * Binding workforce to a Vendor grants NOTHING else: no User, Credential,
 * Role, Permission, User Building Access, Workforce Building Assignment,
 * Shift, Skill, or Supervisor is created or modified by these endpoints.
 *
 * Deactivation is a PATCH with `{ "status": "INACTIVE" }`, not a DELETE, so
 * the binding history survives.
 */
export function createVendorWorkforceRouter(): Router {
  const router = Router();

  router.post(
    '/vendors/:vendorId/workforce',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    createVendorWorkforceBindingHandler,
  );
  router.get(
    '/vendors/:vendorId/workforce',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listVendorWorkforceHandler,
  );
  router.get(
    '/workforce/:workforceId/vendor-bindings',
    authenticationMiddleware,
    requirePermission('workforce.read'),
    listWorkforceVendorBindingsHandler,
  );
  router.patch(
    '/vendors/:vendorId/workforce/:workforceId',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    updateVendorWorkforceBindingHandler,
  );

  return router;
}
