import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  abortTenantImportHandler,
  commitTenantImportHandler,
  confirmTenantImportHandler,
  getTenantImportHandler,
  listTenantImportsHandler,
  uploadTenantImportHandler,
  validateTenantImportHandler,
} from './tenant-import.controller';

/**
 * CR-HM-MASTER-TENANT-BATCH-01 — Tenant/PIC batch import lifecycle.
 *
 * Upload → validate → preview (GET) → confirm → commit, with abort as the
 * rollback of a staged batch. Client-scoped like BE-14A: the caller must hold
 * the tenant_company capabilities AND Client reach through ACTIVE Building
 * assignments (BE-02 — no cross-Building expansion, ever). Row-level Unit
 * references are re-checked against the actor's Building reach at validation
 * and at commit.
 *
 *   POST   /clients/{clientId}/tenant-imports                      tenant_company.manage
 *   GET    /clients/{clientId}/tenant-imports                      tenant_company.read
 *   GET    /clients/{clientId}/tenant-imports/{batchId}            tenant_company.read
 *   POST   /clients/{clientId}/tenant-imports/{batchId}/validate   tenant_company.manage
 *   POST   /clients/{clientId}/tenant-imports/{batchId}/confirm    tenant_company.manage
 *   POST   /clients/{clientId}/tenant-imports/{batchId}/commit     tenant_company.manage
 *   POST   /clients/{clientId}/tenant-imports/{batchId}/abort      tenant_company.manage
 */
export function createTenantImportRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');

  router.post('/clients/:clientId/tenant-imports', auth, manage, uploadTenantImportHandler);
  router.get('/clients/:clientId/tenant-imports', auth, read, listTenantImportsHandler);
  router.get('/clients/:clientId/tenant-imports/:batchId', auth, read, getTenantImportHandler);
  router.post('/clients/:clientId/tenant-imports/:batchId/validate', auth, manage, validateTenantImportHandler);
  router.post('/clients/:clientId/tenant-imports/:batchId/confirm', auth, manage, confirmTenantImportHandler);
  router.post('/clients/:clientId/tenant-imports/:batchId/commit', auth, manage, commitTenantImportHandler);
  router.post('/clients/:clientId/tenant-imports/:batchId/abort', auth, manage, abortTenantImportHandler);
  return router;
}
