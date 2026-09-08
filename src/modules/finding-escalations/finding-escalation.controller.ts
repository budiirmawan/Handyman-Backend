import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { findingEscalationService } from './finding-escalation.service';
import {
  parseCreateFindingEscalationBody,
  parseFindingEscalationFilters,
  parseFindingEscalationIdParam,
  parseUpdateFindingEscalationBody,
} from './finding-escalation.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createFindingEscalationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await findingEscalationService.createFindingEscalation(
        parseCreateFindingEscalationBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getFindingEscalationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await findingEscalationService.getFindingEscalation(
        parseFindingEscalationIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listFindingEscalationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await findingEscalationService.listFindingEscalations(
        parseFindingEscalationFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateFindingEscalationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await findingEscalationService.updateFindingEscalation(
        parseFindingEscalationIdParam(param(req.params.id)),
        parseUpdateFindingEscalationBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
