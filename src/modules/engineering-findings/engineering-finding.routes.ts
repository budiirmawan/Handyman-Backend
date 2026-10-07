import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createEngineeringFindingHandler,
  getEngineeringFindingHandler,
  listEngineeringFindingsHandler,
} from './engineering-finding.controller';

/**
 * BE-10H — Engineering Finding Binding endpoints.
 *
 *   POST /engineering/findings
 *   GET  /engineering/findings?buildingId=&assetId=&sourceType=&status=
 *   GET  /engineering/findings/:id
 *
 * Findings stay BE-09's: creation, classification/severity, source binding,
 * assignment, state transitions, verification, rework, closure, history, and
 * available actions all live on BE-09's own endpoints/services. This router
 * only adds the Engineering context binding and read model — no duplicated
 * Finding workflow endpoints.
 */
export function createEngineeringFindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('engineering_finding.manage');
  const read = requirePermission('engineering_finding.read');

  router.post('/engineering/findings', auth, manage, createEngineeringFindingHandler);
  router.get('/engineering/findings', auth, read, listEngineeringFindingsHandler);
  router.get('/engineering/findings/:id', auth, read, getEngineeringFindingHandler);

  return router;
}
