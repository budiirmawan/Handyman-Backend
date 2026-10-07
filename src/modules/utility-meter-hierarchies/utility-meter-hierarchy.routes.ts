import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  bindSubMeterHandler,
  endUtilityMeterHierarchyHandler,
  getUtilityMeterHierarchyHandler,
  listSubMeterHistoryHandler,
  listSubMetersHandler,
  resolveMainMeterHandler,
  updateUtilityMeterHierarchyHandler,
} from './utility-meter-hierarchy.controller';

/**
 * BE-18C — Main / Sub Meter hierarchy endpoints.
 *
 * Reads (`utility_meter.read`):
 *   GET   /utility/meters/:id/sub-meters          (?status=)
 *   GET   /utility/meters/:id/main-meter          → null when top level
 *   GET   /utility/meters/:id/main-meter-history  (?status=)
 *   GET   /utility/meter-hierarchies/:id
 * Management (`utility_meter.manage`):
 *   POST  /utility/meters/:id/sub-meters
 *   PATCH /utility/meter-hierarchies/:id
 *   PATCH /utility/meter-hierarchies/:id/end
 *
 * The BE-18A `utility_meter.*` permissions are reused deliberately: the
 * hierarchy is Meter master data, not a separate domain, so it must not
 * introduce a parallel permission surface.
 *
 * Building access is asserted in the service against the Meters themselves
 * (the path id is a Meter or a relationship, not a Building context), so
 * every route resolves isolation from authoritative BE-18A records.
 */
export function createUtilityMeterHierarchyRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('utility_meter.manage');
  const read = requirePermission('utility_meter.read');

  router.post('/utility/meters/:id/sub-meters', auth, manage, bindSubMeterHandler);
  router.get('/utility/meters/:id/sub-meters', auth, read, listSubMetersHandler);
  router.get('/utility/meters/:id/main-meter', auth, read, resolveMainMeterHandler);
  router.get(
    '/utility/meters/:id/main-meter-history',
    auth,
    read,
    listSubMeterHistoryHandler,
  );

  router.get(
    '/utility/meter-hierarchies/:id',
    auth,
    read,
    getUtilityMeterHierarchyHandler,
  );
  router.patch(
    '/utility/meter-hierarchies/:id',
    auth,
    manage,
    updateUtilityMeterHierarchyHandler,
  );
  router.patch(
    '/utility/meter-hierarchies/:id/end',
    auth,
    manage,
    endUtilityMeterHierarchyHandler,
  );

  return router;
}
