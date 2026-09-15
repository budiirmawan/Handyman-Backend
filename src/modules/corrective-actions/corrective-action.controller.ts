import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { correctiveActionService } from './corrective-action.service';
import {
  parseCompleteCorrectiveActionBody,
  parseCorrectiveActionFilters,
  parseCorrectiveActionIdParam,
  parseCreateCorrectiveActionBody,
  parseRejectCorrectiveActionBody,
  parseSetCorrectiveActionDueDateBody,
  parseUpdateCorrectiveActionBody,
} from './corrective-action.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createCorrectiveActionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionService.createCorrectiveAction(
        parseCreateCorrectiveActionBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getCorrectiveActionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionService.getCorrectiveAction(
        parseCorrectiveActionIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listCorrectiveActionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionService.listCorrectiveActions(
        parseCorrectiveActionFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateCorrectiveActionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionService.updateCorrectiveAction(
        parseCorrectiveActionIdParam(param(req.params.id)),
        parseUpdateCorrectiveActionBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function approveCorrectiveActionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionService.approveCorrectiveAction(
        parseCorrectiveActionIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function rejectCorrectiveActionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionService.rejectCorrectiveAction(
        parseCorrectiveActionIdParam(param(req.params.id)),
        parseRejectCorrectiveActionBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function startCorrectiveActionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionService.startCorrectiveAction(
        parseCorrectiveActionIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function completeCorrectiveActionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionService.completeCorrectiveAction(
        parseCorrectiveActionIdParam(param(req.params.id)),
        parseCompleteCorrectiveActionBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function cancelCorrectiveActionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionService.cancelCorrectiveAction(
        parseCorrectiveActionIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

/**
 * BE-21I — set, move, or clear the deadline.
 *
 * Returns the full Corrective Action so the caller immediately sees the
 * DERIVED `dueStatus` that resulted, rather than having to re-read and
 * recompute it.
 */
export async function setCorrectiveActionDueDateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionService.setCorrectiveActionDueDate(
        parseCorrectiveActionIdParam(param(req.params.id)),
        parseSetCorrectiveActionDueDateBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** BE-21I — read the deadline and its derived state. */
export async function getCorrectiveActionDueDateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionService.getCorrectiveActionDueDate(
        parseCorrectiveActionIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
