import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getDocumentExpiryHandler,
  getVersionExpiryHandler,
  setDocumentExpiryHandler,
  setVersionExpiryHandler,
} from './document-expiry.controller';

/**
 * BE-22H — Expiry via Document / Version.
 * No scheduler/job engine, preserve history via versions.
 */
export function createDocumentExpiryRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('document.read');
  const manage = requirePermission('document.manage');

  router.put('/documents/:documentId/expiry', auth, manage, setDocumentExpiryHandler);
  router.get('/documents/:documentId/expiry', auth, read, getDocumentExpiryHandler);
  router.put('/document-versions/:versionId/expiry', auth, manage, setVersionExpiryHandler);
  router.get('/document-versions/:versionId/expiry', auth, read, getVersionExpiryHandler);

  return router;
}
