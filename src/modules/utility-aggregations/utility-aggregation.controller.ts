import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { utilityAggregationService } from './utility-aggregation.service';
import {
  parseAggregationFiltersQuery,
  parseAggregationGroupingQuery,
  parseAggregationScopeQuery,
} from './utility-aggregation.validation';

/** BE-18M — Utility Aggregation HTTP handlers. */

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readRequest(req: Request) {
  if (!req.auth) {
    throw authenticationRequiredError();
  }
  const scope = parseAggregationScopeQuery({
    ...(queryString(req.query.clientId) !== undefined
      ? { clientId: queryString(req.query.clientId) as string }
      : {}),
    ...(queryString(req.query.buildingId) !== undefined
      ? { buildingId: queryString(req.query.buildingId) as string }
      : {}),
    ...(queryString(req.query.meterId) !== undefined
      ? { meterId: queryString(req.query.meterId) as string }
      : {}),
    ...(queryString(req.query.tenantCompanyId) !== undefined
      ? { tenantCompanyId: queryString(req.query.tenantCompanyId) as string }
      : {}),
  });
  const filters = parseAggregationFiltersQuery({
    ...(queryString(req.query.utilityType) !== undefined
      ? { utilityType: queryString(req.query.utilityType) as string }
      : {}),
    ...(queryString(req.query.from) !== undefined
      ? { from: queryString(req.query.from) as string }
      : {}),
    ...(queryString(req.query.to) !== undefined
      ? { to: queryString(req.query.to) as string }
      : {}),
    ...(queryString(req.query.meterScope) !== undefined
      ? { meterScope: queryString(req.query.meterScope) as string }
      : {}),
    ...(queryString(req.query.interval) !== undefined
      ? { interval: queryString(req.query.interval) as string }
      : {}),
  });
  return { scope, filters, actorUserId: req.auth.userId };
}

/** GET /utility/aggregations/summary */
export async function getUtilitySummaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { scope, filters, actorUserId } = readRequest(req);
    const summary = await utilityAggregationService.getUtilitySummary(
      scope,
      filters,
      actorUserId,
    );
    sendSuccess(res, summary);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/aggregations/consumption */
export async function aggregateConsumptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { scope, filters, actorUserId } = readRequest(req);
    const grouping = parseAggregationGroupingQuery(
      queryString(req.query.groupBy),
    );
    const buckets =
      await utilityAggregationService.aggregateUtilityConsumption(
        scope,
        filters,
        grouping,
        actorUserId,
      );
    sendSuccess(res, buckets, 200, { groupBy: grouping, total: buckets.length });
  } catch (error) {
    next(error);
  }
}

/** GET /utility/aggregations/abnormal */
export async function getAbnormalSummaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { scope, filters, actorUserId } = readRequest(req);
    const summary = await utilityAggregationService.getUtilityAbnormalSummary(
      scope,
      filters,
      actorUserId,
    );
    sendSuccess(res, summary);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/aggregations/verification-approval */
export async function getVerificationApprovalSummaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { scope, filters, actorUserId } = readRequest(req);
    const summary =
      await utilityAggregationService.getUtilityVerificationApprovalSummary(
        scope,
        filters,
        actorUserId,
      );
    sendSuccess(res, summary);
  } catch (error) {
    next(error);
  }
}
