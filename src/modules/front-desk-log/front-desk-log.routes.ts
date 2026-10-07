import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getFrontDeskLogHandler,
  listFrontDeskLogsHandler,
} from './front-desk-log.controller';

/**
 * BE-13L — chronological read projection over authoritative BE-13
 * activities. No reporting/BI or frontend behavior is implemented.
 */
export function createFrontDeskLogRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('front_desk_log.read');

  router.get('/front-desk-logs', auth, read, listFrontDeskLogsHandler);
  router.get('/front-desk-logs/:id', auth, read, getFrontDeskLogHandler);

  return router;
}
