import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignFindingHandler,
  getCurrentFindingAssignmentHandler,
  listFindingAssignmentsHandler,
  updateFindingAssignmentHandler,
} from './finding-assignment.controller';

export function createFindingAssignmentRouter(): Router {
  const router = Router();
  router.post('/findings/:id/assignments', authenticationMiddleware, requirePermission('finding.assign'), assignFindingHandler);
  router.get('/findings/:id/assignments', authenticationMiddleware, requirePermission('finding.read'), listFindingAssignmentsHandler);
  router.get('/findings/:id/assignments/current', authenticationMiddleware, requirePermission('finding.read'), getCurrentFindingAssignmentHandler);
  router.patch('/findings/:id/assignments/:assignmentId', authenticationMiddleware, requirePermission('finding.assign'), updateFindingAssignmentHandler);
  return router;
}
