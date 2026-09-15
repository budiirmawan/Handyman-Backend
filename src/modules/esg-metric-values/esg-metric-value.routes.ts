import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createEsgMetricValueHandler,
  getEsgMetricValueHandler,
  listEsgMetricValuesHandler,
  updateEsgMetricValueHandler,
} from './esg-metric-value.controller';

/**
 * CR-BE-ESG-01 PART 03 — ESG Metric Values & Periods endpoints.
 *
 * Reads (`esg.read`):
 *   GET /esg/metric-values
 *   GET /esg/metric-values/:id
 * Management (`esg.manage`):
 *   POST  /esg/metric-values
 *   PATCH /esg/metric-values/:id
 *
 * Building isolation via `getAccessibleBuildingIds`.
 * Metric definition same-Client ACTIVE, UOM same-Client ACTIVE.
 * Unique period enforcement via DB UNIQUE (client, building, metric, start, end).
 * No automatic aggregation, no baseline/target, no verification workflow,
 * no evidence bindings, no KPI/reporting, no OpenAPI.
 */
export function createEsgMetricValueRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('esg.read');
  const manage = requirePermission('esg.manage');

  router.post('/esg/metric-values', auth, manage, createEsgMetricValueHandler);
  router.get('/esg/metric-values', auth, read, listEsgMetricValuesHandler);
  router.get('/esg/metric-values/:id', auth, read, getEsgMetricValueHandler);
  router.patch('/esg/metric-values/:id', auth, manage, updateEsgMetricValueHandler);

  return router;
}
