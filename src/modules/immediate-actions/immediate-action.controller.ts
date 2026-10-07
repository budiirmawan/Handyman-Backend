import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { immediateActionService } from './immediate-action.service';
import {
  parseCompleteImmediateActionBody,
  parseCreateImmediateActionBody,
  parseImmediateActionFilters,
  parseImmediateActionIdParam,
  parseUpdateImmediateActionBody,
} from './immediate-action.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createImmediateActionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await immediateActionService.createImmediateAction(
        parseCreateImmediateActionBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getImmediateActionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await immediateActionService.getImmediateAction(
        parseImmediateActionIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listImmediateActionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await immediateActionService.listImmediateActions(
        parseImmediateActionFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateImmediateActionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await immediateActionService.updateImmediateAction(
        parseImmediateActionIdParam(param(req.params.id)),
        parseUpdateImmediateActionBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function startImmediateActionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await immediateActionService.transitionImmediateAction(
        parseImmediateActionIdParam(param(req.params.id)),
        'IN_PROGRESS',
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function completeImmediateActionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await immediateActionService.completeImmediateAction(
        parseImmediateActionIdParam(param(req.params.id)),
        parseCompleteImmediateActionBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function cancelImmediateActionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await immediateActionService.transitionImmediateAction(
        parseImmediateActionIdParam(param(req.params.id)),
        'CANCELLED',
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
