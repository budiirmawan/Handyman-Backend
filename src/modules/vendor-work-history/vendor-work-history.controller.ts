import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import {
  parseVendorWorkIdParam,
  vendorWorkService,
} from '../vendor-work';
import { vendorWorkHistoryService } from './vendor-work-history.service';
import { parseVendorWorkHistoryFilters } from './vendor-work-history.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * GET /vendor-works/:id/history — enforces BE-02 Building isolation by loading
 * the Vendor Work first, then asserting access to its Building. History is
 * read-only; no event-creation endpoint is exposed.
 */
export async function getVendorWorkHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorWorkId = parseVendorWorkIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const work = await vendorWorkService.getVendorWork(vendorWorkId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      work.buildingId,
    );

    const filters = parseVendorWorkHistoryFilters(req.query);
    const history = await vendorWorkHistoryService.getVendorWorkHistory(
      vendorWorkId,
      filters,
    );
    sendSuccess(res, history);
  } catch (error) {
    next(error);
  }
}
