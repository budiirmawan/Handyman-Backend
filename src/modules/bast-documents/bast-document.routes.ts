import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createBastDocumentHandler,
  decideBastDocumentHandler,
  getBastDocumentHandler,
  getBastReconciliationInventoryHandler,
  listBastDocumentsHandler,
  resubmitBastDocumentHandler,
  submitBastDocumentHandler,
} from './bast-document.controller';

/**
 * BE-22C — BAST via shared Document foundation.
 * Reuses Work Order / Vendor Work / Work Completion (BE-22B).
 * BE-15H vendor_bast_bindings points to this authoritative BAST via bast_document_id.
 */
export function createBastDocumentRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('document.read');
  const manage = requirePermission('document.manage');
  const accept = requirePermission('bast.accept');

  router.post('/bast-documents', auth, manage, createBastDocumentHandler);
  router.post(
    '/bast-documents/:id/submit',
    auth,
    manage,
    submitBastDocumentHandler,
  );
  router.post(
    '/bast-documents/:id/resubmit',
    authenticationMiddleware,
    requirePermission('document.manage'),
    resubmitBastDocumentHandler,
  );
  router.post(
    '/bast-documents/:id/decisions',
    auth,
    accept,
    decideBastDocumentHandler,
  );
  router.get('/bast-documents', auth, read, listBastDocumentsHandler);
  router.get(
    '/bast-documents/reconciliation',
    auth,
    read,
    getBastReconciliationInventoryHandler,
  );
  router.get('/bast-documents/:id', auth, read, getBastDocumentHandler);

  return router;
}
