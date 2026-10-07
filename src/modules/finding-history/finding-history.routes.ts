import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getFindingHistoryHandler } from './finding-history.controller';

export function createFindingHistoryRouter(): Router {
  const router = Router();
  router.get(
    '/findings/:id/history',
    authenticationMiddleware,
    requirePermission('finding.read'),
    getFindingHistoryHandler,
  );
  return router;
}
