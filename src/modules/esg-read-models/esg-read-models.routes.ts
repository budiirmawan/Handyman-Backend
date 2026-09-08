import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getEsgKpiHandler, getManagementEsgSummaryHandler } from './esg-read-models.service';
export function createEsgReadModelsRouter(): Router {
  const r = Router(); const auth = authenticationMiddleware; const read = requirePermission('esg.read');
  r.get('/esg/kpi', auth, read, getEsgKpiHandler);
  r.get('/management/esg-summary', auth, read, getManagementEsgSummaryHandler);
  return r;
}
