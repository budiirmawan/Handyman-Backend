import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { correctiveActionResponsibilityService } from './corrective-action-responsibility.service';
import {
  parseAssignResponsiblePersonBody,
  parseCorrectiveActionIdParam,
  parseReleaseResponsiblePersonBody,
  parseResponsibilityFilters,
  parseUpdateResponsiblePersonBody,
} from './corrective-action-responsibility.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function assignResponsiblePersonHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionResponsibilityService.assignResponsiblePerson(
        parseCorrectiveActionIdParam(param(req.params.id)),
        parseAssignResponsiblePersonBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getResponsiblePersonHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionResponsibilityService.getResponsiblePerson(
        parseCorrectiveActionIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listResponsibilityHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionResponsibilityService.listResponsibilityHistory(
        parseCorrectiveActionIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listResponsibilitiesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionResponsibilityService.listResponsibilities(
        parseResponsibilityFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateResponsiblePersonHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionResponsibilityService.updateResponsiblePerson(
        parseCorrectiveActionIdParam(param(req.params.id)),
        parseUpdateResponsiblePersonBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function releaseResponsiblePersonHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionResponsibilityService.releaseResponsiblePerson(
        parseCorrectiveActionIdParam(param(req.params.id)),
        parseReleaseResponsiblePersonBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
