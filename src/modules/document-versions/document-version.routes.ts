import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createDocumentVersionHandler,
  getDocumentVersionByNumberHandler,
  getDocumentVersionHandler,
  listDocumentVersionsHandler,
  resolveLatestVersionHandler,
} from './document-version.controller';

/**
 * BE-22G — Document Version routes.
 * Versions belong to existing Document, preserve history, never overwrite.
 */
export function createDocumentVersionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('document.read');
  const manage = requirePermission('document.manage');

  router.post('/documents/:documentId/versions', auth, manage, createDocumentVersionHandler);
  router.get('/documents/:documentId/versions', auth, read, listDocumentVersionsHandler);
  router.get('/documents/:documentId/versions/latest', auth, read, resolveLatestVersionHandler);
  router.get('/documents/:documentId/versions/:versionNumber', auth, read, getDocumentVersionByNumberHandler);
  router.get('/document-versions/:versionId', auth, read, getDocumentVersionHandler);

  return router;
}
