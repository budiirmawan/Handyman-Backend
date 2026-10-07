import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getWorkforceReportingHandler,
  listWorkforceReportingHandler,
} from './workforce-reporting.controller';

/**
 * BE-03I2 — Workforce Reporting Query API.
 *
 * Read-only endpoints over the BE-03I1 reporting read model. Every route
 * requires `workforce.read` and is automatically constrained to the caller's
 * BE-02G accessible building set; no report endpoint trusts caller-supplied
 * Client/Building scope.
 */
export function createWorkforceReportingRouter(): Router {
  const router = Router();

  router.get(
    '/workforce/reporting',
    authenticationMiddleware,
    requirePermission('workforce.read'),
    listWorkforceReportingHandler,
  );

  router.get(
    '/workforce/reporting/:id',
    authenticationMiddleware,
    requirePermission('workforce.read'),
    getWorkforceReportingHandler,
  );

  return router;
}
