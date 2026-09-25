import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { safetyFieldReportService } from './safety-field-report.service';
import {
  parseCreateSafetyFieldReportBody,
  parseSafetyFieldReportIncidentIdParam,
} from './safety-field-report.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createSafetyFieldReportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await safetyFieldReportService.createSafetyFieldReport(
        parseCreateSafetyFieldReportBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getSafetyFieldReportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await safetyFieldReportService.getSafetyFieldReport(
        parseSafetyFieldReportIncidentIdParam(param(req.params.incidentId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
