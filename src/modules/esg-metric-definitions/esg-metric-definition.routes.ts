import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createEsgMetricDefinitionHandler,
  deactivateEsgMetricDefinitionHandler,
  getEsgMetricDefinitionHandler,
  listEsgMetricDefinitionsHandler,
  updateEsgMetricDefinitionHandler,
} from './esg-metric-definition.controller';

/**
 * CR-BE-ESG-01 PART 01 — ESG Metric Definition Foundation endpoints,
 * protected by BE-01 RBAC and BE-02 Client isolation.
 *
 * Reads (`esg.read`):
 *   GET /esg/metric-definitions          (?clientId= & ?status= & ?category= & ?calculationMethod= & ?uomId= & ?search=)
 *   GET /esg/metric-definitions/:id
 * Management (`esg.manage`):
 *   POST   /esg/metric-definitions
 *   PATCH  /esg/metric-definitions/:id     (name / description / category / uomId / calculationMethod only)
 *   POST   /esg/metric-definitions/:id/deactivate
 *
 * Client isolation enforced in service via `contextAccessService`
 * (definitions are Client-scoped; a user reaches a Client through building
 * assignments). Code unique per Client, immutable once created.
 *
 * This surface intentionally stops before metric values, waste records,
 * baselines/targets, evidence bindings, aggregation/reporting, emission
 * factors, or OpenAPI documentation.
 */
export function createEsgMetricDefinitionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('esg.read');
  const manage = requirePermission('esg.manage');

  router.post('/esg/metric-definitions', auth, manage, createEsgMetricDefinitionHandler);
  router.get('/esg/metric-definitions', auth, read, listEsgMetricDefinitionsHandler);
  router.get('/esg/metric-definitions/:id', auth, read, getEsgMetricDefinitionHandler);
  router.patch('/esg/metric-definitions/:id', auth, manage, updateEsgMetricDefinitionHandler);
  router.post(
    '/esg/metric-definitions/:id/deactivate',
    auth,
    manage,
    deactivateEsgMetricDefinitionHandler,
  );

  return router;
}
