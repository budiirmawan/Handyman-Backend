import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelTenantChargeHandler,
  createTenantChargeHandler,
  getTenantChargeHandler,
  listTenantChargesHandler,
  updateTenantChargeHandler,
} from './tenant-charge.controller';

/** BE-19A — lightweight Tenant charges; no invoice, payment or accounting. */
export function createTenantChargeRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_charge.read');
  const manage = requirePermission('tenant_charge.manage');
  router.post('/tenant-companies/:tenantCompanyId/charges', auth, manage, createTenantChargeHandler);
  router.get('/tenant-charges', auth, read, listTenantChargesHandler);
  router.get('/tenant-charges/:id', auth, read, getTenantChargeHandler);
  router.patch('/tenant-charges/:id', auth, manage, updateTenantChargeHandler);
  router.post('/tenant-charges/:id/cancel', auth, manage, cancelTenantChargeHandler);
  return router;
}
