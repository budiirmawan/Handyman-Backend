import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  approvePermitApprovalHandler,
  createPermitApprovalHandler,
  getPermitApprovalActionsHandler,
  getPermitApprovalContextHandler,
  getPermitApprovalHandler,
  listPendingPermitApprovalsHandler,
  rejectPermitApprovalHandler,
  requestPermitApprovalReworkHandler,
} from './permit-approval.controller';

/**
 * BE-20F thin Permit binding over shared reviews and BE-09-style authority.
 */
export function createPermitApprovalRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('permit.read');
  const manage = requirePermission('permit.manage');
  const approve = requirePermission('permit.approve');

  router.post(
    '/permit-applications/:applicationId/approvals',
    auth,
    manage,
    createPermitApprovalHandler,
  );
  router.get(
    '/permit-applications/:applicationId/approval-context',
    auth,
    read,
    getPermitApprovalContextHandler,
  );
  router.get(
    '/permit-approvals/pending',
    auth,
    read,
    listPendingPermitApprovalsHandler,
  );
  router.get(
    '/permit-approvals/:id/available-actions',
    auth,
    read,
    getPermitApprovalActionsHandler,
  );
  router.post(
    '/permit-approvals/:id/approve',
    auth,
    approve,
    approvePermitApprovalHandler,
  );
  router.post(
    '/permit-approvals/:id/reject',
    auth,
    approve,
    rejectPermitApprovalHandler,
  );
  router.post(
    '/permit-approvals/:id/request-rework',
    auth,
    approve,
    requestPermitApprovalReworkHandler,
  );
  router.get('/permit-approvals/:id', auth, read, getPermitApprovalHandler);

  return router;
}
