import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { vendorServiceReportService } from './vendor-service-report.service';
import {
  parseCreateServiceReportBody,
  parseServiceReportFilters,
  parseServiceReportIdParam,
  parseUpdateServiceReportBody,
} from './vendor-service-report.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** POST /vendor-service-reports */
export async function createServiceReportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseCreateServiceReportBody(req.body);
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const report = await vendorServiceReportService.createServiceReport(
      {
        vendorWorkId: body.vendorWorkId,
        serviceReportNumber: body.serviceReportNumber,
        serviceDate: body.serviceDate,
        summary: body.summary,
        workPerformed: body.workPerformed,
        recommendation: body.recommendation,
        preparedByUserId: req.auth.userId,
      },
      req.auth.userId,
    );
    sendSuccess(res, report, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /vendor-service-reports/:reportId */
export async function getServiceReportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const reportId = parseServiceReportIdParam(paramString(req.params.reportId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await vendorServiceReportService.getServiceReport(
        reportId,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /vendor-service-reports?vendorWorkId= & vendorId= & buildingId= */
export async function listServiceReportsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseServiceReportFilters(
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

    const reports = await vendorServiceReportService.listServiceReports(
      filters,
      req.auth.userId,
      accessibleBuildingIds,
    );
    sendSuccess(res, reports);
  } catch (error) {
    next(error);
  }
}

/** PATCH /vendor-service-reports/:reportId */
export async function updateServiceReportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const reportId = parseServiceReportIdParam(paramString(req.params.reportId));
    const body = parseUpdateServiceReportBody(req.body);
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await vendorServiceReportService.updateServiceReport(
        reportId,
        body,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** POST /vendor-service-reports/:reportId/finalize */
export async function finalizeServiceReportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const reportId = parseServiceReportIdParam(paramString(req.params.reportId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await vendorServiceReportService.finalizeServiceReport(
        reportId,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
