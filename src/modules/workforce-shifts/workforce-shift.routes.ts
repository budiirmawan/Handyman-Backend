import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignWorkforceShiftHandler,
  listWorkforceShiftsHandler,
  updateWorkforceShiftHandler,
} from './workforce-shift.controller';

/**
 * BE-03E — Workforce Shift Assignment endpoints, protected by BE-01 RBAC.
 *
 * Reuses the BE-03E Shift permissions rather than introducing new codes:
 *   `shift.read`   → GET   /workforce/:workforceId/shifts
 *   `shift.manage` → POST  /workforce/:workforceId/shifts
 *                    PATCH /workforce/:workforceId/shifts/:shiftId
 *
 * Deactivation is a PATCH with `{ "status": "INACTIVE" }`, not a DELETE, so the
 * rostering history survives.
 */
export function createWorkforceShiftRouter(): Router {
  const router = Router();

  router.post(
    '/workforce/:workforceId/shifts',
    authenticationMiddleware,
    requirePermission('shift.manage'),
    assignWorkforceShiftHandler,
  );
  router.get(
    '/workforce/:workforceId/shifts',
    authenticationMiddleware,
    requirePermission('shift.read'),
    listWorkforceShiftsHandler,
  );
  router.patch(
    '/workforce/:workforceId/shifts/:shiftId',
    authenticationMiddleware,
    requirePermission('shift.manage'),
    updateWorkforceShiftHandler,
  );

  return router;
}
