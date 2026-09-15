import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementCriticalFindingsService } from './management-critical-findings.service';
import { parseManagementCriticalFindingsQuery } from './management-critical-findings.validation';

/** GET /management/critical-findings — BE-24 PART 03B. */
export async function getManagementCriticalFindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementCriticalFindingsQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementCriticalFindingsService.getManagementCriticalFindings(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
