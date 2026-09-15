import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createSupervisorInspectionHandler,
  getSupervisorInspectionHandler,
  listSupervisorInspectionsHandler,
  submitSupervisorDecisionHandler,
} from './supervisor-inspection.controller';

/**
 * BE-11G — Supervisor Inspection endpoints.
 *
 *   POST /housekeeping/supervisor-inspections
 *   GET  /housekeeping/supervisor-inspections
 *   GET  /housekeeping/supervisor-inspections/:id
 *   POST /housekeeping/supervisor-inspections/:id/decision
 */
export function createSupervisorInspectionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('supervisor_inspection.manage');
  const read = requirePermission('supervisor_inspection.read');

  router.post(
    '/housekeeping/supervisor-inspections',
    auth,
    manage,
    createSupervisorInspectionHandler,
  );
  router.get(
    '/housekeeping/supervisor-inspections',
    auth,
    read,
    listSupervisorInspectionsHandler,
  );
  router.get(
    '/housekeeping/supervisor-inspections/:id',
    auth,
    read,
    getSupervisorInspectionHandler,
  );
  router.post(
    '/housekeeping/supervisor-inspections/:id/decision',
    auth,
    manage,
    submitSupervisorDecisionHandler,
  );

  return router;
}
