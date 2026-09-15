import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { operationalFinanceBindingService } from './operational-finance-binding.service';
import { operationalFinanceService } from './operational-finance.service';
import {
  parseCreateOperationalBudgetBody,
  parseCreateOperationalBudgetCategoryBody,
  parseCreateOperationalBudgetSourceBindingBody,
  parseOperationalBudgetBuildingIdParam,
  parseOperationalBudgetCategoryIdParam,
  parseOperationalBudgetFilters,
  parseOperationalBudgetIdParam,
  parseOperationalBudgetSourceBindingIdParam,
  parseUpdateOperationalBudgetBody,
  parseUpdateOperationalBudgetCategoryBody,
} from './operational-finance.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createOperationalBudgetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalFinanceService.createOperationalBudget(
        parseOperationalBudgetBuildingIdParam(param(req.params.buildingId)),
        parseCreateOperationalBudgetBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listOperationalBudgetsHandler(
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
      await operationalFinanceService.listOperationalBudgets(filters, actor(req)),
    );
  } catch (error) {
    next(error);
  }
}

export async function getOperationalBudgetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalFinanceService.getOperationalBudget(
        parseOperationalBudgetIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateOperationalBudgetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalFinanceService.updateOperationalBudget(
        parseOperationalBudgetIdParam(param(req.params.id)),
        parseUpdateOperationalBudgetBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function activateOperationalBudgetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalFinanceService.activateOperationalBudget(
        parseOperationalBudgetIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function closeOperationalBudgetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalFinanceService.closeOperationalBudget(
        parseOperationalBudgetIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function cancelOperationalBudgetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalFinanceService.cancelOperationalBudget(
        parseOperationalBudgetIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function createOperationalBudgetCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalFinanceService.createOperationalBudgetCategory(
        parseOperationalBudgetIdParam(param(req.params.budgetId)),
        parseCreateOperationalBudgetCategoryBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listOperationalBudgetCategoriesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalFinanceService.listOperationalBudgetCategories(
        parseOperationalBudgetIdParam(param(req.params.budgetId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getOperationalBudgetCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalFinanceService.getOperationalBudgetCategory(
        parseOperationalBudgetCategoryIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateOperationalBudgetCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalFinanceService.updateOperationalBudgetCategory(
        parseOperationalBudgetCategoryIdParam(param(req.params.id)),
        parseUpdateOperationalBudgetCategoryBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function deleteOperationalBudgetCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await operationalFinanceService.deleteOperationalBudgetCategory(
      parseOperationalBudgetCategoryIdParam(param(req.params.id)),
      actor(req),
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}
