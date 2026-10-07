import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { createSupportingDocumentHandler, getSupportingDocumentHandler, listSupportingDocumentsHandler } from './supporting-document.controller';

/**
 * BE-22F — Supporting Document via shared Document foundation.
 * May support Work Completion, BAST, Handover, Sign-Off, Tenant or Vendor.
 */
export function createSupportingDocumentRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('document.read');
  const manage = requirePermission('document.manage');

  router.post('/supporting-documents', auth, manage, createSupportingDocumentHandler);
  router.get('/supporting-documents', auth, read, listSupportingDocumentsHandler);
  router.get('/supporting-documents/:id', auth, read, getSupportingDocumentHandler);

  return router;
}
