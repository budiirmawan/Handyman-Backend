import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { esgMetricValueService } from './esg-metric-value.service';
import {
  parseCreateEsgMetricValueBody,
  parseEsgMetricValueFilters,
  parseEsgMetricValueIdParam,
  parseUpdateEsgMetricValueBody,
} from './esg-metric-value.validation';

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? '' : v ?? '';
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createEsgMetricValueHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await esgMetricValueService.createEsgMetricValue(
        parseCreateEsgMetricValueBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (e) {
    next(e);
  }
}

export async function getEsgMetricValueHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await esgMetricValueService.getEsgMetricValue(
        parseEsgMetricValueIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (e) {
    next(e);
  }
}

export async function listEsgMetricValuesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await esgMetricValueService.listEsgMetricValues(
        parseEsgMetricValueFilters(req.query),
        actor(req),
      ),
    );
  } catch (e) {
    next(e);
  }
}

export async function updateEsgMetricValueHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await esgMetricValueService.updateEsgMetricValue(
        parseEsgMetricValueIdParam(param(req.params.id)),
        parseUpdateEsgMetricValueBody(req.body),
        actor(req),
      ),
    );
  } catch (e) {
    next(e);
  }
}
