import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createShiftHandler,
  getShiftHandler,
  listBuildingShiftsHandler,
} from './shift.controller';

/**
 * BE-03E — Shift endpoints, protected by BE-01 RBAC and BE-02 Building
 * isolation.
 *
 * Reads (`shift.read`):    GET  /buildings/:buildingId/shifts
 *                          GET  /shifts/:id
 * Management (`shift.manage`): POST /buildings/:buildingId/shifts
 *
 * Both Building-nested routes additionally pass through
 * `requireBuildingAccess('buildingId')`, so holding `shift.read`/`shift.manage`
 * is not enough — the caller must also have an ACTIVE assignment to that
 * Building. Shift administration therefore inherits BE-02 isolation rather
 * than opening a side channel around it.
 *
 * `updateShiftStatus` is intentionally service-level only: BE-03E specifies it
 * as a minimum operation but does not include a status endpoint in its minimal
 * API surface.
 */
export function createShiftRouter(): Router {
  const router = Router();

  router.post(
    '/buildings/:buildingId/shifts',
    authenticationMiddleware,
    requirePermission('shift.manage'),
    requireBuildingAccess('buildingId'),
    createShiftHandler,
  );
  router.get(
    '/buildings/:buildingId/shifts',
    authenticationMiddleware,
    requirePermission('shift.read'),
    requireBuildingAccess('buildingId'),
    listBuildingShiftsHandler,
  );
  router.get(
    '/shifts/:id',
    authenticationMiddleware,
    requirePermission('shift.read'),
    getShiftHandler,
  );

  return router;
}
