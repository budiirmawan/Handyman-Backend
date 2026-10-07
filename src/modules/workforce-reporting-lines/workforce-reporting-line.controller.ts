import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { workforceReportingLineNotFoundError } from './workforce-reporting-line.errors';
import { workforceReportingLineService } from './workforce-reporting-line.service';
import {
  parseAssignSupervisorBody,
  parseSupervisorIdParam,
  parseUpdateReportingLineBody,
  parseWorkforceIdParam,
} from './workforce-reporting-line.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function assignSupervisorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // The Workforce Profile always comes from the route, never from the body.
    const workforceProfileId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const input = parseAssignSupervisorBody(req.body);
    const reportingLine = await workforceReportingLineService.assignSupervisor({
      ...input,
      workforceProfileId,
    });
    sendSuccess(res, reportingLine, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * Current Supervisor of a Workforce Profile. A profile that exists but has no
 * effective reporting line is a 404 on the reporting line, not on the profile.
 */
export async function getCurrentSupervisorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const supervisor =
      await workforceReportingLineService.resolveCurrentSupervisor(
        workforceProfileId,
      );
    if (!supervisor) {
      throw workforceReportingLineNotFoundError();
    }
    sendSuccess(res, supervisor);
  } catch (error) {
    next(error);
  }
}

export async function listDirectReportsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const supervisorWorkforceProfileId = parseSupervisorIdParam(
      paramString(req.params.supervisorId),
    );
    const reports = await workforceReportingLineService.listDirectReports(
      supervisorWorkforceProfileId,
    );
    sendSuccess(res, reports);
  } catch (error) {
    next(error);
  }
}

/**
 * Updates a reporting line. Deactivation is the same endpoint with
 * `{ "status": "INACTIVE" }` — the row is kept so the history survives.
 */
export async function updateReportingLineHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const input = parseUpdateReportingLineBody(req.body);
    const reportingLine =
      await workforceReportingLineService.updateReportingLine(
        workforceProfileId,
        input,
      );
    sendSuccess(res, reportingLine);
  } catch (error) {
    next(error);
  }
}
