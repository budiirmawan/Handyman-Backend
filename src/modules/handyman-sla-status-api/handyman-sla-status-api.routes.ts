import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getHandymanExecutionScopeStatusVisibilityHandler,
  getHandymanProviderPerformanceHandler,
  getHandymanRequestStatusVisibilityHandler,
  getHandymanSubjectSlaHandler,
} from './handyman-sla-status-api.controller';

/**
 * CR-HM-17 GAP PART 07 — B8 SLA & Status Visibility Customer Care GET surface:
 *
 *   GET /handyman/sla/subjects/:subjectType/:subjectId
 *   GET /handyman/provider-performance
 *   GET /handyman/requests/:id/status-visibility
 *   GET /handyman/execution-scopes/:id/status-visibility
 *
 * All routes are read-only and require `tenant_company.read` + `canAccessClient`.
 */
export function createHandymanSlaStatusApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');

  router.get(
    '/handyman/sla/subjects/:subjectType/:subjectId',
    auth,
    read,
    getHandymanSubjectSlaHandler,
  );
  router.get(
    '/handyman/provider-performance',
    auth,
    read,
    getHandymanProviderPerformanceHandler,
  );
  router.get(
    '/handyman/requests/:id/status-visibility',
    auth,
    read,
    getHandymanRequestStatusVisibilityHandler,
  );
  router.get(
    '/handyman/execution-scopes/:id/status-visibility',
    auth,
    read,
    getHandymanExecutionScopeStatusVisibilityHandler,
  );

  return router;
}
