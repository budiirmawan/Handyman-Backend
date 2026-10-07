import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createTenantCommunicationHandler,
  getTenantCommunicationHandler,
  listTenantCommunicationsHandler,
  readTenantCommunicationHandler,
  sendTenantCommunicationHandler,
  updateTenantCommunicationHandler,
} from './tenant-communication.controller';

/** BE-14K — operational Tenant communication records; no delivery transport. */
export function createTenantCommunicationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');
  router.post('/tenant-companies/:tenantCompanyId/communications', auth, manage, createTenantCommunicationHandler);
  router.get('/tenant-companies/:tenantCompanyId/communications', auth, read, listTenantCommunicationsHandler);
  router.post('/tenant-communications/:id/send', auth, manage, sendTenantCommunicationHandler);
  router.post('/tenant-communications/:id/read', auth, read, readTenantCommunicationHandler);
  router.get('/tenant-communications/:id', auth, read, getTenantCommunicationHandler);
  router.patch('/tenant-communications/:id', auth, manage, updateTenantCommunicationHandler);
  return router;
}
