import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createSecurityShiftHandoverBindingHandler,
  getSecurityShiftHandoverBindingHandler,
  listSecurityShiftHandoverBindingsHandler,
  updateSecurityShiftHandoverBindingHandler,
} from './security-shift-handover.controller';

/**
 * BE-12G — Security Shift Handover endpoints.
 *
 *   POST /buildings/:buildingId/security/shift-handovers
 *   GET  /buildings/:buildingId/security/shift-handovers
 *   GET  /security/shift-handovers/:id
 *   PATCH /security/shift-handovers/:id
 *
 * These endpoints own only the Security binding that attaches a BE-12A
 * start Security Post (+ optional BE-12B Patrol Route) to a pre-existing
 * BE-10J shift_handovers row. The BE-10J lifecycle (DRAFT → READY →
 * ACKNOWLEDGED) is the only authority on the handover status; the
 * binding's ACTIVE/INACTIVE flag is independent and never affects it.
 * The Engineering shift handover APIs (`/engineering/shift-handovers`)
 * remain authoritative for the handover itself.
 */
export function createSecurityShiftHandoverBindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('security_shift_handover.manage');
  const read = requirePermission('security_shift_handover.read');

  router.post(
    '/buildings/:buildingId/security/shift-handovers',
    auth,
    manage,
    requireBuildingAccess('buildingId'),
    createSecurityShiftHandoverBindingHandler,
  );
  router.get(
    '/buildings/:buildingId/security/shift-handovers',
    auth,
    read,
    requireBuildingAccess('buildingId'),
    listSecurityShiftHandoverBindingsHandler,
  );
  router.get(
    '/security/shift-handovers/:id',
    auth,
    read,
    getSecurityShiftHandoverBindingHandler,
  );
  router.patch(
    '/security/shift-handovers/:id',
    auth,
    manage,
    updateSecurityShiftHandoverBindingHandler,
  );

  return router;
}
