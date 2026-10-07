import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getConfigurationAuditHandler,
  listConfigurationAuditHandler,
} from './configuration-audit.controller';

/** BE-27Q read-only projection over append-only operational_events. */
export function createConfigurationAuditRouter(): Router {
  const router = Router();
  const read = requirePermission('operational_event.read');
  router.get(
    '/configuration-audit',
    authenticationMiddleware,
    read,
    listConfigurationAuditHandler,
  );
  router.get(
    '/configuration-audit/:id',
    authenticationMiddleware,
    read,
    getConfigurationAuditHandler,
  );
  return router;
}
