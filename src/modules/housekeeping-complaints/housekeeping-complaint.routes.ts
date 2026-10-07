import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createHousekeepingComplaintBindingHandler,
  getHousekeepingComplaintBindingHandler,
  listHousekeepingComplaintBindingsHandler,
  updateHousekeepingComplaintBindingHandler,
} from './housekeeping-complaint.controller';

/**
 * BE-11L — Housekeeping Complaint Binding endpoints.
 *
 *   POST  /housekeeping/complaint-bindings
 *   GET   /housekeeping/complaint-bindings
 *   GET   /housekeeping/complaint-bindings/:id
 *   PATCH /housekeeping/complaint-bindings/:id
 */
export function createHousekeepingComplaintRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('housekeeping_complaint.manage');
  const read = requirePermission('housekeeping_complaint.read');

  router.post(
    '/housekeeping/complaint-bindings',
    auth,
    manage,
    createHousekeepingComplaintBindingHandler,
  );
  router.get(
    '/housekeeping/complaint-bindings',
    auth,
    read,
    listHousekeepingComplaintBindingsHandler,
  );
  router.get(
    '/housekeeping/complaint-bindings/:id',
    auth,
    read,
    getHousekeepingComplaintBindingHandler,
  );
  router.patch(
    '/housekeeping/complaint-bindings/:id',
    auth,
    manage,
    updateHousekeepingComplaintBindingHandler,
  );

  return router;
}
