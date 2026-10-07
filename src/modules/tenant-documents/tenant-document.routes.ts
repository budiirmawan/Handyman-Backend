import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createTenantDocumentHandler,
  getTenantDocumentHandler,
  listTenantDocumentsHandler,
  updateTenantDocumentHandler,
} from './tenant-document.controller';

/** BE-14J — Tenant document metadata and safe storage references. */
export function createTenantDocumentRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');
  router.post('/tenant-companies/:tenantCompanyId/documents', auth, manage, createTenantDocumentHandler);
  router.get('/tenant-companies/:tenantCompanyId/documents', auth, read, listTenantDocumentsHandler);
  router.get('/tenant-documents/:id', auth, read, getTenantDocumentHandler);
  router.patch('/tenant-documents/:id', auth, manage, updateTenantDocumentHandler);
  return router;
}
