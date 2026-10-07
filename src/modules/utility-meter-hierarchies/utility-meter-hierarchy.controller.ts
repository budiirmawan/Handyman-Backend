import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { utilityMeterHierarchyService } from './utility-meter-hierarchy.service';
import type { UtilityMeterHierarchyFilters } from './utility-meter-hierarchy.types';
import {
  parseBindSubMeterBody,
  parseEndUtilityMeterHierarchyBody,
  parseHierarchyMeterIdParam,
  parseUpdateUtilityMeterHierarchyBody,
  parseUtilityMeterHierarchyIdParam,
  parseUtilityMeterHierarchyStatusQuery,
} from './utility-meter-hierarchy.validation';

/** BE-18C — Main / Sub Meter hierarchy HTTP handlers. */

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

function parseFilters(req: Request): UtilityMeterHierarchyFilters {
  const query = req.query as Record<string, unknown>;
  const filters: UtilityMeterHierarchyFilters = {};

  const status = parseUtilityMeterHierarchyStatusQuery(queryString(query.status));
  if (status !== undefined) {
    filters.status = status;
  }
  return filters;
}

export async function bindSubMeterHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const mainMeterId = parseHierarchyMeterIdParam(paramString(req.params.id));
    const body = parseBindSubMeterBody(req.body);

    const hierarchy = await utilityMeterHierarchyService.bindSubMeter(
      { ...body, mainMeterId },
      req.auth?.userId,
    );
    sendSuccess(res, hierarchy, 201);
  } catch (error) {
    next(error);
  }
}

export async function listSubMetersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const mainMeterId = parseHierarchyMeterIdParam(paramString(req.params.id));
    const hierarchies = await utilityMeterHierarchyService.listSubMeters(
      mainMeterId,
      parseFilters(req),
      req.auth?.userId,
    );
    sendSuccess(res, hierarchies);
  } catch (error) {
    next(error);
  }
}

export async function resolveMainMeterHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subMeterId = parseHierarchyMeterIdParam(paramString(req.params.id));
    const hierarchy = await utilityMeterHierarchyService.resolveMainMeter(
      subMeterId,
      req.auth?.userId,
    );
    sendSuccess(res, hierarchy);
  } catch (error) {
    next(error);
  }
}

export async function listSubMeterHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subMeterId = parseHierarchyMeterIdParam(paramString(req.params.id));
    const hierarchies = await utilityMeterHierarchyService.listSubMeterHistory(
      subMeterId,
      parseFilters(req),
      req.auth?.userId,
    );
    sendSuccess(res, hierarchies);
  } catch (error) {
    next(error);
  }
}

export async function getUtilityMeterHierarchyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityMeterHierarchyIdParam(paramString(req.params.id));
    const hierarchy =
      await utilityMeterHierarchyService.getUtilityMeterHierarchyById(
        id,
        req.auth?.userId,
      );
    sendSuccess(res, hierarchy);
  } catch (error) {
    next(error);
  }
}

export async function updateUtilityMeterHierarchyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityMeterHierarchyIdParam(paramString(req.params.id));
    const body = parseUpdateUtilityMeterHierarchyBody(req.body);

    const hierarchy =
      await utilityMeterHierarchyService.updateUtilityMeterHierarchy(
        id,
        body,
        req.auth?.userId,
      );
    sendSuccess(res, hierarchy);
  } catch (error) {
    next(error);
  }
}

export async function endUtilityMeterHierarchyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUtilityMeterHierarchyIdParam(paramString(req.params.id));
    const body = parseEndUtilityMeterHierarchyBody(req.body);

    const hierarchy =
      await utilityMeterHierarchyService.endUtilityMeterHierarchy(
        id,
        body,
        req.auth?.userId,
      );
    sendSuccess(res, hierarchy);
  } catch (error) {
    next(error);
  }
}
