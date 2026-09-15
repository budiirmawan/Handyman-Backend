import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { utilityAbnormalConsumptionService } from './utility-abnormal-consumption.service';
import type {
  UtilityAbnormalConsumptionFilters,
  UtilityAbnormalityRuleFilters,
} from './utility-abnormal-consumption.types';
import {
  parseAbnormalConsumptionIdParam,
  parseAbnormalityBuildingIdParam,
  parseAbnormalityClientIdParam,
  parseAbnormalityConsumptionIdParam,
  parseAbnormalityDateQuery,
  parseAbnormalityLimitQuery,
  parseAbnormalityMeterIdParam,
  parseAbnormalityRuleStatusQuery,
  parseAbnormalityStatusQuery,
  parseAbnormalityTenantIdParam,
  parseAbnormalityTypeQuery,
  parseAbnormalityUtilityTypeQuery,
  parseAbnormalityUuidQuery,
  parseCreateUtilityAbnormalityRuleBody,
  parseEvaluateConsumptionBody,
  parseLinkAbnormalConsumptionFindingBody,
  parseResolveAbnormalConsumptionBody,
} from './utility-abnormal-consumption.validation';

/** BE-18J — Abnormal Consumption HTTP handlers. */

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

/** Shared `?meterId=&tenantCompanyId=&buildingId=&status=&abnormalityType=&utilityType=&from=&to=&limit=`. */
function parseFilters(req: Request): UtilityAbnormalConsumptionFilters {
  const query = req.query as Record<string, unknown>;
  const filters: UtilityAbnormalConsumptionFilters = {};

  const meterId = parseAbnormalityUuidQuery(
    queryString(query.meterId),
    'meterId',
    'Meter id',
  );
  if (meterId !== undefined) {
    filters.meterId = meterId;
  }

  const tenantCompanyId = parseAbnormalityUuidQuery(
    queryString(query.tenantCompanyId),
    'tenantCompanyId',
    'Tenant company id',
  );
  if (tenantCompanyId !== undefined) {
    filters.tenantCompanyId = tenantCompanyId;
  }

  const buildingId = parseAbnormalityUuidQuery(
    queryString(query.buildingId),
    'buildingId',
    'Building id',
  );
  if (buildingId !== undefined) {
    filters.buildingId = buildingId;
  }

  const status = parseAbnormalityStatusQuery(queryString(query.status));
  if (status !== undefined) {
    filters.status = status;
  }

  const abnormalityType = parseAbnormalityTypeQuery(
    queryString(query.abnormalityType),
  );
  if (abnormalityType !== undefined) {
    filters.abnormalityType = abnormalityType;
  }

  const utilityType = parseAbnormalityUtilityTypeQuery(
    queryString(query.utilityType),
  );
  if (utilityType !== undefined) {
    filters.utilityType = utilityType;
  }

  const from = parseAbnormalityDateQuery(queryString(query.from), 'from');
  if (from !== undefined) {
    filters.from = from;
  }

  const to = parseAbnormalityDateQuery(queryString(query.to), 'to');
  if (to !== undefined) {
    filters.to = to;
  }

  const limit = parseAbnormalityLimitQuery(queryString(query.limit));
  if (limit !== undefined) {
    filters.limit = limit;
  }

  return filters;
}

/* -------------------------------------------------------------------------
 * Detection rules
 * ---------------------------------------------------------------------- */

/** POST /clients/:clientId/utility-abnormality-rules */
export async function createUtilityAbnormalityRuleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseAbnormalityClientIdParam(
      paramString(req.params.clientId),
    );
    const body = parseCreateUtilityAbnormalityRuleBody(req.body);
    const rule =
      await utilityAbnormalConsumptionService.createUtilityAbnormalityRule(
        { clientId, ...body },
        req.auth?.userId,
      );
    sendSuccess(res, rule, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /clients/:clientId/utility-abnormality-rules */
export async function listUtilityAbnormalityRulesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseAbnormalityClientIdParam(
      paramString(req.params.clientId),
    );
    const query = req.query as Record<string, unknown>;
    const filters: UtilityAbnormalityRuleFilters = {};

    const utilityType = parseAbnormalityUtilityTypeQuery(
      queryString(query.utilityType),
    );
    if (utilityType !== undefined) {
      filters.utilityType = utilityType;
    }
    const abnormalityType = parseAbnormalityTypeQuery(
      queryString(query.abnormalityType),
    );
    if (abnormalityType !== undefined) {
      filters.abnormalityType = abnormalityType;
    }
    const status = parseAbnormalityRuleStatusQuery(queryString(query.status));
    if (status !== undefined) {
      filters.status = status;
    }

    const rules =
      await utilityAbnormalConsumptionService.listUtilityAbnormalityRules(
        clientId,
        filters,
        req.auth?.userId,
      );
    sendSuccess(res, rules);
  } catch (error) {
    next(error);
  }
}

