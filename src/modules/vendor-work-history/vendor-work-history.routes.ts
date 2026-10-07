import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getVendorWorkHistoryHandler } from './vendor-work-history.controller';

/**
 * BE-15K — Vendor Work History endpoint, protected by BE-01 RBAC and BE-02
 * Building isolation (enforced in the controller after resolving the Vendor
 * Work's Building). Reuses the BE-07 operational-events binding.
 *
 * Reads (`vendor.read`):
 *   GET /vendor-works/:id/history  (?eventType= & ?from= & ?to=)
 *
 * History is read-only — no event-creation endpoint is exposed.
 */
export function createVendorWorkHistoryRouter(): Router {
  const router = Router();

  router.get(
    '/vendor-works/:id/history',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getVendorWorkHistoryHandler,
  );

  return router;
}
