import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createHousekeepingFindingHandler,
  getHousekeepingFindingHandler,
  listHousekeepingFindingsHandler,
} from './housekeeping-finding.controller';

/**
 * BE-11H — Housekeeping Finding Binding endpoints.
 *
 *   POST /housekeeping/findings
 *   GET  /housekeeping/findings
 *   GET  /housekeeping/findings/:id
 */
export function createHousekeepingFindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('housekeeping_finding.manage');
  const read = requirePermission('housekeeping_finding.read');

  router.post(
    '/housekeeping/findings',
    auth,
    manage,
    createHousekeepingFindingHandler,
  );
  router.get(
    '/housekeeping/findings',
    auth,
    read,
    listHousekeepingFindingsHandler,
  );
  router.get(
    '/housekeeping/findings/:id',
    auth,
    read,
    getHousekeepingFindingHandler,
  );

  return router;
}
