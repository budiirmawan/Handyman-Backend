import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { workforceKpiService } from './workforce-kpi.service';
import { parseWorkforceKpiQuery } from './workforce-kpi.validation';

/**
 * BE-23G — Workforce KPI controller.
 *
 * GET /workforce/reports/kpi
 */
export async function workforceKpiHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseWorkforceKpiQuery(req.query as Record<string, unknown>);
    sendSuccess(
      res,
      await workforceKpiService.getWorkforceKpi(filters, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}
