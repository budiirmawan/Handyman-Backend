import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementAssetRegistryComplianceService } from './management-asset-registry-compliance.service';
import { parseManagementAssetRegistryComplianceQuery } from './management-asset-registry-compliance.validation';

/** GET /management/asset-registry-compliance — BE-24 PART 05A. */
export async function getManagementAssetRegistryComplianceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementAssetRegistryComplianceQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementAssetRegistryComplianceService.getManagementAssetRegistryCompliance(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
