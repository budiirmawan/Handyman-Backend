import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { operationalFinanceBindingService } from './operational-finance-binding.service';
import {
  parseCreateOperationalBudgetSourceBindingBody,
  parseOperationalBudgetIdParam,
  parseOperationalBudgetSourceBindingIdParam,
} from './operational-finance.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createOperationalBudgetSourceBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalFinanceBindingService.createOperationalBudgetSourceBinding(
        parseOperationalBudgetIdParam(param(req.params.budgetId)),
        parseCreateOperationalBudgetSourceBindingBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getOperationalBudgetSourceBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalFinanceBindingService.getOperationalBudgetSourceBinding(
        parseOperationalBudgetSourceBindingIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listOperationalBudgetSourceBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalFinanceBindingService.listOperationalBudgetSourceBindings(
        parseOperationalBudgetIdParam(param(req.params.budgetId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function removeOperationalBudgetSourceBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalFinanceBindingService.removeOperationalBudgetSourceBinding(
        parseOperationalBudgetSourceBindingIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
