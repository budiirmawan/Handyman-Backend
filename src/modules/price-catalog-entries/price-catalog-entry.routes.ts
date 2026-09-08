import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  activatePriceCatalogEntryHandler,
  correctPriceCatalogEntryHandler,
  createPriceCatalogEntryHandler,
  deactivatePriceCatalogEntryHandler,
  getPriceCatalogEntryHandler,
  listPriceCatalogEntriesHandler,
  lookupPriceCatalogHandler,
  replacePriceCatalogEntryHandler,
  updatePriceCatalogEntryHandler,
} from './price-catalog-entry.controller';

/**
 * CR-BE-PRICE-01 PART 01+02+05 — Price Authority Foundation, Material
 * Price/UOM/Scope Selection, and the governed Override/Corrective lane.
 *
 * Internal-only surface (governance §20): reference prices are never exposed
 * to RFQ Vendor sessions. `/correct` is the sole route fenced by
 * `price_catalog.override` — steward (`.manage`) and reader (`.read`)
 * permissions never imply it (§14). This surface intentionally stops before
 * OpenAPI documentation (PART 06).
 */
export function createPriceCatalogEntryRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('price_catalog.read');
  const manage = requirePermission('price_catalog.manage');
  const override = requirePermission('price_catalog.override');

  // PART 02 — deterministic §8 resolver probe (`price_catalog.read` covers
  // lookup; no additional permission is introduced).
  router.get('/price-catalog/lookup', auth, read, lookupPriceCatalogHandler);

  router.post('/price-catalog/entries', auth, manage, createPriceCatalogEntryHandler);
  router.get('/price-catalog/entries', auth, read, listPriceCatalogEntriesHandler);
  router.get('/price-catalog/entries/:id', auth, read, getPriceCatalogEntryHandler);
  router.patch('/price-catalog/entries/:id', auth, manage, updatePriceCatalogEntryHandler);
  router.post('/price-catalog/entries/:id/activate', auth, manage, activatePriceCatalogEntryHandler);
  router.post('/price-catalog/entries/:id/replace', auth, manage, replacePriceCatalogEntryHandler);
  // PART 05 — retroactive correction of an already-entered ACTIVE window:
  // exceptional authority, mandatory reason, dedicated audit event (§11/§14).
  router.post('/price-catalog/entries/:id/correct', auth, override, correctPriceCatalogEntryHandler);
  router.post('/price-catalog/entries/:id/deactivate', auth, manage, deactivatePriceCatalogEntryHandler);

  return router;
}
