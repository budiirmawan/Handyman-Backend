import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { parseManagementBuildingOperationalFinanceQuery } from './management-building-operational-finance.validation';
import { managementBuildingOperationalFinanceService } from './management-building-operational-finance.service';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

export async function getManagementBuildingOperationalFinanceSummaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementBuildingOperationalFinanceQuery(
      param(req.params.buildingId),
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementBuildingOperationalFinanceService.getManagementBuildingOperationalFinanceSummary(
        query.buildingId,
        query.periodStart,
        query.periodEnd,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
