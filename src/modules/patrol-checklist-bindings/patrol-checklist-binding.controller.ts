import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { patrolChecklistBindingService } from './patrol-checklist-binding.service';
import {
  parseBindingIdParam,
  parseCreatePatrolChecklistBindingBody,
  parseExecutionIdParam,
  parsePatrolChecklistBindingFilter,
  parseUpdatePatrolChecklistBindingBody,
} from './patrol-checklist-binding.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/** POST /security/patrol-checklist-bindings */
export async function createPatrolChecklistBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const body = parseCreatePatrolChecklistBindingBody(req.body);
    const binding =
      await patrolChecklistBindingService.createPatrolChecklistBinding(
        {
          ...body,
          createdByUserId: req.auth.userId,
        },
        req.auth.userId,
      );
    sendSuccess(res, binding, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /security/patrol-checklist-bindings */
export async function listPatrolChecklistBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parsePatrolChecklistBindingFilter(
      req.query as Record<string, unknown>,
    );
    const bindings =
      await patrolChecklistBindingService.listPatrolChecklistBindings(
        filters,
        req.auth.userId,
      );
    sendSuccess(res, bindings);
  } catch (error) {
    next(error);
  }
}

/** GET /security/patrol-checklist-bindings/:id */
export async function getPatrolChecklistBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseBindingIdParam(paramString(req.params.id));
    const binding =
      await patrolChecklistBindingService.getPatrolChecklistBinding(
        id,
        req.auth.userId,
      );
    sendSuccess(res, binding);
  } catch (error) {
    next(error);
  }
}

/** PATCH /security/patrol-checklist-bindings/:id */
export async function updatePatrolChecklistBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseBindingIdParam(paramString(req.params.id));
    const body = parseUpdatePatrolChecklistBindingBody(req.body);
    const binding =
      await patrolChecklistBindingService.updatePatrolChecklistBinding(
        id,
        body,
        req.auth.userId,
      );
    sendSuccess(res, binding);
  } catch (error) {
    next(error);
  }
}

/** POST /security/patrol-checklist-bindings/:id/start */
export async function startPatrolChecklistExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseBindingIdParam(paramString(req.params.id));
    const execution =
      await patrolChecklistBindingService.startPatrolChecklistExecution(
        id,
        req.auth.userId,
      );
    sendSuccess(res, execution, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /security/patrol-checklist-executions/:id */
export async function getPatrolChecklistExecutionContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseExecutionIdParam(paramString(req.params.id));
    const context =
      await patrolChecklistBindingService.resolvePatrolChecklistExecutionContext(
        id,
        req.auth.userId,
      );
    sendSuccess(res, context);
  } catch (error) {
    next(error);
  }
}
