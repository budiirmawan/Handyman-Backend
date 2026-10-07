import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelWalkInVisitHandler,
  createWalkInVisitHandler,
  getWalkInVisitHandler,
  listWalkInVisitsHandler,
  updateWalkInVisitHandler,
} from './walk-in-visit.controller';

/**
 * BE-13D — Walk-In / Guest Book endpoints.
 *
 *   POST  /walk-in-visits
 *   GET   /walk-in-visits
 *   GET   /walk-in-visits/:id
 *   PATCH /walk-in-visits/:id
 *   POST  /walk-in-visits/:id/cancel
 *
 * Guest-book layer for visitors without a prior invitation. Reuses the
 * shared BE-13A visitor identity (existing match or inline
 * registration through the BE-13A service) — never a second visitor
 * master. No Photo/OCR, Host Confirmation, Check-In, Pass or
 * Check-Out semantics here.
 */
export function createWalkInVisitRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('walk_in_visit.manage');
  const read = requirePermission('walk_in_visit.read');

  router.post('/walk-in-visits', auth, manage, createWalkInVisitHandler);
  router.get('/walk-in-visits', auth, read, listWalkInVisitsHandler);
  router.get('/walk-in-visits/:id', auth, read, getWalkInVisitHandler);
  router.patch('/walk-in-visits/:id', auth, manage, updateWalkInVisitHandler);
  router.post(
    '/walk-in-visits/:id/cancel',
    auth,
    manage,
    cancelWalkInVisitHandler,
  );

  return router;
}
