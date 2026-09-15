import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  acknowledgeShiftHandoverHandler,
  createShiftHandoverHandler,
  getShiftHandoverHandler,
  listShiftHandoversHandler,
  markShiftHandoverReadyHandler,
  updateShiftHandoverHandler,
} from './shift-handover.controller';

/**
 * BE-10J — Shift Handover endpoints.
 *
 *   POST /buildings/:buildingId/engineering/shift-handovers
 *   GET  /buildings/:buildingId/engineering/shift-handovers?date=
 *   GET  /engineering/shift-handovers/:id
 *   PATCH /engineering/shift-handovers/:id
 *   POST /engineering/shift-handovers/:id/ready
 *   POST /engineering/shift-handovers/:id/acknowledge
 *
 * Handover content is resolved live from the authoritative Engineering
 * records — no duplicated operational engines or shift/attendance logic.
 */
export function createShiftHandoverRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('shift_handover.manage');
  const read = requirePermission('shift_handover.read');

  router.post(
    '/buildings/:buildingId/engineering/shift-handovers',
    auth,
    manage,
    requireBuildingAccess('buildingId'),
    createShiftHandoverHandler,
  );
  router.get(
    '/buildings/:buildingId/engineering/shift-handovers',
    auth,
    read,
    requireBuildingAccess('buildingId'),
    listShiftHandoversHandler,
  );
  router.get('/engineering/shift-handovers/:id', auth, read, getShiftHandoverHandler);
  router.patch('/engineering/shift-handovers/:id', auth, manage, updateShiftHandoverHandler);
  router.post('/engineering/shift-handovers/:id/ready', auth, manage, markShiftHandoverReadyHandler);
  router.post('/engineering/shift-handovers/:id/acknowledge', auth, manage, acknowledgeShiftHandoverHandler);

  return router;
}
