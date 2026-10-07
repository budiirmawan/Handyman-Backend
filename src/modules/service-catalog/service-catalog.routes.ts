import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createServiceCatalogEntryHandler,
  deactivateServiceCatalogEntryHandler,
  getServiceCatalogEntryHandler,
  listServiceCatalogEntriesHandler,
  updateServiceCatalogEntryHandler,
} from './service-catalog.controller';

/**
 * CR-BE-SVC-01 PART 01 — Service Catalog Foundation endpoints, protected by
 * BE-01 RBAC and BE-02 Client isolation.
 *
 * Reads (`service_catalog.read`):
 *   GET /service-catalog/entries          (?clientId= & ?status= & ?category= & ?search=)
 *   GET /service-catalog/entries/:id
 * Management (`service_catalog.manage`):
 *   POST   /service-catalog/entries
 *   PATCH  /service-catalog/entries/:id     (name / description / category only)
 *   POST   /service-catalog/entries/:id/deactivate
 *
 * Client isolation is enforced in the service via `contextAccessService`
 * (catalog entries are Client-scoped; a user reaches a Client through their
 * building assignments). `code` is unique per Client and immutable once
 * created (governance §5/§11).
 *
 * This surface intentionally stops before OpenAPI documentation (PART 06). No
 * Service Request integration, RFQ/quotation/PO linkage, or SERVICE pricing is
 * introduced here — PART 01 is identity only.
 */
export function createServiceCatalogRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('service_catalog.read');
  const manage = requirePermission('service_catalog.manage');

  router.post('/service-catalog/entries', auth, manage, createServiceCatalogEntryHandler);
  router.get('/service-catalog/entries', auth, read, listServiceCatalogEntriesHandler);
  router.get('/service-catalog/entries/:id', auth, read, getServiceCatalogEntryHandler);
  router.patch('/service-catalog/entries/:id', auth, manage, updateServiceCatalogEntryHandler);
  router.post(
    '/service-catalog/entries/:id/deactivate',
    auth,
    manage,
    deactivateServiceCatalogEntryHandler,
  );

  return router;
}
