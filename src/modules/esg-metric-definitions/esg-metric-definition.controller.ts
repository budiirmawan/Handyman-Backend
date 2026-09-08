import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { esgMetricDefinitionService } from './esg-metric-definition.service';
import {
  parseCreateEsgMetricDefinitionBody,
  parseEsgMetricDefinitionFilters,
  parseEsgMetricDefinitionIdParam,
  parseUpdateEsgMetricDefinitionBody,
} from './esg-metric-definition.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createEsgMetricDefinitionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await esgMetricDefinitionService.createEsgMetricDefinition(
        parseCreateEsgMetricDefinitionBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getEsgMetricDefinitionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await esgMetricDefinitionService.getEsgMetricDefinition(
        parseEsgMetricDefinitionIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listEsgMetricDefinitionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await esgMetricDefinitionService.listEsgMetricDefinitions(
        parseEsgMetricDefinitionFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateEsgMetricDefinitionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await esgMetricDefinitionService.updateEsgMetricDefinition(
        parseEsgMetricDefinitionIdParam(param(req.params.id)),
        parseUpdateEsgMetricDefinitionBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function deactivateEsgMetricDefinitionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await esgMetricDefinitionService.deactivateEsgMetricDefinition(
        parseEsgMetricDefinitionIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
