import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementDailyOperationsService } from './management-daily-operations.service';
import { parseManagementDailyOperationsQuery } from './management-daily-operations.validation';

/** GET /management/daily-operations — BE-24 PART 02A. */
export async function getManagementDailyOperationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementDailyOperationsQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementDailyOperationsService.getManagementDailyOperations(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
