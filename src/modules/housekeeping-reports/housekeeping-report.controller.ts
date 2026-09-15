import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { housekeepingReportService } from './housekeeping-report.service';
import { parseHousekeepingReportFilters } from './housekeeping-report.validation';

export async function housekeepingSummaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseHousekeepingReportFilters(
      req.query as Record<string, unknown>,
    );
    const summary = await housekeepingReportService.getHousekeepingSummary(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, summary);
  } catch (error) {
    next(error);
  }
}

export async function cleaningDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseHousekeepingReportFilters(
      req.query as Record<string, unknown>,
    );
    const dataset = await housekeepingReportService.getCleaningDataset(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, dataset);
  } catch (error) {
    next(error);
  }
}

export async function inspectionDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseHousekeepingReportFilters(
      req.query as Record<string, unknown>,
    );
    const dataset = await housekeepingReportService.getInspectionDataset(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, dataset);
  } catch (error) {
    next(error);
  }
}

export async function supervisorInspectionDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseHousekeepingReportFilters(
      req.query as Record<string, unknown>,
    );
    const dataset =
      await housekeepingReportService.getSupervisorInspectionDataset(
        filters,
        req.auth.userId,
      );
    sendSuccess(res, dataset);
  } catch (error) {
    next(error);
  }
}

export async function findingDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseHousekeepingReportFilters(
      req.query as Record<string, unknown>,
    );
    const dataset = await housekeepingReportService.getFindingDataset(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, dataset);
  } catch (error) {
    next(error);
  }
}

export async function consumableDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseHousekeepingReportFilters(
      req.query as Record<string, unknown>,
    );
    const dataset = await housekeepingReportService.getConsumableDataset(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, dataset);
  } catch (error) {
    next(error);
  }
}

export async function qualityAuditDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseHousekeepingReportFilters(
      req.query as Record<string, unknown>,
    );
    const dataset = await housekeepingReportService.getQualityAuditDataset(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, dataset);
  } catch (error) {
    next(error);
  }
}

export async function complaintDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseHousekeepingReportFilters(
      req.query as Record<string, unknown>,
    );
    const dataset = await housekeepingReportService.getComplaintDataset(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, dataset);
  } catch (error) {
    next(error);
  }
}