/* -------------------------------------------------------------------------
 * Detection and records
 * ---------------------------------------------------------------------- */

/** POST /utility/consumptions/:id/abnormality-evaluations */
export async function evaluateConsumptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const consumptionId = parseAbnormalityConsumptionIdParam(
      paramString(req.params.id),
    );
    const body = parseEvaluateConsumptionBody(req.body);
    const evaluation =
      await utilityAbnormalConsumptionService.evaluateConsumption(
        {
          consumptionId,
          ...body,
          ...(req.auth?.userId ? { detectedByUserId: req.auth.userId } : {}),
        },
        req.auth?.userId,
      );
    // 201 when something was flagged; 200 when the period read as normal.
    sendSuccess(res, evaluation, evaluation.detections.length > 0 ? 201 : 200);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/consumptions/:id/abnormal-consumptions */
export async function listConsumptionAbnormalitiesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const consumptionId = parseAbnormalityConsumptionIdParam(
      paramString(req.params.id),
    );
    const records =
      await utilityAbnormalConsumptionService.listAbnormalConsumptionsByConsumption(
        consumptionId,
        req.auth?.userId,
      );
    sendSuccess(res, records);
  } catch (error) {
    next(error);
  }
}

/** POST /utility/abnormal-consumptions/:id/resolve */
export async function resolveAbnormalConsumptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const abnormalConsumptionId = parseAbnormalConsumptionIdParam(
      paramString(req.params.id),
    );
    const body = parseResolveAbnormalConsumptionBody(req.body);
    const record =
      await utilityAbnormalConsumptionService.resolveUtilityAbnormalConsumption(
        { abnormalConsumptionId, ...body },
        req.auth?.userId,
      );
    sendSuccess(res, record);
  } catch (error) {
    next(error);
  }
}

/** POST /utility/abnormal-consumptions/:id/finding */
export async function linkAbnormalConsumptionFindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const abnormalConsumptionId = parseAbnormalConsumptionIdParam(
      paramString(req.params.id),
    );
    const body = parseLinkAbnormalConsumptionFindingBody(req.body);
    const userId = req.auth?.userId;
    if (!userId) {
      // BE-09 requires a real reporter; there is no system actor here.
      throw AppError.badRequest('An authenticated user is required.');
    }
    const record =
      await utilityAbnormalConsumptionService.linkAbnormalConsumptionFinding(
        { abnormalConsumptionId, ...body },
        userId,
      );
    sendSuccess(res, record, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/abnormal-consumptions/:id */
export async function getAbnormalConsumptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const abnormalConsumptionId = parseAbnormalConsumptionIdParam(
      paramString(req.params.id),
    );
    const record =
      await utilityAbnormalConsumptionService.getUtilityAbnormalConsumptionById(
        abnormalConsumptionId,
        req.auth?.userId,
      );
    sendSuccess(res, record);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/meters/:id/abnormal-consumptions */
export async function listMeterAbnormalitiesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterId = parseAbnormalityMeterIdParam(paramString(req.params.id));
    const records =
      await utilityAbnormalConsumptionService.listAbnormalConsumptionsByMeter(
        meterId,
        parseFilters(req),
        req.auth?.userId,
      );
    sendSuccess(res, records);
  } catch (error) {
    next(error);
  }
}

/** GET /buildings/:buildingId/abnormal-consumptions */
export async function listBuildingAbnormalitiesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseAbnormalityBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const records =
      await utilityAbnormalConsumptionService.listAbnormalConsumptionsByBuilding(
        buildingId,
        parseFilters(req),
        req.auth?.userId,
      );
    sendSuccess(res, records);
  } catch (error) {
    next(error);
  }
}

/** GET /tenant-companies/:tenantCompanyId/abnormal-consumptions */
export async function listTenantAbnormalitiesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tenantCompanyId = parseAbnormalityTenantIdParam(
      paramString(req.params.tenantCompanyId),
    );
    const records =
      await utilityAbnormalConsumptionService.listAbnormalConsumptionsByTenantCompany(
        tenantCompanyId,
        parseFilters(req),
        req.auth?.userId,
      );
    sendSuccess(res, records);
  } catch (error) {
    next(error);
  }
}
