import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createUtilityMeterHandler,
  getUtilityMeterHandler,
  listBuildingUtilityMetersHandler,
  listClientUtilityMetersHandler,
  updateUtilityMeterHandler,
  updateUtilityMeterStatusHandler,
} from './utility-meter.controller';

/**
 * BE-18A — Meter Master endpoints, protected by BE-01 RBAC (default-deny) and
 * BE-02 Client / Building isolation.
 *
 * Reads (`utility_meter.read`):
 *   GET   /buildings/:buildingId/utility-meters
 *   GET   /clients/:clientId/utility-meters   (?buildingId=)
 *   GET   /utility/meters/:id
 * Management (`utility_meter.manage`):
 *   POST  /buildings/:buildingId/utility-meters
 *   PATCH /utility/meters/:id
 *   PATCH /utility/meters/:id/status
 *
 * All list endpoints accept ?status= &utilityType= &uomId= &spaceId=
 * &functionalLocationId= &search=.
 *
 * The `utility/*` namespace is deliberately distinct from BE-10C's
 * `engineering/meter-reading-*` operational surface: BE-18A owns the Meter
 * master, BE-10C keeps the engineering reading workflow.
 *
 * Building-scoped routes additionally pass through `requireBuildingAccess`;
 * `/utility/meters/:id` resolves its Building from the record and asserts
 * access in the service (the id itself is not a Building context).
 */
export function createUtilityMeterRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('utility_meter.manage');
  const read = requirePermission('utility_meter.read');

  router.post(
    '/buildings/:buildingId/utility-meters',
    auth,
    manage,
    requireBuildingAccess('buildingId'),
    createUtilityMeterHandler,
  );
  router.get(
    '/buildings/:buildingId/utility-meters',
    auth,
    read,
    requireBuildingAccess('buildingId'),
    listBuildingUtilityMetersHandler,
  );
  router.get(
    '/clients/:clientId/utility-meters',
    auth,
    read,
    listClientUtilityMetersHandler,
  );
  router.get('/utility/meters/:id', auth, read, getUtilityMeterHandler);
  router.patch('/utility/meters/:id', auth, manage, updateUtilityMeterHandler);
  router.patch(
    '/utility/meters/:id/status',
    auth,
    manage,
    updateUtilityMeterStatusHandler,
  );

  return router;
}
