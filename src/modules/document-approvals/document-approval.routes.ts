import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  approveHandler,
  getApprovalStatusHandler,
  listApprovalHistoryHandler,
  rejectHandler,
  submitForApprovalHandler,
} from './document-approval.controller';

/**
 * BE-22I — Approval via shared Document foundation.
 * Reuses BE-09 approval/workflow foundation (reviews + available_actions).
 */
export function createDocumentApprovalRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('document.read');
  const manage = requirePermission('document.manage');
  const approve = requirePermission('document.approve');

  router.post('/documents/:documentId/approvals', auth, manage, submitForApprovalHandler);
  router.get('/documents/:documentId/approvals', auth, read, listApprovalHistoryHandler);
  router.get('/document-approvals/:id', auth, read, getApprovalStatusHandler);
  router.post('/document-approvals/:id/approve', auth, approve, approveHandler);
  router.post('/document-approvals/:id/reject', auth, approve, rejectHandler);

  return router;
}
