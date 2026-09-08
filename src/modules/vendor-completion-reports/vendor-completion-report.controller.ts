import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { vendorCompletionReportService } from './vendor-completion-report.service';
import {
  parseCompletionReportFilters,
  parseCompletionReportIdParam,
  parseCreateCompletionReportBody,
  parseUpdateCompletionReportBody,
} from './vendor-completion-report.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** POST /vendor-completion-reports */
export async function createCompletionReportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseCreateCompletionReportBody(req.body);
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const report = await vendorCompletionReportService.createCompletionReport(
      {
        vendorWorkId: body.vendorWorkId,
        summary: body.summary,
        notes: body.notes,
        createdByUserId: req.auth.userId,
      },
      req.auth.userId,
    );
    sendSuccess(res, report, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /vendor-completion-reports/:reportId */
export async function getCompletionReportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const reportId = parseCompletionReportIdParam(
      paramString(req.params.reportId),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await vendorCompletionReportService.getCompletionReport(
        reportId,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /vendor-completion-reports?vendorWorkId= & vendorId= & buildingId= */
export async function listCompletionReportsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseCompletionReportFilters(
      req.query as Record<string, unknown>,
    );

    if (filters.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filters.buildingId,
      );
    }
    const accessibleBuildingIds =
      await contextAccessService.getAccessibleBuildingIds(req.auth.userId);

    const reports = await vendorCompletionReportService.listCompletionReports(
      filters,
      req.auth.userId,
      accessibleBuildingIds,
    );
    sendSuccess(res, reports);
  } catch (error) {
    next(error);
  }
}

/** PATCH /vendor-completion-reports/:reportId */
export async function updateCompletionReportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const reportId = parseCompletionReportIdParam(
      paramString(req.params.reportId),
    );
    const body = parseUpdateCompletionReportBody(req.body);
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await vendorCompletionReportService.updateCompletionReport(
        reportId,
        body,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** POST /vendor-completion-reports/:reportId/submit */
export async function submitCompletionReportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const reportId = parseCompletionReportIdParam(
      paramString(req.params.reportId),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await vendorCompletionReportService.submitCompletionReport(
        reportId,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
