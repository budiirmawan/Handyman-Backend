import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementPendingApprovalService } from './management-pending-approval.service';
import { parseManagementPendingApprovalQuery } from './management-pending-approval.validation';

/** GET /management/pending-approvals — BE-24 PART 03A. */
export async function getManagementPendingApprovalHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementPendingApprovalQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementPendingApprovalService.getManagementPendingApproval(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
