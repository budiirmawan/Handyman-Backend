import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createFindingClassificationHandler,
  getFindingClassificationHandler,
  listFindingClassificationsHandler,
  updateFindingClassificationHandler,
} from './finding-classification.controller';

export function createFindingClassificationRouter(): Router {
  const router = Router();
  router.post('/clients/:clientId/finding-classifications', authenticationMiddleware, requirePermission('finding.manage'), createFindingClassificationHandler);
  router.get('/clients/:clientId/finding-classifications', authenticationMiddleware, requirePermission('finding.read'), listFindingClassificationsHandler);
  router.get('/finding-classifications/:id', authenticationMiddleware, requirePermission('finding.read'), getFindingClassificationHandler);
  router.patch('/finding-classifications/:id', authenticationMiddleware, requirePermission('finding.manage'), updateFindingClassificationHandler);
  return router;
}
