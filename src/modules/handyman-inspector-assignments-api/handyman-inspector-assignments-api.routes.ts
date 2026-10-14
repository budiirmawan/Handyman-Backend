import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignInspectorHandler,
  getEligibleInspectorsHandler,
  getInspectorAssignmentHandler,
  getInspectorHistoryHandler,
  reassignInspectorHandler,
  revokeInspectorHandler,
} from './handyman-inspector-assignments-api.controller';

/**
 * CR-HM-OPS-DISPATCH-02 P0-A — Inspector assignment HTTP surface.
 *
 *   GET  /handyman/visit-appointments/:visitAppointmentId/inspector/eligible
 *   GET  /handyman/visit-appointments/:visitAppointmentId/inspector
 *   POST /handyman/visit-appointments/:visitAppointmentId/inspector
 *   POST /handyman/visit-appointments/:visitAppointmentId/inspector/reassign
 *   POST /handyman/visit-appointments/:visitAppointmentId/inspector/revoke
 *   GET  /handyman/requests/:handymanRequestId/inspector-assignments/history
 */
export function createHandymanInspectorAssignmentsApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');

  const base = '/handyman/visit-appointments/:visitAppointmentId/inspector';

  router.get(`${base}/eligible`, auth, read, getEligibleInspectorsHandler);
  router.get(base, auth, read, getInspectorAssignmentHandler);
  router.post(base, auth, manage, assignInspectorHandler);
  router.post(`${base}/reassign`, auth, manage, reassignInspectorHandler);
  router.post(`${base}/revoke`, auth, manage, revokeInspectorHandler);

  router.get(
    '/handyman/requests/:handymanRequestId/inspector-assignments/history',
    auth,
    read,
    getInspectorHistoryHandler,
  );
  return router;
}
