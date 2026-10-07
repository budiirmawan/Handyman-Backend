import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createToiletInspectionBindingHandler,
  getToiletInspectionBindingHandler,
  getToiletInspectionExecutionHandler,
  listToiletInspectionBindingsHandler,
  startToiletInspectionExecutionHandler,
  updateToiletInspectionBindingHandler,
} from './toilet-inspection.controller';

/**
 * BE-11E — Toilet Inspection Binding endpoints.
 *
 *   POST  /housekeeping/toilet-inspection-bindings
 *   GET   /housekeeping/toilet-inspection-bindings
 *   GET   /housekeeping/toilet-inspection-bindings/:id
 *   PATCH /housekeeping/toilet-inspection-bindings/:id
 *   POST  /housekeeping/toilet-inspection-bindings/:id/start
 *   GET   /housekeeping/toilet-inspection-executions/:id
 */
export function createToiletInspectionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('toilet_inspection.manage');
  const read = requirePermission('toilet_inspection.read');

  router.post(
    '/housekeeping/toilet-inspection-bindings',
    auth,
    manage,
    createToiletInspectionBindingHandler,
  );
  router.get(
    '/housekeeping/toilet-inspection-bindings',
    auth,
    read,
    listToiletInspectionBindingsHandler,
  );
  router.get(
    '/housekeeping/toilet-inspection-bindings/:id',
    auth,
    read,
    getToiletInspectionBindingHandler,
  );
  router.patch(
    '/housekeeping/toilet-inspection-bindings/:id',
    auth,
    manage,
    updateToiletInspectionBindingHandler,
  );
  router.post(
    '/housekeeping/toilet-inspection-bindings/:id/start',
    auth,
    manage,
    startToiletInspectionExecutionHandler,
  );
  router.get(
    '/housekeeping/toilet-inspection-executions/:id',
    auth,
    read,
    getToiletInspectionExecutionHandler,
  );

  return router;
}
