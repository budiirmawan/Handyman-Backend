import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { listHandymanOperationsQueueHandler } from './handyman-operations-queue.controller';

/**
 * Production read-only Handyman queue. It uses the existing
 * `tenant_company.read` authority and the same Client/C6 + exact Building
 * guards as the established Handyman reads. This route is Handyman-request
 * keyed only; it does not synthesize or join a generic Work Order id.
 */
export function createHandymanOperationsQueueRouter(): Router {
  const router = Router();
  router.get(
    '/handyman/operations/queue',
    authenticationMiddleware,
    requirePermission('tenant_company.read'),
    listHandymanOperationsQueueHandler,
  );
  return router;
}
