import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { utilityMeterService } from './utility-meter.service';
import type { UtilityMeterFilters } from './utility-meter.types';
import {
  parseCreateUtilityMeterBody,
  parseUpdateUtilityMeterBody,
  parseUpdateUtilityMeterStatusBody,
  parseUtilityMeterBuildingIdParam,
  parseUtilityMeterClientIdParam,
  parseUtilityMeterIdParam,
  parseUtilityMeterSearchQuery,
  parseUtilityMeterStatusQuery,
  parseUtilityMeterUuidQuery,
  parseUtilityTypeQuery,
} from './utility-meter.validation';

/** BE-18A — Meter Master HTTP handlers. */

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

function parseFilters(req: Request): UtilityMeterFilters {
  const query = req.query as Record<string, unknown>;
  const filters: UtilityMeterFilters = {};

  const status = parseUtilityMeterStatusQuery(queryString(query.status));
  if (status !== undefined) {
    filters.status = status;
  }

  const utilityType = parseUtilityTypeQuery(queryString(query.utilityType));
  if (utilityType !== undefined) {
    filters.utilityType = utilityType;
  }

  const uomId = parseUtilityMeterUuidQuery(
    queryString(query.uomId),
    'uomId',
    'UOM id',
  );
  if (uomId !== undefined) {
    filters.uomId = uomId;
  }

  const spaceId = parseUtilityMeterUuidQuery(
    queryString(query.spaceId),
    'spaceId',
    'Space id',
  );
  if (spaceId !== undefined) {
    filters.spaceId = spaceId;
  }

  const functionalLocationId = parseUtilityMeterUuidQuery(
    queryString(query.functionalLocationId),
    'functionalLocationId',
    'Functional location id',
  );
  if (functionalLocationId !== undefined) {
    filters.functionalLocationId = functionalLocationId;
  }

  const search = parseUtilityMeterSearchQuery(queryString(query.search));
  if (search !== undefined) {
    filters.search = search;
  }

  return filters;
}

export async function createUtilityMeterHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseUtilityMeterBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const body = parseCreateUtilityMeterBody(req.body);

    const meter = await utilityMeterService.createUtilityMeter(
      { ...body, buildingId },
      req.auth?.userId,
    );
    sendSuccess(res, meter, 201);
  } catch (error) {
    next(error);
  }
}

export async function getUtilityMeterHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityMeterIdParam(paramString(req.params.id));
    const meter = await utilityMeterService.getUtilityMeterById(
      id,
      req.auth?.userId,
    );
    sendSuccess(res, meter);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingUtilityMetersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseUtilityMeterBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const filters = parseFilters(req);

    const meters = await utilityMeterService.listUtilityMetersByBuilding(
      buildingId,
      filters,
      req.auth?.userId,
    );
    sendSuccess(res, meters);
  } catch (error) {
    next(error);
  }
}

export async function listClientUtilityMetersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseUtilityMeterClientIdParam(
      paramString(req.params.clientId),
    );
    const filters = parseFilters(req);
    const buildingId = parseUtilityMeterUuidQuery(
      queryString((req.query as Record<string, unknown>).buildingId),
      'buildingId',
      'Building id',
    );

    const meters = await utilityMeterService.listUtilityMetersByClient(
      clientId,
      { ...filters, ...(buildingId === undefined ? {} : { buildingId }) },
      req.auth?.userId,
    );
    sendSuccess(res, meters);
  } catch (error) {
    next(error);
  }
}

export async function updateUtilityMeterHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityMeterIdParam(paramString(req.params.id));
    const body = parseUpdateUtilityMeterBody(req.body);

    const meter = await utilityMeterService.updateUtilityMeter(
      id,
      body,
      req.auth?.userId,
    );
    sendSuccess(res, meter);
  } catch (error) {
    next(error);
  }
}

export async function updateUtilityMeterStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityMeterIdParam(paramString(req.params.id));
    const body = parseUpdateUtilityMeterStatusBody(req.body);

    const meter = await utilityMeterService.updateUtilityMeterStatus(
      id,
      body,
      req.auth?.userId,
    );
    sendSuccess(res, meter);
  } catch (error) {
    next(error);
  }
}
