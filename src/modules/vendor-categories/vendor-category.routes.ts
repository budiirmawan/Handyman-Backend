import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createVendorCategoryHandler,
  getVendorCategoryHandler,
  listClientVendorCategoriesHandler,
  updateVendorCategoryHandler,
} from './vendor-category.controller';

/**
 * BE-06B — Vendor Category endpoints, protected by BE-01 RBAC.
 *
 * Reads (`vendor.read`):        GET   /clients/:clientId/vendor-categories
 *                               GET   /vendor-categories/:id
 * Management (`vendor.manage`): POST  /clients/:clientId/vendor-categories
 *                               PATCH /vendor-categories/:id
 *
 * Vendor Categories are Client-scoped reference data for the Vendor domain,
 * so they reuse the BE-06A `vendor.*` permissions and follow the BE-04E Room
 * Type route convention: writes and Client-scoped reads are nested under the
 * Client (BE-02 isolation). Cross-Client enforcement happens where the
 * reference is USED: classifying a Vendor (PATCH /vendors/:id) rejects any
 * Category of a different Client.
 *
 * Status lifecycle (ACTIVE/INACTIVE) travels through the general
 * `PATCH /vendor-categories/:id` (which accepts `status`);
 * `updateVendorCategoryStatus` also exists at the service level.
 */
export function createVendorCategoryRouter(): Router {
  const router = Router();

  router.post(
    '/clients/:clientId/vendor-categories',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    createVendorCategoryHandler,
  );
  router.get(
    '/clients/:clientId/vendor-categories',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listClientVendorCategoriesHandler,
  );
  router.get(
    '/vendor-categories/:id',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getVendorCategoryHandler,
  );
  router.patch(
    '/vendor-categories/:id',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    updateVendorCategoryHandler,
  );

  return router;
}
