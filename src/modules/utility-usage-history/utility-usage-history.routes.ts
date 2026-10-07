import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getBuildingUsageHistoryHandler,
  getLatestMeterUsageHistoryHandler,
  getMeterUsageHistoryHandler,
  getTenantUsageHistoryHandler,
  resolveUsageHistoryHandler,
} from './utility-usage-history.controller';

/**
 * BE-18H — Usage History endpoints.
 *
 * Reads only (`utility_meter.read`):
 *   GET /utility/meters/:id/usage-history
 *   GET /utility/meters/:id/usage-history/latest  → null when never calculated
 *   GET /buildings/:buildingId/usage-history
 *   GET /tenant-companies/:tenantCompanyId/usage-history
 *   GET /utility/usage-history
 *
 * All routes accept ?meterId, ?tenantCompanyId, ?buildingId, ?from, ?to,
 * ?order (ASC default), ?limit.
 *
 * Every route is a GET. Usage History is a projection over authoritative
 * BE-18G consumptions, so there is deliberately no POST, PATCH or DELETE
 * anywhere in this module — history cannot be written, amended or erased
 * through BE-18H, and the append-oriented guarantee stays with BE-18G/BE-18E.
 *
 * The BE-18A `utility_meter.*` permissions are reused deliberately: usage
 * history is a view of Meter data, not a separate domain, so it must not
 * introduce a parallel permission surface.
 *
 * Building access is asserted in the service against authoritative records
 * (the Meter's Building, the Building itself, or the Tenant's Client), never
 * a caller-supplied context.
 */
export function createUtilityUsageHistoryRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('utility_meter.read');

  // `/latest` is registered before the generic history route so the literal
  // segment can never be captured as a filter value.
  router.get(
    '/utility/meters/:id/usage-history/latest',
    auth,
    read,
    getLatestMeterUsageHistoryHandler,
  );
  router.get(
    '/utility/meters/:id/usage-history',
    auth,
    read,
    getMeterUsageHistoryHandler,
  );

  router.get(
    '/buildings/:buildingId/usage-history',
    auth,
    read,
    getBuildingUsageHistoryHandler,
  );
  router.get(
    '/tenant-companies/:tenantCompanyId/usage-history',
    auth,
    read,
    getTenantUsageHistoryHandler,
  );

  router.get('/utility/usage-history', auth, read, resolveUsageHistoryHandler);

  return router;
}
