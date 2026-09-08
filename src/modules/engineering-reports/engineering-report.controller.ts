import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { engineeringReportService } from './engineering-report.service';
import {
  BINDING_REPORT_STATUSES,
  BREAKDOWN_REPORT_STATUSES,
  EXECUTION_REPORT_STATUSES,
  FINDING_REPORT_STATUSES,
  parseReportQuery,
} from './engineering-report.validation';

function queryOf(req: Request): Record<string, unknown> {
  return req.query as Record<string, unknown>;
}

function requireUser(req: Request): string {
  if (!req.auth) {
    throw authenticationRequiredError();
  }
  return req.auth.userId;
}

/** GET /engineering/reports/technical-summary */
export async function technicalSummaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseReportQuery(queryOf(req));
    sendSuccess(
      res,
      await engineeringReportService.getTechnicalSummary(filters, requireUser(req)),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/reports/inspections */
export async function inspectionDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseReportQuery(queryOf(req), {
      allowedStatuses: BINDING_REPORT_STATUSES,
    });
    sendSuccess(
      res,
      await engineeringReportService.getInspectionDataset(filters, requireUser(req)),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/reports/meter-readings */
export async function meterReadingDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseReportQuery(queryOf(req), {
      allowedStatuses: BINDING_REPORT_STATUSES,
    });
    sendSuccess(
      res,
      await engineeringReportService.getMeterReadingDataset(filters, requireUser(req)),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/reports/equipment-logs */
export async function equipmentLogDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseReportQuery(queryOf(req), {
      allowedStatuses: EXECUTION_REPORT_STATUSES,
    });
    sendSuccess(
      res,
      await engineeringReportService.getEquipmentLogDataset(filters, requireUser(req)),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/reports/checklists */
export async function checklistDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseReportQuery(queryOf(req), {
      allowedStatuses: EXECUTION_REPORT_STATUSES,
    });
    sendSuccess(
      res,
      await engineeringReportService.getChecklistDataset(filters, requireUser(req)),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/reports/breakdowns */
export async function breakdownDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseReportQuery(queryOf(req), {
      allowedStatuses: BREAKDOWN_REPORT_STATUSES,
    });
    sendSuccess(
      res,
      await engineeringReportService.getBreakdownDataset(filters, requireUser(req)),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/reports/maintenance */
export async function maintenanceDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseReportQuery(queryOf(req), {
      allowedStatuses: BINDING_REPORT_STATUSES,
    });
    sendSuccess(
      res,
      await engineeringReportService.getMaintenanceDataset(filters, requireUser(req)),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/reports/findings */
export async function findingDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseReportQuery(queryOf(req), {
      allowedStatuses: FINDING_REPORT_STATUSES,
    });
    sendSuccess(
      res,
      await engineeringReportService.getFindingDataset(filters, requireUser(req)),
    );
  } catch (error) {
    next(error);
  }
}
