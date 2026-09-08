import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { investigationReadinessService } from './investigation-readiness.service';
import {
  parseIncidentIdParam,
  parseInvestigationReadinessFilters,
} from './investigation-readiness.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function getInvestigationReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await investigationReadinessService.getInvestigationReadiness(
        parseIncidentIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listInvestigationReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await investigationReadinessService.listInvestigationReadiness(
        parseInvestigationReadinessFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
