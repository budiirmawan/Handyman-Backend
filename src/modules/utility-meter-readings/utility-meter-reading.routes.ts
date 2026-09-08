import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getLatestMeterReadingHandler,
  getUtilityMeterReadingHandler,
  listBuildingMeterReadingsHandler,
  listMeterReadingsHandler,
  listTenantMeterReadingsHandler,
  recordUtilityMeterReadingHandler,
} from './utility-meter-reading.controller';

/**
 * BE-18E — Meter Reading endpoints.
 *
 * Reads (`utility_meter.read`):
 *   GET  /utility/meters/:id/readings         — chronological history
 *   GET  /utility/meters/:id/readings/latest  → null when never read
 *   GET  /buildings/:buildingId/meter-readings
 *   GET  /tenant-companies/:tenantCompanyId/meter-readings
 *   GET  /utility/meter-readings/:id
 * Management (`utility_meter.manage`):
 *   POST /utility/meters/:id/readings
 *
 * All list routes accept ?meterId, ?tenantCompanyId, ?source, ?readingType,
 * ?from, ?to, ?limit.
 *
 * The BE-18A `utility_meter.*` permissions are reused deliberately: a reading
 * is a fact about a Meter, not a separate domain, so it must not introduce a
 * parallel permission surface. There is deliberately NO update and NO delete
 * route — readings are append-only, so a posted reading cannot be silently
 * overwritten or removed, and a correction is recorded as a new reading.
 *
 * Building access is asserted in the service against the Meter's own
 * Building, so isolation always derives from authoritative records rather
 * than a caller-supplied context.
 */
export function createUtilityMeterReadingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('utility_meter.manage');
  const read = requirePermission('utility_meter.read');

  router.post(
    '/utility/meters/:id/readings',
    auth,
    manage,
    recordUtilityMeterReadingHandler,
  );
  // `/latest` is registered before the generic history route so the literal
  // segment can never be captured as a filter value.
  router.get(
    '/utility/meters/:id/readings/latest',
    auth,
    read,
    getLatestMeterReadingHandler,
  );
  router.get('/utility/meters/:id/readings', auth, read, listMeterReadingsHandler);

  router.get(
    '/buildings/:buildingId/meter-readings',
    auth,
    read,
    listBuildingMeterReadingsHandler,
  );
  router.get(
    '/tenant-companies/:tenantCompanyId/meter-readings',
    auth,
    read,
    listTenantMeterReadingsHandler,
  );

  router.get(
    '/utility/meter-readings/:id',
    auth,
    read,
    getUtilityMeterReadingHandler,
  );

  return router;
}
