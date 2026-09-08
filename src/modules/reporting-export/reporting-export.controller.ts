import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  authenticationRequiredError,
  permissionDeniedError,
} from '../auth';
import { permissionService } from '../permissions';
import { reportingExportService } from './reporting-export.service';
import { isManagementReportingExportDataset } from './reporting-export.types';
import { parseReportingExportQuery } from './reporting-export.validation';

/**
 * BE-23J — Export Dataset controller.
 *
 * GET /reports/export
 *
 * Responds with JSON only. No file streaming, no attachment headers, no
 * binary encoding — turning the envelope into a CSV/XLSX/PDF document is
 * the consumer's responsibility, not the backend's.
 */
export async function reportingExportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseReportingExportQuery(
      req.query as Record<string, unknown>,
    );
    if (isManagementReportingExportDataset(filters.dataset)) {
      const permissions = await permissionService.resolvePermissionsForUser(
        req.auth.userId,
      );
      if (!permissions.includes('management_read_model.read')) {
        throw permissionDeniedError();
      }
    }
    sendSuccess(
      res,
      await reportingExportService.getReportingExport(filters, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}
