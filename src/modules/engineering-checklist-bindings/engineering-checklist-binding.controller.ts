import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { engineeringChecklistBindingService } from './engineering-checklist-binding.service';
import {
  parseBindingIdParam,
  parseCreateEngineeringChecklistBindingBody,
  parseExecutionIdParam,
  parseListEngineeringChecklistQuery,
  parseUpdateEngineeringChecklistBindingBody,
} from './engineering-checklist-binding.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** POST /engineering/checklist-bindings */
export async function createEngineeringChecklistBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseCreateEngineeringChecklistBindingBody(
      req.body as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const binding =
      await engineeringChecklistBindingService.createEngineeringChecklistBinding(
        {
          buildingId: body.buildingId,
          checklistTemplateId: body.checklistTemplateId,
          assetId: body.assetId,
          functionalLocationId: body.functionalLocationId,
          status: body.status,
          createdByUserId: req.auth.userId,
        },
        req.auth.userId,
      );

    sendSuccess(res, binding, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/checklist-bindings?buildingId=&assetId= */
export async function listEngineeringChecklistBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseListEngineeringChecklistQuery(
      req.query as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const bindings =
      await engineeringChecklistBindingService.listEngineeringChecklistBindings(
        filters,
        req.auth.userId,
      );
    sendSuccess(res, bindings);
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/checklist-bindings/:id */
export async function getEngineeringChecklistBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await engineeringChecklistBindingService.getEngineeringChecklistBinding(
        id,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** PATCH /engineering/checklist-bindings/:id */
export async function updateEngineeringChecklistBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    const body = parseUpdateEngineeringChecklistBindingBody(
      req.body as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await engineeringChecklistBindingService.updateEngineeringChecklistBinding(
        id,
        body,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** POST /engineering/checklist-bindings/:id/start */
export async function startEngineeringChecklistExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const execution =
      await engineeringChecklistBindingService.startEngineeringChecklistExecution(
        id,
        req.auth.userId,
      );
    sendSuccess(res, execution, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/checklist-executions/:id */
export async function getEngineeringChecklistExecutionContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseExecutionIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await engineeringChecklistBindingService.resolveEngineeringChecklistExecutionContext(
        id,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
