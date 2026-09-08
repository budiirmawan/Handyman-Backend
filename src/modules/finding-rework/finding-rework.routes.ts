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
  router.post('/findings/:id/reject', authenticationMiddleware, requirePermission('finding.review'), rejectFindingHandler);
  router.post('/findings/:id/rework', authenticationMiddleware, requirePermission('finding.manage'), requestFindingReworkHandler);
  router.get('/findings/:id/rework', authenticationMiddleware, requirePermission('finding.read'), getFindingReworkHandler);
  router.patch('/findings/:id/rework', authenticationMiddleware, requirePermission('finding.manage'), updateFindingReworkNotesHandler);
  router.post('/findings/:id/resubmit', authenticationMiddleware, requirePermission('finding.manage'), resubmitFindingHandler);
  return router;
}
