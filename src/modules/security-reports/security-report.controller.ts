import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { securityReportService } from './security-report.service';
import {
  BINDING_REPORT_STATUSES,
  EXECUTION_REPORT_STATUSES,
  FINDING_REPORT_STATUSES,
  HANDOVER_REPORT_STATUSES,
  INCIDENT_READINESS_REPORT_STATUSES,
  KEY_REPORT_STATUSES,
  LOST_FOUND_REPORT_STATUSES,
  parseReportQuery,
  PATROL_REPORT_STATUSES,
  POST_REPORT_STATUSES,
} from './security-report.validation';

function queryOf(req: Request): Record<string, unknown> {
  return req.query as Record<string, unknown>;
}

function requireUser(req: Request): string {
  if (!req.auth) {
    throw authenticationRequiredError();
  }
  return req.auth.userId;
}

/** GET /security/reports/summary */
export async function securitySummaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Summary does NOT require buildingId; it may roll up across
    // every accessible building.
    const filters = parseReportQuery(queryOf(req));
    sendSuccess(
      res,
      await securityReportService.getSecuritySummary(filters, requireUser(req)),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /security/reports/patrols */
export async function patrolDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseReportQuery(queryOf(req), {
      allowedStatuses: PATROL_REPORT_STATUSES,
    });
    sendSuccess(
      res,
      await securityReportService.getPatrolDataset(filters, requireUser(req)),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /security/reports/security-posts */
export async function securityPostDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseReportQuery(queryOf(req), {
      allowedStatuses: POST_REPORT_STATUSES,
    });
    sendSuccess(
      res,
      await securityReportService.getSecurityPostDataset(filters, requireUser(req)),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /security/reports/findings */
export async function securityFindingDatasetHandler(
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
      await securityReportService.getSecurityFindingDataset(
        filters,
        requireUser(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /security/reports/shift-handovers */
export async function shiftHandoverDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseReportQuery(queryOf(req), {
      allowedStatuses: HANDOVER_REPORT_STATUSES,
    });
    sendSuccess(
      res,
      await securityReportService.getShiftHandoverDataset(
        filters,
        requireUser(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /security/reports/incident-readiness */
export async function incidentReadinessDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseReportQuery(queryOf(req), {
      allowedStatuses: INCIDENT_READINESS_REPORT_STATUSES,
    });
    sendSuccess(
      res,
      await securityReportService.getIncidentReadinessDataset(
        filters,
        requireUser(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /security/reports/visitor-bindings */
export async function visitorBindingDatasetHandler(
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
      await securityReportService.getVisitorBindingDataset(
        filters,
        requireUser(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /security/reports/keys */
export async function keyControlDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseReportQuery(queryOf(req), {
      allowedStatuses: KEY_REPORT_STATUSES,
    });
    sendSuccess(
      res,
      await securityReportService.getKeyControlDataset(filters, requireUser(req)),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /security/reports/lost-found */
export async function lostFoundDatasetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseReportQuery(queryOf(req), {
      allowedStatuses: LOST_FOUND_REPORT_STATUSES,
    });
    sendSuccess(
      res,
      await securityReportService.getLostFoundDataset(filters, requireUser(req)),
    );
  } catch (error) {
    next(error);
  }
}
