import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { operationalIncidentService } from './operational-incident.service';
import {
  parseCreateOperationalIncidentBody,
  parseOperationalIncidentFilters,
  parseOperationalIncidentIdParam,
  parseUpdateOperationalIncidentBody,
} from './operational-incident.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createOperationalIncidentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalIncidentService.createOperationalIncident(
        parseCreateOperationalIncidentBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getOperationalIncidentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalIncidentService.getOperationalIncident(
        parseOperationalIncidentIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listOperationalIncidentsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalIncidentService.listOperationalIncidents(
        parseOperationalIncidentFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateOperationalIncidentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalIncidentService.updateOperationalIncident(
        parseOperationalIncidentIdParam(param(req.params.id)),
        parseUpdateOperationalIncidentBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
