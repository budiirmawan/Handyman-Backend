import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createServiceCategoryHandler,
  deactivateServiceCategoryHandler,
  deactivateServiceAvailabilityHandler,
  getServiceCategoryHandler,
  getServiceCatalogReadModelHandler,
  grantServiceAvailabilityHandler,
  importStarterPackHandler,
  linkServiceCategoryHandler,
  listServiceAvailabilityHandler,
  listServiceCategoriesHandler,
  updateServiceCategoryHandler,
} from './service-catalog-master.controller';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — Service Catalog Starter endpoints.
 *
 * Two-level Service Catalog (Service Category → Service Item), Client/Building
 * availability grants and the governed starter-pack import. Reuses the
 * existing `service_catalog.read` / `service_catalog.manage` RBAC fences and
 * the existing Client/Building isolation rule (`contextAccessService`).
 *
 * Reads (`service_catalog.read`):
 *   GET  /service-catalog/catalog
 *   GET  /service-catalog/service-categories
 *   GET  /service-catalog/service-categories/:id
 *   GET  /service-catalog/entries/:serviceCatalogId/availability
 * Management (`service_catalog.manage`):
 *   POST  /service-catalog/service-categories
 *   PATCH /service-catalog/service-categories/:id
 *   POST  /service-catalog/service-categories/:id/deactivate
 *   POST  /service-catalog/entries/:serviceCatalogId/category
 *   POST  /service-catalog/entries/:serviceCatalogId/availability
 *   POST  /service-catalog/entries/:serviceCatalogId/availability/:availabilityId/deactivate
 *   POST  /service-catalog/starter-pack/import   (Idempotency-Key required)
 *
 * Pricing is NOT a field here: the governed reference price remains the
 * existing `price_catalog_entries` SERVICE authority and is composed at read
 * time (null when no governed price resolves — never guessed).
 */
export function createServiceCatalogMasterRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('service_catalog.read');
  const manage = requirePermission('service_catalog.manage');

  router.get(
    '/service-catalog/catalog',
    auth,
    read,
    getServiceCatalogReadModelHandler,
  );

  router.get(
    '/service-catalog/service-categories',
    auth,
    read,
    listServiceCategoriesHandler,
  );
  router.post(
    '/service-catalog/service-categories',
    auth,
    manage,
    createServiceCategoryHandler,
  );
  router.get(
    '/service-catalog/service-categories/:id',
    auth,
    read,
    getServiceCategoryHandler,
  );
  router.patch(
    '/service-catalog/service-categories/:id',
    auth,
    manage,
    updateServiceCategoryHandler,
  );
  router.post(
    '/service-catalog/service-categories/:id/deactivate',
    auth,
    manage,
    deactivateServiceCategoryHandler,
  );

  router.get(
    '/service-catalog/entries/:serviceCatalogId/availability',
    auth,
    read,
    listServiceAvailabilityHandler,
  );
  router.post(
    '/service-catalog/entries/:serviceCatalogId/availability',
    auth,
    manage,
    grantServiceAvailabilityHandler,
  );
  router.post(
    '/service-catalog/entries/:serviceCatalogId/availability/:availabilityId/deactivate',
    auth,
    manage,
    deactivateServiceAvailabilityHandler,
  );
  router.post(
    '/service-catalog/entries/:serviceCatalogId/category',
    auth,
    manage,
    linkServiceCategoryHandler,
  );

  router.post(
    '/service-catalog/starter-pack/import',
    auth,
    manage,
    importStarterPackHandler,
  );

  return router;
}
