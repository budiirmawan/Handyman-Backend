import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { utilityMeterReadingService } from './utility-meter-reading.service';
import type { UtilityMeterReadingFilters } from './utility-meter-reading.types';
import {
  parseReadingBuildingIdParam,
  parseReadingDateQuery,
  parseReadingLimitQuery,
  parseReadingMeterIdParam,
  parseReadingSourceQuery,
  parseReadingTenantIdParam,
  parseReadingTypeQuery,
  parseReadingUuidQuery,
  parseRecordUtilityMeterReadingBody,
  parseUtilityMeterReadingIdParam,
} from './utility-meter-reading.validation';

/** BE-18E — Meter Reading HTTP handlers. */

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

/** Shared `?meterId=&tenantCompanyId=&source=&readingType=&from=&to=&limit=`. */
function parseFilters(req: Request): UtilityMeterReadingFilters {
  const query = req.query as Record<string, unknown>;
  const filters: UtilityMeterReadingFilters = {};

  const meterId = parseReadingUuidQuery(
    queryString(query.meterId),
    'meterId',
    'Meter id',
  );
  if (meterId !== undefined) {
    filters.meterId = meterId;
  }

  const tenantCompanyId = parseReadingUuidQuery(
    queryString(query.tenantCompanyId),
    'tenantCompanyId',
    'Tenant company id',
  );
  if (tenantCompanyId !== undefined) {
    filters.tenantCompanyId = tenantCompanyId;
  }

  const source = parseReadingSourceQuery(queryString(query.source));
  if (source !== undefined) {
    filters.source = source;
  }

  const readingType = parseReadingTypeQuery(queryString(query.readingType));
  if (readingType !== undefined) {
    filters.readingType = readingType;
  }

  const from = parseReadingDateQuery(queryString(query.from), 'from');
  if (from !== undefined) {
    filters.from = from;
  }

  const to = parseReadingDateQuery(queryString(query.to), 'to');
  if (to !== undefined) {
    filters.to = to;
  }

  const limit = parseReadingLimitQuery(queryString(query.limit));
  if (limit !== undefined) {
    filters.limit = limit;
  }

  return filters;
}

export async function recordUtilityMeterReadingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterId = parseReadingMeterIdParam(paramString(req.params.id));
    const body = parseRecordUtilityMeterReadingBody(req.body);
    const actorUserId = req.auth?.userId ?? '';

    const reading = await utilityMeterReadingService.recordUtilityMeterReading(
      { ...body, meterId, recordedByUserId: actorUserId },
      req.auth?.userId,
    );
    sendSuccess(res, reading, 201);
  } catch (error) {
    next(error);
  }
}

export async function getUtilityMeterReadingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityMeterReadingIdParam(paramString(req.params.id));
    const reading = await utilityMeterReadingService.getUtilityMeterReadingById(
      id,
      req.auth?.userId,
    );
    sendSuccess(res, reading);
  } catch (error) {
    next(error);
  }
}

export async function listMeterReadingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterId = parseReadingMeterIdParam(paramString(req.params.id));
    const readings = await utilityMeterReadingService.listReadingsByMeter(
      meterId,
      parseFilters(req),
      req.auth?.userId,
    );
    sendSuccess(res, readings);
  } catch (error) {
    next(error);
  }
}

export async function getLatestMeterReadingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterId = parseReadingMeterIdParam(paramString(req.params.id));
    const reading = await utilityMeterReadingService.getLatestReadingForMeter(
      meterId,
      req.auth?.userId,
    );
    sendSuccess(res, reading);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingMeterReadingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseReadingBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const readings = await utilityMeterReadingService.listReadingsByBuilding(
      buildingId,
      parseFilters(req),
      req.auth?.userId,
    );
    sendSuccess(res, readings);
  } catch (error) {
    next(error);
  }
}

export async function listTenantMeterReadingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tenantCompanyId = parseReadingTenantIdParam(
      paramString(req.params.tenantCompanyId),
    );
    const readings =
      await utilityMeterReadingService.listReadingsByTenantCompany(
        tenantCompanyId,
        parseFilters(req),
        req.auth?.userId,
      );
    sendSuccess(res, readings);
  } catch (error) {
    next(error);
  }
}
