import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { utilityKpiService } from './utility-kpi.service';
import { parseUtilityKpiQuery } from './utility-kpi.validation';

/**
 * BE-23I — Utility KPI controller.
 *
 * GET /utility/reports/kpi
 */
export async function utilityKpiHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseUtilityKpiQuery(req.query as Record<string, unknown>);
    sendSuccess(
      res,
      await utilityKpiService.getUtilityKpi(filters, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}
