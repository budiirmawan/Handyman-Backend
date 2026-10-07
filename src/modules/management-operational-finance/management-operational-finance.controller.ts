import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { parseOperationalBudgetIdParam } from '../operational-finance';
import { managementOperationalFinanceService } from './management-operational-finance.service';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function getManagementOperationalBudgetSummaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await managementOperationalFinanceService.getManagementOperationalBudgetSummary(
        parseOperationalBudgetIdParam(param(req.params.budgetId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getManagementOperationalBudgetCategoriesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await managementOperationalFinanceService.getManagementOperationalBudgetCategories(
        parseOperationalBudgetIdParam(param(req.params.budgetId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
