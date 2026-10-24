import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getHandymanArrivalLocationIdentifiersHandler,
  getHandymanBuildingGeofencePolicyHandler,
  getHandymanBuildingGeofencePolicyHistoryHandler,
  postHandymanArrivalLocationIdentifierDeactivateHandler,
  postHandymanArrivalLocationIdentifierHandler,
  putHandymanBuildingGeofencePolicyHandler,
} from './handyman-arrival-configuration.controller';

/**
 * CR-HM-FIELD-OPERATIONS-01 PART 04 — the six CR Owner approved configuration
 * operations (gate §8: SG-1 approved, SG-2 OPTION A, SG-6 proceed):
 *
 *   POST /handyman/buildings/:buildingId/arrival-location-identifiers
 *   GET  /handyman/buildings/:buildingId/arrival-location-identifiers
 *   POST /handyman/buildings/:buildingId/arrival-location-identifiers/:identifierId/deactivate
 *   PUT  /handyman/buildings/:buildingId/geofence-policy
 *   GET  /handyman/buildings/:buildingId/geofence-policy
 *   GET  /handyman/buildings/:buildingId/geofence-policy/history
 *
 * TWO-LAYER AUTHORITY (AC-1) — both layers are required:
 *   1. existing RBAC: `building_configuration.manage` for writes and
 *      `building_configuration.read` for reads (SG-2 Option A: no new
 *      permission code, no new role, no seed change);
 *   2. the service-level BE-02G exact-Building guard, which is what stops a
 *      same-Client SIBLING-Building manager. RBAC alone is intentionally not
 *      sufficient and is never treated as scope.
 *
 * SEPARATION OF AUTHORITY (AC-3): field personas (Crew Lead, Inspector,
 * helper, Tenant PIC) hold no configuration permission, so no actor can
 * configure the evidence that verifies its own arrival. Configuration is an
 * operations/administration act only, and it never produces a verdict,
 * consumes a challenge or starts work (AC-10).
 */
export function createHandymanArrivalConfigurationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('building_configuration.read');
  const manage = requirePermission('building_configuration.manage');

  // G-2 — arrival QR registry.
  router.post(
    '/handyman/buildings/:buildingId/arrival-location-identifiers',
    auth,
    manage,
    postHandymanArrivalLocationIdentifierHandler,
  );
  router.get(
    '/handyman/buildings/:buildingId/arrival-location-identifiers',
    auth,
    read,
    getHandymanArrivalLocationIdentifiersHandler,
  );
  router.post(
    '/handyman/buildings/:buildingId/arrival-location-identifiers/'
      + ':identifierId/deactivate',
    auth,
    manage,
    postHandymanArrivalLocationIdentifierDeactivateHandler,
  );

  // G-3 — per-Building geofence policy.
  router.put(
    '/handyman/buildings/:buildingId/geofence-policy',
    auth,
    manage,
    putHandymanBuildingGeofencePolicyHandler,
  );
  // Registered before the bare path for readability only; Express matches
  // exact paths so both remain distinct.
  router.get(
    '/handyman/buildings/:buildingId/geofence-policy/history',
    auth,
    read,
    getHandymanBuildingGeofencePolicyHistoryHandler,
  );
  router.get(
    '/handyman/buildings/:buildingId/geofence-policy',
    auth,
    read,
    getHandymanBuildingGeofencePolicyHandler,
  );

  return router;
}
