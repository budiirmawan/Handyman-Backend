import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePlatformPermission } from '../platform-iam';
import {
  createSaasPackageHandler,
  createSaasProductHandler,
  getSaasPackageHandler,
  getSaasProductHandler,
  listSaasPackagesHandler,
  listSaasProductsHandler,
  updateSaasPackageHandler,
  updateSaasProductHandler,
} from './platform-product.controller';

/**
 * CR-BE-SAAS-01 PART 02 — SaaS Product & Package catalog endpoints
 * (SaaS Control Plane, frozen contract §22 catalog subset).
 *
 * Reads (`platform.product.read`):
 *   GET /platform/products            (list)
 *   GET /platform/products/:id        (includes packages)
 *   GET /platform/packages            (list)
 *   GET /platform/packages/:id        (includes features + limits)
 * Management (`platform.product.manage`):
 *   POST /platform/products
 *   PATCH /platform/products/:id
 *   POST /platform/packages           (features[] & limits[] nested)
 *   PATCH /platform/packages/:id
 *
 * No Idempotency-Key / expectedVersion: these commands are not in the
 * frozen §17.2 idempotency catalog and the catalog tables are not §17.3
 * OCC aggregates. The add-on surface (§22) is intentionally NOT
 * registered here — it belongs to a later PART.
 *
 * Plane boundary: default deny via requirePlatformPermission; NO
 * building/organization scoping (platform authority is cross-customer by
 * explicit grant, frozen §3). The business-plane /modules surface is
 * untouched and keeps its own permissions.
 */
export function createPlatformProductRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.get(
    '/platform/products',
    auth,
    requirePlatformPermission('platform.product.read'),
    listSaasProductsHandler,
  );
  router.get(
    '/platform/products/:id',
    auth,
    requirePlatformPermission('platform.product.read'),
    getSaasProductHandler,
  );
  router.post(
    '/platform/products',
    auth,
    requirePlatformPermission('platform.product.manage'),
    createSaasProductHandler,
  );
  router.patch(
    '/platform/products/:id',
    auth,
    requirePlatformPermission('platform.product.manage'),
    updateSaasProductHandler,
  );

  router.get(
    '/platform/packages',
    auth,
    requirePlatformPermission('platform.product.read'),
    listSaasPackagesHandler,
  );
  router.get(
    '/platform/packages/:id',
    auth,
    requirePlatformPermission('platform.product.read'),
    getSaasPackageHandler,
  );
  router.post(
    '/platform/packages',
    auth,
    requirePlatformPermission('platform.product.manage'),
    createSaasPackageHandler,
  );
  router.patch(
    '/platform/packages/:id',
    auth,
    requirePlatformPermission('platform.product.manage'),
    updateSaasPackageHandler,
  );

  return router;
}
