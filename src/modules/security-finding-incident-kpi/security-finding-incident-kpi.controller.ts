import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { securityFindingIncidentKpiService } from './security-finding-incident-kpi.service';
import { parseFindingIncidentKpiQuery } from './security-finding-incident-kpi.validation';

/**
 * BE-23F2 — Security Finding / Incident / Handover KPI controller.
 *
 * GET /security/reports/finding-incident-kpi
 */
export async function securityFindingIncidentKpiHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseFindingIncidentKpiQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await securityFindingIncidentKpiService.getSecurityFindingIncidentKpi(
        filters,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
