import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementBuildingPerformanceService } from './management-building-performance.service';
import { parseManagementBuildingPerformanceQuery } from './management-building-performance.validation';

/** GET /management/building-performance — BE-24 PART 08A. */
export async function getManagementBuildingPerformanceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementBuildingPerformanceQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementBuildingPerformanceService.getManagementBuildingPerformance(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
