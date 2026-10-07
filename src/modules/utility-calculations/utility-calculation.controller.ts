import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { utilityCalculationService } from './utility-calculation.service';
import type {
  UtilityCalculationBasisFilters,
  UtilityCalculationFilters,
} from './utility-calculation.types';
import {
  parseCalculateUtilityValueBody,
  parseCalculationBasisStatusQuery,
  parseCalculationBuildingIdParam,
  parseCalculationClientIdParam,
  parseCalculationConsumptionIdParam,
  parseCalculationDateQuery,
  parseCalculationLimitQuery,
  parseCalculationMeterIdParam,
  parseCalculationStatusQuery,
  parseCalculationTenantIdParam,
  parseCalculationUtilityTypeQuery,
  parseCalculationUuidQuery,
  parseCreateUtilityCalculationBasisBody,
  parseRecalculateUtilityValueBody,
  parseUtilityCalculationIdParam,
} from './utility-calculation.validation';

/** BE-18I — Utility Calculation HTTP handlers. */

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

/** Shared `?meterId=&tenantCompanyId=&buildingId=&status=&utilityType=&from=&to=&limit=`. */
function parseFilters(req: Request): UtilityCalculationFilters {
  const query = req.query as Record<string, unknown>;
  const filters: UtilityCalculationFilters = {};

  const meterId = parseCalculationUuidQuery(
    queryString(query.meterId),
    'meterId',
    'Meter id',
  );
  if (meterId !== undefined) {
    filters.meterId = meterId;
  }

  const tenantCompanyId = parseCalculationUuidQuery(
    queryString(query.tenantCompanyId),
    'tenantCompanyId',
    'Tenant company id',
  );
  if (tenantCompanyId !== undefined) {
    filters.tenantCompanyId = tenantCompanyId;
  }

  const buildingId = parseCalculationUuidQuery(
    queryString(query.buildingId),
    'buildingId',
    'Building id',
  );
  if (buildingId !== undefined) {
    filters.buildingId = buildingId;
  }

  const status = parseCalculationStatusQuery(queryString(query.status));
  if (status !== undefined) {
    filters.status = status;
  }

  const utilityType = parseCalculationUtilityTypeQuery(
    queryString(query.utilityType),
  );
  if (utilityType !== undefined) {
    filters.utilityType = utilityType;
  }

  const from = parseCalculationDateQuery(queryString(query.from), 'from');
  if (from !== undefined) {
    filters.from = from;
  }

  const to = parseCalculationDateQuery(queryString(query.to), 'to');
  if (to !== undefined) {
    filters.to = to;
  }

  const limit = parseCalculationLimitQuery(queryString(query.limit));
  if (limit !== undefined) {
    filters.limit = limit;
  }

  return filters;
}

/* -------------------------------------------------------------------------
 * Calculation basis
 * ---------------------------------------------------------------------- */

/** POST /clients/:clientId/utility-calculation-bases */
export async function createUtilityCalculationBasisHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseCalculationClientIdParam(
      paramString(req.params.clientId),
    );
    const body = parseCreateUtilityCalculationBasisBody(req.body);
    const basis = await utilityCalculationService.createUtilityCalculationBasis(
      { clientId, ...body },
      req.auth?.userId,
    );
    sendSuccess(res, basis, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /clients/:clientId/utility-calculation-bases */
export async function listUtilityCalculationBasesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseCalculationClientIdParam(
      paramString(req.params.clientId),
    );
    const query = req.query as Record<string, unknown>;
    const filters: UtilityCalculationBasisFilters = {};

    const utilityType = parseCalculationUtilityTypeQuery(
      queryString(query.utilityType),
    );
    if (utilityType !== undefined) {
      filters.utilityType = utilityType;
    }
    const status = parseCalculationBasisStatusQuery(queryString(query.status));
    if (status !== undefined) {
      filters.status = status;
    }

    const bases = await utilityCalculationService.listUtilityCalculationBases(
      clientId,
      filters,
      req.auth?.userId,
    );
    sendSuccess(res, bases);
  } catch (error) {
    next(error);
  }
}

/* -------------------------------------------------------------------------
 * Calculation
 * ---------------------------------------------------------------------- */

/** POST /utility/consumptions/:id/calculations */
export async function calculateUtilityValueHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const consumptionId = parseCalculationConsumptionIdParam(
      paramString(req.params.id),
    );
    const body = parseCalculateUtilityValueBody(req.body);
    const calculation = await utilityCalculationService.calculateUtilityValue(
      {
        consumptionId,
        ...body,
        ...(req.auth?.userId ? { calculatedByUserId: req.auth.userId } : {}),
      },
      req.auth?.userId,
    );
    sendSuccess(res, calculation, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/consumptions/:id/calculations — full history for a consumption. */
export async function listConsumptionCalculationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const consumptionId = parseCalculationConsumptionIdParam(
      paramString(req.params.id),
    );
    const calculations =
      await utilityCalculationService.listCalculationsByConsumption(
        consumptionId,
        req.auth?.userId,
      );
    sendSuccess(res, calculations);
  } catch (error) {
    next(error);
  }
}

/** POST /utility/calculations/:id/recalculate */
export async function recalculateUtilityValueHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const calculationId = parseUtilityCalculationIdParam(
      paramString(req.params.id),
    );
    const body = parseRecalculateUtilityValueBody(req.body);
    const calculation = await utilityCalculationService.recalculateUtilityValue(
      {
        calculationId,
        ...body,
        ...(req.auth?.userId ? { calculatedByUserId: req.auth.userId } : {}),
      },
      req.auth?.userId,
    );
    sendSuccess(res, calculation, 201);
  } catch (error) {
    next(error);
  }
}

/** POST /utility/calculations/:id/finalize */
export async function finalizeUtilityCalculationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const calculationId = parseUtilityCalculationIdParam(
      paramString(req.params.id),
    );
    const calculation =
      await utilityCalculationService.finalizeUtilityCalculation(
        calculationId,
        req.auth?.userId,
      );
    sendSuccess(res, calculation);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/calculations/:id */
export async function getUtilityCalculationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const calculationId = parseUtilityCalculationIdParam(
      paramString(req.params.id),
    );
    const calculation =
      await utilityCalculationService.getUtilityCalculationById(
        calculationId,
        req.auth?.userId,
      );
    sendSuccess(res, calculation);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/meters/:id/calculations */
export async function listMeterCalculationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterId = parseCalculationMeterIdParam(paramString(req.params.id));
    const calculations =
      await utilityCalculationService.listCalculationsByMeter(
        meterId,
        parseFilters(req),
        req.auth?.userId,
      );
    sendSuccess(res, calculations);
  } catch (error) {
    next(error);
  }
}

/** GET /buildings/:buildingId/utility-calculations */
export async function listBuildingCalculationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseCalculationBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const calculations =
      await utilityCalculationService.listCalculationsByBuilding(
        buildingId,
        parseFilters(req),
        req.auth?.userId,
      );
    sendSuccess(res, calculations);
  } catch (error) {
    next(error);
  }
}

/** GET /tenant-companies/:tenantCompanyId/utility-calculations */
export async function listTenantCalculationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tenantCompanyId = parseCalculationTenantIdParam(
      paramString(req.params.tenantCompanyId),
    );
    const calculations =
      await utilityCalculationService.listCalculationsByTenantCompany(
        tenantCompanyId,
        parseFilters(req),
        req.auth?.userId,
      );
    sendSuccess(res, calculations);
  } catch (error) {
    next(error);
  }
}
