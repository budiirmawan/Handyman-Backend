import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  cancelFindingHandler,
  createFindingHandler,
  getFindingAvailableActionsHandler,
  getFindingHandler,
  getFindingSourceHandler,
  getFindingStateHandler,
  listFindingsHandler,
  transitionFindingStateHandler,
  updateFindingHandler,
  updateFindingSourceHandler,
} from './finding.controller';

/** BE-09A generic Finding foundation routes. */
export function createFindingRouter(): Router {
  const router = Router();

  router.post(
    '/buildings/:buildingId/findings',
    authenticationMiddleware,
    requirePermission('finding.manage'),
    requireBuildingAccess('buildingId'),
    createFindingHandler,
  );
  router.get(
    '/buildings/:buildingId/findings',
    authenticationMiddleware,
    requirePermission('finding.read'),
    requireBuildingAccess('buildingId'),
    listFindingsHandler,
  );
  router.get(
    '/findings/:id',
    authenticationMiddleware,
    requirePermission('finding.read'),
    getFindingHandler,
  );
  router.patch(
    '/findings/:id',
    authenticationMiddleware,
    requirePermission('finding.manage'),
    updateFindingHandler,
  );
  router.get(
    '/findings/:id/available-actions',
    authenticationMiddleware,
    requirePermission('finding.read'),
    getFindingAvailableActionsHandler,
  );
  router.get(
    '/findings/:id/state',
    authenticationMiddleware,
    requirePermission('finding.read'),
    getFindingStateHandler,
  );
  router.patch(
    '/findings/:id/state',
    authenticationMiddleware,
    transitionFindingStateHandler,
  );
  router.get(
    '/findings/:id/source',
    authenticationMiddleware,
    requirePermission('finding.read'),
    getFindingSourceHandler,
  );
  router.patch(
    '/findings/:id/source',
    authenticationMiddleware,
    requirePermission('finding.manage'),
    updateFindingSourceHandler,
  );
  router.post(
    '/findings/:id/cancel',
    authenticationMiddleware,
    requirePermission('finding.manage'),
    cancelFindingHandler,
  );

  return router;
}
