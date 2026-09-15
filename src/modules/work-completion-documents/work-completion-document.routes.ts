import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createWorkCompletionDocumentHandler,
  getWorkCompletionDocumentHandler,
  listWorkCompletionDocumentsHandler,
} from './work-completion-document.controller';

/**
 * BE-22B — Work Completion Document routes.
 * Reuses BE-22A Document foundation + Work Order / Vendor Work masters.
 * No BAST, no duplication.
 */
export function createWorkCompletionDocumentRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('document.read');
  const manage = requirePermission('document.manage');

  router.post('/work-completion-documents', auth, manage, createWorkCompletionDocumentHandler);
  router.get('/work-completion-documents', auth, read, listWorkCompletionDocumentsHandler);
  router.get('/work-completion-documents/:id', auth, read, getWorkCompletionDocumentHandler);

  return router;
}
