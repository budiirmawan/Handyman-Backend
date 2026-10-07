import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  aggregateConsumptionHandler,
  getAbnormalSummaryHandler,
  getUtilitySummaryHandler,
  getVerificationApprovalSummaryHandler,
} from './utility-aggregation.controller';

/**
 * BE-18M — Utility Aggregation endpoints, protected by BE-01 RBAC and BE-02
 * Client / Building isolation (enforced in the service once the requested
 * scope is resolved). Read-only throughout: the BE-18A utility read
 * permission is sufficient, and no route mutates anything.
 *
 * Every endpoint requires exactly one scope anchor as a query parameter —
 * `clientId`, `buildingId`, `meterId` or `tenantCompanyId` — plus optional
 * `utilityType`, `from`, `to`, `meterScope` and `interval` filters.
 *
 *   GET /utility/aggregations/summary                 totals + breakdowns
 *   GET /utility/aggregations/consumption?groupBy=…   grouped totals
 *   GET /utility/aggregations/abnormal                BE-18J counts
 *   GET /utility/aggregations/verification-approval   BE-18K / BE-18L status
 */
export function createUtilityAggregationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('utility_meter.read');

  router.get('/utility/aggregations/summary', auth, read, getUtilitySummaryHandler);
  router.get(
    '/utility/aggregations/consumption',
    auth,
    read,
    aggregateConsumptionHandler,
  );
  router.get(
    '/utility/aggregations/abnormal',
    auth,
    read,
    getAbnormalSummaryHandler,
  );
  router.get(
    '/utility/aggregations/verification-approval',
    auth,
    read,
    getVerificationApprovalSummaryHandler,
  );

  return router;
}
