import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementReadScopeService } from './management-read-scope.service';
import { parseManagementReadScopeQuery } from './management-read-scope.validation';

/** GET /management/read-scope — BE-24 shared scope/period context only. */
export async function getManagementReadScopeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseManagementReadScopeQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementReadScopeService.getManagementReadScopeContext(
        filters,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
