import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { createHandoverDocumentHandler, getHandoverDocumentHandler, listHandoverDocumentsHandler } from './handover-document.controller';

/**
 * BE-22D — Handover via shared Document foundation.
 * Reuses Work Order / Vendor Work / Work Completion / BAST.
 */
export function createHandoverDocumentRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('document.read');
  const manage = requirePermission('document.manage');

  router.post('/handover-documents', auth, manage, createHandoverDocumentHandler);
  router.get('/handover-documents', auth, read, listHandoverDocumentsHandler);
  router.get('/handover-documents/:id', auth, read, getHandoverDocumentHandler);

  return router;
}
