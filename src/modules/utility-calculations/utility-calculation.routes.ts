import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  calculateUtilityValueHandler,
  createUtilityCalculationBasisHandler,
  finalizeUtilityCalculationHandler,
  getUtilityCalculationHandler,
  listBuildingCalculationsHandler,
  listConsumptionCalculationsHandler,
  listMeterCalculationsHandler,
  listTenantCalculationsHandler,
  listUtilityCalculationBasesHandler,
  recalculateUtilityValueHandler,
} from './utility-calculation.controller';

/**
 * BE-18I — Utility Calculation endpoints.
 *
 * Reads (`utility_meter.read`):
 *   GET  /utility/calculations/:id
 *   GET  /utility/consumptions/:id/calculations   — full history, newest first
 *   GET  /utility/meters/:id/calculations
 *   GET  /buildings/:buildingId/utility-calculations
 *   GET  /tenant-companies/:tenantCompanyId/utility-calculations
 *   GET  /clients/:clientId/utility-calculation-bases
 * Management (`utility_meter.manage`):
 *   POST /utility/consumptions/:id/calculations
 *   POST /utility/calculations/:id/recalculate
 *   POST /utility/calculations/:id/finalize
 *   POST /clients/:clientId/utility-calculation-bases
 *
 * List routes accept ?meterId, ?tenantCompanyId, ?buildingId, ?status,
 * ?utilityType, ?from, ?to, ?limit.
 *
 * There is deliberately NO update and NO delete route. A result is never
 * edited in place: recalculation supersedes a DRAFT with a new row, and a
 * FINALIZED result is terminal. That keeps the calculation history intact and
 * means a finalized figure can never silently change underneath a reader.
 *
 * The BE-18A `utility_meter.*` permissions are reused deliberately: a
 * calculation is a derived fact about a Meter, not a separate domain, so it
 * must not introduce a parallel permission surface.
 *
 * Building access is asserted in the service against the source Consumption's
 * own Building, so isolation always derives from authoritative records rather
 * than a caller-supplied context.
 */
export function createUtilityCalculationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('utility_meter.manage');
  const read = requirePermission('utility_meter.read');

  // Calculation basis — data-driven rate reference.
  router.post(
    '/clients/:clientId/utility-calculation-bases',
    auth,
    manage,
    createUtilityCalculationBasisHandler,
  );
  router.get(
    '/clients/:clientId/utility-calculation-bases',
    auth,
    read,
    listUtilityCalculationBasesHandler,
  );

  // Calculate from an authoritative consumption, and read its history.
  router.post(
    '/utility/consumptions/:id/calculations',
    auth,
    manage,
    calculateUtilityValueHandler,
  );
  router.get(
    '/utility/consumptions/:id/calculations',
    auth,
    read,
    listConsumptionCalculationsHandler,
  );

  // Action routes are registered before the generic `/:id` read so their
  // literal segments can never be captured as an id.
  router.post(
    '/utility/calculations/:id/recalculate',
    auth,
    manage,
    recalculateUtilityValueHandler,
  );
  router.post(
    '/utility/calculations/:id/finalize',
    auth,
    manage,
    finalizeUtilityCalculationHandler,
  );
  router.get('/utility/calculations/:id', auth, read, getUtilityCalculationHandler);

  router.get(
    '/utility/meters/:id/calculations',
    auth,
    read,
    listMeterCalculationsHandler,
  );
  router.get(
    '/buildings/:buildingId/utility-calculations',
    auth,
    read,
    listBuildingCalculationsHandler,
  );
  router.get(
    '/tenant-companies/:tenantCompanyId/utility-calculations',
    auth,
    read,
    listTenantCalculationsHandler,
  );

  return router;
}
