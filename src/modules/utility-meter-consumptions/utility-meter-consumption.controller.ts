import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { utilityMeterConsumptionService } from './utility-meter-consumption.service';
import type { UtilityMeterConsumptionFilters } from './utility-meter-consumption.types';
import {
  parseCalculateUtilityMeterConsumptionBody,
  parseConsumptionBuildingIdParam,
  parseConsumptionDateQuery,
  parseConsumptionLimitQuery,
  parseConsumptionMeterIdParam,
  parseConsumptionTenantIdParam,
  parseConsumptionUuidQuery,
  parseUtilityMeterConsumptionIdParam,
} from './utility-meter-consumption.validation';

/** BE-18G — Consumption HTTP handlers. */

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

/** Shared `?meterId=&tenantCompanyId=&from=&to=&limit=`. */
function parseFilters(req: Request): UtilityMeterConsumptionFilters {
  const query = req.query as Record<string, unknown>;
  const filters: UtilityMeterConsumptionFilters = {};

  const meterId = parseConsumptionUuidQuery(
    queryString(query.meterId),
    'meterId',
    'Meter id',
  );
  if (meterId !== undefined) {
    filters.meterId = meterId;
  }

  const tenantCompanyId = parseConsumptionUuidQuery(
    queryString(query.tenantCompanyId),
    'tenantCompanyId',
    'Tenant company id',
  );
  if (tenantCompanyId !== undefined) {
    filters.tenantCompanyId = tenantCompanyId;
  }

  const from = parseConsumptionDateQuery(queryString(query.from), 'from');
  if (from !== undefined) {
    filters.from = from;
  }

  const to = parseConsumptionDateQuery(queryString(query.to), 'to');
  if (to !== undefined) {
    filters.to = to;
  }

  const limit = parseConsumptionLimitQuery(queryString(query.limit));
  if (limit !== undefined) {
    filters.limit = limit;
  }

  return filters;
}

export async function calculateUtilityMeterConsumptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterId = parseConsumptionMeterIdParam(paramString(req.params.id));
    const body = parseCalculateUtilityMeterConsumptionBody(req.body);

    const consumption =
      await utilityMeterConsumptionService.calculateUtilityMeterConsumption(
        {
          ...body,
          meterId,
          ...(req.auth?.userId
            ? { calculatedByUserId: req.auth.userId }
            : {}),
        },
        req.auth?.userId,
      );
    sendSuccess(res, consumption, 201);
  } catch (error) {
    next(error);
  }
}

export async function getUtilityMeterConsumptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityMeterConsumptionIdParam(paramString(req.params.id));
    const consumption =
      await utilityMeterConsumptionService.getUtilityMeterConsumptionById(
        id,
        req.auth?.userId,
      );
    sendSuccess(res, consumption);
  } catch (error) {
    next(error);
  }
}

export async function listMeterConsumptionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterId = parseConsumptionMeterIdParam(paramString(req.params.id));
    const consumptions =
      await utilityMeterConsumptionService.listConsumptionsByMeter(
        meterId,
        parseFilters(req),
        req.auth?.userId,
      );
    sendSuccess(res, consumptions);
  } catch (error) {
    next(error);
  }
}

export async function getLatestMeterConsumptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterId = parseConsumptionMeterIdParam(paramString(req.params.id));
    const consumption =
      await utilityMeterConsumptionService.getLatestConsumptionForMeter(
        meterId,
        req.auth?.userId,
      );
    sendSuccess(res, consumption);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingConsumptionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseConsumptionBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const consumptions =
      await utilityMeterConsumptionService.listConsumptionsByBuilding(
        buildingId,
        parseFilters(req),
        req.auth?.userId,
      );
    sendSuccess(res, consumptions);
  } catch (error) {
    next(error);
  }
}

export async function listTenantConsumptionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tenantCompanyId = parseConsumptionTenantIdParam(
      paramString(req.params.tenantCompanyId),
    );
    const consumptions =
      await utilityMeterConsumptionService.listConsumptionsByTenantCompany(
        tenantCompanyId,
        parseFilters(req),
        req.auth?.userId,
      );
    sendSuccess(res, consumptions);
  } catch (error) {
    next(error);
  }
}
