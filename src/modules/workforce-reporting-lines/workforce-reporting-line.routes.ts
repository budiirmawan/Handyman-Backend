import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignSupervisorHandler,
  getCurrentSupervisorHandler,
  listDirectReportsHandler,
  updateReportingLineHandler,
} from './workforce-reporting-line.controller';

/**
 * BE-03F — Workforce Reporting Line endpoints, protected by BE-01 RBAC.
 *
 * Reuses the existing BE-03C Workforce permissions rather than introducing new
 * codes — a reporting line is workforce data, not its own resource domain:
 *   `workforce.read`   → GET   /workforce/:workforceId/supervisor
 *                        GET   /workforce/:supervisorId/direct-reports
 *   `workforce.manage` → POST  /workforce/:workforceId/supervisor
 *                        PATCH /workforce/:workforceId/supervisor
 *
 * Deactivation is a PATCH with `{ "status": "INACTIVE" }`, not a DELETE, so the
 * reporting history survives.
 */
export function createWorkforceReportingLineRouter(): Router {
  const router = Router();

  router.post(
    '/workforce/:workforceId/supervisor',
    authenticationMiddleware,
    requirePermission('workforce.manage'),
    assignSupervisorHandler,
  );
  router.get(
    '/workforce/:workforceId/supervisor',
    authenticationMiddleware,
    requirePermission('workforce.read'),
    getCurrentSupervisorHandler,
  );
  router.get(
    '/workforce/:supervisorId/direct-reports',
    authenticationMiddleware,
    requirePermission('workforce.read'),
    listDirectReportsHandler,
  );
  router.patch(
    '/workforce/:workforceId/supervisor',
    authenticationMiddleware,
    requirePermission('workforce.manage'),
    updateReportingLineHandler,
  );

  return router;
}
