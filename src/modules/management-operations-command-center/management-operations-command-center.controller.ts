import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementOperationsCommandCenterService } from './management-operations-command-center.service';
import { parseManagementOperationsCommandCenterQuery } from './management-operations-command-center.validation';

/** GET /management/operations-command-center — BE-24 PART 09. */
export async function getManagementOperationsCommandCenterHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementOperationsCommandCenterQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementOperationsCommandCenterService.getManagementOperationsCommandCenter(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
