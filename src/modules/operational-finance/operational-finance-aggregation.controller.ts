import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { operationalFinanceAggregationService } from './operational-finance-aggregation.service';
import { parseOperationalBudgetIdParam } from './operational-finance.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

export async function getOperationalBudgetAggregationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    sendSuccess(
      res,
      await operationalFinanceAggregationService.getOperationalBudgetAggregation(
        parseOperationalBudgetIdParam(param(req.params.budgetId)),
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
