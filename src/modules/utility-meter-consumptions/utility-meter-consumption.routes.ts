import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  calculateUtilityMeterConsumptionHandler,
  getLatestMeterConsumptionHandler,
  getUtilityMeterConsumptionHandler,
  listBuildingConsumptionsHandler,
  listMeterConsumptionsHandler,
  listTenantConsumptionsHandler,
} from './utility-meter-consumption.controller';

/**
 * BE-18G — Consumption endpoints.
 *
 * Reads (`utility_meter.read`):
 *   GET  /utility/meters/:id/consumptions          — calculation history
 *   GET  /utility/meters/:id/consumptions/latest   → null when never calculated
 *   GET  /buildings/:buildingId/meter-consumptions
 *   GET  /tenant-companies/:tenantCompanyId/meter-consumptions
 *   GET  /utility/meter-consumptions/:id
 * Management (`utility_meter.manage`):
 *   POST /utility/meters/:id/consumptions
 *
 * All list routes accept ?meterId, ?tenantCompanyId, ?from, ?to, ?limit.
 *
 * The BE-18A `utility_meter.*` permissions are reused deliberately: a
 * consumption is a derived fact about a Meter, not a separate domain, so it
 * must not introduce a parallel permission surface.
 *
 * There is deliberately NO update and NO delete route — calculation history
 * is append-only. A correction is a new calculation from corrected readings.
 *
 * Building access is asserted in the service against the Meter's own
 * Building, so isolation always derives from authoritative records rather
 * than a caller-supplied context.
 */
export function createUtilityMeterConsumptionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('utility_meter.manage');
  const read = requirePermission('utility_meter.read');

  router.post(
    '/utility/meters/:id/consumptions',
    auth,
    manage,
    calculateUtilityMeterConsumptionHandler,
  );
  // `/latest` is registered before the generic history route so the literal
  // segment can never be captured as a filter value.
  router.get(
    '/utility/meters/:id/consumptions/latest',
    auth,
    read,
    getLatestMeterConsumptionHandler,
  );
  router.get(
    '/utility/meters/:id/consumptions',
    auth,
    read,
    listMeterConsumptionsHandler,
  );

  router.get(
    '/buildings/:buildingId/meter-consumptions',
    auth,
    read,
    listBuildingConsumptionsHandler,
  );
  router.get(
    '/tenant-companies/:tenantCompanyId/meter-consumptions',
    auth,
    read,
    listTenantConsumptionsHandler,
  );

  router.get(
    '/utility/meter-consumptions/:id',
    auth,
    read,
    getUtilityMeterConsumptionHandler,
  );

  return router;
}
