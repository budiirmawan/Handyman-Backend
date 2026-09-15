import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createHandymanProviderHandler,
  getHandymanProviderHandler,
  listBuildingHandymanProviderServiceEligibilitiesHandler,
  listBuildingHandymanProvidersHandler,
  listClientHandymanProvidersHandler,
  updateHandymanProviderStatusHandler,
} from './handyman-provider.controller';

/**
 * CR-HM-BE-02 RUN 3 — Handyman Provider HTTP contract, registered through
 * the existing Asentra route composition (no separate server/runtime). Every
 * route requires an authenticated session; RBAC then gates per route:
 *
 * - `handyman_provider.manage` → designation create + status transition
 * - `handyman_provider.read`   → designation and eligibility reads
 *
 * Client access on designation routes and building access/enablement
 * (fail-closed) on building reads remain service-authoritative (Run 1/Run 2).
 */
export function createHandymanProviderRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('handyman_provider.read');

  router.post(
    '/clients/:clientId/handyman-providers',
    auth,
    requirePermission('handyman_provider.manage'),
    createHandymanProviderHandler,
  );
  router.get(
    '/clients/:clientId/handyman-providers',
    auth,
    read,
    listClientHandymanProvidersHandler,
  );
  router.get(
    '/handyman-providers/:providerId',
    auth,
    read,
    getHandymanProviderHandler,
  );
  router.patch(
    '/handyman-providers/:providerId',
    auth,
    requirePermission('handyman_provider.manage'),
    updateHandymanProviderStatusHandler,
  );
  router.get(
    '/buildings/:buildingId/handyman-providers',
    auth,
    read,
    listBuildingHandymanProvidersHandler,
  );
  router.get(
    '/buildings/:buildingId/handyman-providers/:providerId/service-eligibilities',
    auth,
    read,
    listBuildingHandymanProviderServiceEligibilitiesHandler,
  );

  return router;
}
