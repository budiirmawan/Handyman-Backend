import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createUtilityAbnormalityRuleHandler,
  evaluateConsumptionHandler,
  getAbnormalConsumptionHandler,
  linkAbnormalConsumptionFindingHandler,
  listBuildingAbnormalitiesHandler,
  listConsumptionAbnormalitiesHandler,
  listMeterAbnormalitiesHandler,
  listTenantAbnormalitiesHandler,
  listUtilityAbnormalityRulesHandler,
  resolveAbnormalConsumptionHandler,
} from './utility-abnormal-consumption.controller';

/**
 * BE-18J — Abnormal Consumption endpoints.
 *
 * Reads (`utility_meter.read`):
 *   GET  /utility/abnormal-consumptions/:id
 *   GET  /utility/consumptions/:id/abnormal-consumptions
 *   GET  /utility/meters/:id/abnormal-consumptions
 *   GET  /buildings/:buildingId/abnormal-consumptions
 *   GET  /tenant-companies/:tenantCompanyId/abnormal-consumptions
 *   GET  /clients/:clientId/utility-abnormality-rules
 * Management (`utility_meter.manage`):
 *   POST /utility/consumptions/:id/abnormality-evaluations
 *   POST /utility/abnormal-consumptions/:id/resolve
 *   POST /utility/abnormal-consumptions/:id/finding
 *   POST /clients/:clientId/utility-abnormality-rules
 *
 * List routes accept ?meterId, ?tenantCompanyId, ?buildingId, ?status,
 * ?abnormalityType, ?utilityType, ?from, ?to, ?limit.
 *
 * There is deliberately NO route that edits a detected value, and none that
 * touches a Meter Reading, Consumption or Calculation. Detection observes
 * upstream data and writes only its own record; a flag's value is evidence
 * and only its status may move (OPEN → RESOLVED / DISMISSED).
 *
 * Operational follow-up goes through `/finding`, which delegates to BE-09.
 * This module never exposes finding workflow endpoints of its own — status
 * transitions, assignment, review and closure all stay on BE-09's routes,
 * and BE-09 remains the authority for a Finding's available actions.
 *
 * The BE-18A `utility_meter.*` permissions are reused deliberately: an
 * abnormality is a derived fact about a Meter, not a separate domain, so it
 * must not introduce a parallel permission surface.
 *
 * Building access is asserted in the service against the source Consumption's
 * own Building, so isolation always derives from authoritative records rather
 * than a caller-supplied context.
 */
export function createUtilityAbnormalConsumptionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('utility_meter.manage');
  const read = requirePermission('utility_meter.read');

  // Detection rules — configurable thresholds.
  router.post(
    '/clients/:clientId/utility-abnormality-rules',
    auth,
    manage,
    createUtilityAbnormalityRuleHandler,
  );
  router.get(
    '/clients/:clientId/utility-abnormality-rules',
    auth,
    read,
    listUtilityAbnormalityRulesHandler,
  );

  // Evaluate an authoritative consumption, and read what was raised for it.
  router.post(
    '/utility/consumptions/:id/abnormality-evaluations',
    auth,
    manage,
    evaluateConsumptionHandler,
  );
  router.get(
    '/utility/consumptions/:id/abnormal-consumptions',
    auth,
    read,
    listConsumptionAbnormalitiesHandler,
  );

  // Action routes are registered before the generic `/:id` read so their
  // literal segments can never be captured as an id.
  router.post(
    '/utility/abnormal-consumptions/:id/resolve',
    auth,
    manage,
    resolveAbnormalConsumptionHandler,
  );
  router.post(
    '/utility/abnormal-consumptions/:id/finding',
    auth,
    manage,
    linkAbnormalConsumptionFindingHandler,
  );
  router.get(
    '/utility/abnormal-consumptions/:id',
    auth,
    read,
    getAbnormalConsumptionHandler,
  );

  router.get(
    '/utility/meters/:id/abnormal-consumptions',
    auth,
    read,
    listMeterAbnormalitiesHandler,
  );
  router.get(
    '/buildings/:buildingId/abnormal-consumptions',
    auth,
    read,
    listBuildingAbnormalitiesHandler,
  );
  router.get(
    '/tenant-companies/:tenantCompanyId/abnormal-consumptions',
    auth,
    read,
    listTenantAbnormalitiesHandler,
  );

  return router;
}
