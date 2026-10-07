import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createVendorLicenseHandler,
  listCurrentVendorLicensesHandler,
  listVendorLicensesHandler,
  updateVendorLicenseHandler,
} from './vendor-license.controller';

/**
 * BE-06H — Vendor License / Certification endpoints, protected by BE-01
 * RBAC.
 *
 * Reads (`vendor.read`):
 *   GET /vendors/:vendorId/licenses-certifications
 *   GET /vendors/:vendorId/licenses-certifications/current
 * Management (`vendor.manage`):
 *   POST  /vendors/:vendorId/licenses-certifications
 *   PATCH /vendors/:vendorId/licenses-certifications/:id
 *
 * License/certification records are Vendor-domain data, so they reuse the
 * BE-06A `vendor.*` permissions and are nested under the Vendor — Client
 * isolation is inherited through the Vendor (Record → Vendor → Client).
 *
 * `/current` returns the effective records at request time (stored status
 * ACTIVE and not past expiry), resolved at READ time — there is no renewal
 * automation and no notification scheduler. Deactivation and lifecycle
 * changes travel through the PATCH (which accepts `status`); expired
 * records remain historical rows, never deleted.
 *
 * The static `/current` route is registered before the parameterized
 * PATCH sibling; Express matches GET vs PATCH by method, and `/current`
 * never collides with `:id` because ids must be UUIDs.
 */
export function createVendorLicenseRouter(): Router {
  const router = Router();

  router.post(
    '/vendors/:vendorId/licenses-certifications',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    createVendorLicenseHandler,
  );
  router.get(
    '/vendors/:vendorId/licenses-certifications',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listVendorLicensesHandler,
  );
  router.get(
    '/vendors/:vendorId/licenses-certifications/current',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listCurrentVendorLicensesHandler,
  );
  router.patch(
    '/vendors/:vendorId/licenses-certifications/:id',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    updateVendorLicenseHandler,
  );

  return router;
}
