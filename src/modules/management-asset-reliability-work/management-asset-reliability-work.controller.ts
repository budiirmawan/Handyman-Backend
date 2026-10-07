import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementAssetReliabilityWorkService } from './management-asset-reliability-work.service';
import { parseManagementAssetReliabilityWorkQuery } from './management-asset-reliability-work.validation';

/** GET /management/asset-reliability-work — BE-24 PART 05B. */
export async function getManagementAssetReliabilityWorkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementAssetReliabilityWorkQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementAssetReliabilityWorkService.getManagementAssetReliabilityWork(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
