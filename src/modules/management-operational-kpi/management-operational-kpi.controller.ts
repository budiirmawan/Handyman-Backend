import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementOperationalKpiService } from './management-operational-kpi.service';
import { parseManagementOperationalKpiQuery } from './management-operational-kpi.validation';

/** GET /management/operational-kpi — BE-24 PART 07. */
export async function getManagementOperationalKpiHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementOperationalKpiQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementOperationalKpiService.getManagementOperationalKpi(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
