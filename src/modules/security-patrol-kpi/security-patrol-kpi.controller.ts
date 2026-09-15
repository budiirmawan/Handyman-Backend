import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { securityPatrolKpiService } from './security-patrol-kpi.service';
import { parsePatrolKpiQuery } from './security-patrol-kpi.validation';

/**
 * BE-23F1 — Security Patrol & Activity KPI controller.
 *
 * GET /security/reports/patrol-kpi
 */
export async function securityPatrolKpiHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parsePatrolKpiQuery(req.query as Record<string, unknown>);
    sendSuccess(
      res,
      await securityPatrolKpiService.getSecurityPatrolKpi(
        filters,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
