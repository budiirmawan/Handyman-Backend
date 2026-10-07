import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { listAssetHistoryHandler } from './asset-history.controller';

/**
 * BE-05I — Asset History endpoint, protected by BE-01 RBAC and BE-02
 * Building isolation.
 *
 * Read (`asset_history.read`):
 *   GET /assets/:assetId/history   (?eventType= &limit= &offset=)
 *
 * READ-ONLY BY DESIGN. There is deliberately no POST, PATCH, or DELETE:
 * history is appended by the domain services as a side effect of real
 * operations, never authored or edited through the API. A dedicated read
 * permission keeps the audit trail visible only to roles entitled to it.
 */
export function createAssetHistoryRouter(): Router {
  const router = Router();

  router.get(
    '/assets/:assetId/history',
    authenticationMiddleware,
    requirePermission('asset_history.read'),
    listAssetHistoryHandler,
  );

  return router;
}
