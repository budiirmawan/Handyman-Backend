import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { processSyncBatchHandler } from './mobile-sync.controller';

/**
 * BE-25G — Offline Sync Contract.
 *
 *   POST /mobile/sync
 *
 * Lightweight batch contract for mobile offline synchronization. Every
 * operation is executed through the SAME shared services as the REST
 * endpoints — validation, RBAC (per-item), data scope, and workflow rules
 * are never bypassed. Idempotency (BE-25H) and conflict handling (BE-25I)
 * are not implemented; operation identifiers are carried and echoed only.
 */
export function createMobileSyncRouter(): Router {
  const router = Router();

  router.post(
    '/mobile/sync',
    authenticationMiddleware,
    processSyncBatchHandler,
  );

  return router;
}
