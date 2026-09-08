import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  archiveDocumentHandler,
  createDocumentHandler,
  getDocumentHandler,
  listDocumentsHandler,
  restoreDocumentHandler,
  updateDocumentHandler,
} from './document.controller';

/**
 * BE-22A — Document Foundation routes (ONE foundation for INTERNAL/TENANT/VENDOR).
 *
 * Reuses BE-07 file reference convention, BE-02 Client/Building isolation,
 * BE-01 RBAC. No BAST/version/expiry/approval/archive engines here.
 */
export function createDocumentRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('document.read');
  const manage = requirePermission('document.manage');
  const archive = requirePermission('document.archive');

  router.post('/documents', auth, manage, createDocumentHandler);
  router.get('/documents', auth, read, listDocumentsHandler);
  router.get('/documents/:id', auth, read, getDocumentHandler);
  router.patch('/documents/:id', auth, manage, updateDocumentHandler);
  router.post('/documents/:id/archive', auth, archive, archiveDocumentHandler);
  router.post('/documents/:id/restore', auth, archive, restoreDocumentHandler);

  return router;
}
