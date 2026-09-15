import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createServiceChargeReadinessHandler,
  getServiceChargeReadinessHandler,
  listServiceChargeReadinessHandler,
  updateServiceChargeReadinessHandler,
} from './service-charge-readiness.controller';

/** BE-19C — preparation/readiness only; no service-charge calculation engine. */
export function createServiceChargeReadinessRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('service_charge_readiness.read');
  const manage = requirePermission('service_charge_readiness.manage');
  router.post('/tenant-companies/:tenantCompanyId/service-charge-readiness', auth, manage, createServiceChargeReadinessHandler);
  router.get('/service-charge-readiness', auth, read, listServiceChargeReadinessHandler);
  router.get('/service-charge-readiness/:id', auth, read, getServiceChargeReadinessHandler);
  router.patch('/service-charge-readiness/:id', auth, manage, updateServiceChargeReadinessHandler);
  return router;
}
