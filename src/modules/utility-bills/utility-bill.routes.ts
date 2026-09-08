import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  generateUtilityBillHandler,
  getUtilityBillHandler,
  getUtilityBillInvoiceReadyHandler,
  listUtilityBillsHandler,
  updateUtilityBillHandler,
} from './utility-bill.controller';

/** BE-19B — Electricity/Water billing from finalized BE-18 calculations. */
export function createUtilityBillRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('utility_bill.read');
  const manage = requirePermission('utility_bill.manage');
  router.post('/tenant-companies/:tenantCompanyId/utility-bills', auth, manage, generateUtilityBillHandler);
  router.get('/utility-bills', auth, read, listUtilityBillsHandler);
  router.get('/utility-bills/:id/invoice-ready', auth, read, getUtilityBillInvoiceReadyHandler);
  router.get('/utility-bills/:id', auth, read, getUtilityBillHandler);
  router.patch('/utility-bills/:id', auth, manage, updateUtilityBillHandler);
  return router;
}
