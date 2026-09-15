import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  authenticationRequiredError,
  permissionDeniedError,
} from '../auth';
import { permissionService } from '../permissions';
import { getReportingExportDatasetAdapter } from './reporting-export.registry';
import { reportingExportService } from './reporting-export.service';
import { parseReportingExportQuery } from './reporting-export.validation';

/**
 * BE-23J — Export Dataset controller.
 *
 * GET /reports/export
 *
 * Authority is two-layered and fail-closed:
 *
 *   1. the route gate requires authentication plus `reporting_export.read`
 *      (delivery permission for this endpoint), and
 *   2. this handler requires the selected adapter's own
 *      `requiredReadPermission` (dataset capability permission).
 *
 * R13 FIX 01 — the second layer is REGISTRY-DRIVEN. The Reporting adapter
 * registry stays the single dataset capability declaration: the permission
 * asserted here is read off the selected adapter, so no dataset→permission
 * map is duplicated, no permission is inferred from a dataset name, and a
 * dataset cannot be reached through the JSON path under a narrower authority
 * than the archive generation path already enforces. Because the Management
 * Operations Command Center dataset declares `management_read_model.read` as
 * its own `requiredReadPermission`, it keeps that requirement through this
 * same rule and needs no dataset-specific branch.
 *
 * Ordering is deliberate: authenticate, validate the dataset (unknown dataset
 * stays a 400), obtain the adapter, resolve the caller's permissions, then
 * assert the dataset capability — and only then execute. A denied caller
 * never reaches dataset execution, and the denial is the shared
 * `permissionDeniedError()` (403) carrying no permission-resolution detail.
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
    const adapter = getReportingExportDatasetAdapter(filters.dataset);
    const permissions = await permissionService.resolvePermissionsForUser(
      req.auth.userId,
    );
    if (!permissions.includes(adapter.requiredReadPermission)) {
      throw permissionDeniedError();
    }
    sendSuccess(
      res,
      await reportingExportService.getReportingExport(filters, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}
