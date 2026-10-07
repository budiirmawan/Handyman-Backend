import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createEngineeringChecklistBindingHandler,
  getEngineeringChecklistBindingHandler,
  getEngineeringChecklistExecutionContextHandler,
  listEngineeringChecklistBindingsHandler,
  startEngineeringChecklistExecutionHandler,
  updateEngineeringChecklistBindingHandler,
} from './engineering-checklist-binding.controller';

/**
 * BE-10E — Engineering Checklist Binding endpoints.
 *
 *   POST /engineering/checklist-bindings
 *   GET  /engineering/checklist-bindings?buildingId=&assetId=
 *   GET  /engineering/checklist-bindings/:id
 *   PATCH /engineering/checklist-bindings/:id
 *   POST /engineering/checklist-bindings/:id/start
 *   GET  /engineering/checklist-executions/:id
 *
 * Execution stays BE-07's: the start endpoint only creates the shared
 * checklist execution row for the binding — responses, completion, evidence,
 * and verification continue through BE-07's own endpoints (no duplicated
 * checklist execution endpoints here).
 */
export function createEngineeringChecklistBindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('engineering_checklist_binding.manage');
  const read = requirePermission('engineering_checklist_binding.read');

  router.post('/engineering/checklist-bindings', auth, manage, createEngineeringChecklistBindingHandler);
  router.get('/engineering/checklist-bindings', auth, read, listEngineeringChecklistBindingsHandler);
  router.get('/engineering/checklist-bindings/:id', auth, read, getEngineeringChecklistBindingHandler);
  router.patch('/engineering/checklist-bindings/:id', auth, manage, updateEngineeringChecklistBindingHandler);
  router.post('/engineering/checklist-bindings/:id/start', auth, manage, startEngineeringChecklistExecutionHandler);
  router.get('/engineering/checklist-executions/:id', auth, read, getEngineeringChecklistExecutionContextHandler);

  return router;
}
