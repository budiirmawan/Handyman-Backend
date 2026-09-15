import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { incidentClosureService } from './incident-closure.service';
import {
  parseCloseIncidentBody,
  parseClosureFilters,
  parseIncidentIdParam,
} from './incident-closure.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

/** BE-21K — computed closure readiness, with the blockers that justify it. */
export async function getClosureStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await incidentClosureService.getClosureStatus(
        parseIncidentIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function closeIncidentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await incidentClosureService.closeIncident(
        parseIncidentIdParam(param(req.params.id)),
        parseCloseIncidentBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listClosureStatusesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await incidentClosureService.listClosureStatuses(
        parseClosureFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
