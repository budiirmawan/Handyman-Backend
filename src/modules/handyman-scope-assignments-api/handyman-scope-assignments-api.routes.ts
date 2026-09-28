import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getHandymanExecutionScopeAssignmentHandler,
  postHandymanExecutionScopeAssignmentHandler,
  postHandymanExecutionScopeReassignHandler,
} from './handyman-scope-assignments-api.controller';

/**
 * CR-HM-04 activation PART C — Execution Scope assignment HTTP
 * surface (minimum operational API over the PART A/B runtime):
 *
 *   POST /handyman/execution-scopes/:executionScopeId/assignment
 *   GET  /handyman/execution-scopes/:executionScopeId/assignment
 *   POST /handyman/execution-scopes/:executionScopeId/assignment/reassign
 *
 * Permissions: reads `tenant_company.read`; mutations
 * `tenant_company.manage` (existing vocabulary; no new permission).
 * Assignment targets HANDYMAN_EXECUTION_SCOPE only; assignment never
 * implies arrival, CHECK-IN, work start, or a schedule. The internal
 * Lead resolver is deliberately NOT a standalone endpoint.
 */
export function createHandymanScopeAssignmentsApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');
  const base = '/handyman/execution-scopes/:executionScopeId/assignment';

  router.post(base, auth, manage, postHandymanExecutionScopeAssignmentHandler);
  router.get(base, auth, read, getHandymanExecutionScopeAssignmentHandler);
  router.post(
    `${base}/reassign`,
    auth,
    manage,
    postHandymanExecutionScopeReassignHandler,
  );
  return router;
}
