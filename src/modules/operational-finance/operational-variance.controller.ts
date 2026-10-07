import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { operationalVarianceService } from './operational-variance.service';
import {
  parseOperationalBudgetFilters,
  parseOperationalBudgetIdParam,
} from './operational-finance.validation';

/**
 * CR-BE-COMM-VAR-01 PART 05 — read-only variance and traceability boundary.
 * Every handler is a projection: nothing here writes or mutates financial state.
 */

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function getOperationalBudgetVarianceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalVarianceService.getOperationalBudgetVariance(
        parseOperationalBudgetIdParam(param(req.params.budgetId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listOperationalBudgetVarianceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const pathBuildingId = req.params.buildingId;
    const filters = parseOperationalBudgetFilters({
      ...req.query,
      ...(pathBuildingId === undefined ? {} : { buildingId: pathBuildingId }),
    });
    sendSuccess(
      res,
      await operationalVarianceService.listOperationalBudgetVariance(
        filters,
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getOperationalBudgetTraceabilityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalVarianceService.getOperationalBudgetTraceability(
        parseOperationalBudgetIdParam(param(req.params.budgetId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
