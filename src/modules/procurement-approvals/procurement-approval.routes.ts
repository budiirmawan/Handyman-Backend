import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  approveProcurementApprovalHandler,
  createProcurementApprovalHandler,
  getProcurementApprovalActionsHandler,
  getProcurementApprovalHandler,
  listPendingProcurementApprovalsHandler,
  rejectProcurementApprovalHandler,
} from './procurement-approval.controller';

/**
 * BE-17D — Procurement Approval Binding endpoints, protected by BE-01 RBAC and
 * BE-02 Building isolation (enforced in the controller after resolving the
 * binding's Building).
 *
 *   POST /procurement-approvals                         (manage)
 *   GET  /procurement-approvals/pending                 (read)
 *   GET  /procurement-approvals/:id/available-actions   (read)
 *   POST /procurement-approvals/:id/approve             (manage)
 *   POST /procurement-approvals/:id/reject              (manage)
 *   GET  /procurement-approvals/:id                     (read)
 *
 * The decide endpoints require `procurement_approval.manage`; only the
 * assigned authorized approver may decide (enforced in the service via the
 * reused available-actions authority). Vendor Selection Readiness is not
 * implemented here (BE-17E).
 */
export function createProcurementApprovalRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('procurement_approval.read');
  const manage = requirePermission('procurement_approval.manage');

  router.post('/procurement-approvals', auth, manage, createProcurementApprovalHandler);
  router.get('/procurement-approvals/pending', auth, read, listPendingProcurementApprovalsHandler);
  router.get('/procurement-approvals/:id/available-actions', auth, read, getProcurementApprovalActionsHandler);
  router.post('/procurement-approvals/:id/approve', auth, manage, approveProcurementApprovalHandler);
  router.post('/procurement-approvals/:id/reject', auth, manage, rejectProcurementApprovalHandler);
  router.get('/procurement-approvals/:id', auth, read, getProcurementApprovalHandler);
  return router;
}
