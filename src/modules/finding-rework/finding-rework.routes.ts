import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getFindingReworkHandler,
  rejectFindingHandler,
  requestFindingReworkHandler,
  resubmitFindingHandler,
  updateFindingReworkNotesHandler,
} from './finding-rework.controller';

export function createFindingReworkRouter(): Router {
  const router = Router();
  // Route-level gates mirror the BE-09J action authority
  // (`finding-action.authority.ts`). Executor-side rework/resubmit belong to
  // the active Finding assignee holding `finding.execute`; requesting rework
  // belongs to the reviewer holding `finding.review`. Active-assignee /
  // reviewer / lifecycle enforcement is retained in the controller (action
  // authority) and the service — a route permission is never a substitute.
  router.post('/findings/:id/reject', authenticationMiddleware, requirePermission('finding.review'), rejectFindingHandler);
  router.post('/findings/:id/rework', authenticationMiddleware, requirePermission('finding.review'), requestFindingReworkHandler);
  router.get('/findings/:id/rework', authenticationMiddleware, requirePermission('finding.read'), getFindingReworkHandler);
  router.patch('/findings/:id/rework', authenticationMiddleware, requirePermission('finding.execute'), updateFindingReworkNotesHandler);
  router.post('/findings/:id/resubmit', authenticationMiddleware, requirePermission('finding.execute'), resubmitFindingHandler);
  return router;
}
