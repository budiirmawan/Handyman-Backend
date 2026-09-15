import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  closeFindingHandler,
  getFindingClosureHandler,
} from './finding-closure.controller';

export function createFindingClosureRouter(): Router {
  const router = Router();
  router.get('/findings/:id/closure', authenticationMiddleware, requirePermission('finding.read'), getFindingClosureHandler);
  router.post('/findings/:id/close', authenticationMiddleware, requirePermission('finding.close'), closeFindingHandler);
  return router;
}
