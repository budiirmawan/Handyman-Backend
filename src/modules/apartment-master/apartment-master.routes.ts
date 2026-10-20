import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignUnitPartyRoleHandler,
  endUnitPartyRoleHandler,
  getApartmentUnitHandler,
  listApartmentUnitOccupanciesHandler,
  listApartmentUnitsHandler,
  listUnitPartyRolesHandler,
  updateApartmentUnitHandler,
} from './apartment-master.controller';

/**
 * CR-HM-MASTER-IND-01 — Indonesian apartment master administration.
 *
 * Every route is Building-scoped: the Client is DERIVED from
 * Building → Property on the server and the caller must hold an ACTIVE
 * assignment to the exact Building (BE-02 isolation, unchanged). A Unit is the
 * existing Space master, so Unit reads/writes reuse the existing
 * `space.read` / `space.manage` capabilities; only the new Owner/Occupant/PIC
 * authority gets dedicated capabilities (`unit_party.read` / `.manage`).
 * Occupancy history reuses `tenant_company.read` because tenancy remains the
 * BE-14C authority.
 *
 *   GET    /buildings/{buildingId}/units                     space.read
 *   GET    /buildings/{buildingId}/units/{unitId}            space.read
 *   PATCH  /buildings/{buildingId}/units/{unitId}            space.manage
 *   GET    /buildings/{buildingId}/units/{unitId}/occupancies tenant_company.read
 *   GET    /buildings/{buildingId}/units/{unitId}/parties    unit_party.read
 *   POST   /buildings/{buildingId}/units/{unitId}/parties    unit_party.manage
 *   POST   /unit-party-roles/{id}/end                        unit_party.manage
 *
 * Lists are paginated with the shared `page`/`pageSize` contract and expose
 * `meta.page/pageSize/total/totalPages`.
 */
export function createApartmentMasterRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.get(
    '/buildings/:buildingId/units',
    auth,
    requirePermission('space.read'),
    listApartmentUnitsHandler,
  );
  router.get(
    '/buildings/:buildingId/units/:unitId',
    auth,
    requirePermission('space.read'),
    getApartmentUnitHandler,
  );
  router.patch(
    '/buildings/:buildingId/units/:unitId',
    auth,
    requirePermission('space.manage'),
    updateApartmentUnitHandler,
  );
  router.get(
    '/buildings/:buildingId/units/:unitId/occupancies',
    auth,
    requirePermission('tenant_company.read'),
    listApartmentUnitOccupanciesHandler,
  );
  router.get(
    '/buildings/:buildingId/units/:unitId/parties',
    auth,
    requirePermission('unit_party.read'),
    listUnitPartyRolesHandler,
  );
  router.post(
    '/buildings/:buildingId/units/:unitId/parties',
    auth,
    requirePermission('unit_party.manage'),
    assignUnitPartyRoleHandler,
  );
  router.post(
    '/unit-party-roles/:id/end',
    auth,
    requirePermission('unit_party.manage'),
    endUnitPartyRoleHandler,
  );

  return router;
}
