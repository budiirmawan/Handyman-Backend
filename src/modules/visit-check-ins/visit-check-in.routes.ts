import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelVisitCheckInHandler,
  checkInVisitHandler,
  checkOutVisitHandler,
  getVisitCheckInHandler,
  listVisitCheckInsHandler,
} from './visit-check-in.controller';

/**
 * BE-13G / BE-13H — Check-In & Check-Out endpoints (one controlled
 * visit lifecycle).
 *
 *   POST /visit-check-ins
 *   GET  /visit-check-ins
 *   GET  /visit-check-ins/:id
 *   POST /visit-check-ins/:id/check-out
 *   POST /visit-check-ins/:id/cancel
 *
 * Backend-authoritative check-in over the BE-13C / BE-13D visit
 * contexts, gated by the BE-13F host confirmation where one exists.
 * One active check-in per visit. Check-out closes the active visit
 * while preserving the check-in history; cancel is a mistake reversal
 * only. BE-13I Visitor Pass endpoints are separate, while visit closure
 * refuses to leave an ACTIVE pass unresolved.
 */
export function createVisitCheckInRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('visit_check_in.manage');
  const read = requirePermission('visit_check_in.read');

  router.post('/visit-check-ins', auth, manage, checkInVisitHandler);
  router.get('/visit-check-ins', auth, read, listVisitCheckInsHandler);
  router.get('/visit-check-ins/:id', auth, read, getVisitCheckInHandler);
  router.post(
    '/visit-check-ins/:id/check-out',
    auth,
    manage,
    checkOutVisitHandler,
  );
  router.post(
    '/visit-check-ins/:id/cancel',
    auth,
    manage,
    cancelVisitCheckInHandler,
  );

  return router;
}
