import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { utilityUsageHistoryService } from './utility-usage-history.service';
import type { UtilityUsageHistoryFilters } from './utility-usage-history.types';
import {
  parseUsageHistoryBuildingIdParam,
  parseUsageHistoryDateQuery,
  parseUsageHistoryLimitQuery,
  parseUsageHistoryMeterIdParam,
  parseUsageHistoryOrderQuery,
  parseUsageHistoryTenantIdParam,
  parseUsageHistoryUuidQuery,
} from './utility-usage-history.validation';

/** BE-18H — Usage History HTTP handlers (read-only). */

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return undefined;
}

/** Shared `?meterId=&tenantCompanyId=&buildingId=&from=&to=&order=&limit=`. */
function parseFilters(req: Request): UtilityUsageHistoryFilters {
  const query = req.query as Record<string, unknown>;
  const filters: UtilityUsageHistoryFilters = {};

  const meterId = parseUsageHistoryUuidQuery(
    queryString(query.meterId),
    'meterId',
    'Meter id',
  );
  if (meterId !== undefined) {
    filters.meterId = meterId;
  }

  const tenantCompanyId = parseUsageHistoryUuidQuery(
    queryString(query.tenantCompanyId),
    'tenantCompanyId',
    'Tenant company id',
  );
  if (tenantCompanyId !== undefined) {
    filters.tenantCompanyId = tenantCompanyId;
  }

  const buildingId = parseUsageHistoryUuidQuery(
    queryString(query.buildingId),
    'buildingId',
    'Building id',
  );
  if (buildingId !== undefined) {
    filters.buildingId = buildingId;
  }

  const from = parseUsageHistoryDateQuery(queryString(query.from), 'from');
  if (from !== undefined) {
    filters.from = from;
  }

  const to = parseUsageHistoryDateQuery(queryString(query.to), 'to');
  if (to !== undefined) {
    filters.to = to;
  }

  const order = parseUsageHistoryOrderQuery(queryString(query.order));
  if (order !== undefined) {
    filters.order = order;
  }

  const limit = parseUsageHistoryLimitQuery(queryString(query.limit));
  if (limit !== undefined) {
    filters.limit = limit;
  }

  return filters;
}

/** GET /utility/meters/:id/usage-history */
export async function getMeterUsageHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterId = parseUsageHistoryMeterIdParam(paramString(req.params.id));
    const history = await utilityUsageHistoryService.getUsageHistoryByMeter(
      meterId,
      parseFilters(req),
      req.auth?.userId,
    );
    sendSuccess(res, history);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/meters/:id/usage-history/latest */
export async function getLatestMeterUsageHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterId = parseUsageHistoryMeterIdParam(paramString(req.params.id));
    const entry =
      await utilityUsageHistoryService.getLatestUsageHistoryForMeter(
        meterId,
        req.auth?.userId,
      );
    sendSuccess(res, entry);
  } catch (error) {
    next(error);
  }
}

/** GET /buildings/:buildingId/usage-history */
export async function getBuildingUsageHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseUsageHistoryBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const history = await utilityUsageHistoryService.getUsageHistoryByBuilding(
      buildingId,
      parseFilters(req),
      req.auth?.userId,
    );
    sendSuccess(res, history);
  } catch (error) {
    next(error);
  }
}

/** GET /tenant-companies/:tenantCompanyId/usage-history */
export async function getTenantUsageHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tenantCompanyId = parseUsageHistoryTenantIdParam(
      paramString(req.params.tenantCompanyId),
    );
    const history =
      await utilityUsageHistoryService.getUsageHistoryByTenantCompany(
        tenantCompanyId,
        parseFilters(req),
        req.auth?.userId,
      );
    sendSuccess(res, history);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/usage-history — chronological history across the caller's scope. */
export async function resolveUsageHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const history = await utilityUsageHistoryService.resolveUsageHistory(
      parseFilters(req),
      req.auth?.userId,
    );
    sendSuccess(res, history);
  } catch (error) {
    next(error);
  }
}
