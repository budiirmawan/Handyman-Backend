import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { createFindingSeverityHandler, getFindingSeverityHandler, listFindingSeveritiesHandler, updateFindingSeverityHandler } from './finding-severity.controller';

export function createFindingSeverityRouter(): Router {
  const router = Router();
  router.post('/clients/:clientId/finding-severities', authenticationMiddleware, requirePermission('finding.manage'), createFindingSeverityHandler);
  router.get('/clients/:clientId/finding-severities', authenticationMiddleware, requirePermission('finding.read'), listFindingSeveritiesHandler);
  router.get('/finding-severities/:id', authenticationMiddleware, requirePermission('finding.read'), getFindingSeverityHandler);
  router.patch('/finding-severities/:id', authenticationMiddleware, requirePermission('finding.manage'), updateFindingSeverityHandler);
  return router;
}
