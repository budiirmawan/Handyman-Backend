import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { permitWorkContextService } from './permit-work-context.service';
import {
  parseAssignPermitWorkLocationBody,
  parseAssignPermitWorkTypeBody,
  parsePermitWorkApplicationIdParam,
  parsePermitWorkContextFilters,
  parsePermitWorkPermitIdParam,
  parseUpdatePermitWorkContextBody,
} from './permit-work-context.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function assignPermitWorkLocationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitWorkContextService.assignPermitWorkLocation(
        parsePermitWorkApplicationIdParam(param(req.params.id)),
        parseAssignPermitWorkLocationBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function assignPermitWorkTypeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitWorkContextService.assignPermitWorkType(
        parsePermitWorkApplicationIdParam(param(req.params.id)),
        parseAssignPermitWorkTypeBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getApplicationWorkContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitWorkContextService.getApplicationWorkContext(
        parsePermitWorkApplicationIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getPermitWorkContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitWorkContextService.getPermitWorkContext(
        parsePermitWorkPermitIdParam(param(req.params.permitId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updatePermitWorkContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitWorkContextService.updatePermitWorkContext(
        parsePermitWorkApplicationIdParam(param(req.params.id)),
        parseUpdatePermitWorkContextBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listPermitWorkContextsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitWorkContextService.listPermitWorkContexts(
        parsePermitWorkContextFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
