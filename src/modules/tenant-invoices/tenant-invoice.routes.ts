import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  addTenantInvoiceLineHandler, cancelTenantInvoiceHandler,
  createTenantInvoiceHandler, finalizeTenantInvoiceHandler,
  getTenantInvoiceHandler, listTenantInvoicesHandler, updateTenantInvoiceHandler,
} from './tenant-invoice.controller';

/** BE-19D — Tenant Invoice; no payment, tax, GL, or accounting engine. */
export function createTenantInvoiceRouter(): Router {
  const router = Router(); const auth = authenticationMiddleware;
  const read = requirePermission('tenant_invoice.read');
  const manage = requirePermission('tenant_invoice.manage');
  router.post('/tenant-companies/:tenantCompanyId/invoices', auth, manage, createTenantInvoiceHandler);
  router.get('/tenant-invoices', auth, read, listTenantInvoicesHandler);
  router.post('/tenant-invoices/:id/lines', auth, manage, addTenantInvoiceLineHandler);
  router.post('/tenant-invoices/:id/finalize', auth, manage, finalizeTenantInvoiceHandler);
  router.post('/tenant-invoices/:id/cancel', auth, manage, cancelTenantInvoiceHandler);
  router.get('/tenant-invoices/:id', auth, read, getTenantInvoiceHandler);
  router.patch('/tenant-invoices/:id', auth, manage, updateTenantInvoiceHandler);
  return router;
}
