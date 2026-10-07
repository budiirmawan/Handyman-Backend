import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createPatrolChecklistBindingHandler,
  getPatrolChecklistBindingHandler,
  getPatrolChecklistExecutionContextHandler,
  listPatrolChecklistBindingsHandler,
  startPatrolChecklistExecutionHandler,
  updatePatrolChecklistBindingHandler,
} from './patrol-checklist-binding.controller';

/**
 * BE-12E — Patrol Checklist Binding endpoints.
 *
 *   POST /security/patrol-checklist-bindings
 *   GET  /security/patrol-checklist-bindings
 *   GET  /security/patrol-checklist-bindings/:id
 *   PATCH /security/patrol-checklist-bindings/:id
 *   POST /security/patrol-checklist-bindings/:id/start
 *   GET  /security/patrol-checklist-executions/:id
 *
 * The binding associates a BE-07 Checklist Template with a BE-12B Patrol
 * Route (+ optional BE-12A Start Post). Execution stays BE-07's: the
 * start endpoint only creates the shared checklist execution row for the
 * binding — responses, completion, evidence, and verification continue
 * through BE-07's own endpoints (no duplicated checklist execution
 * endpoints here). When a checklist execution produces a Finding, the
 * caller routes it through BE-09 (`sourceType = CHECKLIST_EXECUTION`).
 */
export function createPatrolChecklistBindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('patrol_checklist_binding.manage');
  const read = requirePermission('patrol_checklist_binding.read');

  router.post(
    '/security/patrol-checklist-bindings',
    auth,
    manage,
    createPatrolChecklistBindingHandler,
  );
  router.get(
    '/security/patrol-checklist-bindings',
    auth,
    read,
    listPatrolChecklistBindingsHandler,
  );
  router.get(
    '/security/patrol-checklist-bindings/:id',
    auth,
    read,
    getPatrolChecklistBindingHandler,
  );
  router.patch(
    '/security/patrol-checklist-bindings/:id',
    auth,
    manage,
    updatePatrolChecklistBindingHandler,
  );
  router.post(
    '/security/patrol-checklist-bindings/:id/start',
    auth,
    manage,
    startPatrolChecklistExecutionHandler,
  );
  router.get(
    '/security/patrol-checklist-executions/:id',
    auth,
    read,
    getPatrolChecklistExecutionContextHandler,
  );

  return router;
}
